/**
 * The end-to-end demo.
 *
 * Starts the server, signs a webhook the way Stripe does, sends it, waits for
 * the run to finish, and prints what the API gives back. Then it sends the
 * exact same delivery again to show that it does not start a second run.
 *
 * It fails the process if any of that does not hold. A demo that prints
 * something reassuring regardless of what happened is worse than no demo:
 * three separate versions of this project's chaos demo passed while proving
 * nothing, and each time the fix was to make the check specific.
 */

import { createHmac, randomUUID } from 'node:crypto'

import { loadConfig } from './config.ts'
import { buildServer } from './server.ts'

const PORT = 8099

function stripeSignature(payload: string, secret: string, timestamp: number): string {
  const signed = `${timestamp}.${payload}`
  const v1 = createHmac('sha256', secret).update(signed).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

async function waitFor<T>(
  what: string,
  attempt: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await attempt()
    if (result !== null) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const line = (text = '') => console.log(text)
const rule = () => line('─'.repeat(64))

async function main(): Promise<void> {
  const config = { ...loadConfig(), port: PORT }
  const secret = config.secrets[0]!

  const server = await buildServer({ config })
  await server.app.listen({ port: PORT, host: '127.0.0.1' })

  const base = `http://127.0.0.1:${PORT}`
  const endpoint = `${base}/webhooks/${config.endpointId}`

  try {
    rule()
    line('  AutomaBuild — the four components, end to end')
    rule()
    line()

    // ---------------------------------------------------------------- forged
    line('1. A forged signature is rejected, and says nothing about why.')
    // A current timestamp with a wrong digest. The tolerance window is checked
    // before the HMAC is computed — which is right, since an obviously stale
    // delivery should not cost a signature verification — so a forgery dated
    // 1970 would come back as stale and never exercise this path at all.
    const forged = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'de'.repeat(32)}`,
      },
      body: JSON.stringify({ id: 'evt_forged' }),
    })
    line(`   ${forged.status} ${JSON.stringify(await forged.json())}`)
    if (forged.status !== 401) throw new Error(`expected 401, got ${forged.status}`)
    line()

    // ------------------------------------------------------------------ stale
    line('2. A correctly signed but stale delivery is rejected too.')
    const stalePayload = JSON.stringify({ id: 'evt_stale' })
    const staleAt = Math.floor(Date.now() / 1000) - 3600
    const stale = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(stalePayload, secret, staleAt),
      },
      body: stalePayload,
    })
    line(`   ${stale.status} ${JSON.stringify(await stale.json())}`)
    if (stale.status !== 400) throw new Error(`expected 400, got ${stale.status}`)
    line()

    // ------------------------------------------------------------------ real
    const eventId = `evt_${randomUUID().slice(0, 12)}`
    const payload = JSON.stringify({
      id: eventId,
      type: 'invoice.paid',
      data: { object: { amount_paid: 4200, currency: 'chf' } },
    })
    const now = Math.floor(Date.now() / 1000)
    const headers = {
      'content-type': 'application/json',
      'stripe-signature': stripeSignature(payload, secret, now),
    }

    line(`3. A genuine delivery (${eventId}) starts a durable run.`)
    const accepted = await fetch(endpoint, { method: 'POST', headers, body: payload })
    line(`   ${accepted.status} ${JSON.stringify(await accepted.json())}`)
    if (accepted.status !== 200) throw new Error(`expected 200, got ${accepted.status}`)

    const finished = await waitFor('the run to finish', async () => {
      const response = await fetch(`${base}/api/runs/latest`)
      if (!response.ok) return null
      const run = (await response.json()) as {
        id: string
        status: string
        steps: { nodeId: string; outcome: string; durationMs?: number; attempts?: number }[]
      }
      return run.status === 'running' ? null : run
    })

    line(`   run ${finished.id} — ${finished.status}`)
    for (const step of finished.steps) {
      const ms = step.durationMs === undefined ? '' : ` ${step.durationMs}ms`
      const tries = (step.attempts ?? 0) > 1 ? ` (${step.attempts} attempts)` : ''
      line(`     ${step.outcome.padEnd(12)} ${step.nodeId}${ms}${tries}`)
    }
    line()

    // ------------------------------------------------------------- duplicate
    line('4. The same delivery again — no second run.')
    const before = await countRuns(base)
    const duplicate = await fetch(endpoint, { method: 'POST', headers, body: payload })
    const duplicateBody = (await duplicate.json()) as { duplicate?: boolean }
    line(`   ${duplicate.status} ${JSON.stringify(duplicateBody)}`)
    if (duplicateBody.duplicate !== true) {
      throw new Error(`expected the gate to call this a duplicate, got ${JSON.stringify(duplicateBody)}`)
    }

    const after = await countRuns(base)
    line(`   runs before ${before}, after ${after}`)
    if (after !== before) throw new Error(`a duplicate delivery created ${after - before} extra run(s)`)
    line()

    // -------------------------------------------------------------- mapping
    line('5. The mapped URL resolved against real upstream output.')
    const record = finished.steps.find((step) => step.nodeId === 'record')
    if (record === undefined) throw new Error('the mapped step is missing from the run')
    if (record.outcome !== 'succeeded') {
      throw new Error(
        `the mapped step did not succeed (${record.outcome}). ` +
          `The URL contains {{ steps.lookup.output.body.full_name }}; if it had not ` +
          `resolved, the request would have gone out with the braces still in it.`,
      )
    }
    line(`   ${record.nodeId} succeeded, so {{ steps.lookup.output.body.full_name }} resolved.`)
    line()

    rule()
    line('  PASS — verified, de-duplicated, executed durably, mapped, and served.')
    rule()
  } finally {
    await server.close()
  }
}

async function countRuns(base: string): Promise<number> {
  const response = await fetch(`${base}/api/runs`)
  return ((await response.json()) as unknown[]).length
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\nFAIL — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
