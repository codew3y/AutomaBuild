/**
 * The graph core: cycle prevention, ancestry, and validation.
 *
 * Pure functions over plain objects, so none of this needs a browser. That is
 * the reason it is split out — these are the parts that have to be correct,
 * and correctness is much easier to establish away from a canvas.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ancestors,
  assertParentsFirst,
  canConnect,
  chainTail,
  danglingEdges,
  descendants,
  orphans,
  roots,
  topologicalOrder,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '../src/core/graph.ts'
import { canPublish, issuesByNode, referencedSteps, validate } from '../src/core/validation.ts'
import { SCHEMAS, visibleFields } from '../src/sample.ts'

const node = (id: string, kind = 'http', data: Record<string, unknown> = {}): FlowNode => ({
  id,
  kind,
  position: { x: 0, y: 0 },
  data,
})

const edge = (source: string, target: string, sourceHandle?: string): FlowEdge => ({
  id: `${source}->${target}${sourceHandle === undefined ? '' : `:${sourceHandle}`}`,
  source,
  target,
  ...(sourceHandle === undefined ? {} : { sourceHandle }),
})

/** trigger → a → b → c */
const chain: FlowGraph = {
  nodes: ['trigger', 'a', 'b', 'c'].map((id) => node(id)),
  edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'c')],
}

/**
 *            ┌→ left  ─┐
 * trigger → split      → (nothing joins; branches stay separate)
 *            └→ right ─┘
 */
const branched: FlowGraph = {
  nodes: ['trigger', 'split', 'left', 'right'].map((id) => node(id)),
  edges: [
    edge('trigger', 'split'),
    edge('split', 'left', 'yes'),
    edge('split', 'right', 'no'),
  ],
}

describe('reachability', () => {
  it('walks forwards and backwards', () => {
    assert.deepEqual([...descendants(chain, 'a')].sort(), ['b', 'c'])
    assert.deepEqual([...ancestors(chain, 'c')].sort(), ['a', 'b', 'trigger'])
  })

  it('excludes the node itself', () => {
    assert.equal(descendants(chain, 'a').has('a'), false)
    assert.equal(ancestors(chain, 'a').has('a'), false)
  })

  it('keeps branches separate', () => {
    // Neither branch is an ancestor of the other, which is what makes a
    // cross-branch reference invalid.
    assert.equal(ancestors(branched, 'left').has('right'), false)
    assert.equal(descendants(branched, 'left').has('right'), false)
  })

  it('does not loop forever on a cyclic graph', () => {
    const cyclic: FlowGraph = {
      nodes: ['a', 'b'].map((id) => node(id)),
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    assert.deepEqual([...descendants(cyclic, 'a')].sort(), ['a', 'b'])
  })
})

describe('canConnect', () => {
  it('allows a connection that extends the chain', () => {
    const extended: FlowGraph = { ...chain, nodes: [...chain.nodes, node('d')] }
    assert.deepEqual(canConnect(extended, { source: 'c', target: 'd' }), { valid: true })
  })

  it('refuses a connection that would close a loop', () => {
    // The point of doing this during the drag: the graph never enters the
    // invalid state, so nothing has to undo it and the user is not told off
    // after the fact.
    const result = canConnect(chain, { source: 'c', target: 'a' })
    assert.equal(result.valid, false)
    assert.equal(result.reason, 'would_create_cycle')
  })

  it('refuses a long-range cycle, not just an immediate one', () => {
    const long: FlowGraph = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')],
    }
    assert.equal(canConnect(long, { source: 'e', target: 'a' }).reason, 'would_create_cycle')
  })

  it('refuses a self-loop', () => {
    assert.equal(canConnect(chain, { source: 'a', target: 'a' }).reason, 'self_loop')
  })

  it('refuses a duplicate edge', () => {
    assert.equal(canConnect(chain, { source: 'a', target: 'b' }).reason, 'duplicate_edge')
  })

  it('refuses a second edge into an occupied input', () => {
    // A step takes one input; two upstream steps racing to supply it has no
    // meaning in an engine that runs linear chains and branches.
    const withSpare: FlowGraph = { ...chain, nodes: [...chain.nodes, node('spare')] }
    assert.equal(
      canConnect(withSpare, { source: 'spare', target: 'b' }).reason,
      'handle_already_used',
    )
  })

  it('allows two edges out of different branch handles', () => {
    const extra: FlowGraph = { ...branched, nodes: [...branched.nodes, node('third')] }
    assert.deepEqual(
      canConnect(extra, { source: 'split', target: 'third', sourceHandle: 'maybe' }),
      { valid: true },
    )
  })

  it('refuses a node that is not in the graph', () => {
    assert.equal(canConnect(chain, { source: 'ghost', target: 'a' }).reason, 'unknown_node')
  })
})

