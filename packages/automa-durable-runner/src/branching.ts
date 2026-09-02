/**
 * Which steps a branch leaves behind.
 *
 * The engine executes steps in topological order, and every node of a flow
 * becomes a pending row when the run is created. A branch does not change that
 * — it decides which of the pending rows will never run, and those have to be
 * marked, because a step left `pending` in a finished run is indistinguishable
 * from one the run simply has not reached yet.
 *
 * The rule that makes this correct is narrower than it first looks. It is not
 * "everything downstream of the untaken edge": a branch whose two arms rejoin
 * has steps after the join that must still run, and skipping them because they
 * are downstream of the untaken arm would silently drop the rest of the flow.
 *
 * The rule is: skip what is reachable from the untaken arm and *not* reachable
 * from the taken one. A join point is reachable from both, so it survives.
 */

export interface FlowEdge {
  readonly from: string
  readonly to: string
  /**
   * Which arm of a branch this edge is.
   *
   * Absent on an ordinary edge. A branch node is expected to have exactly one
   * edge labelled `yes` and one labelled `no`; anything else is a flow the
   * compiler should have refused.
   */
  readonly arm?: 'yes' | 'no'
}

/** Everything reachable from a starting set, following edges forwards. */
export function reachableFrom(edges: readonly FlowEdge[], from: readonly string[]): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from)
    if (list === undefined) outgoing.set(edge.from, [edge.to])
    else list.push(edge.to)
  }

  const seen = new Set<string>()
  const queue = [...from]

  while (queue.length > 0) {
    const node = queue.pop()!
    if (seen.has(node)) continue
    seen.add(node)
    // A cycle would loop forever without the seen check above. The compiler
    // refuses cycles, but this must not be the thing that depends on it.
    for (const next of outgoing.get(node) ?? []) queue.push(next)
  }

  return seen
}

/**
 * The node ids to mark skipped after a branch resolves.
 *
 * `taken` is the arm the condition selected. Anything reachable only through
 * the other arm never runs.
 */
export function stepsToSkip(
  edges: readonly FlowEdge[],
  branchNodeId: string,
  taken: 'yes' | 'no',
): string[] {
  const arms = edges.filter((edge) => edge.from === branchNodeId && edge.arm !== undefined)

  const takenHeads = arms.filter((edge) => edge.arm === taken).map((edge) => edge.to)
  const untakenHeads = arms.filter((edge) => edge.arm !== taken).map((edge) => edge.to)

  if (untakenHeads.length === 0) return []

  // Reachability from the taken side has to start at the branch's taken
  // successors, not at the branch itself — starting at the branch would reach
  // both arms and nothing would ever be skipped.
  const kept = reachableFrom(edges, takenHeads)
  const abandoned = reachableFrom(edges, untakenHeads)

  return [...abandoned].filter((node) => !kept.has(node)).sort()
}

/**
 * The condition language, which is deliberately small.
 *
 * A condition is a set of comparisons joined by `and` and `or`:
 *
 *     tier = premium and country is in GB, IE, FR
 *     total >= 100 or flags.vip exists
 *
 * Each comparison is `left op right`, where either side may be a literal and
 * the references have already been substituted by the time this sees them. A
 * bare value with no operator is tested for truthiness.
 *
 * Symbol operators: `=`, `!=`, `>`, `<`, `>=`, `<=`.
 *
 * Word operators, which is what the earlier six were missing. Real conditions
 * are mostly about text — a subject line containing a word, an address ending
 * in a domain, a field being present at all — and none of that can be said
 * with arithmetic. The vocabulary follows Zapier's, because it is the one
 * anyone arriving here will already have in their head:
 *
 *     contains / does not contain
 *     starts with / does not start with
 *     ends with / does not end with
 *     is in / is not in          (right side is a comma-separated list)
 *     exists / does not exist    (no right side)
 *
 * Comparison is case-insensitive for the word operators and exact for `=`,
 * which matches where people's expectations actually sit: `contains` is being
 * asked as a question about meaning, `=` as a question about identity.
 *
 * `and` binds tighter than `or`, as in every language that has both. There is
 * no bracketing — a condition needing brackets has outgrown a single text
 * field, and the honest answer is a second branch rather than a parser.
 *
 * Not an expression language, and not `eval`. A workflow engine that runs
 * user-supplied code needs a sandbox, and a sandbox is a much larger thing to
 * get right than a comparison. The cost is that some conditions cannot be
 * expressed; the benefit is that a flow definition can never be a way to run
 * code on the worker.
 */
