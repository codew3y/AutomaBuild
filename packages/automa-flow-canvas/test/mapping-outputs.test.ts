/**
 * What the mapping panel is allowed to offer.
 *
 * This is the exact logic that leaked one flow's fields into another, twice.
 * First because the sample was merged under every real run, and then — after
 * that was fixed — because `run` is reset to the bundled sample on a flow
 * switch, so deriving from it whenever a server was connected produced the
 * sample's fields again by a different route.
 *
 * The rule has three cases and only one of them is the sample.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { outputsFromRun, type RunRecord } from '../src/core/run.ts'
import { SAMPLE_OUTPUTS, SAMPLE_RUN } from '../src/sample.ts'

/** The decision as the editor makes it. Kept in step with App.tsx by name. */
function mappingOutputs(options: {
  connected: boolean
  live: boolean
  run: RunRecord
}): Record<string, unknown> {
  if (!options.connected) return SAMPLE_OUTPUTS
  if (!options.live) return {}
  return outputsFromRun(options.run)
}

const realRun: RunRecord = {
  id: 'run_real',
  startedAt: '2026-03-01T09:00:00Z',
  status: 'succeeded',
  graph: { nodes: [], edges: [] },
  steps: [
    {
      nodeId: 'trigger',
      outcome: 'succeeded',
      output: { orderId: 'ord_991', total: 8800 },
    },
  ],
}

describe('what the mapping panel offers', () => {
  test('no server: the bundled sample, which is the point of shipping one', () => {
    const offered = mappingOutputs({ connected: false, live: false, run: SAMPLE_RUN })
    assert.deepEqual(offered, SAMPLE_OUTPUTS)
  })

  test('a server, but this flow has never run: nothing', () => {
    // The case that was wrong twice. `run` is still the bundled sample here,
    // because the flow switch resets it so the run viewer has a graph to draw
    // — so anything deriving from `run` produces the sample's fields under
    // this flow's step ids. Every flow's trigger is called `trigger`, which is
    // what made it look like real data for a flow that had never run.
    const offered = mappingOutputs({ connected: true, live: false, run: SAMPLE_RUN })
    assert.deepEqual(offered, {})
    assert.equal(Object.keys(offered).includes('trigger'), false)
  })

  test('a server and a real run: only what that run produced', () => {
    const offered = mappingOutputs({ connected: true, live: true, run: realRun })
    assert.deepEqual(offered, { trigger: { output: { orderId: 'ord_991', total: 8800 } } })
  })

  test('a real run never has the sample merged underneath it', () => {
    // The first version of this bug: `{ ...SAMPLE_OUTPUTS, ...fromRun }`, which
    // offered lookup and shape from the sample beside a real trigger.
    const offered = mappingOutputs({ connected: true, live: true, run: realRun })
    for (const sampleStep of Object.keys(SAMPLE_OUTPUTS)) {
      if (sampleStep === 'trigger') continue
      assert.equal(
        Object.keys(offered).includes(sampleStep),
        false,
        `${sampleStep} came from the sample, not from the run`,
      )
    }
  })

  test('a trigger describes the payload the flow actually received', () => {
    const offered = mappingOutputs({ connected: true, live: true, run: realRun })
    const trigger = offered.trigger as { output: Record<string, unknown> }
    assert.deepEqual(Object.keys(trigger.output).sort(), ['orderId', 'total'])
    // And not the sample's shape, which is a Stripe invoice.
    assert.equal('event' in trigger.output, false)
  })
})
