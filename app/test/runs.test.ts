import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { toViewerListing, toViewerOutcome, toViewerRun, toViewerRunStatus } from '../src/runs.ts'
import type { RunRow, StepRow } from 'automa-durable-runner'

const graph = { nodes: [], edges: [] }

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run_1',
    tenantId: 't',
    flowId: 'f',
    flowVersionId: 'v',
    status: 'succeeded',
    attemptGroup: 1,
    startedAt: new Date('2026-03-01T09:00:00.000Z'),
    finishedAt: null,
    deadlineAt: null,
    cancelRequestedAt: null,
    cancelledAtStepId: null,
    stepCount: 0,
    stepsSucceeded: 0,
    stepsFailed: 0,
    errorClass: null,
    errorCode: null,
    input: null,
    ...over,
  }) as RunRow

const step = (over: Partial<StepRow> = {}): StepRow =>
  ({
    id: 's1',
    tenantId: 't',
    runId: 'run_1',
    runStartedAt: new Date('2026-03-01T09:00:00.000Z'),
    nodeId: 'a',
    iterationIndex: 0,
    topoOrder: 0,
    stepKind: 'noop',
    status: 'succeeded',
    attemptsStarted: 1,
    attemptsConsumed: 0,
    deferrals: 0,
    maxAttempts: 5,
    maxDeferrals: 5,
    nextAttemptAt: null,
    idempotencyKey: 'k',
    leaseExpiresAt: null,
    workerId: null,
    inputInline: null,
    outputInline: null,
    errorClass: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    ...over,
  }) as StepRow

describe('run status', () => {
  test('collapses seven engine statuses into the four the viewer has', () => {
    assert.equal(toViewerRunStatus('succeeded'), 'succeeded')
    assert.equal(toViewerRunStatus('failed'), 'failed')
    assert.equal(toViewerRunStatus('timed_out'), 'failed')
    assert.equal(toViewerRunStatus('cancelled'), 'cancelled')
    assert.equal(toViewerRunStatus('queued'), 'running')
    assert.equal(toViewerRunStatus('running'), 'running')
    assert.equal(toViewerRunStatus('waiting_confirmation'), 'running')
  })
})

describe('step outcome', () => {
  test('a pending step in a finished run was never reached', () => {
    assert.equal(toViewerOutcome('pending', true), 'not_reached')
  })

  test('a pending step in a live run is still coming', () => {
    assert.equal(toViewerOutcome('pending', false), 'running')
  })

  test('a step a resume skipped had already succeeded, and reads that way', () => {
    // "Skipped" would suggest it did not happen, when the opposite is true and
    // its output is right there in the step row.
    assert.equal(toViewerOutcome('skipped_resumed', true), 'succeeded')
    assert.notEqual(toViewerOutcome('skipped_resumed', true), 'skipped')
  })

  test('a timed-out step is a failure', () => {
    assert.equal(toViewerOutcome('timed_out', true), 'failed')
  })

  test('a step left running when the run ended did not finish', () => {
    assert.equal(toViewerOutcome('running', true), 'not_reached')
    assert.equal(toViewerOutcome('running', false), 'running')
  })
})

describe('translating a run', () => {
  test('orders steps the way they ran, not the way they arrived', () => {
    const view = toViewerRun(
      run({ stepCount: 3 }),
      [
        step({ id: 's3', nodeId: 'c', topoOrder: 2 }),
        step({ id: 's1', nodeId: 'a', topoOrder: 0 }),
        step({ id: 's2', nodeId: 'b', topoOrder: 1 }),
      ],
      graph,
    )
    assert.deepEqual(view.steps.map((s) => s.nodeId), ['a', 'b', 'c'])
  })

  test('a step that never ran carries no duration at all', () => {
    // Not zero. "Took no time" and "never happened" must not render alike.
    const view = toViewerRun(
      run({ status: 'failed' }),
      [step({ status: 'pending', startedAt: null, durationMs: null })],
      graph,
    )
    assert.equal(view.steps[0]?.outcome, 'not_reached')
    assert.equal(view.steps[0]?.durationMs, undefined)
    assert.equal(view.steps[0]?.startedAt, undefined)
  })

  test('carries the timings the engine recorded', () => {
    const view = toViewerRun(
      run(),
      [step({ startedAt: new Date('2026-03-01T09:00:01.000Z'), durationMs: 137 })],
      graph,
    )
    assert.equal(view.steps[0]?.startedAt, '2026-03-01T09:00:01.000Z')
    assert.equal(view.steps[0]?.durationMs, 137)
  })

  test('reports attempts started, so a retried step shows as retried', () => {
    const view = toViewerRun(run(), [step({ attemptsStarted: 3, attemptsConsumed: 2 })], graph)
    assert.equal(view.steps[0]?.attempts, 3)
  })

  test('builds an error string when there is no message, and prefers the message when there is', () => {
    const withMessage = toViewerRun(
      run({ status: 'failed' }),
      [step({ status: 'failed', errorClass: 'client_error', errorCode: '402', errorMessage: 'card declined' })],
      graph,
    )
    assert.equal(withMessage.steps[0]?.error, 'card declined')

    const withoutMessage = toViewerRun(
      run({ status: 'failed' }),
      [step({ status: 'failed', errorClass: 'client_error', errorCode: '402' })],
      graph,
    )
    assert.equal(withoutMessage.steps[0]?.error, 'client_error: 402')
  })

  test('a successful step has no error field rather than a null one', () => {
    const view = toViewerRun(run(), [step()], graph)
    assert.ok(!('error' in view.steps[0]!))
  })
})

describe('a listing', () => {
  test('derives what was never reached from the counts on the run row', () => {
    const listing = toViewerListing(run({ status: 'failed', stepCount: 5, stepsSucceeded: 2, stepsFailed: 1 }))
    assert.equal(listing.succeeded, 2)
    assert.equal(listing.failed, 1)
    assert.equal(listing.notReached, 2)
  })

  test('never reports a negative count, whatever the counters say', () => {
    const listing = toViewerListing(run({ stepCount: 1, stepsSucceeded: 3, stepsFailed: 0 }))
    assert.equal(listing.notReached, 0)
  })

  test('matches the shape the canvas computes for itself', () => {
    // The two halves of the same contract: this one from a row, the canvas's
    // describeRun from a whole run. Same keys, or the list changes shape
    // depending on whether a backend is present.
    const listing = toViewerListing(run({ stepCount: 1, stepsSucceeded: 1 }), 42)
    assert.deepEqual(Object.keys(listing).sort(), [
      'failed',
      'id',
      'notReached',
      'startedAt',
      'status',
      'succeeded',
      'totalMs',
    ])
  })
})
