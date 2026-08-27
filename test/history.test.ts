import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeRun, relativeTime, sortHistory, type RunListing } from '../src/core/history.ts'
import type { RunRecord } from '../src/core/run.ts'

const graph = { nodes: [], edges: [] }

const run = (id: string, startedAt: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  startedAt,
  status: 'succeeded',
  graph,
  steps: [],
  ...over,
})

const listing = (id: string, startedAt: string): RunListing => ({
  id,
  startedAt,
  status: 'succeeded',
  succeeded: 0,
  failed: 0,
  notReached: 0,
  totalMs: 0,
})

describe('run history', () => {
  test('a listing carries the counts the list shows, without the step log', () => {
    const described = describeRun(
      run('run_1', '2026-03-01T09:00:00Z', {
        status: 'failed',
        steps: [
          { nodeId: 'a', outcome: 'succeeded', durationMs: 120 },
          { nodeId: 'b', outcome: 'failed', durationMs: 40 },
          { nodeId: 'c', outcome: 'not_reached' },
        ],
      }),
    )

    assert.deepEqual(described, {
      id: 'run_1',
      startedAt: '2026-03-01T09:00:00Z',
      status: 'failed',
      succeeded: 1,
      failed: 1,
      notReached: 1,
      totalMs: 160,
    })
    assert.ok(!('steps' in described), 'a listing must not carry the step log')
  })

  test('newest first', () => {
    const sorted = sortHistory([
      listing('a', '2026-03-01T09:00:00Z'),
      listing('b', '2026-03-01T11:00:00Z'),
      listing('c', '2026-03-01T10:00:00Z'),
    ])
    assert.deepEqual(sorted.map((l) => l.id), ['b', 'c', 'a'])
  })

  test('runs from the same millisecond keep a stable order between fetches', () => {
    const same = '2026-03-01T09:00:00.000Z'
    const first = sortHistory([listing('r1', same), listing('r2', same), listing('r3', same)])
    // Same set, arriving in a different order from the server.
    const second = sortHistory([listing('r3', same), listing('r1', same), listing('r2', same)])
    assert.deepEqual(first.map((l) => l.id), second.map((l) => l.id))
    assert.deepEqual(first.map((l) => l.id), ['r3', 'r2', 'r1'])
  })

  test('does not mutate the array it was given', () => {
    const input = [listing('a', '2026-03-01T09:00:00Z'), listing('b', '2026-03-01T11:00:00Z')]
    sortHistory(input)
    assert.deepEqual(input.map((l) => l.id), ['a', 'b'])
  })

  describe('relative time', () => {
    const now = Date.parse('2026-03-01T12:00:00Z')

    test('reads in the units a person would use', () => {
      assert.equal(relativeTime('2026-03-01T11:59:30Z', now), 'just now')
      assert.equal(relativeTime('2026-03-01T11:56:00Z', now), '4 min ago')
      assert.equal(relativeTime('2026-03-01T09:00:00Z', now), '3 h ago')
      assert.equal(relativeTime('2026-02-27T12:00:00Z', now), '2 d ago')
    })

    test('falls back to a date once relative stops being useful', () => {
      assert.equal(relativeTime('2025-11-02T12:00:00Z', now), '2025-11-02')
    })

    test('clock skew reads as just now, not as a run from the future', () => {
      assert.equal(relativeTime('2026-03-01T12:00:03Z', now), 'just now')
    })

    test('an unparseable timestamp is shown as-is rather than as NaN', () => {
      assert.equal(relativeTime('not a date', now), 'not a date')
    })
  })
})
