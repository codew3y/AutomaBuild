/**
 * The transform and email steps.
 *
 * The email tests send over real SMTP to Mailpit, which accepts everything and
 * delivers nothing, then read the message back out of its API. A mock
 * transporter would test that nodemailer was called; this tests that a message
 * was composed, accepted by a server, and arrived with the right headers —
 * which is the part that actually breaks.
 *
 * They skip themselves when Mailpit is not running, so `npm test` still works
 * on a clean checkout with nothing started.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateTransform, transformHandler, TransformError } from '../src/steps/transform.ts'
import {
  classifyFailure,
  createTransportFor,
  emailHandler,
  isAllowedRecipient,
  parseRecipients,
  smtpFromEnv,
  type SmtpConfig,
} from '../src/steps/email.ts'
import { withMapping } from '../src/handlers.ts'
import type { StepContext } from 'automa-durable-runner'

const MAILPIT = 'http://127.0.0.1:8025'

const context = (config: Record<string, unknown>, idempotencyKey = 'idem-1'): StepContext =>
  ({
    node: { id: 'step', kind: 'x', idempotent: false, config },
    idempotencyKey,
    upstream: {},
    run: { input: null },
    step: {},
    signal: AbortSignal.timeout(15_000),
    deadlineMs: 15_000,
  }) as unknown as StepContext

/* ------------------------------------------------------------- transform */

describe('the transform step', () => {
  test('builds an object from a JSON template', async () => {
    const result = await transformHandler()(
      context({ template: '{"name":"Sam","tier":"premium","orders":2}' }),
    )
    assert.deepEqual(result.output, { name: 'Sam', tier: 'premium', orders: 2 })
  })

  test('a bare string is a legitimate transform, not an error', () => {
    // Mapping one upstream field through to a name of your choosing. By the
    // time this runs, withMapping has already replaced the reference.
    assert.equal(evaluateTransform('sam@example.com'), 'sam@example.com')
  })

  test('something that clearly meant to be JSON and is not is an error', () => {
    // Opening with a brace is the signal. Failing silently to a string here
    // would hand the next step the literal text of a broken template.
    assert.throws(() => evaluateTransform('{"name": }'), TransformError)
    assert.throws(() => evaluateTransform('[1, 2,'), TransformError)
  })

  test('keeps a value that arrived already structured', () => {
    // The whole field was a single {{ }} reference, so it kept its type
    // instead of being stringified.
    assert.deepEqual(evaluateTransform({ already: 'an object' }), { already: 'an object' })
    assert.deepEqual(evaluateTransform([1, 2, 3]), [1, 2, 3])
  })

  test('an empty template is null rather than an empty string', () => {
    assert.equal(evaluateTransform('   '), null)
  })

  test('accepts the field under its old name', async () => {
    // The editor's schema called it `expression` first. A flow published under
    // that name must not stop working because the name changed.
    const result = await transformHandler()(context({ expression: '{"ok":true}' }))
    assert.deepEqual(result.output, { ok: true })
  })

  test('a transform with no template at all is an error', async () => {
    await assert.rejects(() => transformHandler()(context({})), /needs a template/)
  })

  test('numbers and booleans survive the round trip as themselves', async () => {
    const result = await transformHandler()(
      context({ template: '{"count":0,"enabled":false,"missing":null}' }),
    )
    assert.deepEqual(result.output, { count: 0, enabled: false, missing: null })
  })
})

/* ----------------------------------------------------------------- email */

describe('email address handling', () => {
  test('splits on commas and semicolons, and trims', () => {
    assert.deepEqual(parseRecipients('a@x.test, b@y.test ; c@z.test'), [
      'a@x.test',
      'b@y.test',
      'c@z.test',
    ])
  })

  test('an empty allow-list permits everything', () => {
    assert.equal(isAllowedRecipient('anyone@anywhere.test', []), true)
  })

  test('a whole address matches only itself', () => {
    assert.equal(isAllowedRecipient('sam@example.com', ['sam@example.com']), true)
    assert.equal(isAllowedRecipient('other@example.com', ['sam@example.com']), false)
  })

  test('a domain rule matches the domain and nothing that merely contains it', () => {
    // The hole a substring check would leave: an allow-list of @example.com
    // must not permit example.com.evil.test.
    assert.equal(isAllowedRecipient('sam@example.com', ['@example.com']), true)
    assert.equal(isAllowedRecipient('sam@example.com.evil.test', ['@example.com']), false)
    assert.equal(isAllowedRecipient('sam@notexample.com', ['@example.com']), false)
  })

  test('matching ignores case, because addresses do', () => {
    assert.equal(isAllowedRecipient('Sam@Example.COM', ['@example.com']), true)
  })
})

