/**
 * The pin.
 *
 * This is the test the library exists to pass. Everything else is a deny-list,
 * and a deny-list that resolves twice is decorative: the attacker answers the
 * first lookup with a public address to pass validation, and the second — the
 * one the socket actually uses — with whatever they want.
 *
 * The assertion is not "the code looks right". It is a query count against a
 * DNS server we own, plus the address the connection actually landed on.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Resolver } from 'node:dns/promises'
import { createSafeFetch, getConnectionInfo, SsrfBlockedError } from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { echoServer, type TestServer } from './helpers/http-server.ts'

const REBIND_NAME = 'rebind.test'

describe('DNS rebinding — resolve, validate, pin', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await echoServer('served by the pinned origin')
    // First A query answers with the address we permit. Every later query
    // answers with the metadata endpoint — the rebind.
    dns = await startDnsServer((name, type, queryIndex) => {
      if (name !== REBIND_NAME || type !== 'A') return []
      return queryIndex === 1 ? ['127.0.0.1'] : ['169.254.169.254']
    })
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  const makeFetch = () =>
    createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      // 127.0.0.1 stands in for "a legitimate public address" so that the
      // fixture can be reached at all. The rebind target stays blocked.
      allowedRanges: ['127.0.0.1/32'],
    })

  it('connects to the validated address and never re-resolves', async () => {
    const safeFetch = makeFetch()
    const queriesBefore = dns.queriesFor('A').length

    const response = await safeFetch(`http://${REBIND_NAME}:${origin.port}/pinned`)

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'served by the pinned origin')

    // Exactly one A query for the whole request. A second would mean the HTTP
    // stack resolved the name again, which is the window this library closes.
    assert.equal(
      dns.queriesFor('A').length - queriesBefore,
      1,
      'the HTTP stack re-resolved: the pin is not holding',
    )

    const info = getConnectionInfo(response)
    assert.equal(info?.resolvedIp, '127.0.0.1', 'connected somewhere unvalidated')
    assert.equal(info?.hostname, REBIND_NAME)
  })

  it('still sends the hostname as Host, so virtual hosting survives the pin', async () => {
    // Pinning must take away resolution, not identity. If we connected by IP
    // and sent the IP as Host, every name-based vhost would break.
    const lastHit = origin.hits.at(-1)
    assert.ok(lastHit?.host?.startsWith(REBIND_NAME), `Host was ${lastHit?.host}`)
  })

  it('the name really did rebind — the second answer is the metadata endpoint', async () => {
    // Proves the fixture is not a no-op: had the stack asked again, this is
    // the answer it would have received.
    const resolver = new Resolver()
    resolver.setServers([`127.0.0.1:${dns.port}`])
    assert.deepEqual(await resolver.resolve4(REBIND_NAME), ['169.254.169.254'])
  })

  it('re-validates on the next request rather than trusting the earlier pass', async () => {
    // A name that was safe a moment ago is not safe now. No caching of the
    // verdict, ever.
    const safeFetch = makeFetch()
    await assert.rejects(
      () => safeFetch(`http://${REBIND_NAME}:${origin.port}/again`),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'metadata-endpoint')
        assert.equal(error.resolvedIp, '169.254.169.254')
        return true
      },
    )
  })
})

describe('the pin refuses to be bypassed', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await echoServer('ok')
    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  it('reports the address it connected to for every successful request', async () => {
    // Layer 4 of the defence is detection, and detection needs this field.
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
    })
    const seen: string[] = []
    const observed = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
      onConnect: (info) => seen.push(`${info.hostname} -> ${info.resolvedIp}`),
    })

    const first = await safeFetch(`http://anything.test:${origin.port}/`)
    await first.text()
    assert.equal(getConnectionInfo(first)?.resolvedIp, '127.0.0.1')

    const second = await observed(`http://anything.test:${origin.port}/`)
    await second.text()
    assert.deepEqual(seen, ['anything.test -> 127.0.0.1'])
  })
})