export type ConditionResult = { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly reason: string }

const OPERATORS = ['>=', '<=', '!=', '=', '>', '<'] as const

/**
 * Word operators, longest phrase first.
 *
 * Order is load-bearing twice over. `does not contain` must be tried before
 * `contains`, or the negation is read as its own opposite. And `is not in`
 * before `is in`, for the same reason.
 *
 * Each is matched as a whole word with spaces around it, so a value of
 * "containsulfates" is a value and not an operator.
 */
const WORD_OPERATORS = [
  'does not start with',
  'does not contain',
  'does not end with',
  'does not exist',
  'is not in',
  'starts with',
  'ends with',
  'contains',
  'is in',
  'exists',
] as const

type WordOperator = (typeof WORD_OPERATORS)[number]

/** Operators taking no right-hand side. */
const UNARY: readonly string[] = ['exists', 'does not exist']

/** Case-insensitive, because that is what someone asking about text means. */
function fold(value: string): string {
  return unquote(value).toLowerCase()
}

/** `GB, IE, FR` — the right side of `is in`. Empty entries are dropped. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => fold(entry))
    .filter((entry) => entry !== '')
}

const UNRESOLVED = /^\s*\{\{[^}]*\}\}\s*$/

/**
 * Whether a value is actually there, as `exists` means it.
 *
 * An unresolved reference arrives here as the literal `{{ ... }}` text rather
 * than as nothing — that is deliberate elsewhere, so a broken mapping stays
 * visible. Here it has to read as absence, or `exists` answers yes about a
 * field that is not there.
 */
function present(raw: string): boolean {
  const trimmed = unquote(raw)
  if (trimmed === '') return false
  if (UNRESOLVED.test(trimmed)) return false
  return trimmed !== 'null' && trimmed !== 'undefined'
}

function applyWord(op: WordOperator, leftRaw: string, rightRaw: string): ConditionResult {
  const left = fold(leftRaw)
  const right = fold(rightRaw)

  switch (op) {
    case 'contains':
      return { ok: true, value: left.includes(right) }
    case 'does not contain':
      return { ok: true, value: !left.includes(right) }
    case 'starts with':
      return { ok: true, value: left.startsWith(right) }
    case 'does not start with':
      return { ok: true, value: !left.startsWith(right) }
    case 'ends with':
      return { ok: true, value: left.endsWith(right) }
    case 'does not end with':
      return { ok: true, value: !left.endsWith(right) }
    case 'is in':
      return { ok: true, value: splitList(rightRaw).includes(left) }
    case 'is not in':
      return { ok: true, value: !splitList(rightRaw).includes(left) }
    case 'exists':
      return { ok: true, value: present(leftRaw) }
    case 'does not exist':
      return { ok: true, value: !present(leftRaw) }
  }
}

/**
 * Find a word operator in a comparison.
 *
 * Matched against a lower-cased copy so `Contains` works, but the operands are
 * sliced out of the original — lower-casing the value someone is comparing
 * against would be a surprising thing for the parser to do on their behalf.
 *
 * The returned offset is into the original string: the haystack is padded with
 * one leading space, and the match includes the operator's own leading space,
 * so the two cancel.
 */
function findWordOperator(source: string): { op: WordOperator; at: number } | null {
  const haystack = ' ' + source.toLowerCase() + ' '
  for (const op of WORD_OPERATORS) {
    const at = haystack.indexOf(' ' + op + ' ')
    if (at !== -1) return { op, at }
  }
  return null
}