describe('classifying a send failure', () => {
  test('a 4xx reply is temporary and the message was not accepted', () => {
    const { facts } = classifyFailure({ responseCode: 451, message: 'try later' })
    assert.equal(facts.deterministicallyBroken, false)
    assert.equal(facts.responseReceived, true)
  })

  test('a 5xx reply is permanent, so retrying sends nothing', () => {
    const { facts } = classifyFailure({ responseCode: 550, message: 'no such user' })
    assert.equal(facts.deterministicallyBroken, true)
  })

  test('a dropped connection is an unknown outcome, not a failure to retry blindly', () => {
    // The dangerous case: the server may have accepted and we never heard. For
    // a step that is not repeatable the engine must pause rather than guess,
    // and that hinges on responseReceived being false.
    const { facts } = classifyFailure({ code: 'ECONNRESET', message: 'socket hang up' })
    assert.equal(facts.responseReceived, false)
    assert.equal(facts.requestSent, true)
    assert.equal(facts.code, 'ECONNRESET')
  })
})

describe('reading SMTP settings from the environment', () => {
  test('is absent when no host is set, so the step reports itself unconfigured', () => {
    assert.equal(smtpFromEnv({}), null)
  })

  test('refuses a host with no sender', () => {
    assert.throws(() => smtpFromEnv({ SMTP_HOST: 'smtp.test' }), /SMTP_FROM/)
  })

  test('implies TLS from the port, and lets it be overridden', () => {
    const base = { SMTP_HOST: 'smtp.test', SMTP_FROM: 'a@b.test' }
    assert.equal(smtpFromEnv({ ...base, SMTP_PORT: '465' })?.secure, true)
    assert.equal(smtpFromEnv({ ...base, SMTP_PORT: '587' })?.secure, false)
    assert.equal(smtpFromEnv({ ...base, SMTP_PORT: '587', SMTP_SECURE: 'true' })?.secure, true)
  })
})

/* -------------------------------------------------- against a real server */

let mailpitUp = false

before(async () => {
  try {
    const response = await fetch(`${MAILPIT}/api/v1/info`, { signal: AbortSignal.timeout(2000) })
    mailpitUp = response.ok
  } catch {
    mailpitUp = false
  }
  if (!mailpitUp) {
    console.log('  (Mailpit is not running — skipping the tests that actually send)')
  } else {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' })
  }
})

after(async () => {
  if (mailpitUp) await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' })
})

const smtp: SmtpConfig = {
  host: '127.0.0.1',
  port: 1025,
  secure: false,
  from: 'AutomaBuild <flows@automabuild.test>',
}

async function inbox(): Promise<{ messages: { ID: string; Subject: string; MessageID: string }[] }> {
  const response = await fetch(`${MAILPIT}/api/v1/messages`)
  return response.json() as Promise<{ messages: { ID: string; Subject: string; MessageID: string }[] }>
}

describe('sending an email for real', () => {
  test('composes and delivers a message a server accepts', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')

    const handler = emailHandler({ config: smtp, transporter: createTransportFor(smtp) })
    const result = await handler(
      context({
        to: 'sam@example.test',
        subject: 'Your invoice is paid',
        body: 'Hi Sam,\n\nThanks — CHF 42.00 received.',
      }),
    )

    const output = result.output as { accepted: string[]; messageId: string }
    assert.deepEqual(output.accepted, ['sam@example.test'])

    const { messages } = await inbox()
    const sent = messages.find((m) => m.Subject === 'Your invoice is paid')
    assert.ok(sent !== undefined, 'the message must actually have arrived')

    const full = await (await fetch(`${MAILPIT}/api/v1/message/${sent.ID}`)).json()
    assert.match(String(full.Text), /Thanks — CHF 42\.00 received\./)
    assert.equal(full.To[0].Address, 'sam@example.test')
    assert.equal(full.From.Address, 'flows@automabuild.test')
  })

  test('a retry presents the same Message-ID, so a duplicate is identifiable', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')

    // Sending is not idempotent and cannot be made so over SMTP. What can be
    // done is deriving the id from the idempotency key, which is constant
    // across retries: a relay that de-duplicates gets the chance to, and a
    // duplicate that does get through is identifiable afterwards rather than
    // looking like two unrelated messages.
    const handler = emailHandler({ config: smtp, transporter: createTransportFor(smtp) })
    const step = { to: 'dup@example.test', subject: 'Retried', body: 'once' }

    await handler(context(step, 'stable-key'))
    await handler(context(step, 'stable-key'))

    const { messages } = await inbox()
    const both = messages.filter((m) => m.Subject === 'Retried')
    assert.equal(both.length, 2, 'both attempts really were sent — this is the honest part')
    assert.equal(both[0]!.MessageID, both[1]!.MessageID, 'and both carry the same id')
    assert.match(both[0]!.MessageID, /stable-key@automabuild/)
  })

  test('refuses a recipient outside the allow-list without contacting the server', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')

    const handler = emailHandler({
      config: { ...smtp, allowedRecipients: ['@example.test'] },
      transporter: createTransportFor(smtp),
    })

    await assert.rejects(
      () => handler(context({ to: 'someone@elsewhere.test', subject: 's', body: 'b' })),
      /refusing to send/,
    )

    const { messages } = await inbox()
    assert.equal(
      messages.some((m) => m.Subject === 's'),
      false,
      'nothing may reach the server when the recipient is refused',
    )
  })

  test('refuses to send an email with no body', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')
    const handler = emailHandler({ config: smtp, transporter: createTransportFor(smtp) })
    await assert.rejects(
      () => handler(context({ to: 'sam@example.test', subject: 'Empty', body: '   ' })),
      /needs a body/,
    )
  })

  test('refuses something that is not an address', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')
    const handler = emailHandler({ config: smtp, transporter: createTransportFor(smtp) })
    await assert.rejects(
      () => handler(context({ to: 'not-an-address', subject: 's', body: 'b' })),
      /not an email address/,
    )
  })

  test('sends to several recipients at once', async (t) => {
    if (!mailpitUp) return t.skip('Mailpit is not running')
    const handler = emailHandler({ config: smtp, transporter: createTransportFor(smtp) })
    const result = await handler(
      context({ to: 'one@example.test, two@example.test', subject: 'Both', body: 'hello' }),
    )
    const output = result.output as { accepted: string[] }
    assert.deepEqual(output.accepted.sort(), ['one@example.test', 'two@example.test'])
  })
})

