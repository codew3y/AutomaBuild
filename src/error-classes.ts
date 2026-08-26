/**
 * The error classification table.
 *
 * Every failure the engine sees maps to exactly one class, and the class — not
 * the original error — decides what happens next. Two axes, deliberately
 * independent, because conflating them is how retry budgets get destroyed:
 *
 *   retryable            may this be attempted again at all?
 *   consumesAttempt      does this attempt count against maxAttempts?
 *
 * `rate_limited` is the row that shows why they must be separate. It is
 * retryable, but it must NOT consume an attempt: a provider having a busy
 * afternoon would otherwise exhaust a step's five attempts without a single
 * real error having occurred.
 *
 * `unknown_outcome` is the row most engines omit, and omitting it is why
 * people receive duplicate invoices. "We sent the request and never saw the
 * response" is not success and not failure. Retrying it is a guess about
 * someone else's system. We stop and ask.
 */

export type ErrorClass =
  | 'transient_network'
  | 'rate_limited'
  | 'auth_expired'
  | 'auth_broken'
  | 'client_error'
  | 'server_error'
  | 'timeout'
  | 'unknown_outcome'
  | 'internal'
  | 'poison'

/**
 * What the engine does with a class once it has one.
 *
 * `conditional` means the decision needs one more fact — whether the connector
 * declares the call idempotent — so it cannot be answered by this table alone.
 */
export type Retryability = 'yes' | 'no' | 'conditional'

export type ErrorAction =
  | 'backoff' // wait and try again
  | 'respect_retry_after' // wait as long as the provider asked, then try again
  | 'refresh_credentials' // refresh the token once, then retry
  | 'fail_run' // terminal; the run stops
  | 'fail_step' // terminal for this step; an error handler may take over
  | 'pause_for_confirmation' // a human decides whether it already happened
  | 'dead_letter' // straight to the DLQ, no retry

export interface ErrorClassSpec {
  readonly class: ErrorClass
  readonly retryable: Retryability
  /**
   * Whether a failure of this class burns one of the step's attempts.
   *
   * False for classes that describe the *provider's* availability rather than
   * the request's validity.
   */
  readonly consumesAttempt: boolean
  readonly action: ErrorAction
  /** Whether this failure should page someone rather than merely be recorded. */
  readonly alerts: boolean
  readonly description: string
}

const SPECS: Record<ErrorClass, ErrorClassSpec> = {
  transient_network: {
    class: 'transient_network',
    retryable: 'yes',
    consumesAttempt: true,
    action: 'backoff',
    alerts: false,
    description: 'Connection reset, DNS failure, 502/503/504. The request very likely never arrived.',
  },
  rate_limited: {
    class: 'rate_limited',
    retryable: 'yes',
    consumesAttempt: false,
    action: 'respect_retry_after',
    alerts: false,
    description: '429 or a provider quota error. Their capacity problem, not our failure.',
  },
  auth_expired: {
    class: 'auth_expired',
    retryable: 'yes',
    consumesAttempt: false,
    action: 'refresh_credentials',
    alerts: false,
    description: '401 with a refreshable token. Refresh once; a second 401 is auth_broken.',
  },
  auth_broken: {
    class: 'auth_broken',
    retryable: 'no',
    consumesAttempt: false,
    action: 'fail_run',
    alerts: true,
    description: 'Revoked grant or a 401 that survived a refresh. Retrying cannot fix consent.',
  },
  client_error: {
    class: 'client_error',
    retryable: 'no',
    consumesAttempt: false,
    action: 'fail_step',
    alerts: false,
    description: '400, 404, 422, schema validation. The request is wrong and will stay wrong.',
  },
  server_error: {
    class: 'server_error',
    retryable: 'conditional',
    consumesAttempt: true,
    action: 'backoff',
    alerts: false,
    description: '500 after the request was accepted. Safe to retry only if the call is idempotent.',
  },
  timeout: {
    class: 'timeout',
    retryable: 'conditional',
    consumesAttempt: true,
    action: 'backoff',
    alerts: false,
    description: 'Our deadline expired. Whether it arrived is unknown, so idempotency decides.',
  },
  unknown_outcome: {
    class: 'unknown_outcome',
    retryable: 'no',
    consumesAttempt: false,
    action: 'pause_for_confirmation',
    alerts: true,
    description: 'Request sent, response lost, effect not idempotent. Guessing here duplicates money.',
  },
  internal: {
    class: 'internal',
    retryable: 'yes',
    consumesAttempt: true,
    action: 'backoff',
    alerts: true,
    description: 'Our bug. Retry, because it may be transient, but alert on the rate.',
  },
  poison: {
    class: 'poison',
    retryable: 'no',
    consumesAttempt: false,
    action: 'dead_letter',
    alerts: true,
    description: 'Deterministically unprocessable input. Retrying is an infinite loop.',
  },
}

export const ERROR_CLASSES: readonly ErrorClass[] = Object.keys(SPECS) as ErrorClass[]

export function specFor(errorClass: ErrorClass): ErrorClassSpec {
  const spec = SPECS[errorClass]
  if (spec === undefined) {
    // Unreachable through the type system, but this module is called from
    // boundaries where a string arrived from a database column.
    throw new RangeError(`Unknown error class: ${JSON.stringify(errorClass)}`)
  }
  return spec
}

/** Context needed to resolve the `conditional` rows. */
export interface RetryContext {
  /**
   * Whether repeating this call is safe — either the connector supports
   * idempotency keys, or the action is inherently side-effect-free.
   */
  readonly idempotent: boolean
}

export interface RetryDecision {
  readonly retry: boolean
  readonly consumesAttempt: boolean
  readonly action: ErrorAction
  /** Why, in a form fit for a step row and an operator's eyes. */
  readonly reason: string
}

/**
 * Resolve a class into an actual decision.
 *
 * The conditional rows collapse here: a `timeout` or `server_error` on a
 * non-idempotent call becomes `unknown_outcome`, because that is precisely
 * what it is — we do not know whether the effect happened, and we must not
 * pretend that a retry is free.
 */
export function decideRetry(errorClass: ErrorClass, context: RetryContext): RetryDecision {
  const spec = specFor(errorClass)

  if (spec.retryable === 'conditional' && !context.idempotent) {
    const escalated = specFor('unknown_outcome')
    return {
      retry: false,
      consumesAttempt: false,
      action: escalated.action,
      reason: `${errorClass} on a non-idempotent call: the effect may or may not have happened, so this becomes unknown_outcome rather than a retry`,
    }
  }

  return {
    retry: spec.retryable !== 'no',
    consumesAttempt: spec.consumesAttempt,
    action: spec.action,
    reason: spec.description,
  }
}

/** Classes from which a run can never continue. */
export function isTerminal(errorClass: ErrorClass): boolean {
  const spec = specFor(errorClass)
  return spec.retryable === 'no' && spec.action !== 'pause_for_confirmation'
}
