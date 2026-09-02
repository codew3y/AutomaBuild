/**
 * What the canvas's HTTP fields become.
 *
 * No socket is opened. The request the engine would send is the whole subject
 * here, and building it is where the mistakes are — the engine's own tests
 * already cover what happens once it goes out.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { authorizationHeader, normaliseRequest, parseHeaderLines } from '../src/steps/http.ts'

describe('headers', () => {
  it('reads one header per line, as they are written everywhere else', () => {
    assert.deepEqual(
      parseHeaderLines('Accept: application/json\nX-Api-Version: 2024-01'),
      { Accept: 'application/json', 'X-Api-Version': '2024-01' },
    )
  })

  it('splits on the first colon only', () => {
    // A URL in a header value has a colon of its own, and it belongs to the
    // value.
    assert.deepEqual(parseHeaderLines('Referer: https://example.com/a'), {
      Referer: 'https://example.com/a',
    })
  })

  it('skips blank lines and comments rather than refusing the request', () => {
    assert.deepEqual(parseHeaderLines('Accept: application/json\n\n# auth below\nX-Key: abc'), {
      Accept: 'application/json',
      'X-Key': 'abc',
    })
  })

  it('says which line it could not read', () => {
    assert.throws(() => parseHeaderLines('Accept application/json'), /Accept application\/json/)
  })
})

describe('authorization', () => {
  it('encodes Basic, which is the reason the field exists', () => {
    // "user:password" in base64. Asking someone to do this themselves is how
    // an un-encoded password gets pasted and the only feedback is a 401.
    assert.equal(authorizationHeader('Basic user:password'), 'Basic dXNlcjpwYXNzd29yZA==')
  })

  it('leaves Bearer alone', () => {
    assert.equal(authorizationHeader('Bearer sk_live_abc'), 'Bearer sk_live_abc')
  })

  it('passes through a scheme it has not heard of', () => {
    assert.equal(authorizationHeader('Signature keyId=x'), 'Signature keyId=x')
  })

  it('is nothing when empty', () => {
    assert.equal(authorizationHeader('   '), '')
  })
})

describe('the request', () => {
  it('defaults to a GET with no body', () => {
    const request = normaliseRequest({ url: 'https://example.com' })
    assert.equal(request.method, 'GET')
    assert.equal(request.body, undefined)
  })

  it('sends JSON with a content type', () => {
    const request = normaliseRequest({
      url: 'https://example.com',
      method: 'post',
      body: '{"total": 42}',
    })
    assert.equal(request.method, 'POST')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.equal(request.body, '{"total":42}')
  })

  it('fails on invalid JSON here rather than as a 400 from the far end', () => {
    assert.throws(
      () => normaliseRequest({ url: 'https://x.test', method: 'POST', body: '{"a": }' }),
      /not valid JSON/,
    )
  })

  it('form-encodes when asked', () => {
    const request = normaliseRequest({
      url: 'https://example.com',
      method: 'POST',
      payload: 'form',
      body: 'name=Ada\nrole=engineer',
    })
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.equal(request.body, 'name=Ada&role=engineer')
  })

  it('sends raw exactly as typed, and invents no content type', () => {
    const request = normaliseRequest({
      url: 'https://example.com',
      method: 'POST',
      payload: 'raw',
      body: 'not json, not a form',
    })
    assert.equal(request.body, 'not json, not a form')
    assert.equal(request.headers['content-type'], undefined)
  })

  it('does not overrule a content type the author wrote', () => {
    const request = normaliseRequest({
      url: 'https://example.com',
      method: 'POST',
      headers: 'content-type: application/vnd.api+json',
      body: '{"a":1}',
    })
    assert.equal(request.headers['content-type'], 'application/vnd.api+json')
  })

  it('does not overrule an Authorization the author wrote', () => {
    const request = normaliseRequest({
      url: 'https://example.com',
      headers: 'Authorization: Bearer written-by-hand',
      auth: 'Bearer from-the-field',
    })
    assert.equal(request.headers['Authorization'], 'Bearer written-by-hand')
  })

  it('drops a leftover body on a method that carries none', () => {
    // Rather than failing the run over a field someone typed and then changed
    // their mind about.
    const request = normaliseRequest({ url: 'https://x.test', method: 'GET', body: '{"a":1}' })
    assert.equal(request.body, undefined)
  })

  it('serialises a mapped body that resolved to an object', () => {
    // `{{ steps.x.output.payload }}` alone keeps its type through resolution,
    // so the config arrives holding an object rather than text.
    const request = normaliseRequest({
      url: 'https://x.test',
      method: 'POST',
      body: { total: 42 },
    })
    assert.equal(request.body, '{"total":42}')
  })

  it('refuses a payload type it does not know', () => {
    assert.throws(
      () => normaliseRequest({ url: 'https://x.test', method: 'POST', payload: 'xml', body: 'a' }),
      /expected json, form or raw/,
    )
  })
})