/**
 * Split on a joining word, at the top level.
 *
 * `and` and `or` are ordinary words, so the split has to skip any that fall
 * inside quotes — `subject contains "fish and chips"` is one comparison, not
 * two. Nothing else nests, which is why tracking the quote character is enough
 * and a real tokeniser is not.
 *
 * Returns null when the word does not appear, so the caller can tell "one
 * comparison" from "a join with one empty side".
 */
function splitJoined(source: string, word: 'and' | 'or'): string[] | null {
  const needle = ' ' + word + ' '
  const lower = source.toLowerCase()
  const parts: string[] = []

  let start = 0
  let quote: string | null = null

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (lower.startsWith(needle, i)) {
      parts.push(source.slice(start, i))
      i += needle.length - 1
      start = i + 1
    }
  }

  if (parts.length === 0) return null
  parts.push(source.slice(start))
  return parts
}

/** Strip one layer of matching quotes, so `"premium"` compares as `premium`. */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  const first = trimmed[0]
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Truthiness, in the terms a flow author would expect rather than JavaScript's. */
function truthy(raw: string): boolean {
  const value = unquote(raw).toLowerCase()
  // "false" and "0" are the two that JavaScript would call true as strings,
  // and that anyone writing a condition means as false.
  return value !== '' && value !== 'false' && value !== '0' && value !== 'null' && value !== 'undefined'
}

export function evaluateCondition(condition: string): ConditionResult {
  const source = condition.trim()
  if (source === '') return { ok: false, reason: 'the condition is empty' }

  // `or` is split first so it ends up outermost, and therefore binds loosest.
  const alternatives = splitJoined(source, 'or')
  if (alternatives !== null) {
    let value = false
    for (const part of alternatives) {
      const result = evaluateCondition(part)
      // A broken sub-condition fails the whole thing rather than counting as
      // false. "The condition was not met" and "the condition could not be
      // read" are different answers, and collapsing them hides a typo behind a
      // branch that quietly always goes the same way.
      if (!result.ok) return result
      if (result.value) value = true
    }
    return { ok: true, value }
  }

  const conjuncts = splitJoined(source, 'and')
  if (conjuncts !== null) {
    let value = true
    for (const part of conjuncts) {
      const result = evaluateCondition(part)
      if (!result.ok) return result
      if (!result.value) value = false
    }
    return { ok: true, value }
  }

  // Word operators before symbols. The two never compete for the same text —
  // `country is in GB, IE` holds no symbol, `a >= b` holds no word — but the
  // order still has to be fixed, and words first means a quoted value
  // containing `>` is not mistaken for a comparison.
  const word = findWordOperator(source)
  if (word !== null) {
    const left = source.slice(0, word.at)
    const right = source.slice(word.at + word.op.length + 1)
    if (UNARY.includes(word.op) && right.trim() !== '') {
      return {
        ok: false,
        reason: word.op + ' takes nothing after it, but found ' + JSON.stringify(right.trim()),
      }
    }
    return applyWord(word.op, left, right)
  }

  for (const op of OPERATORS) {
    // `=` must not match the `=` inside `>=`, which is why the operator list
    // is ordered longest-first and `indexOf` is used rather than a split.
    const at = source.indexOf(op)
    if (at === -1) continue

    const left = unquote(source.slice(0, at))
    const right = unquote(source.slice(at + op.length))

    if (op === '=') return { ok: true, value: left === right }
    if (op === '!=') return { ok: true, value: left !== right }

    const a = Number(left)
    const b = Number(right)
    if (Number.isNaN(a) || Number.isNaN(b)) {
      return {
        ok: false,
        reason: `cannot compare ${JSON.stringify(left)} ${op} ${JSON.stringify(right)} as numbers`,
      }
    }

    if (op === '>') return { ok: true, value: a > b }
    if (op === '<') return { ok: true, value: a < b }
    if (op === '>=') return { ok: true, value: a >= b }
    return { ok: true, value: a <= b }
  }

  // No operator: the whole thing is a value, and the question is whether it is
  // set. `{{ steps.x.output.premium }}` reads naturally this way.
  return { ok: true, value: truthy(source) }
}