describe('a transform preserves types', () => {
  const withScope = (template: string, upstream: Record<string, unknown>, input: unknown = null) =>
    transformHandler()({
      node: { id: 'shape', kind: 'transform', idempotent: true, config: { template } },
      idempotencyKey: 'k',
      upstream,
      run: { input },
      step: {},
      signal: AbortSignal.timeout(5000),
      deadlineMs: 5000,
    } as unknown as StepContext)

  test('a number stays a number', async () => {
    // The bug this pins: resolving into the *text* of the template and then
    // parsing gives {"stars": "119635"} — every value a string, and a later
    // step comparing numbers comparing text instead.
    const result = await withScope('{"stars":"{{ steps.repo.output.count }}"}', {
      repo: { count: 119635 },
    })
    assert.deepEqual(result.output, { stars: 119635 })
    assert.equal(typeof (result.output as { stars: unknown }).stars, 'number')
  })

  test('booleans, nulls and objects survive too', async () => {
    const result = await withScope(
      '{"on":"{{ steps.s.output.flag }}","none":"{{ steps.s.output.nothing }}","deep":"{{ steps.s.output.obj }}"}',
      { s: { flag: false, nothing: 0, obj: { a: [1, 2] } } },
    )
    assert.deepEqual(result.output, { on: false, none: 0, deep: { a: [1, 2] } })
  })

  test('a reference inside a longer string is still text', async () => {
    // Concatenation cannot mean anything else.
    const result = await withScope('{"label":"repo {{ steps.s.output.name }} today"}', {
      s: { name: 'node' },
    })
    assert.deepEqual(result.output, { label: 'repo node today' })
  })

  test('reaches into nested structures and arrays', async () => {
    const result = await withScope(
      '{"outer":{"inner":"{{ steps.s.output.n }}"},"list":["{{ steps.s.output.n }}","static"]}',
      { s: { n: 7 } },
    )
    assert.deepEqual(result.output, { outer: { inner: 7 }, list: [7, 'static'] })
  })

  test('reads the trigger payload', async () => {
    const result = await withScope('{"amount":"{{ trigger.body.total }}"}', {}, { total: 4200 })
    assert.deepEqual(result.output, { amount: 4200 })
  })

  test('a reference that resolves to nothing fails the step rather than shipping braces', async () => {
    await assert.rejects(
      () => withScope('{"x":"{{ steps.s.output.gone }}"}', { s: { present: 1 } }),
      /unresolved reference: steps\.s\.output\.gone/,
    )
  })
})

describe('holding a field back from resolution', () => {
  test('a raw field reaches the handler unresolved, and the rest do not', async () => {
    let seen: Record<string, unknown> = {}
    const wrapped = withMapping(
      async (ctx) => {
        seen = (ctx.node.config ?? {}) as Record<string, unknown>
        return {}
      },
      { rawFields: ['template'] },
    )

    await wrapped({
      node: {
        id: 'n',
        kind: 'transform',
        idempotent: true,
        config: { template: '{{ a.b }}', label: '{{ steps.s.output.name }}' },
      },
      idempotencyKey: 'k',
      upstream: { s: { name: 'resolved' } },
      run: { input: null },
      step: {},
      signal: AbortSignal.timeout(5000),
      deadlineMs: 5000,
    } as unknown as StepContext)

    assert.equal(seen['template'], '{{ a.b }}', 'a raw field must arrive untouched')
    assert.equal(seen['label'], 'resolved', 'every other field is still resolved')
  })

  test('a missing reference in a held field is not reported by the wrapper', async () => {
    // Otherwise the transform could never run: its template is full of
    // references the wrapper cannot see the shape of.
    const wrapped = withMapping(async () => ({ output: 'ran' }), { rawFields: ['template'] })
    const result = await wrapped({
      node: { id: 'n', kind: 'transform', idempotent: true, config: { template: '{{ nope.gone }}' } },
      idempotencyKey: 'k',
      upstream: {},
      run: { input: null },
      step: {},
      signal: AbortSignal.timeout(5000),
      deadlineMs: 5000,
    } as unknown as StepContext)
    assert.deepEqual(result, { output: 'ran' })
  })
})
