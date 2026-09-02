/**
 * The executor runs one step attempt and records what happened.
 *
 * The shape that matters: claim in a transaction, execute *outside* any
 * transaction, then record in a second transaction. Holding a database
 * transaction open across a network call would pin a connection for the
 * duration of someone else's outage, and a pool of ten dies to one slow
 * provider.
 *
 * The cost of that shape is a window: the work can happen and the process die
 * before the result is written. That window is exactly why idempotency keys
 * exist, and why the retry presents the same one.
 */

import type { Pool } from 'pg'
import { withTransaction } from '../db/client.ts'
import { classify, type FailureFacts } from '../classify.ts'
import { DEFAULT_BACKOFF, type BackoffPolicy } from '../backoff.ts'
import { onAttemptFailed, type StepRetryState } from '../retry.ts'
import { systemRandom, type Random } from '../random.ts'
import { DEFAULT_TIMEOUTS, type TimeoutConfig } from '../timeouts.ts'
import {
  type ConcurrencyLimits,
  claimStep,
  enqueue,
  getRun,
  listSteps,
  recordFailure,
  markSkipped,
  recordSuccess,
  writeDlqEntry,
} from './repository.ts'
import { StepFailure, type HandlerRegistry, type StepContext } from './handlers.ts'
import { stepsToSkip } from '../branching.ts'
import type { FlowDefinition, RunRow, StepRow } from '../types.ts'

/**
 * Find the flow a run was started on.
 *
 * Returning null means the version is gone. That is not retryable — every
 * attempt would look for the same missing version — so the step fails
 * deterministically rather than burning its attempt budget discovering it.
 */
export type FlowResolver = (
  flowVersionId: string,
) => FlowDefinition | null | Promise<FlowDefinition | null>

export interface ExecutorDeps {
  readonly handlers: HandlerRegistry
  /**
   * The one flow this worker runs.
   *
   * Enough when nothing is ever republished. The moment a new version can be
   * published while runs of the old one are in flight this is wrong: every
   * step would be looked up in the newest definition, so a run already
   * underway would start executing nodes it never had. Use `flows` then.
   */
  readonly flow?: FlowDefinition
  /**
   * Resolve a flow by the version its run was started on.
   *
   * Takes precedence over `flow`, and is what lets a publish be non-blocking:
   * in-flight runs keep resolving the definition they began with, and only
   * runs created afterwards see the new one.
   */
  readonly flows?: FlowResolver
  readonly workerId: string
  readonly random?: Random
  readonly backoff?: BackoffPolicy
  readonly timeouts?: TimeoutConfig
  /** Enforced at claim time. Omit for no limits. */
  readonly limits?: ConcurrencyLimits
  /** How long a blocked step waits before trying to claim again. */
  readonly blockedRetryMs?: number
}

export type StepOutcome =
  | { readonly kind: 'not_claimed' }
  | {
      readonly kind: 'deferred'
      readonly stepId: string
      readonly scope: 'tenant' | 'flow'
      readonly running: number
      readonly limit: number
    }
  | { readonly kind: 'succeeded'; readonly stepId: string }
  | { readonly kind: 'retry_scheduled'; readonly stepId: string; readonly delayMs: number }
  | { readonly kind: 'dead_lettered'; readonly stepId: string; readonly reason: string }
  | { readonly kind: 'paused'; readonly stepId: string }
  | { readonly kind: 'failed'; readonly stepId: string; readonly errorClass: string }

export interface RunStepInput {
  readonly runId: string
  readonly runStartedAt: Date
  readonly stepId: string
  /** Needed to count concurrency and to tag the messages this produces. */
  readonly tenantId?: string
}

