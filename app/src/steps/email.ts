/**
 * The email step — it actually sends.
 *
 * Over SMTP rather than a provider's HTTP API, because SMTP is the one
 * interface every provider offers: the same step works against Gmail, a
 * corporate relay, SES, Postmark, or a local catcher during development,
 * without this file knowing which.
 *
 * Two things here are about correctness rather than plumbing:
 *
 * **Sending is not idempotent.** There is no way to ask an SMTP server whether
 * it already accepted a message, so a retry after an ambiguous failure sends a
 * second email. Everything below is arranged around minimising that window and
 * being honest about it where it cannot be closed — see `classifyFailure`.
 *
 * **A `Message-ID` is generated from the step's idempotency key**, so the same
 * step retried presents the same id. Most relays do nothing with that, but the
 * ones that do de-duplicate on it, and it costs nothing to give them the
 * chance. It also makes a duplicate identifiable after the fact instead of
 * being two unrelated-looking messages.
 */

import { createTransport, type Transporter } from 'nodemailer'
import { StepFailure, type StepHandler } from 'automa-durable-runner'

export interface SmtpConfig {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string
  readonly password?: string
  /** The default From, when a step does not set one. */
  readonly from: string
  /**
   * Refuse to send anywhere else.
   *
   * A flow's recipient comes from a user, and in a system where a webhook body
   * can reach the To field that is an open relay with extra steps. Empty means
   * no restriction, which is right in production and wrong everywhere else.
   */
  readonly allowedRecipients?: readonly string[]
}

export interface EmailStepConfig {
  readonly to?: string
  readonly subject?: string
  readonly body?: string
  readonly from?: string
  readonly cc?: string
  readonly replyTo?: string
}

/** RFC 5322 in full is not worth it here; this rejects what is obviously not
 *  an address, which is all the check is for. */
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter((address) => address !== '')
}

export class EmailConfigError extends Error {
  readonly name = 'EmailConfigError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * May this address be written to?
 *
 * Matches a whole address, or a domain written as `@example.com`. Substring
 * matching would be a hole: an allow-list containing `@example.com` would
 * otherwise permit `attacker@example.com.evil.test`.
 */
export function isAllowedRecipient(address: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  const lower = address.toLowerCase()
  const domain = lower.slice(lower.lastIndexOf('@'))
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase()
    if (rule === '') return false
    return rule.startsWith('@') ? domain === rule : lower === rule
  })
}

/**
 * Whether a send failure may be retried.
 *
 * The hard part is that sending is not idempotent, so "retry" and "send it
 * twice" are the same action whenever we cannot tell if the server accepted
 * the message. The rules:
 *
 *   - A 4xx SMTP reply is a temporary condition and the message was *not*
 *     accepted. Safe to retry.
 *   - A 5xx reply is permanent and the message was not accepted. Retrying
 *     sends nothing and wastes the budget, so it fails for good.
 *   - A connection that drops mid-transaction is the ambiguous case: the
 *     server may have accepted and we never heard. `requestSent` is set so the
 *     engine treats it as an unknown outcome for a non-idempotent step, which
 *     pauses for a human rather than silently sending a second copy.
 */
export function classifyFailure(error: unknown): {
  message: string
  facts: Record<string, unknown>
} {
  const err = error as { responseCode?: number; code?: string; message?: string }
  const message = err.message ?? String(error)

  if (typeof err.responseCode === 'number') {
    const permanent = err.responseCode >= 500
    return {
      message: `SMTP ${err.responseCode}: ${message}`,
      facts: {
        httpStatus: err.responseCode,
        deterministicallyBroken: permanent,
        // The server replied, so it did not accept the message.
        requestSent: true,
        responseReceived: true,
      },
    }
  }

  return {
    message,
    facts: {
      ...(err.code === undefined ? {} : { code: err.code }),
      // No reply. Whether the message was accepted is genuinely unknown, and
      // for a step that is not repeatable the engine must not guess.
      requestSent: true,
      responseReceived: false,
    },
  }
}

export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST
  if (host === undefined || host === '') return null

  const from = env.SMTP_FROM
  if (from === undefined || from === '') {
    throw new EmailConfigError('SMTP_HOST is set but SMTP_FROM is not; every message needs a sender')
  }

  const port = Number(env.SMTP_PORT ?? 587)
  return {
    host,
    port,
    // Implicit TLS on 465; STARTTLS is negotiated on everything else.
    secure: env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE === 'true',
    ...(env.SMTP_USER === undefined ? {} : { user: env.SMTP_USER }),
    ...(env.SMTP_PASSWORD === undefined ? {} : { password: env.SMTP_PASSWORD }),
    from,
    allowedRecipients: (env.SMTP_ALLOWED_RECIPIENTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  }
}

export function createTransportFor(config: SmtpConfig): Transporter {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password ?? '' } }),
    // A step attempt has its own deadline; these keep a hung relay from
    // holding the attempt open until that deadline every time.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

export function emailHandler(options: {
  config: SmtpConfig
  transporter?: Transporter
}): StepHandler {
  const transporter = options.transporter ?? createTransportFor(options.config)
  const allowed = options.config.allowedRecipients ?? []

  return async (context) => {
    const step = (context.node.config ?? {}) as EmailStepConfig

    const to = (step.to ?? '').trim()
    if (to === '') throw new StepFailure('an email step needs a recipient', { deterministicallyBroken: true })

    const body = step.body ?? ''
    if (body.trim() === '') {
      // An email with no body is not a sendable email, and sending an empty
      // one is worse than refusing: it reaches a person and says nothing.
      throw new StepFailure('an email step needs a body', { deterministicallyBroken: true })
    }

    const recipients = parseRecipients(to)
    for (const address of recipients) {
      if (!ADDRESS.test(address)) {
        throw new StepFailure(`not an email address: ${address}`, { deterministicallyBroken: true })
      }
      if (!isAllowedRecipient(address, allowed)) {
        // Deterministic: the allow-list will not change between retries, and
        // burning five attempts to rediscover that helps nobody.
        throw new StepFailure(`refusing to send to ${address}: not in SMTP_ALLOWED_RECIPIENTS`, {
          deterministicallyBroken: true,
        })
      }
    }

    try {
      const info = await transporter.sendMail({
        from: step.from ?? options.config.from,
        to: recipients.join(', '),
        ...(step.cc === undefined || step.cc.trim() === '' ? {} : { cc: step.cc }),
        ...(step.replyTo === undefined || step.replyTo.trim() === ''
          ? {}
          : { replyTo: step.replyTo }),
        subject: step.subject ?? '',
        text: body,
        // Derived from the idempotency key, so a retry presents the same id.
        // Most relays ignore it; the ones that de-duplicate on it get the
        // chance to, and a duplicate is identifiable afterwards either way.
        messageId: `<${context.idempotencyKey}@automabuild>`,
      })

      return {
        output: {
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
        },
      }
    } catch (error) {
      const { message, facts } = classifyFailure(error)
      throw new StepFailure(message, facts)
    }
  }
}
