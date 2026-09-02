/**
 * What the canvas means by an HTTP step, translated into what the engine takes.
 *
 * The engine's handler already accepts `headers` as an object and `body` as a
 * string, and it has done since the beginning — the gap was never in the
 * engine. It was that the editor offered a URL and a method and nothing else,
 * which is not enough to call any real API: almost every one of them wants an
 * `Authorization` header, and every POST wants a content type that matches
 * what is actually in the body.
 *
 * Asking someone to type a JSON object into a text field to get headers would
 * have closed the gap and pleased nobody. So the editor offers three plain
 * text fields — headers, auth, payload type — and this turns them into the
 * request the engine sends.
 *
 * Everything here runs *after* `withMapping` has resolved `{{ }}`, which is
 * what makes `Authorization: Bearer {{ steps.login.output.token }}` work: by
 * the time the text is parsed into headers, the reference is already a token.
 */

import { StepFailure, type StepHandler } from 'automa-durable-runner'

/** How the body is encoded, and what content type says so. */
export type PayloadType = 'json' | 'form' | 'raw'

const PAYLOAD_TYPES: readonly string[] = ['json', 'form', 'raw']

/**
 * Parse `Key: Value` lines.
 *
 * One header per line, which is how headers are written everywhere else — in
 * curl, in a browser's network panel, in an API's own documentation. Someone
 * copying a header out of a provider's docs can paste it.
 *
 * A blank line is skipped rather than rejected: people leave one between
 * groups, and refusing to send a request over it would be pedantry.
 */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const at = line.indexOf(':')
    if (at === -1) {
      throw new StepFailure(
        `cannot read the header line ${JSON.stringify(line)}: expected "Name: value"`,
        { deterministicallyBroken: true },
      )
    }

    const name = line.slice(0, at).trim()
    if (name === '') {
      throw new StepFailure(`a header line has no name: ${JSON.stringify(line)}`, {
        deterministicallyBroken: true,
      })
    }

    // Only the first colon splits. `Referer: https://example.com` has two, and
    // the second one belongs to the value.
    headers[name] = line.slice(at + 1).trim()
  }

  return headers
}

/**
 * Turn the auth field into an `Authorization` value.
 *
 * Two forms, both written the way the header itself is written, so there is
 * nothing new to learn:
 *
 *     Bearer sk_live_...          sent as-is
 *     Basic user:password         encoded to base64 here
 *
 * The Basic case is the reason this exists at all. The header wants base64,
 * and asking someone to encode their own password before pasting it is how
 * people end up pasting it un-encoded and being told only that the server said
 * 401.
 *
 * Anything else is passed through untouched — a provider using its own scheme
 * name should not be blocked by our not having heard of it.
 */
export function authorizationHeader(auth: string): string {
  const trimmed = auth.trim()
  if (trimmed === '') return ''

  const at = trimmed.indexOf(' ')
  const scheme = at === -1 ? trimmed : trimmed.slice(0, at)
  const rest = at === -1 ? '' : trimmed.slice(at + 1).trim()

  if (scheme.toLowerCase() === 'basic' && rest.includes(':')) {
    return `Basic ${Buffer.from(rest, 'utf8').toString('base64')}`
  }

  return trimmed
}

/** `k=v` or `k: v` per line, for a form-encoded body. */
function parseFormLines(text: string): string {
  const params = new URLSearchParams()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    // `=` first, because a value may legitimately contain a colon and a URL is
    // the most likely thing anyone puts in a form field.
    const at = line.indexOf('=') === -1 ? line.indexOf(':') : line.indexOf('=')
    if (at === -1) {
      throw new StepFailure(
        `cannot read the form line ${JSON.stringify(line)}: expected "name=value"`,
        { deterministicallyBroken: true },
      )
    }
    params.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }

  return params.toString()
}

