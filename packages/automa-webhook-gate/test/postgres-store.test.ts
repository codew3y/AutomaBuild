/**
 * The Postgres replay store.
 *
 * These need the database:
 *
 *   npm run db:up && npm run db:migrate && npm test
 *
 * They skip themselves when nothing is listening, so the pure suite still runs
 * with no infrastructure at all.
 *
 * The test that matters is the concurrent one. An in-memory store cannot prove
 * anything about simultaneous delivery — the whole question is what two
 * database connections do at the same instant, and a `Map` has no instants.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool, dbConfigFromEnv } from '../src/db.ts'
import { PostgresReplayStore } from '../src/replay/postgres.ts'
import { createGate, type EndpointConfig } from '../src/gate.ts'
import { createHmac } from 'node:crypto'

async function reachable(): Promise<boolean> {
  const probe = createPool(dbConfigFromEnv())
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => {})
  }
}

const SKIP = (await reachable())
  ? false
  : 'no database — run `npm run db:up && npm run db:migrate`'

const SECRET = 'whsec_pg_secret'
const BODY = '{"event":"charge.refunded"}'
const NOW = new Date('2026-03-01T12:00:00Z')

describe('PostgresReplayStore', { skip: SKIP }, () => {
  let pool: Pool
  let store: PostgresReplayStore
  let endpointId: string

  before(() => {
    pool = createPool()
    store = new PostgresReplayStore(pool)
  })
  beforeEach(() => {
    // A fresh endpoint per test, so tests cannot collide through the table.
    endpointId = randomUUID()
  })
  after(async () => {
    await pool.end()
  })

  const record = (dedupKey: string, receivedAt = NOW) =>
    store.record({ endpointId, dedupKey, outcome: 'accepted' as const, receivedAt })

  it('accepts a key once and reports the second as a duplicate', async () => {
    const first = await record('evt-1')
    const second = await record('evt-1')

    assert.equal(first.first, true)
    assert.equal(second.first, false)
    assert.equal(second.originallyAt?.toISOString(), NOW.toISOString())
  })

  it('lets exactly one of ten simultaneous copies through', async () => {
    // The property the whole table exists for, and the one an in-memory store
    // cannot demonstrate: ten connections racing on the same key. A SELECT
    // then INSERT would let several of them find nothing and all proceed.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => record('stampede')),
    )
    const accepted = results.filter((result) => result.first)
    assert.equal(accepted.length, 1, `${accepted.length} copies were accepted, expected 1`)
  })

  it('keeps keys separate per endpoint', async () => {
    const other = randomUUID()
    assert.equal((await record('shared')).first, true)
    assert.equal(
      (
        await store.record({
          endpointId: other,
          dedupKey: 'shared',
          outcome: 'accepted',
          receivedAt: NOW,
        })
      ).first,
      true,
      'two endpoints may legitimately see the same provider event id',
    )
  })

  it('does not record a rejected delivery', async () => {
    // Otherwise an attacker burns a legitimate delivery's key by claiming it
    // first with a forged signature, and the real one is dropped as a
    // duplicate.
    const rejected = await store.record({
      endpointId,
      dedupKey: 'contested',
      outcome: 'rejected_signature',
      receivedAt: NOW,
    })
    assert.equal(rejected.first, true, 'a rejection reports first so the caller does not treat it as a duplicate')

    const genuine = await record('contested')
    assert.equal(genuine.first, true, 'the genuine delivery was locked out by a forgery')
  })

  it('prunes by age', async () => {
    await record('old', new Date('2026-01-01T00:00:00Z'))
    await record('recent', NOW)

    const removed = await store.prune(new Date('2026-02-01T00:00:00Z'))
    assert.ok(removed >= 1)

    // The pruned key is forgotten, so the same delivery would be accepted
    // again — which is why retention must exceed the timestamp tolerance.
    assert.equal((await record('old', new Date('2026-01-01T00:00:00Z'))).first, true)
    assert.equal((await record('recent')).first, false, 'the recent one should still be remembered')
  })

  it('stores the partition-key-free primary key the design depends on', async () => {
    const { rows } = await pool.query<{ column: string }>(
      `SELECT a.attname AS column
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE t.relname = 'webhook_deliveries' AND c.contype = 'p'
        ORDER BY k.ord`,
    )
    assert.deepEqual(
      rows.map((row) => row.column),
      ['endpoint_id', 'dedup_key'],
      'received_at must NOT be in the primary key, or the constraint is vacuous',
    )
  })

  it('is not partitioned', async () => {
    // If someone partitions this table later, the primary key has to gain the
    // partition key and the replay protection silently stops working.
    const { rows } = await pool.query<{ partitioned: boolean }>(
      `SELECT c.relkind = 'p' AS partitioned FROM pg_class c WHERE c.relname = 'webhook_deliveries'`,
    )
    assert.equal(rows[0]?.partitioned, false)
  })
})

describe('the gate over Postgres', { skip: SKIP }, () => {
  let pool: Pool
  let gate: ReturnType<typeof createGate>
  let endpoint: EndpointConfig

  before(() => {
    pool = createPool()
    gate = createGate({ store: new PostgresReplayStore(pool) })
  })
  beforeEach(() => {
    endpoint = { endpointId: randomUUID(), scheme: 'github', secrets: [SECRET] }
  })
  after(async () => {
    await pool.end()
  })

  const signed = (deliveryId: string) => ({
    rawBody: BODY,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`,
      'x-github-delivery': deliveryId,
    },
    now: NOW,
  })

  it('accepts once and de-duplicates the replay', async () => {
    const first = await gate(endpoint, signed('d-pg-1'))
    const second = await gate(endpoint, signed('d-pg-1'))
    assert.equal(first.outcome, 'accepted')
    assert.equal(second.outcome, 'duplicate')
  })

  it('survives a simultaneous replay', async () => {
    // Two copies of the same captured request hitting two processes at once.
    const [a, b] = await Promise.all([
      gate(endpoint, signed('d-pg-race')),
      gate(endpoint, signed('d-pg-race')),
    ])
    const outcomes = [a.outcome, b.outcome].sort()
    assert.deepEqual(outcomes, ['accepted', 'duplicate'])
  })
})