export async function runStep(
  pool: Pool,
  input: RunStepInput,
  deps: ExecutorDeps,
): Promise<StepOutcome> {
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS
  const policy = deps.backoff ?? DEFAULT_BACKOFF
  const random = deps.random ?? systemRandom

  // The run is loaded before the claim rather than inside buildContext, because
  // the claim needs its flow id and the flow lookup needs its version. It is
  // not an extra query: buildContext used to load exactly this and now takes
  // it as an argument.
  const run = await withTransaction(pool, (tx) => getRun(tx, input.runStartedAt, input.runId))
  if (run === null) {
    // The run was deleted — a partition dropped, most likely — while a message
    // for it was still in the queue. Nothing to execute and nothing to record.
    return { kind: 'not_claimed' }
  }

  // 1. Claim. Three outcomes, and telling them apart matters.
  const result = await withTransaction(pool, (tx) =>
    claimStep(tx, {
      runStartedAt: input.runStartedAt,
      stepId: input.stepId,
      workerId: deps.workerId,
      leaseMs: timeouts.stepAttemptMs * 2,
      tenantId: input.tenantId,
      flowId: run.flowId,
      ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    }),
  )

  // Someone else owns it: this delivery was a duplicate. Do nothing at all.
  if (result.kind === 'taken') return { kind: 'not_claimed' }

  if (result.kind === 'blocked') {
    // At a concurrency ceiling. The step is still ours to run and nothing has
    // failed — the system is busy. Put it back with a delay and do not touch
    // the attempt counters, or a traffic spike would exhaust every step's
    // retry budget without a single real error having occurred.
    await withTransaction(pool, (tx) =>
      enqueue(tx, {
        topic: 'run_step',
        payload: {
          runId: input.runId,
          runStartedAt: input.runStartedAt.toISOString(),
          stepId: input.stepId,
        },
        tenantId: input.tenantId,
        delayMs: deps.blockedRetryMs ?? 250,
      }),
    )
    return {
      kind: 'deferred',
      stepId: input.stepId,
      scope: result.scope,
      running: result.running,
      limit: result.limit,
    }
  }

  const claimed = result.step

  // Resolved here, after the claim, so that a version which cannot be found
  // fails this step through the ordinary path — recorded, classified,
  // dead-lettered — rather than escaping into the worker loop.
  let flow: FlowDefinition | null = null
  let output: unknown
  let failure: FailureFacts | null = null
  let failureMessage = ''

  try {
    flow = await flowFor(deps, run)
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error
    failure = error.facts
    failureMessage = error.message
  }

  const context =
    flow === null ? null : await buildContext(pool, claimed, run, flow, timeouts)

  // 2. Execute, outside any transaction.
  const handler = deps.handlers[claimed.stepKind]

  if (failure !== null) {
    // The version could not be resolved. Nothing to execute.
  } else if (context === null) {
    // Unreachable: context is only null when the flow could not be resolved,
    // and that sets failure above. Written out rather than asserted away so
    // that if it ever does happen it is a recorded step failure and not a
    // crash in the worker loop.
    failure = { internal: true }
    failureMessage = "no execution context"
  } else if (handler === undefined) {
    failure = { deterministicallyBroken: true }
    failureMessage = `no handler registered for step kind ${JSON.stringify(claimed.stepKind)}`
  } else {
    try {
      const result = await handler(context.ctx)
      output = result.output
    } catch (error) {
      failureMessage = (error as Error).message
      failure =
        error instanceof StepFailure
          ? error.facts
          : // Anything that escapes a handler without describing itself is our
            // bug until proven otherwise. Assuming it is a transient network
            // fault would retry things that will never work.
            { internal: true }
    } finally {
      context.dispose()
    }
  }

  // 3. Record, in a second transaction, along with whatever comes next.
  if (failure === null) {
    return withTransaction(pool, async (tx) => {
      const wrote = await recordSuccess(tx, {
        runStartedAt: input.runStartedAt,
        stepId: input.stepId,
        workerId: deps.workerId,
        output,
      })
      // The lease lapsed mid-step and someone else owns it now. Our result is
      // stale; writing it would overwrite whatever they are doing.
      if (!wrote) return { kind: 'not_claimed' }

      await tx.query(
        `UPDATE runs SET steps_succeeded = steps_succeeded + 1 WHERE started_at = $1 AND id = $2`,
        [input.runStartedAt, input.runId],
      )

      // A branch that has just succeeded decides what never runs. In the same
      // transaction as its own result, so a crash between the two cannot leave
      // a resolved branch with both arms still pending — which would run both.
      const taken = takenArm(output)
      if (taken !== null && flow !== null) {
        const abandoned = stepsToSkip(flow.edges ?? [], claimed.nodeId, taken)
        await markSkipped(
          tx,
          { id: input.runId, startedAt: input.runStartedAt },
          abandoned,
          `not taken: ${claimed.nodeId} went ${taken}`,
        )
      }

      await enqueueAdvance(tx, input, claimed.tenantId)
      return { kind: 'succeeded', stepId: input.stepId }
    })
  }

  const errorClass = classify(failure)
  const state: StepRetryState = {
    attemptsStarted: claimed.attemptsStarted,
    attemptsConsumed: claimed.attemptsConsumed,
    deferrals: claimed.deferrals,
  }
  const decision = onAttemptFailed(
    state,
    {
      errorClass,
      // A step whose flow version is missing is treated as not repeatable.
      // The safe default when we cannot read the node: assume the effect may
      // already have happened.
      idempotent: flow === null ? false : nodeFor(flow, claimed).idempotent,
      retryAfterMs: failure.retryAfterMs ?? null,
    },
    { now: Date.now(), random, policy: withStepLimits(policy, claimed) },
  )

  return withTransaction(pool, async (tx) => {
    const common = {
      runStartedAt: input.runStartedAt,
      stepId: input.stepId,
      workerId: deps.workerId,
      attemptsConsumed: decision.state.attemptsConsumed,
      deferrals: decision.state.deferrals,
      errorClass,
      errorMessage: failureMessage.slice(0, 2000),
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    }

    if (decision.kind === 'retry') {
      const wrote = await recordFailure(tx, {
        ...common,
        status: 'failed',
        retryDelayMs: decision.delayMs,
      })
      if (!wrote) return { kind: 'not_claimed' }
      // The run is advanced when the retry comes due, not now.
      await enqueueAdvance(tx, input, claimed.tenantId, decision.delayMs)
      return { kind: 'retry_scheduled', stepId: input.stepId, delayMs: decision.delayMs }
    }

    if (decision.kind === 'terminal' && decision.action === 'pause_for_confirmation') {
      const wrote = await recordFailure(tx, {
        ...common,
        status: 'waiting_confirmation',
        retryDelayMs: null,
      })
      if (!wrote) return { kind: 'not_claimed' }
      await enqueueAdvance(tx, input, claimed.tenantId)
      return { kind: 'paused', stepId: input.stepId }
    }

    const wrote = await recordFailure(tx, { ...common, status: 'failed', retryDelayMs: null })
    if (!wrote) return { kind: 'not_claimed' }

    await tx.query(
      `UPDATE runs SET steps_failed = steps_failed + 1 WHERE started_at = $1 AND id = $2`,
      [input.runStartedAt, input.runId],
    )

    // Against the step's own limits, not the instance default: a node
    // configured with maxAttempts 3 exhausts at 3, and reporting that as
    // "deferrals_exhausted" would send whoever reads the DLQ hunting a rate
    // limit that never happened.
    const stepLimits = withStepLimits(policy, claimed)
    const dlqReason =
      decision.kind === 'exhausted'
        ? decision.state.attemptsConsumed >= stepLimits.maxAttempts
          ? 'attempts_exhausted'
          : 'deferrals_exhausted'
        : errorClass === 'poison'
          ? 'poison'
          : null

    if (dlqReason !== null) {
      await writeDlqEntry(tx, {
        tenantId: claimed.tenantId,
        runId: input.runId,
        runStartedAt: input.runStartedAt,
        stepExecutionId: input.stepId,
        flowVersionId: run.flowVersionId,
        nodeId: claimed.nodeId,
        originTopic: 'run_step',
        reason: dlqReason,
        errorClass,
        errorChain: [{ message: failureMessage, errorClass }],
        replayPayload: {
          runId: input.runId,
          runStartedAt: input.runStartedAt.toISOString(),
          stepId: input.stepId,
          nodeId: claimed.nodeId,
          stepKind: claimed.stepKind,
          idempotencyKey: claimed.idempotencyKey,
          input: claimed.inputInline,
          flowVersionId: run.flowVersionId,
        },
      })
      await enqueueAdvance(tx, input, claimed.tenantId)
      return { kind: 'dead_lettered', stepId: input.stepId, reason: dlqReason }
    }

    await enqueueAdvance(tx, input, claimed.tenantId)
    return { kind: 'failed', stepId: input.stepId, errorClass }
  })
}

