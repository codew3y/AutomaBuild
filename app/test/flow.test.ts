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

  test('a step with no executor is recorded but warns rather than silently doing nothing', () => {
    const result = compile(
      graph([['t', 'trigger'], ['e', 'email', { to: 'a@b.c', body: 'x' }]], [['t', 'e']]),
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0]?.nodeId, 'e')
    assert.match(result.warnings[0]!.message, /does nothing yet/)
  })

  describe('what it refuses to compile', () => {
    test('a branch, because the engine runs one chain', () => {
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
      assert.ok(result.problems.some((p) => /branches are not supported/.test(p.message)))
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
