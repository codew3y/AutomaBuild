/**
 * The store layer: undo semantics and autosave.
 *
 * Zustand's vanilla store works outside React, so all of this is testable with
 * no renderer and no browser — which matters, because the interesting
 * behaviour here is *semantics* (what counts as one undo step) rather than
 * anything visual.
 *
 * Time is injected everywhere, so throttling and debouncing are assertions
 * rather than waits.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGraphStore } from '../src/store/graph-store.ts'
import {
  applyPatch,
  createAutosave,
  diffGraph,
  type PatchOp,
  type SaveState,
} from '../src/core/patch.ts'
import type { FlowGraph, FlowNode } from '../src/core/graph.ts'

const node = (id: string, x = 0, y = 0): FlowNode => ({
  id,
  kind: 'http',
  position: { x, y },
  data: {},
})

/** A clock the test moves by hand. */
function fakeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

describe('undo semantics', () => {
  it('undoes and redoes a node addition', () => {
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now })

    clock.advance(1000)
    store.getState().addNode(node('a'))
    assert.equal(store.getState().nodes.length, 1)

    store.temporal.getState().undo()
    assert.equal(store.getState().nodes.length, 0)

    store.temporal.getState().redo()
    assert.equal(store.getState().nodes.length, 1)
  })

  it('coalesces a drag into a single undo step', () => {
    // The behaviour the throttle exists for. React Flow emits a position
    // change on every pointer move, so a drag is dozens of updates. Without
    // coalescing, ctrl-Z rewinds it one pixel at a time and reads as broken.
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 300 })

    clock.advance(1000)
    store.getState().addNode(node('a'))
    const afterAdd = store.temporal.getState().pastStates.length

    // Forty pointer moves over 200 ms — one gesture.
    for (let i = 1; i <= 40; i++) {
      clock.advance(5)
      store.getState().moveNode('a', { x: i * 5, y: 0 })
    }

    const recorded = store.temporal.getState().pastStates.length - afterAdd
    assert.ok(recorded <= 1, `a single drag produced ${recorded} undo entries`)

    store.temporal.getState().undo()
    // One undo takes the node back to where the drag began, not one pixel.
    assert.equal(store.getState().nodes[0]?.position.x, 0)
  })

  it('starts a new undo entry for a second drag after the gesture ends', () => {
    // Two drags 100 ms apart are two gestures. Only the UI knows where one
    // ended, so it says so on pointer-up.
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 300 })

    clock.advance(1000)
    store.getState().addNode(node('a'))

    clock.advance(10)
    store.getState().moveNode('a', { x: 10, y: 0 })
    clock.advance(10)
    store.getState().moveNode('a', { x: 20, y: 0 })
    store.endGesture()

    const afterFirstDrag = store.temporal.getState().pastStates.length
    clock.advance(100)
    store.getState().moveNode('a', { x: 30, y: 0 })

    assert.equal(
      store.temporal.getState().pastStates.length,
      afterFirstDrag + 1,
      'the second drag should be its own undo entry',
    )
    store.temporal.getState().undo()
    assert.equal(store.getState().nodes[0]?.position.x, 20, 'back to where the second drag began')
  })

  it('keeps two deliberate edits as separate steps', () => {
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 300 })

    clock.advance(1000)
    store.getState().addNode(node('a'))
    clock.advance(1000)
    store.getState().addNode(node('b'))
    clock.advance(1000)
    store.getState().addNode(node('c'))

    assert.equal(store.getState().nodes.length, 3)
    store.temporal.getState().undo()
    assert.equal(store.getState().nodes.length, 2)
    store.temporal.getState().undo()
    assert.equal(store.getState().nodes.length, 1)
  })

  it('stays correct across twenty mixed operations', () => {
    // The exit criterion. Adds, connects, moves and deletes interleaved, then
    // wound all the way back.
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 0 })
    const state = () => store.getState()

    const applied: Array<() => void> = []
    for (let i = 0; i < 5; i++) applied.push(() => state().addNode(node(`n${i}`, i * 100, 0)))
    for (let i = 0; i < 4; i++) {
      applied.push(() => {
        state().connect({ source: `n${i}`, target: `n${i + 1}` })
      })
    }
    for (let i = 0; i < 5; i++) applied.push(() => state().moveNode(`n${i}`, { x: i * 50, y: 40 }))
    for (let i = 0; i < 3; i++) {
      applied.push(() => state().updateNodeData(`n${i}`, { url: `https://x${i}.test` }))
    }
    applied.push(() => state().removeEdge('n0->n1'))
    applied.push(() => state().removeNode('n4'))
    applied.push(() => state().addNode(node('extra', 900, 0)))

    for (const step of applied) {
      clock.advance(1000)
      step()
    }

    assert.equal(state().nodes.length, 5, 'five original minus one removed plus one extra')
    const depth = store.temporal.getState().pastStates.length

    for (let i = 0; i < depth; i++) store.temporal.getState().undo()
    assert.deepEqual(state().nodes, [], 'twenty undos should return to empty')

    for (let i = 0; i < depth; i++) store.temporal.getState().redo()
    assert.equal(state().nodes.length, 5, 'and redo should put it all back')
  })

  it('deletes a node together with its edges, as one step', () => {
    // Otherwise undoing the deletion restores an isolated node and the edges
    // have to come from somewhere.
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 0 })
    const state = () => store.getState()

    clock.advance(1000)
    state().addNode(node('a'))
    clock.advance(1000)
    state().addNode(node('b'))
    clock.advance(1000)
    state().connect({ source: 'a', target: 'b' })
    assert.equal(state().edges.length, 1)

    clock.advance(1000)
    state().removeNode('b')
    assert.equal(state().edges.length, 0, 'the edge must go with the node')

    store.temporal.getState().undo()
    assert.equal(state().nodes.length, 2)
    assert.equal(state().edges.length, 1, 'and come back with it')
  })

  it('refuses a connection that would create a cycle, and records nothing', () => {
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 0 })
    const state = () => store.getState()

    for (const id of ['a', 'b', 'c']) {
      clock.advance(1000)
      state().addNode(node(id))
    }
    clock.advance(1000)
    state().connect({ source: 'a', target: 'b' })
    clock.advance(1000)
    state().connect({ source: 'b', target: 'c' })

    const depthBefore = store.temporal.getState().pastStates.length
    clock.advance(1000)
    const result = state().connect({ source: 'c', target: 'a' })

    assert.equal(result.valid, false)
    assert.equal(result.reason, 'would_create_cycle')
    assert.equal(state().edges.length, 2, 'the edge must not have been added')
    assert.equal(
      store.temporal.getState().pastStates.length,
      depthBefore,
      'a refused connection is not an undoable event',
    )
  })

  it('does not put the viewport in the undo stack', () => {
    // partialize keeps it out. If it were in, panning would be undoable and
    // ctrl-Z after a pan would scroll the canvas instead of undoing the edit
    // the user actually wants back.
    const clock = fakeClock()
    const store = createGraphStore({ now: clock.now, coalesceMs: 0 })

    clock.advance(1000)
    store.getState().addNode(node('a'))

    const recorded = store.temporal.getState().pastStates[0]
    assert.ok(recorded)
    assert.deepEqual(
      Object.keys(recorded).sort(),
      ['edges', 'nodes'],
      'only the graph belongs in history',
    )
  })
})

