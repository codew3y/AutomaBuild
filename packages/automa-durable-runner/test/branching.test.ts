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

describe('the word operators', () => {
  const yes = (condition: string) => {
    const result = evaluateCondition(condition)
    assert.equal(result.ok, true, `${condition} did not evaluate`)
    assert.equal(result.ok && result.value, true, `${condition} was false`)
  }

  const no = (condition: string) => {
    const result = evaluateCondition(condition)
    assert.equal(result.ok, true, `${condition} did not evaluate`)
    assert.equal(result.ok && result.value, false, `${condition} was true`)
  }

  it('asks about text, which arithmetic could not', () => {
    yes('Order confirmed contains confirm')
    no('Order confirmed contains refund')
    yes('ada@example.com ends with @example.com')
    no('ada@example.com ends with @other.com')
    yes('INV-2024-01 starts with INV-')
    no('INV-2024-01 starts with PO-')
  })

  it('is case-insensitive, because that is what asking about text means', () => {
    yes('Order Confirmed CONTAINS confirmed')
    yes('ADA@EXAMPLE.COM ends with @example.com')
  })

  it('negates without reading as its own opposite', () => {
    // `does not contain` has to be found before `contains`, or the parser
    // matches the tail of the phrase and inverts the answer.
    no('Order confirmed does not contain confirm')
    yes('Order confirmed does not contain refund')
    yes('ada@example.com does not end with @other.com')
    yes('INV-1 does not start with PO-')
  })

  it('tests membership against a list', () => {
    yes('GB is in GB, IE, FR')
    yes('gb is in GB, IE, FR')
    no('US is in GB, IE, FR')
    yes('US is not in GB, IE, FR')
    // `is not in` before `is in`, same reason as the negations above.
    no('GB is not in GB, IE, FR')
  })

  it('answers whether a field is there at all', () => {
    yes('ada@example.com exists')
    no(' exists')
    no('"" exists')
    yes('"" does not exist')

    // The one case worth being careful about. An unresolved reference reaches
    // the evaluator as its own literal text, so that a broken mapping stays
    // visible everywhere else. `exists` is the one place that has to read it
    // as absence instead.
    no('{{ steps.lookup.output.email }} exists')
    yes('{{ steps.lookup.output.email }} does not exist')
  })

  it('refuses a value after an operator that takes none', () => {
    const result = evaluateCondition('email exists something')
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /takes nothing after it/)
  })

  it('does not mistake a word inside a value for an operator', () => {
    // "containsulfates" contains "contains", but not as a word.
    yes('containsulfates = containsulfates')
  })
})

describe('joining conditions', () => {
  const value = (condition: string) => {
    const result = evaluateCondition(condition)
    assert.equal(result.ok, true, `${condition} did not evaluate`)
    return result.ok && result.value
  }

  it('joins with and', () => {
    assert.equal(value('premium = premium and 100 >= 50'), true)
    assert.equal(value('premium = premium and 10 >= 50'), false)
    assert.equal(value('basic = premium and 100 >= 50'), false)
  })

  it('joins with or', () => {
    assert.equal(value('basic = premium or 100 >= 50'), true)
    assert.equal(value('basic = premium or 10 >= 50'), false)
  })

  it('binds and tighter than or, as every language with both does', () => {
    // Read as `false or (true and true)`. Splitting on `and` first would give
    // `(false or true) and true`, which is the same here — so the case that
    // actually distinguishes them:
    //   false and false or true  ->  (false and false) or true  ->  true
    assert.equal(value('a = b and c = d or e = e'), true)
    //   true or false and false  ->  true or (false and false) ->  true
    assert.equal(value('e = e or a = b and c = d'), true)
    //   true and false or false  ->  (true and false) or false ->  false
    assert.equal(value('e = e and a = b or c = d'), false)
  })

  it('does not split a join word out of a quoted value', () => {
    // Two comparisons would be `subject contains "fish` and `chips"`, and the
    // first of those is a different question with a different answer.
    assert.equal(value('"fish and chips" contains "and"'), true)
    assert.equal(value('"fish and chips" = "fish and chips"'), true)
  })

  it('fails the whole condition when one part cannot be read', () => {
    // Not "false". A typo that silently makes a branch always go one way is
    // the failure mode this exists to prevent.
    const result = evaluateCondition('premium = premium and abc > def')
    assert.equal(result.ok, false)
  })

  it('combines words and symbols', () => {
    assert.equal(value('ada@example.com ends with @example.com and 100 >= 50'), true)
    assert.equal(value('GB is in GB, IE and tier = tier'), true)
  })
})
