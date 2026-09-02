/**
 * Methods and bodies, including the method rewriting the fetch specification
 * requires on redirect. Getting this wrong replays a POST somewhere the caller
 * never intended — a smaller problem than SSRF, but the same shape.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSafeFetch } from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { startHttpServer, type TestServer } from './helpers/http-server.ts'

describe('request methods and bodies', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await startHttpServer((request, response) => {
      const path = request.url ?? '/'

      const redirects: Record<string, number> = {
        '/see-other': 303,
        '/moved': 301,
        '/found': 302,
        '/temporary': 307,
        '/permanent': 308,
      }
      if (path in redirects) {
        response.writeHead(redirects[path]!, { location: `http://origin.test:${origin.port}/echo` })
        response.end()
        return
      }

      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            method: request.method,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: request.headers['content-type'] ?? null,
          }),
        )
      })
    })

    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  const makeFetch = (maxRedirects = 0) =>
    createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
      maxRedirects,
    })

  const echo = async (path: string, init?: Parameters<ReturnType<typeof makeFetch>>[1], hops = 0) => {
    const response = await makeFetch(hops)(`http://origin.test:${origin.port}${path}`, init)
    return JSON.parse(await response.text()) as {
      method: string
      body: string
      contentType: string | null
    }
  }

  it('sends a POST body', async () => {
    const result = await echo('/echo', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(result.method, 'POST')
    assert.equal(result.body, '{"hello":"world"}')
    assert.equal(result.contentType, 'application/json')
  })

  it('sends a Uint8Array body', async () => {
    const result = await echo('/echo', {
      method: 'PUT',
      body: new TextEncoder().encode('raw bytes'),
    })
    assert.equal(result.method, 'PUT')
    assert.equal(result.body, 'raw bytes')
  })

  it('accepts a Headers instance as well as a plain object', async () => {
    const result = await echo('/echo', {
      method: 'POST',
      body: 'x',
      headers: new Headers({ 'content-type': 'text/plain' }),
    })
    assert.equal(result.contentType, 'text/plain')
  })

  it('downgrades POST to GET on a 303, dropping the body', async () => {
    const result = await echo('/see-other', { method: 'POST', body: 'discard me' }, 1)
    assert.equal(result.method, 'GET')
    assert.equal(result.body, '')
    assert.equal(result.contentType, null)
  })

  for (const [path, status] of [
    ['/moved', 301],
    ['/found', 302],
  ] as const) {
    it(`downgrades POST to GET on a ${status}, as browsers do`, async () => {
      const result = await echo(path, { method: 'POST', body: 'discard me' }, 1)
      assert.equal(result.method, 'GET')
      assert.equal(result.body, '')
    })
  }

  for (const [path, status] of [
    ['/temporary', 307],
    ['/permanent', 308],
  ] as const) {
    it(`preserves the method and body on a ${status}`, async () => {
      const result = await echo(path, { method: 'POST', body: 'keep me' }, 1)
      assert.equal(result.method, 'POST')
      assert.equal(result.body, 'keep me')
    })
  }
})