/**
 * Schedule the run to be looked at again.
 *
 * The tenant is not optional. A worker pool dedicated to one tenant claims by
 * tenant_id, so an untagged message is invisible to it — every run would stall
 * silently after its first step, with the work sitting in the outbox looking
 * perfectly healthy.
 */
function enqueueAdvance(
  tx: Parameters<typeof enqueue>[0],
  input: RunStepInput,
  tenantId: string,
  delayMs?: number,
): Promise<string> {
  return enqueue(tx, {
    topic: 'advance_run',
    payload: { runId: input.runId, runStartedAt: input.runStartedAt.toISOString() },
    tenantId,
    ...(delayMs === undefined ? {} : { delayMs }),
  })
}

/**
 * The flow definition for a run, however this worker was configured.
 *
 * A worker given neither is a programming error, not a runtime condition, so
 * it throws rather than failing the step: every step would fail identically
 * and the DLQ would fill with the same misconfiguration.
 */
async function flowFor(deps: ExecutorDeps, run: RunRow): Promise<FlowDefinition> {
  if (deps.flows !== undefined) {
    const resolved = await deps.flows(run.flowVersionId)
    if (resolved === null) {
      throw new StepFailure(`flow version ${run.flowVersionId} is not available`, {
        deterministicallyBroken: true,
      })
    }
    return resolved
  }
  if (deps.flow !== undefined) return deps.flow
  throw new Error('ExecutorDeps needs either flow or flows')
}

