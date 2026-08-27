/**
 * Step handlers, and the failure vocabulary they speak.
 *
 * A handler does one thing and either returns an output or throws. It does not
 * decide whether to retry, how long to wait, or whether the run continues —
 * all of that is the executor's job, using the classification table. The
 * handler's only responsibility on failure is to describe *what happened*
 * accurately enough for the classifier to be right.
 */

import { createSafeFetch, SsrfBlockedError, getConnectionInfo } from 'automa-safe-fetch'
import type { FailureFacts } from '../classify.ts'
import type { FlowNode, RunRow, StepRow } from '../types.ts'

export interface StepContext {
  readonly run: RunRow
  readonly step: StepRow
  readonly node: FlowNode
  /**
   * Constant across automatic retries, so a provider that honours it will
   * refuse to perform the same effect twice. Handlers that talk to something
   * supporting idempotency keys must send this.
   */
  readonly idempotencyKey: string
  /** Outputs of the steps before this one, keyed by node id. */
  readonly upstream: Readonly<Record<string, unknown>>
  /** Fires when the step deadline passes or the run is cancelled. */
  readonly signal: AbortSignal
  readonly deadlineMs: number
}

export interface StepResult {
  readonly output?: unknown
}

export type StepHandler = (context: StepContext) => Promise<StepResult>

/**
 * A failure that already knows how to describe itself.
 *
 * Handlers throw this when they can say something specific — a status code, a
 * socket error, whether the request was actually sent. Anything else that
 * escapes a handler is treated as `internal`, which is the safe reading: our
 * bug until proven otherwise.
 */
export class StepFailure extends Error {
  override readonly name = 'StepFailure'
  readonly facts: FailureFacts
  constructor(message: string, facts: FailureFacts) {
    super(message)
    this.facts = facts
  }
}

/** Does nothing successfully. The control in every test that is about the engine. */
export const noopHandler: StepHandler = async (context) => {
  const config = context.node.config ?? {}
  return { output: config.output ?? null }
}

/**
 * A handler that fails a scripted number of times, then succeeds.
 *
 * Test infrastructure rather than a real step, but it lives here because the
 * matrix depends on it and hiding it in the test folder would mean two copies.
 * `failures` is consulted against `attemptsStarted`, so it survives the process
 * dying — which is what makes the crash-recovery tests meaningful.
 */
export function scriptedHandler(script: {
  /** Facts to throw on each attempt; undefined entries succeed. */
  readonly failures: readonly (FailureFacts | undefined)[]
  readonly output?: unknown
  /** Called every time the handler runs, for asserting side-effect counts. */
  readonly onInvoke?: (context: StepContext) => void
}): StepHandler {
  return async (context) => {
    script.onInvoke?.(context)
    const facts = script.failures[context.step.attemptsStarted - 1]
    if (facts !== undefined) {
      throw new StepFailure(`scripted failure on attempt ${context.step.attemptsStarted}`, facts)
    }
    return { output: script.output ?? null }
  }
}

export interface HttpStepConfig {
  readonly url: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/**
 * An HTTP step, over `automa-safe-fetch`.
 *
 * The URL comes from a flow definition, which means it comes from a user. That
 * makes every request a potential SSRF, so this deliberately does not use
 * `fetch`: the client resolves the name, validates every address, and connects
 * to the one it checked.
 *
 * A blocked destination is `client_error`, not a network fault. It will be
 * blocked identically on every retry, and burning five attempts discovering
 * that helps nobody.
 */
export function httpHandler(options: { safeFetch?: ReturnType<typeof createSafeFetch> } = {}): StepHandler {
  const safeFetch = options.safeFetch ?? createSafeFetch({ maxRedirects: 0 })

  return async (context) => {
    const config = context.node.config as unknown as HttpStepConfig
    if (config?.url === undefined) {
      throw new StepFailure('http step has no url', { deterministicallyBroken: true })
    }

    let requestSent = false
    try {
      const response = await safeFetch(config.url, {
        method: config.method ?? 'GET',
        headers: {
          // Only meaningful to providers that implement it, harmless elsewhere.
          'idempotency-key': context.idempotencyKey,
          ...config.headers,
        },
        ...(config.body === undefined ? {} : { body: config.body }),
        signal: context.signal,
        timeoutMs: context.deadlineMs,
      })
      requestSent = true

      const text = await response.text()
      if (!response.ok) {
        throw new StepFailure(`HTTP ${response.status}`, {
          httpStatus: response.status,
          requestSent: true,
          responseReceived: true,
        })
      }

      return {
        output: {
          status: response.status,
          body: text,
          resolvedIp: getConnectionInfo(response)?.resolvedIp ?? null,
        },
      }
    } catch (error) {
      if (error instanceof StepFailure) throw error

      if (error instanceof SsrfBlockedError) {
        // Deterministic: the same URL resolves the same way next time.
        throw new StepFailure(`blocked: ${error.reason}`, {
          deterministicallyBroken: false,
          httpStatus: 400,
          requestSent: false,
        })
      }

      const code = (error as NodeJS.ErrnoException).code
      throw new StepFailure((error as Error).message, {
        ...(code === undefined ? {} : { code }),
        requestSent,
        responseReceived: false,
      })
    }
  }
}

export type HandlerRegistry = Readonly<Record<string, StepHandler>>

export function defaultHandlers(): HandlerRegistry {
  return { noop: noopHandler, http: httpHandler() }
}
