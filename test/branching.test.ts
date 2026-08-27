import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCondition, reachableFrom, stepsToSkip, type FlowEdge } from '../src/branching.ts'

const edge = (from: string, to: string, arm?: 'yes' | 'no'): FlowEdge =>
  arm === undefined ? { from, to } : { from, to, arm }

describe('what a branch leaves behind', () => {
  it('skips the arm that was not taken', () => {
    //        ┌── yes ── send
    // t ── b ┤
    //        └── no ─── log
    const edges = [
      edge('t', 'b'),
      edge('b', 'send', 'yes'),
      edge('b', 'log', 'no'),
    ]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['log'])
    assert.deepEqual(stepsToSkip(edges, 'b', 'no'), ['send'])
  })

  it('skips everything further down the abandoned arm, not just its first step', () => {
    const edges = [
      edge('b', 'a1', 'yes'),
      edge('b', 'b1', 'no'),
      edge('b1', 'b2'),
      edge('b2', 'b3'),
    ]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['b1', 'b2', 'b3'])
  })

  it('keeps a step where the two arms rejoin', () => {
    // The rule that is easy to get wrong. `finish` is downstream of the arm
    // that was not taken, but it is also downstream of the one that was, so
    // skipping it would silently drop the rest of the flow.
    //        ┌── yes ── a ──┐
    // b ─────┤              ├── finish
    //        └── no ─── c ──┘
    const edges = [
      edge('b', 'a', 'yes'),
      edge('b', 'c', 'no'),
      edge('a', 'finish'),
      edge('c', 'finish'),
    ]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['c'])
    assert.deepEqual(stepsToSkip(edges, 'b', 'no'), ['a'])
  })

  it('keeps everything after a join, however deep', () => {
    const edges = [
      edge('b', 'a', 'yes'),
      edge('b', 'c', 'no'),
      edge('a', 'join'),
      edge('c', 'join'),
      edge('join', 'then'),
      edge('then', 'last'),
    ]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['c'])
  })

  it('handles a branch inside a branch', () => {
    const edges = [
      edge('outer', 'inner', 'yes'),
      edge('outer', 'other', 'no'),
      edge('inner', 'x', 'yes'),
      edge('inner', 'y', 'no'),
    ]
    // Taking the outer 'no' abandons the whole inner branch and both its arms.
    assert.deepEqual(stepsToSkip(edges, 'outer', 'no'), ['inner', 'x', 'y'])
  })

  it('skips nothing when the branch has only one arm', () => {
    const edges = [edge('b', 'only', 'yes')]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), [])
  })

  it('does not loop forever on a cycle', () => {
    // The compiler refuses cycles, but this must not be the thing relying on
    // that: a hang is a far worse failure than a wrong answer.
    const edges = [
      edge('b', 'a', 'yes'),
      edge('b', 'c', 'no'),
      edge('c', 'd'),
      edge('d', 'c'),
    ]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['c', 'd'])
  })

  it('ignores unlabelled edges out of the branch', () => {
    // A branch with a plain edge as well as arms is a malformed flow. It must
    // not cause the arms to be mis-resolved.
    const edges = [edge('b', 'stray'), edge('b', 'a', 'yes'), edge('b', 'c', 'no')]
    assert.deepEqual(stepsToSkip(edges, 'b', 'yes'), ['c'])
  })
})

describe('reachability', () => {
  it('follows edges forwards only', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')]
    assert.deepEqual([...reachableFrom(edges, ['b'])].sort(), ['b', 'c'])
  })

  it('includes the starting nodes themselves', () => {
    assert.deepEqual([...reachableFrom([], ['solo'])], ['solo'])
  })
})

describe('the condition language', () => {
  const value = (condition: string) => {
    const result = evaluateCondition(condition)
    assert.equal(result.ok, true, `expected ${condition} to evaluate`)
    return result.ok ? result.value : null
  }

  it('compares strings for equality, quoted or not', () => {
    assert.equal(value('premium = premium'), true)
    assert.equal(value('"premium" = "premium"'), true)
    assert.equal(value("'premium' = premium"), true)
    assert.equal(value('basic = "premium"'), false)
  })

  it('handles inequality', () => {
    assert.equal(value('basic != premium'), true)
    assert.equal(value('premium != premium'), false)
  })

  it('compares numbers', () => {
    assert.equal(value('4200 > 1000'), true)
    assert.equal(value('4200 < 1000'), false)
    assert.equal(value('10 >= 10'), true)
    assert.equal(value('9 <= 10'), true)
  })

  it('does not confuse >= with =', () => {
    // The reason the operator list is ordered longest-first: matching `=`
    // inside `>=` would compare "4200 >" against "10".
    assert.equal(value('10 >= 10'), true)
    assert.equal(value('9 >= 10'), false)
  })

  it('refuses to compare non-numbers with a numeric operator', () => {
    const result = evaluateCondition('premium > basic')
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /as numbers/)
  })

  it('treats a bare value as a question of whether it is set', () => {
    assert.equal(value('premium'), true)
    assert.equal(value('true'), true)
    assert.equal(value('""'), false)
  })

  it('reads false and zero as false, the way a flow author means them', () => {
    // JavaScript would call the strings "false" and "0" truthy, which is not
    // what anyone writing a condition intends.
    assert.equal(value('false'), false)
    assert.equal(value('0'), false)
    assert.equal(value('null'), false)
    assert.equal(value('undefined'), false)
  })

  it('rejects an empty condition rather than guessing', () => {
    assert.equal(evaluateCondition('   ').ok, false)
  })

  it('is not an expression language, and cannot be made to run code', () => {
    // No operator, so this is a truthiness test on a literal string. What it
    // must not be is evaluated.
    assert.equal(value('process.exit(1)'), true)
    assert.equal(value('1 = 1; process.exit(1)'), false)
  })
})
