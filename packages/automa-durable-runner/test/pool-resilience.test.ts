/**
 * A dropped idle connection must not take the process down.
 *
 * `pg.Pool` emits `error` when a client sitting idle in the pool fails — the
 * database restarted, a proxy dropped it, the network blinked. In Node an
 * `error` event with no listener is rethrown, so a pool with no handler kills
 * the process. This was not hypothetical: it crashed the AutomaBuild server
 * the first time `docker compose restart` touched Postgres, with a stack trace
 * from inside pg-protocol and no request to blame it on.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createPool } from '../src/db/client.ts'

const pool = createPool()
const admin = createPool()

after(async () => {
  await Promise.all([pool.end(), admin.end()])
})

describe('pool resilience', () => {
  it('survives every idle connection being terminated, and still works after', async () => {
    // Open a connection and return it to the pool, so there is an idle client
    // for the kill to land on.
    await pool.query('SELECT 1')

    // What an operator restarting the database looks like from in here.
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()`,
    )

    // If the handler were missing the process would already be gone, and this
    // test would fail by taking the whole run with it rather than by
    // asserting. That is the honest shape of the check.
    await new Promise((resolve) => setTimeout(resolve, 800))

    const { rows } = await pool.query('SELECT 42 AS answer')
    assert.equal(rows[0]?.answer, 42, 'the pool must reconnect rather than stay broken')
  })

  it('has a listener attached, so the event can never be unhandled', () => {
    // The property stated directly, in case the behavioural test above is ever
    // made to pass some other way.
    assert.ok(createPool().listenerCount('error') > 0)
  })
})