describe('patches', () => {
  const base: FlowGraph = {
    nodes: [node('a'), node('b')],
    edges: [{ id: 'a->b', source: 'a', target: 'b' }],
  }

  it('reports nothing when nothing changed', () => {
    assert.deepEqual(diffGraph(base, { ...base }), [])
  })

  it('describes an added node as one operation', () => {
    const after: FlowGraph = { ...base, nodes: [...base.nodes, node('c')] }
    const ops = diffGraph(base, after)
    assert.equal(ops.length, 1)
    assert.equal(ops[0]?.op, 'add')
    assert.equal(ops[0]?.path, '/nodes/c')
  })

  it('is unaffected by reordering', () => {
    // A general differ working on array indices would rewrite everything when
    // a node is brought to the front, which the canvas does on selection.
    const reordered: FlowGraph = { ...base, nodes: [...base.nodes].reverse() }
    assert.deepEqual(diffGraph(base, reordered), [])
  })

  it('produces one operation for an insertion at the front', () => {
    const after: FlowGraph = { ...base, nodes: [node('z'), ...base.nodes] }
    assert.equal(diffGraph(base, after).length, 1)
  })

  it('describes a move and a data change as replacements', () => {
    const moved: FlowGraph = {
      ...base,
      nodes: [{ ...base.nodes[0]!, position: { x: 50, y: 60 } }, base.nodes[1]!],
    }
    assert.equal(diffGraph(base, moved)[0]?.op, 'replace')

    const edited: FlowGraph = {
      ...base,
      nodes: [{ ...base.nodes[0]!, data: { url: 'https://x.test' } }, base.nodes[1]!],
    }
    assert.equal(diffGraph(base, edited)[0]?.op, 'replace')
  })

  it('round-trips: applying a patch reproduces the target', () => {
    const after: FlowGraph = {
      nodes: [node('a', 10, 10), node('c')],
      edges: [{ id: 'a->c', source: 'a', target: 'c' }],
    }
    const rebuilt = applyPatch(base, diffGraph(base, after))
    assert.deepEqual(
      rebuilt.nodes.map((n) => n.id).sort(),
      after.nodes.map((n) => n.id).sort(),
    )
    assert.deepEqual(rebuilt.edges.map((e) => e.id), ['a->c'])
    assert.equal(rebuilt.nodes.find((n) => n.id === 'a')?.position.x, 10)
  })

  it('escapes ids containing slashes', () => {
    const odd: FlowGraph = { nodes: [node('a/b~c')], edges: [] }
    const ops = diffGraph({ nodes: [], edges: [] }, odd)
    assert.equal(ops[0]?.path, '/nodes/a~1b~0c')
    const rebuilt = applyPatch({ nodes: [], edges: [] }, ops)
    assert.equal(rebuilt.nodes[0]?.id, 'a/b~c')
  })
})

