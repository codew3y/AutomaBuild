/**
 * The paths reached when something is malformed, broken, or hostile in a way
 * the corpus does not cover — plus the one success path that skips DNS
 * entirely, because the caller supplied an address we permit.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSafeFetch,
  getConnectionInfo,
  SsrfBlockedError,
  type AddressResolver,
} from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { echoServer, type TestServer } from './helpers/http-server.ts'

/** A resolver that fails however the test needs it to. */
function brokenResolver(behaviour: 'servfail' | 'garbage'): AddressResolver {
  if (behaviour === 'garbage') {
    return {
      resolve4: async () => ['this is not an address'],
      resolve6: async () => [],
    }
  }
  const fail = async (): Promise<string[]> => {
    const error = new Error('query failed') as NodeJS.ErrnoException
    error.code = 'ESERVFAIL'
    throw error
  }
  return { resolve4: fail, resolve6: fail }
}

describe('malformed input', () => {
  const safeFetch = createSafeFetch()

  it('refuses a URL that will not parse', async () => {
    for (const bad of ['not a url', 'http://', '://missing-scheme', '']) {
      await assert.rejects(
        () => safeFetch(bad),
        (error: unknown) => {
          assert.ok(error instanceof SsrfBlockedError, `${JSON.stringify(bad)} threw ${error}`)
          assert.equal(error.reason, 'malformed-url')
          return true
        },
      )
    }
  })

  it('refuses a relative URL rather than resolving it against something', async () => {
    await assert.rejects(() => safeFetch('/just/a/path'), SsrfBlockedError)
  })
})

describe('resolver failures', () => {
  it('reports a resolver that cannot answer', async () => {
    const safeFetch = createSafeFetch({ resolver: brokenResolver('servfail') })
    await assert.rejects(
      () => safeFetch('http://example.com/'),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'dns-resolution-failed')
        assert.match(error.message, /ESERVFAIL/)
        return true
      },
    )
  })

  it('refuses an answer it cannot parse rather than guessing', async () => {
    // A resolver returning something that is not an address is either broken
    // or lying. Either way it does not get the benefit of the doubt.
    const safeFetch = createSafeFetch({ resolver: brokenResolver('garbage') })
    await assert.rejects(
      () => safeFetch('http://example.com/'),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'dns-resolution-failed')
        return true
      },
    )
  })

  it('surfaces a connection refused as an ordinary error, not a block', async () => {
    // Nothing is listening. This is a network failure, not an SSRF verdict,
    // and conflating the two would make the alerting useless.
    const safeFetch = createSafeFetch({
      resolver: { resolve4: async () => ['127.0.0.1'], resolve6: async () => [] },
      allowedRanges: ['127.0.0.1/32'],
      allowedPorts: [9],
    })
    await assert.rejects(
      () => safeFetch('http://nothing-here.test:9/'),
      (error: unknown) => {
        assert.ok(!(error instanceof SsrfBlockedError), 'a refused connection is not a block')
        return true
      },
    )
  })
})

describe('an IP literal the caller is allowed to reach', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await echoServer('reached by literal address')
    dns = await startDnsServer(() => [])
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  it('connects without consulting DNS at all', async () => {
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
    })

    const queriesBefore = dns.queries.length
    const response = await safeFetch(`http://127.0.0.1:${origin.port}/literal`)

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'reached by literal address')
    assert.equal(getConnectionInfo(response)?.resolvedIp, '127.0.0.1')
    assert.equal(
      dns.queries.length,
      queriesBefore,
      'an address needs no resolving — DNS should not have been asked',
    )
  })

  it('still refuses a literal outside the allowed ranges', async () => {
    const safeFetch = createSafeFetch({
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
    })
    await assert.rejects(
      () => safeFetch(`http://127.0.0.2:${origin.port}/`),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'blocked-range')
        return true
      },
    )
  })
})
