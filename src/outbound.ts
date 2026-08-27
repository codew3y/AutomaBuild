/**
 * Sending webhooks, in the Standard Webhooks format.
 *
 * The format is chosen so recipients can verify us with an off-the-shelf
 * library rather than reading our documentation and writing HMAC code — which
 * most of them will get subtly wrong, in the ways the verifiers in this
 * project exist to catch.
 *
 * Signing is the easy half. The hard half is what happens when the recipient
 * is down, and the shape of that answer is the same as any at-least-once
 * delivery system: retry with jitter, cap the attempts, and put what is left
 * somewhere a human will look.
 *
 * **We are the untrustworthy party here.** A recipient must assume we will
 * deliver the same event more than once, because we will: a response lost in
 * transit is indistinguishable from a request that never arrived, and the only
 * safe action is to send it again. That is why every delivery carries a stable
 * `webhook-id` — it is what lets them deduplicate, and it does not change
 * across retries of the same event.
 */

import { createHmac, randomUUID } from 'node:crypto'
import { decodeSecret } from './verify/standard-webhooks.ts'

/**
 * The three headers a Standard Webhooks delivery carries.
 *
 * The index signature is deliberate: these get handed straight to a verifier,
 * which takes a general header map, and a closed interface would not satisfy
 * it — forcing every call site into a cast, which is exactly where a wrong
 * header name stops being a type error.
 */
export interface SignedHeaders {
  readonly 'webhook-id': string
  readonly 'webhook-timestamp': string
  readonly 'webhook-signature': string
  readonly [header: string]: string
}

/**
 * Sign a payload with every active secret.
 *
 * All of them, space-delimited, because that is what makes a secret rotation
 * survivable from the recipient's side: during the window they may know only
 * the old secret or only the new one, and a delivery signed with both verifies
 * either way. Sending only the newest turns every rotation into an outage for
 * anyone who has not yet updated.
 */
export function signPayload(input: {
  readonly payload: string
  readonly secrets: readonly string[]
  readonly messageId?: string
  readonly timestamp?: Date
}): SignedHeaders {
  if (input.secrets.length === 0) {
    throw new RangeError('at least one signing secret is required')
  }

  const messageId = input.messageId ?? `msg_${randomUUID()}`
  const seconds = Math.floor((input.timestamp ?? new Date()).getTime() / 1000)
  const signedContent = `${messageId}.${seconds}.${input.payload}`

  const signatures = input.secrets.map(
    (secret) => `v1,${createHmac('sha256', decodeSecret(secret)).update(signedContent).digest('base64')}`,
  )

  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(seconds),
    'webhook-signature': signatures.join(' '),
  }
}

export interface DeliveryAttempt {
  readonly attempt: number
  readonly status?: number
  readonly error?: string
  readonly at: Date
}

export type DeliveryResult =
  | { readonly kind: 'delivered'; readonly status: number; readonly attempts: readonly DeliveryAttempt[] }
  | {
      readonly kind: 'exhausted'
      readonly attempts: readonly DeliveryAttempt[]
      /** Everything needed to send this again, without reconstructing it. */
      readonly dlq: DlqEntry
    }
  | {
      readonly kind: 'abandoned'
      readonly reason: string
      readonly attempts: readonly DeliveryAttempt[]
      readonly dlq: DlqEntry
    }

export interface DlqEntry {
  readonly url: string
  readonly payload: string
  readonly headers: SignedHeaders
  readonly messageId: string
  readonly lastError: string
  readonly attempts: number
}

export interface SendOptions {
  readonly url: string
  readonly payload: string
  readonly secrets: readonly string[]
  readonly messageId?: string
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly capDelayMs?: number
  readonly timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Injected so a retry ladder is a test rather than a wait. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly now?: () => Date
}

const DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  capDelayMs: 900_000,
  timeoutMs: 30_000,
}

/**
 * Full-jitter backoff: `random(0, min(cap, base * 2^attempt))`.
 *
 * Jitter matters more for outbound than inbound. When a recipient comes back
 * up after an outage, every event queued for them retries — and without
 * jitter they all retry at the same instant, which knocks the recipient over
 * again just as they recover.
 */
export function backoffMs(
  attempt: number,
  options: { baseDelayMs?: number; capDelayMs?: number; random?: () => number } = {},
): number {
  const base = options.baseDelayMs ?? DEFAULTS.baseDelayMs
  const cap = options.capDelayMs ?? DEFAULTS.capDelayMs
  const random = options.random ?? Math.random
  const window = Math.min(cap, base * 2 ** Math.min(attempt - 1, 30))
  return Math.floor(random() * window)
}

/**
 * Is this status worth trying again?
 *
 * 4xx means the recipient understood and refused: the same request will be
 * refused identically next time, and retrying is noise. The exceptions are
 * 408 and 429, which are explicitly "not now" rather than "not ever".
 */
export function isRetryable(status: number): boolean {
  if (status === 408 || status === 429) return true
  if (status >= 500) return true
  return false
}

export async function send(options: SendOptions): Promise<DeliveryResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const doFetch = options.fetchImpl ?? fetch
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? (() => new Date())

  // Signed once, outside the retry loop. The message id and timestamp must
  // stay identical across attempts — re-signing each time would give every
  // retry a new id, and the recipient would have no way to tell a retry from a
  // new event. That is precisely the duplicate we are asking them to catch.
  const headers = signPayload({
    payload: options.payload,
    secrets: options.secrets,
    ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    timestamp: now(),
  })

  const attempts: DeliveryAttempt[] = []
  let lastError = 'no attempt was made'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let status: number | undefined
    try {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: options.payload,
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status

      if (response.ok) {
        attempts.push({ attempt, status, at: now() })
        return { kind: 'delivered', status, attempts }
      }

      lastError = `HTTP ${status}`
      attempts.push({ attempt, status, error: lastError, at: now() })

      if (!isRetryable(status)) {
        // A refusal, not a failure. Retrying a 400 four more times helps
        // nobody and looks like an attack from the recipient's side.
        return {
          kind: 'abandoned',
          reason: lastError,
          attempts,
          dlq: buildDlq(options, headers, lastError, attempt),
        }
      }
    } catch (error) {
      lastError = (error as Error).message
      attempts.push({ attempt, error: lastError, at: now() })
    }

    if (attempt < maxAttempts) {
      await sleep(
        backoffMs(attempt, {
          ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
          ...(options.capDelayMs === undefined ? {} : { capDelayMs: options.capDelayMs }),
          ...(options.random === undefined ? {} : { random: options.random }),
        }),
      )
    }
  }

  return {
    kind: 'exhausted',
    attempts,
    dlq: buildDlq(options, headers, lastError, maxAttempts),
  }
}

function buildDlq(
  options: SendOptions,
  headers: SignedHeaders,
  lastError: string,
  attempts: number,
): DlqEntry {
  return {
    url: options.url,
    payload: options.payload,
    // The original headers, signature included. A DLQ entry that has to be
    // re-signed to be replayed would get a new message id, and the recipient
    // would see a different event rather than the one they missed.
    headers,
    messageId: headers['webhook-id'],
    lastError,
    attempts,
  }
}
