/**
 * The branch step.
 *
 * It evaluates one condition and reports which way it went. It makes no
 * external call and produces no data of its own beyond that decision — the
 * engine reads `taken` and marks the abandoned arm's steps skipped.
 *
 * The condition's `{{ }}` references are resolved before this runs, by the
 * ordinary mapping wrapper, so what arrives here is a comparison between
 * literal values: `premium = premium`, not `{{ steps.fetch.output.tier }} =
 * premium`. That ordering is what keeps the condition language from ever
 * needing to know about the flow.
 */

import { StepFailure, evaluateCondition, type StepHandler } from 'automa-durable-runner'

export function branchHandler(): StepHandler {
  return async (context) => {
    const condition = String((context.node.config ?? {})['condition'] ?? '')

    const result = evaluateCondition(condition)
    if (!result.ok) {
      // Deterministic: the same condition will fail the same way on every
      // retry, and burning five attempts to rediscover that helps nobody.
      throw new StepFailure(`cannot evaluate the condition: ${result.reason}`, {
        deterministicallyBroken: true,
      })
    }

    return {
      output: {
        taken: result.value ? 'yes' : 'no',
        // The resolved condition, kept so the run viewer can show *why* the
        // branch went the way it did. "It took the no path" is not an answer
        // anyone can act on; "basic = premium" is.
        condition,
      },
    }
  }
}
