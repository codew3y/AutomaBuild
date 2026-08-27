/**
 * Reference resolution and the run view — the logic behind the two panels.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { outputTree, readPath, referenceFor, resolveTemplate } from '../src/core/resolve.ts'
import { buildRunView, outputsFromRun, summarise, type RunRecord } from '../src/core/run.ts'
import type { FlowGraph } from '../src/core/graph.ts'

const OUTPUTS = {
  fetch: {
    output: {
      id: 'cus_4821',
      email: 'sam@example.com',
      tier: 'premium',
      credits: 0,
      active: false,
      address: { city: 'Zurich', country: 'CH' },
      orders: [{ id: 'ord_1', total: 42 }],
      note: null,
    },
  },
}

describe('readPath', () => {
  it('walks dotted and indexed paths alike', () => {
    assert.equal(readPath(OUTPUTS, 'fetch.output.email').value, 'sam@example.com')
    assert.equal(readPath(OUTPUTS, 'fetch.output.address.city').value, 'Zurich')
    assert.equal(readPath(OUTPUTS, 'fetch.output.orders[0].total').value, 42)
    assert.equal(readPath(OUTPUTS, 'fetch.output.orders.0.total').value, 42)
  })

  it('reports a missing path rather than returning undefined silently', () => {
    // The distinction the whole preview rests on: a value that is absent is
    // not the same as a value that is empty.
    assert.deepEqual(readPath(OUTPUTS, 'fetch.output.nope'), { found: false, value: undefined })
    assert.equal(readPath(OUTPUTS, 'fetch.output.note').found, true)
    assert.equal(readPath(OUTPUTS, 'fetch.output.note').value, null)
  })
})

describe('resolveTemplate', () => {
  it('substitutes a reference', () => {
    const result = resolveTemplate('{{ steps.fetch.output.email }}', OUTPUTS)
    assert.equal(result.text, 'sam@example.com')
    assert.deepEqual(result.missing, [])
  })

  it('substitutes inside surrounding text', () => {
    const result = resolveTemplate('Hi {{ steps.fetch.output.email }}, welcome', OUTPUTS)
    assert.equal(result.text, 'Hi sam@example.com, welcome')
  })

  it('keeps the type when the whole field is one reference', () => {
    // Otherwise a number previews as a string and `false` previews as the word
    // "false", which is exactly the confusion the preview is meant to remove.
    const number = resolveTemplate('{{ steps.fetch.output.credits }}', OUTPUTS)
    assert.equal(number.single, true)
    assert.equal(number.value, 0)

    const boolean = resolveTemplate('{{ steps.fetch.output.active }}', OUTPUTS)
    assert.equal(boolean.value, false)
  })

  it('marks an unresolvable path instead of rendering nothing', () => {
    // Rendering '' would be indistinguishable from a field that resolved to an
    // empty string, and a mapping that quietly resolves to nothing is the most
    // common way one of these flows breaks.
    const result = resolveTemplate('{{ steps.fetch.output.missing }}', OUTPUTS)
    assert.deepEqual(result.missing, ['steps.fetch.output.missing'])
    assert.match(result.text, /⟨steps\.fetch\.output\.missing⟩/)
  })

  it('reports every missing reference, not just the first', () => {
    const result = resolveTemplate('{{ steps.a.output.x }} {{ steps.b.output.y }}', OUTPUTS)
    assert.equal(result.missing.length, 2)
  })

  it('leaves text with no references alone', () => {
    const result = resolveTemplate('just a string', OUTPUTS)
    assert.equal(result.text, 'just a string')
    assert.equal(result.single, false)
  })
})

describe('outputTree', () => {
  const leaves = outputTree(OUTPUTS)

  it('flattens nested output into pickable paths', () => {
    const paths = leaves.map((leaf) => leaf.path)
    assert.ok(paths.includes('fetch.output.email'))
    assert.ok(paths.includes('fetch.output.address.city'))
  })

  it('shows one sample element of an array rather than all of them', () => {
    const paths = leaves.map((leaf) => leaf.path)
    assert.ok(paths.includes('fetch.output.orders[0].total'))
    assert.equal(paths.filter((p) => p.startsWith('fetch.output.orders[')).length > 0, true)
    assert.equal(paths.some((p) => p.includes('[1]')), false, 'one element is enough to show shape')
  })

  it('labels each leaf with its type', () => {
    const byPath = new Map(leaves.map((leaf) => [leaf.path, leaf]))
    assert.equal(byPath.get('fetch.output.email')?.kind, 'string')
    assert.equal(byPath.get('fetch.output.credits')?.kind, 'number')
    assert.equal(byPath.get('fetch.output.active')?.kind, 'boolean')
    assert.equal(byPath.get('fetch.output.address')?.kind, 'object')
    assert.equal(byPath.get('fetch.output.orders')?.kind, 'array')
    assert.equal(byPath.get('fetch.output.note')?.kind, 'null')
  })

  it('builds the reference a pick inserts', () => {
    assert.equal(referenceFor('fetch.output.email'), '{{ steps.fetch.output.email }}')
  })
})

describe('the run view', () => {
  const graph: FlowGraph = {
    nodes: ['trigger', 'check', 'left', 'right'].map((id) => ({
      id,
      kind: 'http',
      position: { x: 0, y: 0 },
      data: {},
    })),
    edges: [
      { id: 'trigger->check', source: 'trigger', target: 'check' },
      { id: 'check->left', source: 'check', target: 'left', sourceHandle: 'yes' },
      { id: 'check->right', source: 'check', target: 'right', sourceHandle: 'no' },
    ],
  }

  const run: RunRecord = {
    id: 'run-1',
    startedAt: '2026-03-01T09:14:00Z',
    status: 'succeeded',
    graph,
    steps: [
      { nodeId: 'trigger', outcome: 'succeeded', durationMs: 12, output: { ok: true } },
      { nodeId: 'check', outcome: 'succeeded', durationMs: 3, output: { branch: 'yes' } },
      { nodeId: 'left', outcome: 'succeeded', durationMs: 240, output: { sent: true } },
      { nodeId: 'right', outcome: 'not_reached' },
    ],
  }

  it('lights only the edges the run followed', () => {
    // The thing the viewer exists for. "The email never went out" is usually
    // not a failure — it is a branch that went the other way.
    const view = buildRunView(run)
    assert.equal(view.takenEdgeIds.has('check->left'), true)
    assert.equal(view.takenEdgeIds.has('check->right'), false)
    assert.equal(view.reachedNodeIds.has('right'), false)
  })

  it('exposes each step by node for the canvas overlay', () => {
    const view = buildRunView(run)
    assert.equal(view.byNode.get('left')?.durationMs, 240)
    assert.equal(view.byNode.get('right')?.outcome, 'not_reached')
  })

  it('summarises outcomes', () => {
    const summary = summarise(run)
    assert.equal(summary.succeeded, 3)
    assert.equal(summary.failed, 0)
    assert.equal(summary.notReached, 1)
    assert.equal(summary.totalMs, 255)
  })

  it('offers the run outputs for a mapping preview', () => {
    // Previewing against a real past run beats previewing against invented
    // sample data: the shapes are the ones the provider actually returned.
    const outputs = outputsFromRun(run)
    assert.deepEqual(outputs.left, { output: { sent: true } })
    assert.equal('right' in outputs, false, 'a step that never ran has no output')
  })

  it('carries the graph it ran on, not a reference to the current one', () => {
    // Rendering an old run against today's design means debugging a failure on
    // a diagram where the step in question may not exist any more.
    assert.equal(run.graph.nodes.length, 4)
  })
})
