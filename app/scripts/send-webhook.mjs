/**
 * Fire one signed webhook at a running server.
 *
 * The demo publishes its own flow and asserts a fixed outcome, which makes it a
 * test rather than a tool. This is the tool: it signs a delivery the way Stripe
 * does and sends it, so whatever flow is currently published is what runs.
 *
 *   npm run send
 *   npm run send -- --amount 9900 --currency eur
 *   npm run send -- --repeat        (same event id twice, to see the gate refuse)
 *
 * The signature is computed here rather than being pasted in, because a
 * hand-made one is stale within the tolerance window and the failure looks
 * like a bug in the verifier.
 */

import { createHmac, randomUUID } from 'node:crypto'

const args = process.argv.slice(2)

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1]
}

const PORT = flag('port', process.env.PORT ?? '8080')
const BASE = flag('base', `http://127.0.0.1:${PORT}`)
const ENDPOINT = flag('endpoint', process.env.ENDPOINT_ID ?? '00000000-0000-4000-8000-0000000000e1')

const secrets = (process.env.WEBHOOK_SECRETS ?? process.env.WEBHOOK_SECRET ?? '')
  .split(',')
  .map((secret) => secret.trim())
  .filter((secret) => secret !== '')

if (secrets.length === 0) {
  console.error('WEBHOOK_SECRETS is not set — it has to match the server you are sending to.')
  process.exit(1)
}

const payload = JSON.stringify({
  id: `evt_${randomUUID().slice(0, 12)}`,
  type: flag('type', 'invoice.paid'),
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      amount_paid: Number(flag('amount', '4200')),
      currency: flag('currency', 'chf'),
      customer_email: flag('email', 'sam@example.test'),
    },
  },
})

const timestamp = Math.floor(Date.now() / 1000)
const signature = createHmac('sha256', secrets[0]).update(`${timestamp}.${payload}`).digest('hex')

const headers = {
  'content-type': 'application/json',
  'stripe-signature': `t=${timestamp},v1=${signature}`,
}

const url = `${BASE}/webhooks/${ENDPOINT}`

async function send(label) {
  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: payload })
  } catch (error) {
    // A refused connection is the ordinary case — the server is not running —
    // and a raw stack trace makes it look like something broke.
    if ((error?.cause?.code ?? error?.code) === 'ECONNREFUSED') {
      console.error(`Nothing is listening on ${BASE}.`)
      console.error('Start the server first:  npm start')
      process.exit(1)
    }
    throw error
  }
  const body = await response.text()
  console.log(`${label}  ${response.status}  ${body}`)
  return response
}

console.log(`POST ${url}`)
console.log(`     ${payload}`)
console.log()

const first = await send('sent    ')

// The same bytes and the same signature: a genuine re-delivery, which the gate
// must answer as a duplicate without starting a second run.
if (args.includes('--repeat')) await send('repeated')

if (!first.ok) process.exit(1)

console.log()
console.log(`Watch it run:  ${BASE}/api/runs/latest`)
console.log(`In the editor: ${BASE}/  →  History`)