describe('autosave', () => {
  /** A controllable timer, so the debounce is asserted rather than waited on. */
  function manualTimers() {
    let queued: (() => void) | null = null
    return {
      setTimer: (fn: () => void) => {
        queued = fn
        return 1
      },
      clearTimer: () => {
        queued = null
      },
      fire() {
        const fn = queued
        queued = null
        fn?.()
      },
      get armed() {
        return queued !== null
      },
    }
  }

  const graphWith = (...ids: string[]): FlowGraph => ({ nodes: ids.map((id) => node(id)), edges: [] })

  it('debounces: many changes produce one save', async () => {
    const timers = manualTimers()
    const sent: PatchOp[][] = []
    const autosave = createAutosave({
      save: async (ops) => {
        sent.push([...ops])
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.schedule(graphWith('a'))
    autosave.schedule(graphWith('a', 'b'))
    autosave.schedule(graphWith('a', 'b', 'c'))
    assert.equal(sent.length, 0, 'nothing should have gone out yet')

    timers.fire()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(sent.length, 1, 'three edits, one request')
    assert.equal(sent[0]?.length, 3, 'carrying all three nodes')
  })

  it('reports saved, saving, unsaved in that order', async () => {
    const timers = manualTimers()
    const states: SaveState[] = []
    const autosave = createAutosave({
      save: async () => {},
      onStateChange: (state) => states.push(state),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.schedule(graphWith('a'))
    assert.deepEqual(states, ['unsaved'])

    timers.fire()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(states, ['unsaved', 'saving', 'saved'])
  })

  it('flushes immediately, for blur and tab hide', async () => {
    // A debounce alone loses the last edit when someone closes the tab within
    // 800 ms of typing it — which is exactly when people close tabs.
    const timers = manualTimers()
    let saves = 0
    const autosave = createAutosave({
      save: async () => {
        saves++
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.schedule(graphWith('a'))
    await autosave.flush()

    assert.equal(saves, 1)
    assert.equal(timers.armed, false, 'the pending timer should have been cancelled')
  })

  it('sends a delta against the last acknowledged state, not the whole graph', async () => {
    const timers = manualTimers()
    const sent: PatchOp[][] = []
    const autosave = createAutosave({
      save: async (ops) => {
        sent.push([...ops])
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.schedule(graphWith('a', 'b'))
    await autosave.flush()
    autosave.schedule(graphWith('a', 'b', 'c'))
    await autosave.flush()

    assert.equal(sent[0]?.length, 2)
    assert.equal(sent[1]?.length, 1, 'the second save should carry only the new node')
    assert.equal(sent[1]?.[0]?.path, '/nodes/c')
  })

  it('does not advance the base when a save fails', async () => {
    // The failure that loses work silently. If the base advanced on send, the
    // next patch would be computed against a state the server never received,
    // and the difference would be gone with nothing to indicate it.
    const timers = manualTimers()
    const sent: PatchOp[][] = []
    let failNext = true
    const autosave = createAutosave({
      save: async (ops) => {
        sent.push([...ops])
        if (failNext) {
          failNext = false
          throw new Error('network')
        }
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.schedule(graphWith('a'))
    await assert.rejects(() => autosave.flush())
    assert.equal(autosave.state, 'unsaved')

    // The retry must still carry the first node, not just anything after it.
    autosave.schedule(graphWith('a', 'b'))
    await autosave.flush()

    const paths = sent[1]!.map((op) => op.path).sort()
    assert.deepEqual(paths, ['/nodes/a', '/nodes/b'], 'the failed change was dropped')
  })

  it('sends nothing when the graph is unchanged', async () => {
    const timers = manualTimers()
    let saves = 0
    const autosave = createAutosave({
      save: async () => {
        saves++
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    autosave.reset(graphWith('a'))
    autosave.schedule(graphWith('a'))
    await autosave.flush()
    assert.equal(saves, 0, 'a pointer moving over the canvas is not an edit')
    assert.equal(autosave.state, 'saved')
  })
})
