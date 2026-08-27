/**
 * The lookup that makes the application multi-tenant.
 *
 * The engine has scoped every table and query by tenant_id since its first
 * migration, so isolation downstream was never the gap. The gap was that
 * nothing at the edge could decide *which* tenant a request was for: one
 * endpoint id in an environment variable meant one tenant.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createPool } from 'automa-durable-runner'
import { EndpointStore, isUuid } from '../src/endpoint-store.ts'
import { loadConfig } from '../src/config.ts'

let pool: ReturnType<typeof createPool>
let store: EndpointStore
let reachable = false

const tenantA = randomUUID()
const tenantB = randomUUID()
const endpointA = randomUUID()
const endpointB = randomUUID()
const disabled = randomUUID()

before(async () => {
  try {
    // WEBHOOK_SECRETS is required by loadConfig and irrelevant here.
    process.env.WEBHOOK_SECRETS ??= 'whsec_test'
    pool = createPool(loadConfig().runnerDb)
    await pool.query('SELECT 1')
    reachable = true
  } catch {
    console.log('  (no database — skipping the endpoint store tests)')
    return
  }

  store = new EndpointStore(pool)
  await store.ensure({ endpointId: endpointA, tenantId: tenantA, flowId: randomUUID(), scheme: 'stripe', secrets: ['sa'] })
  await store.ensure({ endpointId: endpointB, tenantId: tenantB, flowId: randomUUID(), scheme: 'github', secrets: ['sb1', 'sb2'] })
  await store.ensure({ endpointId: disabled, tenantId: tenantA, flowId: randomUUID(), scheme: 'stripe', secrets: ['sd'] })
  await pool.query(`UPDATE endpoints SET disabled_at = now() WHERE endpoint_id = $1`, [disabled])
})

after(async () => {
  if (!reachable) return
  await pool.query(`DELETE FROM endpoints WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]])
  await pool.end()
})

describe('resolving an endpoint', () => {
  it('gives back the tenant that owns it', async (t) => {
    if (!reachable) return t.skip('no database')
    const found = await store.forDelivery(endpointA)
    assert.equal(found?.tenantId, tenantA)
  })

  it('keeps every secret, so rotation is not an outage', async (t) => {
    if (!reachable) return t.skip('no database')
    const found = await store.forDelivery(endpointB)
    assert.deepEqual(found?.secrets, ['sb1', 'sb2'])
  })

  it('carries the scheme per endpoint, since one tenant may receive from several senders', async (t) => {
    if (!reachable) return t.skip('no database')
    assert.equal((await store.forDelivery(endpointA))?.scheme, 'stripe')
    assert.equal((await store.forDelivery(endpointB))?.scheme, 'github')
  })

  it('treats a disabled endpoint as absent', async (t) => {
    if (!reachable) return t.skip('no database')
    // The same answer an unknown id gets. Saying "exists but switched off"
    // confirms the id, and there is nothing the caller can do with that.
    assert.equal(await store.forDelivery(disabled), null)
    // Still readable by the control API, which needs to show it.
    assert.notEqual(await store.byId(disabled), null)
  })

  it('returns null for an unknown id rather than throwing', async (t) => {
    if (!reachable) return t.skip('no database')
    assert.equal(await store.forDelivery(randomUUID()), null)
  })

  it('returns null for a malformed id rather than raising a type error', async (t) => {
    if (!reachable) return t.skip('no database')
    // Postgres would raise on a bad uuid, and that would be a 500 for what is
    // a 404.
    assert.equal(await store.forDelivery('not-a-uuid'), null)
    assert.equal(await store.forDelivery("'; DROP TABLE endpoints; --"), null)
  })

  it('lists only the asking tenant', async (t) => {
    if (!reachable) return t.skip('no database')
    const forA = await store.listForTenant(tenantA)
    assert.equal(forA.length, 2)
    assert.ok(forA.every((endpoint) => endpoint.tenantId === tenantA))
  })

  it('does not overwrite an endpoint that already exists', async (t) => {
    if (!reachable) return t.skip('no database')
    // ensure() runs on every boot. An upsert would clobber a secret someone
    // had rotated by hand each time the process restarted.
    await store.ensure({
      endpointId: endpointA,
      tenantId: tenantA,
      flowId: randomUUID(),
      scheme: 'slack',
      secrets: ['replaced'],
    })
    const found = await store.forDelivery(endpointA)
    assert.deepEqual(found?.secrets, ['sa'])
    assert.equal(found?.scheme, 'stripe')
  })
})

describe('uuid checking', () => {
  it('accepts a uuid in either case', () => {
    assert.equal(isUuid('00000000-0000-4000-8000-0000000000E1'), true)
  })

  it('rejects anything else', () => {
    assert.equal(isUuid('nope'), false)
    assert.equal(isUuid(''), false)
    assert.equal(isUuid('00000000-0000-4000-8000-0000000000e1x'), false)
  })
})
