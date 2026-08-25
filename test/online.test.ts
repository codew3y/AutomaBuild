/**
 * The other half of the exit criteria: legitimate requests must still work.
 *
 * A library that blocks everything passes every test in the bypass corpus and
 * is useless. These hit the real network, so they are opt-in — the rest of the
 * suite stays hermetic and CI-safe.
 *
 *   npm run test:online
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSafeFetch, getConnectionInfo, SsrfBlockedError } from '../src/index.ts'

const ONLINE = process.env.SAFE_FETCH_ONLINE === '1'

describe('real public endpoints', { skip: ONLINE ? false : 'set SAFE_FETCH_ONLINE=1' }, () => {
  const safeFetch = createSafeFetch({ timeoutMs: 15_000 })

  it('fetches a public HTTPS page over a pinned connection', async () => {
    const response = await safeFetch('https://example.com/')
    assert.equal(response.status, 200)

    const body = await response.text()
    assert.ok(body.includes('Example Domain'), 'body did not look like example.com')

    const info = getConnectionInfo(response)
    assert.ok(info, 'connection info must be recorded for the audit log')
    assert.equal(info.hostname, 'example.com')
    assert.ok(info.resolvedIp.length > 0)
  })

  it('validates the certificate against the hostname, not the pinned IP', async () => {
    // The pin replaces resolution only. If it also replaced identity, TLS
    // verification would fail here — the certificate does not name an IP.
    const response = await safeFetch('https://api.github.com/zen')
    assert.equal(response.status, 200)
    assert.ok((await response.text()).length > 0)
  })

  it('still blocks the metadata endpoint when the network is real', async () => {
    await assert.rejects(
      () => safeFetch('http://169.254.169.254/latest/meta-data/'),
      SsrfBlockedError,
    )
  })
})
