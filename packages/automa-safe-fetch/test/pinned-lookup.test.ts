/**
 * The failsafe inside the pin.
 *
 * `createPinnedLookup` hands the HTTP stack one address and refuses to answer
 * for any other name. In normal operation the refusal branch is unreachable —
 * which is exactly why it needs a test. An untested failsafe is a comment.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LookupAddress } from 'node:dns'
import { createPinnedLookup } from '../src/safe-fetch.ts'
import { SsrfBlockedError } from '../src/errors.ts'

const lookup = createPinnedLookup({
  expectedHostname: 'pinned.test',
  pinned: { text: '198.51.100.7', family: 4 },
  url: 'http://pinned.test/',
})

/** Promisified so the callback shape is exercised exactly as Node uses it. */
function call(
  hostname: string,
  options: unknown,
): Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => {
      resolve({ error, address, ...(family === undefined ? {} : { family }) })
    })
  })
}

describe('createPinnedLookup', () => {
  it('answers with the validated address for the pinned name', async () => {
    const result = await call('pinned.test', {})
    assert.equal(result.error, null)
    assert.equal(result.address, '198.51.100.7')
    assert.equal(result.family, 4)
  })

  it('honours the { all: true } form Node uses on some paths', async () => {
    const result = await call('pinned.test', { all: true })
    assert.equal(result.error, null)
    assert.deepEqual(result.address, [{ address: '198.51.100.7', family: 4 }])
  })

  it('refuses to resolve any other name', async () => {
    // Reaching here means something in the stack re-resolved behind our back.
    // The request must die rather than continue unpinned.
    const result = await call('somewhere-else.test', {})
    assert.ok(result.error instanceof SsrfBlockedError)
    assert.equal(result.error.reason, 'unpinned-resolution')
    assert.equal(result.error.hostname, 'somewhere-else.test')
    assert.equal(result.address, '')
  })

  it('is not fooled by a name that merely looks similar', async () => {
    for (const impostor of ['pinned.test.evil.com', 'PINNED.TEST', 'pinned.tes', '']) {
      const result = await call(impostor, {})
      assert.ok(
        result.error instanceof SsrfBlockedError,
        `${JSON.stringify(impostor)} was answered as if it were the pinned host`,
      )
    }
  })

  it('carries an IPv6 pin through unchanged', async () => {
    const v6 = createPinnedLookup({
      expectedHostname: 'six.test',
      pinned: { text: '2001:db8::1', family: 6 },
      url: 'http://six.test/',
    })
    const result = await new Promise<{ address: unknown; family?: number }>((resolve) => {
      v6('six.test', {}, (_error, address, family) => resolve({ address, family }))
    })
    assert.equal(result.address, '2001:db8::1')
    assert.equal(result.family, 6)
  })
})