describe('structure', () => {
  it('finds the single root', () => {
    assert.deepEqual(roots(chain).map((n) => n.id), ['trigger'])
  })

  it('finds nodes nothing connects to', () => {
    const withOrphan: FlowGraph = { ...chain, nodes: [...chain.nodes, node('stray')] }
    assert.deepEqual(orphans(withOrphan).map((n) => n.id), ['stray'])
  })

  it('reports an edge pointing at a deleted node', () => {
    const broken: FlowGraph = { nodes: [node('a')], edges: [edge('a', 'gone')] }
    assert.equal(danglingEdges(broken).length, 1)
  })

  it('orders a chain and refuses a cycle', () => {
    assert.deepEqual(
      topologicalOrder(chain)?.map((n) => n.id),
      ['trigger', 'a', 'b', 'c'],
    )
    const cyclic: FlowGraph = {
      nodes: ['a', 'b'].map((id) => node(id)),
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    assert.equal(topologicalOrder(cyclic), null)
  })

  it('insists a parent appears before its children', () => {
    // React Flow does not throw on this — children just render detached at the
    // wrong coordinates, and neither node looks wrong on its own.
    const wrongOrder: FlowNode[] = [
      { ...node('child'), parentId: 'group' },
      node('group', 'group'),
    ]
    assert.throws(() => assertParentsFirst(wrongOrder), /appears before its parent/)
    assert.doesNotThrow(() => assertParentsFirst([...wrongOrder].reverse()))
  })
})

describe('validation', () => {
  const schemas = { http: { required: ['url'] }, noop: {} }

  it('accepts a complete flow', () => {
    const graph: FlowGraph = {
      nodes: [node('trigger', 'noop'), node('a', 'http', { url: 'https://x.test' })],
      edges: [edge('trigger', 'a')],
    }
    const issues = validate(graph, { schemas })
    assert.deepEqual(issues, [])
    assert.equal(canPublish(issues), true)
  })

  it('blocks publishing on a missing required field', () => {
    const graph: FlowGraph = {
      nodes: [node('trigger', 'noop'), node('a', 'http', { url: '' })],
      edges: [edge('trigger', 'a')],
    }
    const issues = validate(graph, { schemas })
    assert.equal(canPublish(issues), false)
    assert.equal(issues[0]?.code, 'missing_required')
    assert.equal(issues[0]?.nodeId, 'a', 'the issue must point at a node to highlight')
    assert.equal(issues[0]?.field, 'url', 'and at the field, so the panel can focus it')
  })

  it('treats an orphan as a warning, not a blocker', () => {
    // Mid-edit an unconnected node is normal. Blocking on it would make the
    // editor hostile; publishing is where it matters.
    const graph: FlowGraph = {
      nodes: [node('trigger', 'noop'), node('stray', 'noop')],
      edges: [],
    }
    const issues = validate(graph, { schemas })
    const orphanIssue = issues.find((issue) => issue.code === 'orphan')
    assert.equal(orphanIssue?.severity, 'warning')
  })

  it('rejects a reference to a step that does not run first', () => {
    // The subtle one. `later` is real and the field is plausible; only its
    // position in the graph makes the reference wrong.
    const graph: FlowGraph = {
      nodes: [
        node('trigger', 'noop'),
        node('first', 'http', { url: '{{ steps.later.output.id }}' }),
        node('later', 'http', { url: 'https://x.test' }),
      ],
      edges: [edge('trigger', 'first'), edge('first', 'later')],
    }
    const issues = validate(graph, { schemas })
    const issue = issues.find((i) => i.code === 'non_ancestor_reference')
    assert.ok(issue, 'a forward reference must be caught before publishing')
    assert.equal(issue.nodeId, 'first')
    assert.equal(issue.field, 'url')
  })

  it('rejects a reference across a branch', () => {
    // The worst version: it resolves while testing whichever path you took,
    // and is empty in production whenever the other one runs.
    const graph: FlowGraph = {
      nodes: [
        node('trigger', 'noop'),
        node('split', 'noop'),
        node('left', 'http', { url: 'https://x.test' }),
        node('right', 'http', { url: '{{ steps.left.output.id }}' }),
      ],
      edges: [edge('trigger', 'split'), edge('split', 'left', 'yes'), edge('split', 'right', 'no')],
    }
    const issue = validate(graph, { schemas }).find((i) => i.code === 'non_ancestor_reference')
    assert.ok(issue, 'a cross-branch reference is not available at run time')
    assert.equal(issue.nodeId, 'right')
  })

  it('accepts a reference to a genuine ancestor', () => {
    const graph: FlowGraph = {
      nodes: [
        node('trigger', 'noop'),
        node('fetch', 'http', { url: 'https://x.test' }),
        node('use', 'http', { url: '{{ steps.fetch.output.url }}' }),
      ],
      edges: [edge('trigger', 'fetch'), edge('fetch', 'use')],
    }
    assert.equal(canPublish(validate(graph, { schemas })), true)
  })

  it('rejects a step referring to itself', () => {
    const graph: FlowGraph = {
      nodes: [node('trigger', 'noop'), node('a', 'http', { url: '{{ steps.a.output.x }}' })],
      edges: [edge('trigger', 'a')],
    }
    assert.equal(
      validate(graph, { schemas }).find((i) => i.code === 'self_reference')?.nodeId,
      'a',
    )
  })

  it('finds references nested in objects and arrays', () => {
    const graph: FlowGraph = {
      nodes: [
        node('trigger', 'noop'),
        node('a', 'http', {
          url: 'https://x.test',
          headers: { auth: '{{ steps.missing.output.token }}' },
          tags: ['plain', '{{ steps.missing.output.tag }}'],
        }),
      ],
      edges: [edge('trigger', 'a')],
    }
    const found = validate(graph, { schemas }).filter((i) => i.code === 'unknown_reference')
    assert.equal(found.length, 2, 'nested references must be checked too')
    assert.deepEqual(found.map((i) => i.field).sort(), ['headers.auth', 'tags[1]'])
  })

  it('reports a flow with no starting point', () => {
    const graph: FlowGraph = {
      nodes: [node('a', 'noop'), node('b', 'noop')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    const codes = validate(graph, { schemas }).map((i) => i.code)
    assert.ok(codes.includes('cycle'))
  })

  it('does not pile reference errors on top of a cycle', () => {
    // Ancestry is meaningless in a cyclic graph, so reporting both would bury
    // the one problem worth fixing under nonsense.
    const graph: FlowGraph = {
      nodes: [
        node('a', 'http', { url: '{{ steps.b.output.x }}' }),
        node('b', 'http', { url: 'https://x.test' }),
      ],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    const issues = validate(graph, { schemas })
    assert.deepEqual(issues.map((i) => i.code), ['cycle'])
  })

  it('groups issues by node for highlighting', () => {
    const graph: FlowGraph = {
      nodes: [node('trigger', 'noop'), node('a', 'http', { url: '' })],
      edges: [edge('trigger', 'a')],
    }
    const grouped = issuesByNode(validate(graph, { schemas }))
    assert.equal(grouped.get('a')?.length, 1)
  })

  it('extracts step references from an expression', () => {
    assert.deepEqual(referencedSteps('{{ steps.one.x }} and {{steps.two.y}}'), ['one', 'two'])
    assert.deepEqual(referencedSteps('no references here'), [])
    assert.deepEqual(referencedSteps(42), [])
  })
})

describe('where the next step would go', () => {
  it('walks to the end of the chain', () => {
    const graph = {
      nodes: [node('t', 'trigger'), node('a'), node('b')],
      edges: [edge('t', 'a'), edge('a', 'b')],
    }
    assert.equal(chainTail(graph)?.id, 'b')
  })

  it('is the trigger itself on a flow with nothing after it', () => {
    assert.equal(chainTail({ nodes: [node('t', 'trigger')], edges: [] })?.id, 't')
  })

  it('ignores a step dropped in open space', () => {
    // The bug this function exists for. An orphan also has no outgoing edge,
    // so defining the tail that way made one loose node ambiguous — and the
    // editor stopped offering anywhere to drop, permanently, until the orphan
    // was wired up or deleted.
    const graph = {
      nodes: [node('t', 'trigger'), node('a'), node('loose')],
      edges: [edge('t', 'a')],
    }
    assert.equal(chainTail(graph)?.id, 'a', 'the orphan is not on the chain')
  })

  it('ignores several orphans, and one orphan on a bare trigger', () => {
    assert.equal(
      chainTail({ nodes: [node('t', 'trigger'), node('x'), node('y')], edges: [] })?.id,
      't',
    )
  })

  it('has no answer at a branch, which has two ends', () => {
    const graph = {
      nodes: [node('t', 'trigger'), node('b', 'branch'), node('yes'), node('no')],
      edges: [edge('t', 'b'), edge('b', 'yes', 'yes'), edge('b', 'no', 'no')],
    }
    assert.equal(chainTail(graph), null)
  })

  it('has no answer for an empty graph', () => {
    assert.equal(chainTail({ nodes: [], edges: [] }), null)
  })

  it('does not walk forever on a cycle', () => {
    // validate() reports a cycle; this must not hang before it gets the chance.
    const graph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    assert.equal(chainTail(graph), null)
  })
})

describe('which fields a step shows', () => {
  // A Text Classifier needs categories and a Summarization does not. Showing
  // every field for every task makes most of the form noise whatever you are
  // doing — n8n avoids it with a node per task, Zapier by swapping the form
  // when the action changes. One step kind here, so the form decides.
  const ai = SCHEMAS['ai']

  it('hides the classification fields for the other tasks', () => {
    const shown = visibleFields(ai, { task: 'summarize' })
    assert.equal(shown.includes('categories'), false)
    assert.equal(shown.includes('allowMultiple'), false)
    assert.equal(shown.includes('prompt'), true, 'the unconditional ones stay')
  })

  it('shows them for a classification', () => {
    const shown = visibleFields(ai, { task: 'classify' })
    assert.equal(shown.includes('categories'), true)
    assert.equal(shown.includes('noMatch'), true)
  })

  it('uses the first choice when the field has not been set yet', () => {
    // A step dropped on the canvas has no task; the menu will send its first
    // option, so that is the form to show rather than an arbitrary one.
    const shown = visibleFields(ai, {})
    const first = ai?.choices?.['task']?.[0]
    assert.equal(shown.includes('categories'), first === 'classify')
  })

  it('leaves a schema without conditions alone', () => {
    const email = SCHEMAS['email']
    assert.deepEqual(visibleFields(email, {}), email?.fields)
  })
})
