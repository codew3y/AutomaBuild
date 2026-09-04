/**
 * The credential routes, over the real server.
 *
 * Injected rather than served on a port, and skipped when there is no
 * database — the same rule the rest of the integration tests follow.
 *
 * What matters here is not that a row can be written. It is that the plaintext
 * cannot come back out: three routes exist and none of them returns a key,
 * because an endpoint that did would turn any authenticated request into every
 * key the tenant owns.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { buildServer, type RunningServer } from '../src/server.ts'
import { loadConfig } from '../src/config.ts'

const KEY = 'a-test-encryption-passphrase'
const SECRET = 'gsk_the_key_that_must_not_come_back'

/*
  The suite runs with no .env — deliberately, so a laptop and CI agree — so
  the settings the server refuses to start without are supplied here. They are
  test values and the encryption key is one of them.
*/
process.env.WEBHOOK_SECRETS ??= 'whsec_credentials_test'
process.env.ENCRYPTION_KEY ??= KEY

/**
 * Whether Postgres is reachable, and nothing else.
 *
 * Split from configuration on purpose: catching both together reported "no
 * database" for a missing environment variable, which sent me looking at
 * Docker for a problem that was not there.
 */
async function databaseUp(): Promise<boolean> {
  try {
    const { createPool } = await import('automa-durable-runner')
    const pool = createPool(loadConfig().runnerDb)
    try {
      await pool.query('select 1')
      return true
    } finally {
      await pool.end()
    }
  } catch {
    return false
  }
}

describe('credentials over HTTP', async () => {
  if (!(await databaseUp())) {
    it('skipped — no database: run `npm run db:up && npm run db:migrate`', () => {})
    return
  }

  let server: RunningServer

  before(async () => {
    server = await buildServer({ startWorker: false })
  })

  after(async () => {
    await server.close()
  })

  it('creates one, and never echoes the key back', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { name: `test ${Date.now()}`, provider: 'groq', secret: SECRET },
    })

    assert.equal(created.statusCode, 201)
    const body = created.body
    assert.equal(body.includes(SECRET), false, 'the key must not be in the response')
    assert.equal(body.includes('gsk_'), false)

    const row = created.json() as { credentialId: string; name: string; provider: string }
    assert.match(row.credentialId, /^[0-9a-f-]{36}$/)
    assert.equal(row.provider, 'groq')

    // And it is listed, still without the key.
    const listed = await server.app.inject({ method: 'GET', url: '/api/credentials' })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.body.includes(SECRET), false, 'the listing must not carry keys either')
    assert.equal(
      (listed.json() as { credentialId: string }[]).some((c) => c.credentialId === row.credentialId),
      true,
    )

    // Deleting it removes it from the listing.
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/credentials/${row.credentialId}`,
    })
    assert.equal(removed.statusCode, 200)

    const after = await server.app.inject({ method: 'GET', url: '/api/credentials' })
    assert.equal(
      (after.json() as { credentialId: string }[]).some((c) => c.credentialId === row.credentialId),
      false,
    )
  })

  it('refuses the same name twice for one provider', async () => {
    // Two credentials with one name are indistinguishable in a picker, which
    // is the only place a name is ever used.
    const name = `duplicate ${Date.now()}`
    const first = await server.app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { name, provider: 'groq', secret: SECRET },
    })
    assert.equal(first.statusCode, 201)

    const second = await server.app.inject({
      method: 'POST',
      url: '/api/credentials',
      payload: { name, provider: 'groq', secret: SECRET },
    })
    assert.equal(second.statusCode, 409)

    await server.app.inject({
      method: 'DELETE',
      url: `/api/credentials/${(first.json() as { credentialId: string }).credentialId}`,
    })
  })

  it('refuses an incomplete one, naming what is missing', async () => {
    for (const [payload, expected] of [
      [{ provider: 'groq', secret: 'x' }, /needs a name/],
      [{ name: 'n', secret: 'x' }, /needs a provider/],
      [{ name: 'n', provider: 'groq' }, /needs a key/],
      [{ name: 'n', provider: 'groq', secret: '   ' }, /needs a key/],
    ] as const) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/credentials',
        payload,
      })
      assert.equal(response.statusCode, 400)
      assert.match((response.json() as { error: string }).error, expected)
    }
  })

  it('refuses an id that is not one, rather than querying with it', async () => {
    const response = await server.app.inject({ method: 'DELETE', url: '/api/credentials/nonsense' })
    assert.equal(response.statusCode, 400)
  })

  it('404s a credential this tenant does not have', async () => {
    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/credentials/00000000-0000-4000-8000-000000000abc',
    })
    assert.equal(response.statusCode, 404)
  })
})
