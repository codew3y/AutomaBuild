import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { compileFlow, type CanvasGraph } from '../src/flow.ts'

const at = (x: number) => ({ x, y: 0 })

const graph = (
  nodes: readonly [string, string, Record<string, unknown>?][],
  edges: readonly [string, string][],
): CanvasGraph => ({
  nodes: nodes.map(([id, kind, data], index) => ({
    id,
    kind,
    position: at(index * 100),
    ...(data === undefined ? {} : { data }),
  })),
  edges: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
})

const options = { flowId: 'flow_1', versionId: 'v1' }

const compile = (g: CanvasGraph) => compileFlow(g, options)

describe('compiling a canvas graph into a flow definition', () => {
  test('a linear chain compiles in order', () => {
    const result = compile(
      graph(
        [
          ['t', 'trigger'],
          ['a', 'http', { url: 'https://example.com/a' }],
          ['b', 'http', { url: 'https://example.com/b' }],
        ],
        [
          ['t', 'a'],
          ['a', 'b'],
        ],
      ),
    )

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.flow.nodes.map((n) => n.id), ['t', 'a', 'b'])
    assert.equal(result.flow.id, 'flow_1')
    assert.equal(result.flow.nodes[0]?.kind, 'trigger')
  })

  test('a step is not assumed repeatable', () => {
    const result = compile(
      graph(
        [
          ['t', 'trigger'],
          ['get', 'http', { url: 'https://example.com', method: 'GET' }],
          ['post', 'http', { url: 'https://example.com', method: 'POST' }],
        ],
        [
          ['t', 'get'],
          ['get', 'post'],
        ],
      ),
    )

    assert.equal(result.ok, true)
    if (!result.ok) return
    const byId = new Map(result.flow.nodes.map((n) => [n.id, n]))
    assert.equal(byId.get('get')?.idempotent, true)
    assert.equal(
      byId.get('post')?.idempotent,
      false,
      'a POST must not be marked repeatable — that is how a charge happens twice',
    )
  })

  test('an unmethoded http step is a GET, and repeatable', () => {
    const result = compile(
      graph([['t', 'trigger'], ['h', 'http', { url: 'https://example.com' }]], [['t', 'h']]),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.flow.nodes[1]?.idempotent, true)
  })

  test('the whole node data reaches the config, so a new field needs no compiler change', () => {
    const result = compile(
      graph(
        [['t', 'trigger'], ['e', 'email', { to: 'a@b.c', subject: 'Hi', body: 'Hello' }]],
        [['t', 'e']],
      ),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.flow.nodes[1]?.config?.['body'], 'Hello')
    assert.equal(result.flow.nodes[1]?.config?.['canvasKind'], 'email')
  })

  test('every step kind maps to an executor that exists', () => {
    const result = compile(
      graph(
        [
          ['t', 'trigger'],
          ['h', 'http', { url: 'https://example.com' }],
          ['x', 'transform', { template: '{"ok":true}' }],
          ['e', 'email', { to: 'a@b.c', body: 'hello' }],
        ],
        [
          ['t', 'h'],
          ['h', 'x'],
          ['x', 'e'],
        ],
      ),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.flow.nodes.map((n) => n.kind),
      ['trigger', 'http', 'transform', 'email'],
      'transform and email used to compile to noop; they have real executors now',
    )
    assert.deepEqual(result.warnings, [], 'nothing is a placeholder any more')
  })

  test('an email step with no body will not compile', () => {
    // Refused here as well as at send time: an email with no body reaches a
    // person and says nothing, which is worse than a flow that will not
    // publish.
    const result = compile(
      graph([['t', 'trigger'], ['e', 'email', { to: 'a@b.c' }]], [['t', 'e']]),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.problems.some((p) => /needs a body/.test(p.message)))
  })

  test('an email step with no recipient will not compile', () => {
    const result = compile(
      graph([['t', 'trigger'], ['e', 'email', { body: 'hi' }]], [['t', 'e']]),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.problems.some((p) => /needs a recipient/.test(p.message)))
  })

  test('a transform step with no template will not compile', () => {
    const result = compile(
      graph([['t', 'trigger'], ['x', 'transform', {}]], [['t', 'x']]),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.problems.some((p) => /needs a template/.test(p.message)))
  })

  test('a transform still accepts the old field name', () => {
    const result = compile(
      graph([['t', 'trigger'], ['x', 'transform', { expression: '{"a":1}' }]], [['t', 'x']]),
    )
    assert.equal(result.ok, true)
  })

  test('a well-formed branch compiles, and carries its arms as labelled edges', () => {
    const result = compileFlow(
      {
        nodes: [
          { id: 't', kind: 'trigger', position: at(0) },
          { id: 'b', kind: 'branch', position: at(1), data: { condition: '{{ x }} = premium' } },
          { id: 'y', kind: 'http', position: at(2), data: { url: 'https://example.com/y' } },
          { id: 'n', kind: 'http', position: at(3), data: { url: 'https://example.com/n' } },
          { id: 'join', kind: 'http', position: at(4), data: { url: 'https://example.com/j' } },
        ],
        edges: [
          { id: 'e0', source: 't', target: 'b' },
          { id: 'e1', source: 'b', target: 'y', sourceHandle: 'yes' },
          { id: 'e2', source: 'b', target: 'n', sourceHandle: 'no' },
          { id: 'e3', source: 'y', target: 'join' },
          { id: 'e4', source: 'n', target: 'join' },
        ],
      },
      options,
    )

    assert.equal(result.ok, true)
    if (!result.ok) return

    // Topological: every node appears before anything it leads to.
    const order = new Map(result.flow.nodes.map((node, index) => [node.id, index]))
    for (const edge of result.flow.edges ?? []) {
      assert.ok(
        order.get(edge.from)! < order.get(edge.to)!,
        `${edge.from} must come before ${edge.to}`,
      )
    }

    const arms = (result.flow.edges ?? []).filter((edge) => edge.arm !== undefined)
    assert.deepEqual(arms.map((edge) => edge.arm).sort(), ['no', 'yes'])
  })

  describe('what it refuses to compile', () => {
    test('a branch whose arms are not labelled yes and no', () => {
      // Two plain edges out of a branch is a shape the engine cannot resolve.
      // Far better caught here than as a run that stalls with both arms
      // pending and no way to tell why.
      const result = compile(
        graph(
          [
            ['t', 'trigger'],
            ['b', 'branch', { condition: 'x' }],
            ['yes', 'http', { url: 'https://example.com' }],
            ['no', 'http', { url: 'https://example.com' }],
          ],
          [
            ['t', 'b'],
            ['b', 'yes'],
            ['b', 'no'],
          ],
        ),
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /one "yes" path and one "no" path/.test(p.message)))
    })

    test('a branch with no condition', () => {
      const result = compileFlow(
        {
          nodes: [
            { id: 't', kind: 'trigger', position: at(0) },
            { id: 'b', kind: 'branch', position: at(1) },
            { id: 'y', kind: 'http', position: at(2), data: { url: 'https://example.com' } },
            { id: 'n', kind: 'http', position: at(3), data: { url: 'https://example.com' } },
          ],
          edges: [
            { id: 'e0', source: 't', target: 'b' },
            { id: 'e1', source: 'b', target: 'y', sourceHandle: 'yes' },
            { id: 'e2', source: 'b', target: 'n', sourceHandle: 'no' },
          ],
        },
        options,
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /needs a condition/.test(p.message)))
    })

    test('an ordinary step leading to two places', () => {
      const result = compile(
        graph(
          [
            ['t', 'trigger'],
            ['a', 'http', { url: 'https://example.com' }],
            ['b', 'http', { url: 'https://example.com' }],
          ],
          [
            ['t', 'a'],
            ['t', 'b'],
          ],
        ),
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /Only a branch step may lead/.test(p.message)))
    })

    test('a flow that does not start at a trigger', () => {
      const result = compile(
        graph([['a', 'http', { url: 'https://example.com' }]], []),
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /has to start at a trigger/.test(p.message)))
    })

    test('a step nothing connects to', () => {
      const result = compile(
        graph(
          [
            ['t', 'trigger'],
            ['a', 'http', { url: 'https://example.com' }],
            ['stranded', 'http', { url: 'https://example.com' }],
          ],
          [['t', 'a']],
        ),
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => p.nodeId === 'stranded'))
    })

    test('an http step with no url', () => {
      const result = compile(graph([['t', 'trigger'], ['h', 'http', {}]], [['t', 'h']]))
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => p.nodeId === 'h' && /needs a URL/.test(p.message)))
    })

    test('a cycle below the entry, which leaves the entry looking like a valid start', () => {
      // t -> a -> b -> a. The entry is untargeted, so an entry check alone
      // passes and the walk would loop forever without the seen set.
      const result = compileFlow(
        {
          nodes: [
            { id: 't', kind: 'trigger', position: at(0) },
            { id: 'a', kind: 'http', position: at(1), data: { url: 'https://example.com' } },
            { id: 'b', kind: 'http', position: at(2), data: { url: 'https://example.com' } },
          ],
          edges: [
            { id: 'e1', source: 't', target: 'a' },
            { id: 'e2', source: 'a', target: 'b' },
            { id: 'e3', source: 'b', target: 'a' },
          ],
        },
        options,
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /loops back/.test(p.message)))
    })

    test('a graph that is entirely a cycle, so nothing is an entry', () => {
      const result = compileFlow(
        {
          nodes: [
            { id: 'a', kind: 'http', position: at(0), data: { url: 'https://example.com' } },
            { id: 'b', kind: 'http', position: at(1), data: { url: 'https://example.com' } },
          ],
          edges: [
            { id: 'e1', source: 'a', target: 'b' },
            { id: 'e2', source: 'b', target: 'a' },
          ],
        },
        options,
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /no beginning/.test(p.message)))
    })

    test('an edge pointing at a step that is not there', () => {
      const result = compileFlow(
        {
          nodes: [{ id: 't', kind: 'trigger', position: at(0) }],
          edges: [{ id: 'e1', source: 't', target: 'ghost' }],
        },
        options,
      )
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.ok(result.problems.some((p) => /does not exist/.test(p.message)))
    })

    test('an empty flow', () => {
      const result = compileFlow({ nodes: [], edges: [] }, options)
      assert.equal(result.ok, false)
    })
  })

  test('reports every problem, not just the first', () => {
    const result = compile(
      graph(
        [
          ['t', 'trigger'],
          ['h', 'http', {}],
          ['stranded', 'http', { url: 'https://example.com' }],
        ],
        [['t', 'h']],
      ),
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.problems.length >= 2, 'someone fixing a flow wants the list')
  })
})