/**
 * Which arm a branch step chose, or null if this was not a branch.
 *
 * The contract is narrow on purpose: a handler signals a branch decision by
 * returning `{ taken: "yes" | "no" }`. Anything else — including a branch
 * handler that forgets — resolves nothing, and the run stalls with both arms
 * pending rather than quietly running both.
 */
function takenArm(output: unknown): "yes" | "no" | null {
  if (output === null || typeof output !== "object") return null
  const taken = (output as { taken?: unknown }).taken
  return taken === "yes" || taken === "no" ? taken : null
}

function nodeFor(flow: FlowDefinition, step: StepRow) {
  const node = flow.nodes.find((candidate) => candidate.id === step.nodeId)
  if (node === undefined) {
    // A step whose node has vanished from the flow version cannot be executed
    // and cannot be repaired by retrying.
    return { id: step.nodeId, kind: step.stepKind, idempotent: false }
  }
  return node
}

/** Per-step limits override the instance policy, so one node can be stricter. */
function withStepLimits(policy: BackoffPolicy, step: StepRow): BackoffPolicy {
  return {
    ...policy,
    maxAttempts: step.maxAttempts,
    maxDeferrals: step.maxDeferrals,
  }
}

async function buildContext(
  pool: Pool,
  step: StepRow,
  run: RunRow,
  flow: FlowDefinition,
  timeouts: TimeoutConfig,
): Promise<{ ctx: StepContext; dispose: () => void }> {
  const priorSteps = await withTransaction(pool, (tx) =>
    listSteps(tx, { id: step.runId, startedAt: step.runStartedAt }),
  )

  const upstream: Record<string, unknown> = {}
  for (const prior of priorSteps) {
    // Includes steps skipped by a resume: their recorded outputs must stay
    // resolvable or downstream mappings break.
    if (prior.status === 'succeeded' || prior.status === 'skipped_resumed') {
      upstream[prior.nodeId] = prior.outputInline
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeouts.stepAttemptMs)
  timer.unref?.()

  return {
    ctx: {
      run,
      step,
      node: nodeFor(flow, step),
      idempotencyKey: step.idempotencyKey,
      upstream,
      signal: controller.signal,
      deadlineMs: timeouts.stepAttemptMs,
    },
    dispose: () => clearTimeout(timer),
  }
}
