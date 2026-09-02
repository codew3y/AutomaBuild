/**
 * Redirects are a URL chosen by the server, not by the caller. Every hop gets
 * the whole pipeline again — parse, encoding check, resolve, validate, pin.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSafeFetch,
  SsrfBlockedError,
  TooManyRedirectsError,
} from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { startHttpServer, type TestServer } from './helpers/http-server.ts'

describe('redirect revalidation', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await startHttpServer((request, response) => {
      const path = request.url ?? '/'
      if (path === '/to-private') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        response.end()
        return
      }
      if (path === '/hop-1') {
        // Still public. The chain must not be refused here.
        response.writeHead(302, { location: `http://public-b.test:${origin.port}/hop-2` })
        response.end()
        return
      }
      if (path === '/hop-2') {
        // This is the hop that turns private.
        response.writeHead(302, { location: 'http://10.0.0.1/admin' })
        response.end()
        return
      }
      if (path === '/loop') {
        response.writeHead(302, { location: `http://public-a.test:${origin.port}/loop` })
        response.end()
        return
      }
      if (path === '/encoded') {
        response.writeHead(302, { location: 'http://0x7f000001/' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('arrived')
    })

    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  const makeFetch = (maxRedirects: number) =>
    createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
      maxRedirects,
    })

  it('does not follow redirects by default', async () => {
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
    })
    await assert.rejects(
      () => safeFetch(`http://public-a.test:${origin.port}/to-private`),
      TooManyRedirectsError,
    )
  })

  it('blocks a redirect into private space at the hop that turns private', async () => {
    const safeFetch = makeFetch(3)
    await assert.rejects(
      () => safeFetch(`http://public-a.test:${origin.port}/to-private`),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'metadata-endpoint')
        assert.equal(error.resolvedIp, '169.254.169.254')
        assert.equal(error.hop, 1, 'must fail on the redirect, not the first request')
        return true
      },
    )
  })

  it('blocks at hop 2 of a chain that stays public through hop 1', async () => {
    // Not before — hop 1 is legitimate and must be followed. Not after —
    // there is no hop 3 to reach.
    const safeFetch = makeFetch(3)
    await assert.rejects(
      () => safeFetch(`http://public-a.test:${origin.port}/hop-1`),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'blocked-range')
        assert.equal(error.resolvedIp, '10.0.0.1')
        assert.equal(error.hop, 2)
        return true
      },
    )
  })

  it('applies the encoding checks to redirect targets too', async () => {
    const safeFetch = makeFetch(2)
    await assert.rejects(
      () => safeFetch(`http://public-a.test:${origin.port}/encoded`),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'ip-literal-encoded')
        assert.equal(error.hop, 1)
        return true
      },
    )
  })

  it('caps the hop count', async () => {
    const safeFetch = makeFetch(2)
    await assert.rejects(
      () => safeFetch(`http://public-a.test:${origin.port}/loop`),
      TooManyRedirectsError,
    )
  })

  it('follows a legitimate redirect all the way to the body', async () => {
    const safeFetch = makeFetch(2)
    const response = await safeFetch(`http://public-a.test:${origin.port}/hop-1`, {
      maxRedirects: 0,
    }).catch(() => null)
    assert.equal(response, null, 'per-request override must win over the instance default')

    const followed = await safeFetch(`http://public-a.test:${origin.port}/elsewhere`)
    assert.equal(followed.status, 200)
    assert.equal(await followed.text(), 'arrived')
  })
})

describe('credential handling across a redirect', () => {
  let first: TestServer
  let second: TestServer
  let dns: DnsServer

  before(async () => {
    second = await startHttpServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(request.headers.authorization ?? 'no-authorization')
    })
    first = await startHttpServer((_request, response) => {
      response.writeHead(302, { location: `http://other-origin.test:${second.port}/` })
      response.end()
    })
    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await first.close()
    await second.close()
    await dns.close()
  })

  it('drops Authorization when the server redirects to another origin', async () => {
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [first.port, second.port],
      allowedRanges: ['127.0.0.1/32'],
      maxRedirects: 1,
    })
    const response = await safeFetch(`http://origin-a.test:${first.port}/`, {
      headers: { authorization: 'Bearer secret-token' },
    })
    assert.equal(await response.text(), 'no-authorization')
  })
})
