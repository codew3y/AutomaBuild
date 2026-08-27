/**
 * The four schemes, and the ways each one is got wrong.
 *
 * Every test is pure — no network, no database, no clock. The timestamp checks
 * take an injected `now`, so "this delivery is ten minutes stale" is a value
 * rather than a wait.
 *
 * The positive cases matter least. Any implementation passes those; the ones
 * that matter are the forgeries, the downgrades, and the stale replays.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyStripe, parseStripeSignature } from '../src/verify/stripe.ts'
import { verifyGitHub } from '../src/verify/github.ts'
import { verifySlack } from '../src/verify/slack.ts'
import {
  verifyStandardWebhooks,
  decodeSecret,
  parseSignatureHeader,
} from '../src/verify/standard-webhooks.ts'
import { checkTolerance, secureCompare } from '../src/verify/common.ts'

const SECRET = 'whsec_test_secret_value'
const BODY = '{"id":"evt_1","type":"payment.succeeded","amount":1000}'
const NOW = new Date('2026-03-01T12:00:00Z')
const TS = Math.floor(NOW.getTime() / 1000)

const hex = (secret: string, message: string) =>
  createHmac('sha256', secret).update(message).digest('hex')
const b64 = (secret: Buffer, message: string) =>
  createHmac('sha256', secret).update(message).digest('base64')

describe('Stripe', () => {
  const sign = (timestamp = TS, body = BODY, secret = SECRET) =>
    hex(secret, `${timestamp}.${body}`)

  const verify = (headers: Record<string, string>, overrides = {}) =>
    verifyStripe({ rawBody: BODY, headers, secrets: [SECRET], now: NOW, ...overrides })

  it('accepts a genuine delivery', () => {
    const result = verify({ 'stripe-signature': `t=${TS},v1=${sign()}` })
    assert.equal(result.ok, true)
    assert.equal(result.secretIndex, 0)
    assert.equal(result.timestamp?.toISOString(), NOW.toISOString())
  })

  it('rejects a forged signature', () => {
    const result = verify({ 'stripe-signature': `t=${TS},v1=${'0'.repeat(64)}` })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'signature_mismatch')
  })

  it('rejects a signature computed over a different body', () => {
    const result = verifyStripe({
      rawBody: '{"amount":999999}',
      headers: { 'stripe-signature': `t=${TS},v1=${sign()}` },
      secrets: [SECRET],
      now: NOW,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'signature_mismatch')
  })

  it('rejects a valid signature that is ten minutes old', () => {
    const stale = TS - 600
    const result = verify({ 'stripe-signature': `t=${stale},v1=${sign(stale)}` })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timestamp_outside_tolerance')
  })

  it('rejects a post-dated delivery too', () => {
    // Only checking the past would let a captured request be replayed forever
    // by moving its timestamp forward.
    const future = TS + 600
    const result = verify({ 'stripe-signature': `t=${future},v1=${sign(future)}` })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timestamp_outside_tolerance')
  })

  it('will not let the timestamp be swapped for a fresher one', () => {
    // The timestamp is inside the signed payload, so re-dating a captured
    // request invalidates the signature it came with.
    const captured = sign(TS - 600)
    const result = verify({ 'stripe-signature': `t=${TS},v1=${captured}` })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'signature_mismatch')
  })

  it('accepts either signature during a secret rotation', () => {
    const oldSecret = 'whsec_old'
    const newSecret = 'whsec_new'
    const headers = {
      'stripe-signature': `t=${TS},v1=${hex(oldSecret, `${TS}.${BODY}`)},v1=${hex(newSecret, `${TS}.${BODY}`)}`,
    }

    const viaOld = verifyStripe({ rawBody: BODY, headers, secrets: [oldSecret], now: NOW })
    const viaNew = verifyStripe({ rawBody: BODY, headers, secrets: [newSecret], now: NOW })
    assert.equal(viaOld.ok, true)
    assert.equal(viaNew.ok, true)
  })

  it('reports which secret matched, so rotation progress is visible', () => {
    const result = verifyStripe({
      rawBody: BODY,
      headers: { 'stripe-signature': `t=${TS},v1=${hex('second', `${TS}.${BODY}`)}` },
      secrets: ['first', 'second'],
      now: NOW,
    })
    assert.equal(result.ok, true)
    assert.equal(result.secretIndex, 1)
  })

  it('ignores a non-v1 scheme rather than verifying it', () => {
    // The downgrade. An attacker adds a scheme of their choosing; an
    // implementation that accepts "any signature" verifies the wrong one.
    const result = verify({
      'stripe-signature': `t=${TS},v0=${'f'.repeat(64)},v2=whatever`,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'malformed_signature', 'a header with no v1 is not verifiable')
  })

  it('does not accept a v0 signature that happens to be correct for v1 content', () => {
    const correct = sign()
    const result = verify({ 'stripe-signature': `t=${TS},v0=${correct}` })
    assert.equal(result.ok, false)
  })

  it('parses the header without being confused by whitespace', () => {
    const parsed = parseStripeSignature(` t=${TS}, v1=abc , v0=zzz `)
    assert.equal(parsed?.timestamp, TS)
    assert.deepEqual(parsed?.v1, ['abc'])
    assert.deepEqual(parsed?.ignoredSchemes, ['v0'])
  })

  it('refuses a malformed header', () => {
    for (const value of ['', 'garbage', 't=abc,v1=x', `v1=${sign()}`, `t=${TS}`]) {
      const result = verify({ 'stripe-signature': value })
      assert.equal(result.ok, false, `${JSON.stringify(value)} should not verify`)
    }
  })
})

describe('GitHub', () => {
  const sign = (body = BODY, secret = SECRET) => `sha256=${hex(secret, body)}`
  const headers = (overrides: Record<string, string> = {}) => ({
    'x-hub-signature-256': sign(),
    'x-github-delivery': 'd-1',
    ...overrides,
  })

  it('accepts a genuine delivery and uses the delivery id for dedup', () => {
    const result = verifyGitHub({ rawBody: BODY, headers: headers(), secrets: [SECRET] })
    assert.equal(result.ok, true)
    assert.equal(result.dedupKey, 'd-1')
    assert.equal(result.timestamp, undefined, 'GitHub carries no timestamp — do not invent one')
  })

  it('rejects a forged signature', () => {
    const result = verifyGitHub({
      rawBody: BODY,
      headers: headers({ 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }),
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'signature_mismatch')
  })

  it('refuses a delivery with no delivery id', () => {
    // Without a timestamp in the signature, the delivery id is the *only*
    // replay protection. Accepting the request without one would be pretending
    // the protection exists.
    const result = verifyGitHub({
      rawBody: BODY,
      headers: { 'x-hub-signature-256': sign() },
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_timestamp')
    assert.match(result.detail ?? '', /replayable indefinitely/)
  })

  it('ignores the legacy SHA-1 header entirely', () => {
    // Honouring it would let an attacker pick the weaker algorithm.
    const sha1 = createHmac('sha1', SECRET).update(BODY).digest('hex')
    const result = verifyGitHub({
      rawBody: BODY,
      headers: { 'x-hub-signature': `sha1=${sha1}`, 'x-github-delivery': 'd-1' },
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unsupported_algorithm')
  })

  it('rejects a signature with the wrong algorithm prefix', () => {
    const result = verifyGitHub({
      rawBody: BODY,
      headers: headers({ 'x-hub-signature-256': `sha1=${hex(SECRET, BODY)}` }),
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unsupported_algorithm')
  })
})

describe('Slack', () => {
  const sign = (timestamp = TS, body = BODY, secret = SECRET) =>
    `v0=${hex(secret, `v0:${timestamp}:${body}`)}`

  const verify = (headers: Record<string, string>, overrides = {}) =>
    verifySlack({ rawBody: BODY, headers, secrets: [SECRET], now: NOW, ...overrides })

  it('accepts a genuine delivery', () => {
    const result = verify({
      'x-slack-signature': sign(),
      'x-slack-request-timestamp': String(TS),
    })
    assert.equal(result.ok, true)
  })

  it('rejects a delivery outside the five-minute window', () => {
    const stale = TS - 301
    const result = verify({
      'x-slack-signature': sign(stale),
      'x-slack-request-timestamp': String(stale),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timestamp_outside_tolerance')
  })

  it('accepts one just inside the window', () => {
    const edge = TS - 299
    const result = verify({
      'x-slack-signature': sign(edge),
      'x-slack-request-timestamp': String(edge),
    })
    assert.equal(result.ok, true)
  })

  it('rejects a v1 label', () => {
    const result = verify({
      'x-slack-signature': sign().replace('v0=', 'v1='),
      'x-slack-request-timestamp': String(TS),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unsupported_algorithm')
  })

  it('requires the timestamp header', () => {
    const result = verify({ 'x-slack-signature': sign() })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_timestamp')
  })

  it('refuses a non-numeric timestamp instead of coercing it', () => {
    const result = verify({
      'x-slack-signature': sign(),
      'x-slack-request-timestamp': 'not-a-number',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'malformed_timestamp')
  })
})

describe('Standard Webhooks', () => {
  const ID = 'msg_2abc'
  const key = decodeSecret(SECRET)
  const sign = (id = ID, timestamp = TS, body = BODY) =>
    `v1,${b64(key, `${id}.${timestamp}.${body}`)}`

  const verify = (headers: Record<string, string>, overrides = {}) =>
    verifyStandardWebhooks({
      rawBody: BODY,
      headers,
      secrets: [SECRET],
      now: NOW,
      ...overrides,
    })

  const headers = (overrides: Record<string, string> = {}) => ({
    'webhook-id': ID,
    'webhook-timestamp': String(TS),
    'webhook-signature': sign(),
    ...overrides,
  })

  it('accepts a genuine delivery and dedupes on the message id', () => {
    const result = verify(headers())
    assert.equal(result.ok, true)
    assert.equal(result.dedupKey, ID, 'the message id is a better key than the signature')
  })

  it('decodes a whsec_ secret to bytes rather than hashing the text', () => {
    // Hashing the printable secret produces a stable, plausible, wrong
    // signature — and fails identically to a wrong secret, which is why this
    // is worth an explicit test.
    //
    // The secret must be genuinely base64 for this to mean anything: given a
    // prefix whose body is not base64, decodeSecret deliberately falls back to
    // the raw bytes, and then the two paths agree and the test proves nothing.
    const b64Secret = `whsec_${Buffer.from('sixteen-byte-key').toString('base64')}`
    const decoded = decodeSecret(b64Secret)
    assert.notEqual(decoded.toString('utf8'), b64Secret, 'the secret should have decoded')

    const signed = `${ID}.${TS}.${BODY}`
    const correct = `v1,${createHmac('sha256', decoded).update(signed).digest('base64')}`
    const naive = `v1,${createHmac('sha256', b64Secret).update(signed).digest('base64')}`

    assert.equal(
      verifyStandardWebhooks({
        rawBody: BODY,
        headers: headers({ 'webhook-signature': correct }),
        secrets: [b64Secret],
        now: NOW,
      }).ok,
      true,
    )
    assert.equal(
      verifyStandardWebhooks({
        rawBody: BODY,
        headers: headers({ 'webhook-signature': naive }),
        secrets: [b64Secret],
        now: NOW,
      }).ok,
      false,
      'hashing the printable secret must not verify',
    )
  })

  it('accepts any of several space-delimited signatures', () => {
    const other = `v1,${'A'.repeat(43)}=`
    const result = verify(headers({ 'webhook-signature': `${other} ${sign()}` }))
    assert.equal(result.ok, true)
  })

  it('skips ed25519 rather than treating it as HMAC', () => {
    const result = verify(headers({ 'webhook-signature': `v1a,${'B'.repeat(43)}=` }))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unsupported_algorithm')
    assert.match(result.detail ?? '', /v1a/)
  })

  it('binds the signature to the message id', () => {
    // Otherwise a captured body could be replayed under a fresh id, defeating
    // the dedup key it is supposed to be protected by.
    const result = verify(headers({ 'webhook-id': 'msg_different' }))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'signature_mismatch')
  })

  it('requires the message id', () => {
    const result = verify({
      'webhook-timestamp': String(TS),
      'webhook-signature': sign(),
    })
    assert.equal(result.ok, false)
  })

  it('parses versions out of the header', () => {
    const parsed = parseSignatureHeader('v1,aaa v1a,bbb junk v2,ccc')
    assert.deepEqual(parsed.v1, ['aaa'])
    assert.deepEqual([...parsed.skippedVersions].sort(), ['malformed', 'v1a', 'v2'])
  })
})

describe('shared behaviour', () => {
  it('compares in constant time and never with ===', () => {
    assert.equal(secureCompare('abc', 'abc'), true)
    assert.equal(secureCompare('abc', 'abd'), false)
    assert.equal(secureCompare('abc', 'abcd'), false, 'different lengths must not throw')
    assert.equal(secureCompare('', ''), true)
  })

  it('refuses a zero tolerance rather than rejecting every delivery', () => {
    assert.throws(() => checkTolerance(TS, 0, NOW), RangeError)
    assert.throws(() => checkTolerance(TS, -1, NOW), RangeError)
  })

  it('rejects a body over the size cap before hashing it', () => {
    const huge = 'x'.repeat(2048)
    const result = verifyGitHub({
      rawBody: huge,
      headers: { 'x-hub-signature-256': `sha256=${hex(SECRET, huge)}`, 'x-github-delivery': 'd' },
      secrets: [SECRET],
      maxBodyBytes: 1024,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'body_too_large')
  })

  it('reports a missing secret rather than failing as a mismatch', () => {
    const result = verifyGitHub({
      rawBody: BODY,
      headers: { 'x-hub-signature-256': `sha256=${hex(SECRET, BODY)}`, 'x-github-delivery': 'd' },
      secrets: [],
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_secret')
  })

  it('is not confused by header case or repetition', () => {
    const ok = verifyGitHub({
      rawBody: BODY,
      headers: { 'X-Hub-Signature-256': `sha256=${hex(SECRET, BODY)}`, 'X-GitHub-Delivery': 'd' },
      secrets: [SECRET],
    })
    assert.equal(ok.ok, true)

    const repeated = verifyGitHub({
      rawBody: BODY,
      headers: {
        'x-hub-signature-256': [`sha256=${hex(SECRET, BODY)}`, 'sha256=other'],
        'x-github-delivery': 'd',
      },
      secrets: [SECRET],
    })
    assert.equal(repeated.ok, false, 'a repeated signature header is not something to guess about')
  })
})

describe('why the raw body matters', () => {
  it('re-serialising the JSON breaks verification', () => {
    // The test the brief asks for, and the reason raw-body capture is the
    // fiddliest part of this project. A signature covers bytes, and a parse
    // followed by a re-stringify does not reproduce them.
    //
    // Note what does *not* change: V8 preserves the insertion order of string
    // keys, so `{"b":2,"a":1}` survives a round trip byte-for-byte. It is
    // whitespace, number formatting and unicode escaping that move — which is
    // worse, because it means the naive approach appears to work against a
    // compact test fixture and fails against a real sender that pretty-prints.
    const original = '{\n  "amount": 1000,\n  "rate": 1.50\n}'
    const signature = `sha256=${hex(SECRET, original)}`

    const asSent = verifyGitHub({
      rawBody: original,
      headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd' },
      secrets: [SECRET],
    })
    assert.equal(asSent.ok, true)

    const roundTripped = JSON.stringify(JSON.parse(original))
    assert.notEqual(roundTripped, original, 'the round trip must actually change the bytes')

    const afterParsing = verifyGitHub({
      rawBody: roundTripped,
      headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd' },
      secrets: [SECRET],
    })
    assert.equal(afterParsing.ok, false, 'this is why the raw body must be captured')
  })

  it('a body differing only in whitespace does not verify', () => {
    const original = '{"a":1}'
    const spaced = '{"a": 1}'
    const signature = `sha256=${hex(SECRET, original)}`
    const result = verifyGitHub({
      rawBody: spaced,
      headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd' },
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
  })

  it('verifies a body that is not JSON at all', () => {
    // Form-encoded and plain-text webhooks exist. A verifier that assumes JSON
    // cannot handle them, and a gateway that parses first cannot either.
    const form = 'a=1&b=two&c=%20'
    const result = verifyGitHub({
      rawBody: Buffer.from(form, 'utf8'),
      headers: { 'x-hub-signature-256': `sha256=${hex(SECRET, form)}`, 'x-github-delivery': 'd' },
      secrets: [SECRET],
    })
    assert.equal(result.ok, true)
  })
})