/**
 * Methods that carry no body.
 *
 * A GET with a body is not forbidden by the specification, but it is ignored
 * by enough of the world that sending one is a way to spend an afternoon. If
 * someone has typed a body and then chosen GET, the body is dropped and the
 * request goes out — the alternative is failing a run over a leftover field.
 */
const BODYLESS: readonly string[] = ['GET', 'HEAD', 'DELETE']

export interface NormalisedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string
}

/**
 * Build the request from the canvas's fields.
 *
 * Exported so it can be tested without a socket, and so the editor's preview
 * could one day show the same thing the run will send.
 */
export function normaliseRequest(config: Record<string, unknown>): NormalisedRequest {
  const url = String(config['url'] ?? '').trim()
  const method = String(config['method'] ?? 'GET').trim().toUpperCase() || 'GET'

  const headerField = config['headers']
  const headers =
    typeof headerField === 'string'
      ? parseHeaderLines(headerField)
      : headerField !== null && typeof headerField === 'object'
        ? Object.fromEntries(
            Object.entries(headerField as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {}

  const auth = authorizationHeader(String(config['auth'] ?? ''))
  if (auth !== '') {
    // An explicit `Authorization` in the headers field wins. Someone who wrote
    // the header by hand meant that header, and silently replacing it would be
    // the parser overruling the author.
    const already = Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
    if (!already) headers['Authorization'] = auth
  }

  const payloadField = String(config['payload'] ?? '').trim().toLowerCase()
  if (payloadField !== '' && !PAYLOAD_TYPES.includes(payloadField)) {
    throw new StepFailure(
      `unknown payload type ${JSON.stringify(payloadField)}: expected json, form or raw`,
      { deterministicallyBroken: true },
    )
  }
  const payload: PayloadType = (payloadField === '' ? 'json' : payloadField) as PayloadType

  const rawBody = config['body']
  const bodyText =
    rawBody === undefined || rawBody === null
      ? ''
      : typeof rawBody === 'string'
        ? rawBody
        : // A mapped body that resolved to an object keeps its type through
          // `resolveValue`, and the obvious thing to do with it is send it.
          JSON.stringify(rawBody)

  if (bodyText.trim() === '' || BODYLESS.includes(method)) {
    return { url, method, headers }
  }

  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')

  if (payload === 'json') {
    // Parsed and re-serialised rather than sent as typed. A body that is not
    // valid JSON but claims to be produces a 400 from the far end with no clue
    // as to which brace is missing; failing here says so, once, and does not
    // retry — the same text will be invalid on every attempt.
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch (error) {
      throw new StepFailure(`the body is not valid JSON: ${(error as Error).message}`, {
        deterministicallyBroken: true,
      })
    }
    if (!hasContentType) headers['content-type'] = 'application/json'
    return { url, method, headers, body: JSON.stringify(parsed) }
  }

  if (payload === 'form') {
    if (!hasContentType) headers['content-type'] = 'application/x-www-form-urlencoded'
    return { url, method, headers, body: parseFormLines(bodyText) }
  }

  // Raw: sent exactly as typed, and no content type is invented. Raw exists
  // for the cases we have not thought of, and guessing at a type would defeat
  // the point of having it.
  return { url, method, headers, body: bodyText }
}

/**
 * Wrap the engine's HTTP handler so it takes the canvas's fields.
 *
 * A wrapper rather than a replacement: SSRF checking, redirect policy,
 * timeouts, the idempotency key and the failure classification all live in the
 * engine's handler and none of them should be reimplemented here.
 */
export function canvasHttpHandler(inner: StepHandler): StepHandler {
  return async (context) => {
    const config = context.node.config ?? {}
    const request = normaliseRequest(config as Record<string, unknown>)

    if (request.url === '') {
      throw new StepFailure('the HTTP step has no url', { deterministicallyBroken: true })
    }

    return inner({
      ...context,
      node: {
        ...context.node,
        config: {
          url: request.url,
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        },
      },
    })
  }
}
