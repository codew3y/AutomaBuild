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
import { DEMO_FLOW } from './demo-flow.ts'

const PORT = 8099
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'

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

  // Checked once, up front: a demo that silently skips the email assertions
  // because a container is not up would read as a full pass.
  const mailpit = await mailpitReachable()

  const server = await buildServer({ config })
  await server.app.listen({ port: PORT, host: '127.0.0.1' })

  if (mailpit !== null) await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' })

  const base = `http://127.0.0.1:${PORT}`
  const endpoint = `${base}/webhooks/${config.endpointId}`

  try {
    rule()
    line('  AutomaBuild — the four components, end to end')
    rule()
    line()

    // --------------------------------------------------------------- publish
    // Published first, so everything below asserts against a known flow. Without
    // this the demo would check whatever happened to be live on this machine,
    // and would pass or fail depending on what someone published last.
    const seeded = await fetch(`${base}/api/flows/published`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph: DEMO_FLOW, publishedBy: 'demo' }),
    })
    if (seeded.status !== 201) throw new Error(`could not publish the demo flow (${seeded.status})`)
    line(`0. Published the demo flow: trigger → http → transform → email.`)
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
        steps: {
          nodeId: string
          outcome: string
          durationMs?: number
          attempts?: number
          output?: unknown
        }[]
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

    // ------------------------------------------------------------ transform
    line('5. The transform combined two sources, keeping types.')
    const shape = finished.steps.find((step) => step.nodeId === 'shape')
    if (shape === undefined) throw new Error('the transform step is missing from the run')
    if (shape.outcome !== 'succeeded') {
      throw new Error(`the transform did not succeed (${shape.outcome})`)
    }

    const output = shape.output as Record<string, unknown> | undefined
    line(`   ${JSON.stringify(output)}`)

    if (output?.['repo'] !== 'nodejs/node') {
      throw new Error('the transform did not resolve its reference to the HTTP step')
    }
    if (output?.['amount'] !== 4200) {
      // Both halves matter: that the webhook payload reached the transform at
      // all, and that a number came back as a number. Resolving into the text
      // of the template and parsing afterwards would give the string "4200".
      throw new Error(
        `expected the number 4200 from the webhook payload, got ${JSON.stringify(output?.['amount'])}`,
      )
    }
    line()

    // ---------------------------------------------------------------- email
    line('6. A real email was composed and accepted by an SMTP server.')
    const notify = finished.steps.find((step) => step.nodeId === 'notify')
    if (notify === undefined) throw new Error('the email step is missing from the run')

    if (mailpit === null) {
      // Not a failure: the demo is useful without a mail server, and saying
      // nothing would let a skipped check read as a passing one.
      line('   skipped — no SMTP server at ' + MAILPIT)
    } else {
      if (notify.outcome !== 'succeeded') {
        throw new Error(`the email step did not succeed (${notify.outcome})`)
      }
      const messages = await mailpitMessages()
      const sent = messages.find((message) => message.Subject.includes('nodejs/node'))
      if (sent === undefined) {
        throw new Error('no message with a resolved subject arrived at the mail server')
      }
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${sent.ID}`)).json()) as {
        Text: string
        To: { Address: string }[]
      }
      line(`   To:      ${full.To[0]?.Address}`)
      line(`   Subject: ${sent.Subject}`)
      for (const bodyLine of full.Text.trim().split('\n')) line(`   | ${bodyLine}`)
      if (!full.Text.includes('4200')) {
        throw new Error('the email body did not carry the amount from the webhook')
      }
    }
    line()

    // -------------------------------------------------------------- publish
    line('7. Publishing a new version does not disturb the runs already done.')
    const beforeVersion = (await (await fetch(`${base}/api/flows/published`)).json()) as {
      versionId: string
    }

    const republished = await fetch(`${base}/api/flows/published`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph: DEMO_FLOW, publishedBy: 'demo' }),
    })
    const newVersion = (await republished.json()) as { versionId?: string }
    if (republished.status !== 201) throw new Error(`publish failed (${republished.status})`)
    if (newVersion.versionId === beforeVersion.versionId) {
      throw new Error('publishing must mint a new version, not overwrite the last one')
    }
    line(`   ${beforeVersion.versionId.slice(0, 8)} → ${newVersion.versionId!.slice(0, 8)}`)

    const stillThere = await fetch(`${base}/api/runs/${finished.id}`)
    const reread = (await stillThere.json()) as { steps: unknown[]; graph: { nodes: unknown[] } }
    if (reread.graph.nodes.length === 0) {
      throw new Error('the finished run lost the graph it ran on when a new version was published')
    }
    line(`   run ${finished.id.slice(0, 8)} still renders against its own version`)
    line()

    // ------------------------------------------------------------- refusal
    line('8. A flow that does not compile is refused, with every problem listed.')
    const refused = await fetch(`${base}/api/flows/published`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        graph: {
          nodes: [
            { id: 't', kind: 'trigger', position: { x: 0, y: 0 } },
            { id: 'e', kind: 'email', position: { x: 200, y: 0 }, data: { to: 'a@b.test' } },
          ],
          edges: [{ id: 't->e', source: 't', target: 'e' }],
        },
      }),
    })
    const problems = (await refused.json()) as { problems?: { message: string }[] }
    line(`   ${refused.status} ${JSON.stringify(problems.problems?.map((p) => p.message))}`)
    if (refused.status !== 422) throw new Error(`expected 422, got ${refused.status}`)
    line()

    rule()
    line('  PASS — verified, de-duplicated, run durably, transformed, sent, published.')
    rule()
  } finally {
    await server.close()
  }
}

async function mailpitReachable(): Promise<true | null> {
  try {
    const response = await fetch(`${MAILPIT}/api/v1/info`, { signal: AbortSignal.timeout(2000) })
    return response.ok ? true : null
  } catch {
    return null
  }
}

async function mailpitMessages(): Promise<{ ID: string; Subject: string }[]> {
  const response = await fetch(`${MAILPIT}/api/v1/messages`)
  const body = (await response.json()) as { messages: { ID: string; Subject: string }[] }
  return body.messages
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
