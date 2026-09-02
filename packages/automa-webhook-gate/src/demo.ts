/**
 * The demo service.
 *
 *   npm run demo
 *
 * A page with four buttons — genuine, forged, replayed, oversized — that sends
 * each request for real and shows what came back. The point is not that it
 * looks nice; it is that the three attacks are visible as HTTP responses
 * rather than as claims in a README.
 *
 * The page signs requests in the browser using a demo secret the server also
 * knows. That is obviously not how a real integration works — the secret would
 * never leave the sender — but here both sides are the demo, and the
 * alternative is a page that cannot produce a valid signature and therefore
 * cannot show the interesting case.
 */

import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { createGate, type EndpointConfig } from './gate.ts'
import { MemoryReplayStore } from './replay/memory.ts'
import { PostgresReplayStore } from './replay/postgres.ts'
import { createPool } from './db.ts'
import { registerRawBody, registerWebhookRoute } from './fastify.ts'
import type { ReplayStore } from './replay/store.ts'

const DEMO_ENDPOINT = '11111111-1111-4111-8111-111111111111'
const DEMO_SECRET = 'whsec_demo_do_not_use_in_production'

/** Use Postgres when it is there, so the demo shows the real store. */
async function chooseStore(): Promise<{ store: ReplayStore; backend: string }> {
  const pool = createPool()
  try {
    await pool.query('SELECT 1 FROM webhook_deliveries LIMIT 1')
    return { store: new PostgresReplayStore(pool), backend: 'postgres' }
  } catch {
    await pool.end().catch(() => {})
    return { store: new MemoryReplayStore(), backend: 'memory (no database reachable)' }
  }
}

const { store, backend } = await chooseStore()
const app = Fastify({ logger: false })

const endpoint: EndpointConfig = {
  endpointId: DEMO_ENDPOINT,
  scheme: 'github',
  secrets: [DEMO_SECRET],
}

const received: Array<{ at: string; outcome: string; status: number; delivery: string }> = []

await app.register(async (scope) => {
  registerRawBody(scope, { maxBodyBytes: 1024 })
  registerWebhookRoute(scope, {
    gate: createGate({ store }),
    lookup: (id) => (id === DEMO_ENDPOINT ? endpoint : null),
  })

  // Record every outcome for the page, including the rejections — which the
  // route deliberately does not reveal to the caller in detail.
  scope.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/webhooks/')) return
    received.unshift({
      at: new Date().toISOString().slice(11, 19),
      outcome: String(reply.statusCode),
      status: reply.statusCode,
      delivery: String(request.headers['x-github-delivery'] ?? '—'),
    })
    received.splice(20)
  })
})

app.get('/', async (_request, reply) => {
  reply.type('text/html').send(PAGE)
})

app.get('/api/secret', async () => ({ secret: DEMO_SECRET, endpointId: DEMO_ENDPOINT }))
app.get('/api/log', async () => received)

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '127.0.0.1' })
console.log(`\n  demo on http://127.0.0.1:${port}`)
console.log(`  replay store: ${backend}\n`)

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>automa-webhook-gate</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --ok: #1a7f37; --bad: #b3261e; --warn: #9a6700; }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 46rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  p.lede { margin: 0 0 2rem; opacity: .75; }
  section { border-top: 1px solid var(--line); padding: 1.25rem 0; }
  h2 { font-size: .95rem; margin: 0 0 .35rem; }
  h2 code { font-weight: 400; opacity: .7; }
  p.what { margin: 0 0 .8rem; opacity: .75; font-size: .9rem; }
  button { font: inherit; padding: .45rem .9rem; border: 1px solid var(--line); border-radius: .4rem; background: transparent; cursor: pointer; }
  button:hover { border-color: currentColor; }
  .result { margin-top: .7rem; font-family: ui-monospace, monospace; font-size: .85rem; white-space: pre-wrap; min-height: 1.4em; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, monospace; font-size: .82rem; }
  td, th { text-align: left; padding: .25rem .5rem .25rem 0; border-bottom: 1px solid var(--line); }
  footer { margin-top: 2rem; font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
<h1>automa-webhook-gate</h1>
<p class="lede">Four requests, sent for real. Watch what the gate does with each.</p>

<section>
  <h2>1 · A genuine delivery <code>expect 200</code></h2>
  <p class="what">Correctly signed, fresh, and never seen before.</p>
  <button data-case="genuine">Send</button>
  <div class="result" id="r-genuine"></div>
</section>

<section>
  <h2>2 · A forged signature <code>expect 401</code></h2>
  <p class="what">Same body, signature replaced with zeroes — what an attacker
  sends when they know the payload format but not the secret.</p>
  <button data-case="forged">Send</button>
  <div class="result" id="r-forged"></div>
</section>

<section>
  <h2>3 · A replay <code>expect 200, duplicate</code></h2>
  <p class="what">A byte-for-byte copy of a delivery already accepted — captured
  off the wire and sent again. The signature is <em>valid</em>: it really did
  come from the sender. Only the store knows it is not new.</p>
  <button data-case="replay">Send twice</button>
  <div class="result" id="r-replay"></div>
</section>

<section>
  <h2>4 · An oversized body <code>expect 413</code></h2>
  <p class="what">Rejected on the way in, before the bytes are assembled or
  hashed — otherwise the memory is already spent by the time the limit applies.</p>
  <button data-case="oversized">Send</button>
  <div class="result" id="r-oversized"></div>
</section>

<section>
  <h2>What the server saw</h2>
  <table><thead><tr><th>time</th><th>delivery id</th><th>status</th></tr></thead>
  <tbody id="log"></tbody></table>
</section>

<footer>
  The browser signs with a demo secret the server also knows, which is not how a
  real integration works — a secret never leaves the sender. Here both sides are
  the demo, and a page that cannot sign cannot show the interesting case.
</footer>

<script type="module">
const { secret, endpointId } = await (await fetch('/api/secret')).json()
const url = '/webhooks/' + endpointId

async function sign(body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return 'sha256=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const post = (body, headers) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

function show(id, response, payload) {
  const el = document.getElementById('r-' + id)
  const cls = response.status === 200 ? (payload.duplicate ? 'warn' : 'ok') : 'bad'
  el.className = 'result ' + cls
  el.textContent = response.status + '  ' + JSON.stringify(payload)
  refresh()
}

async function refresh() {
  const rows = await (await fetch('/api/log')).json()
  document.getElementById('log').innerHTML = rows
    .map(r => '<tr><td>' + r.at + '</td><td>' + r.delivery + '</td><td>' + r.status + '</td></tr>')
    .join('')
}

const cases = {
  async genuine() {
    const body = JSON.stringify({ event: 'invoice.paid', at: Date.now() })
    const r = await post(body, { 'x-hub-signature-256': await sign(body), 'x-github-delivery': 'genuine-' + Date.now() })
    show('genuine', r, await r.json())
  },
  async forged() {
    const body = JSON.stringify({ event: 'invoice.paid', amount: 1000000 })
    const r = await post(body, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64), 'x-github-delivery': 'forged-' + Date.now() })
    show('forged', r, await r.json())
  },
  async replay() {
    const body = JSON.stringify({ event: 'invoice.paid', at: Date.now() })
    const headers = { 'x-hub-signature-256': await sign(body), 'x-github-delivery': 'replay-' + Date.now() }
    const first = await post(body, headers); const firstBody = await first.json()
    const second = await post(body, headers); const secondBody = await second.json()
    const el = document.getElementById('r-replay')
    el.className = 'result ' + (secondBody.duplicate ? 'warn' : 'bad')
    el.textContent =
      'first   ' + first.status + '  ' + JSON.stringify(firstBody) + '\\n' +
      'replay  ' + second.status + '  ' + JSON.stringify(secondBody) +
      (secondBody.duplicate ? '\\n\\naccepted once, and the identical request was recognised.' : '')
    refresh()
  },
  async oversized() {
    const body = JSON.stringify({ pad: 'x'.repeat(4096) })
    const r = await post(body, { 'x-hub-signature-256': await sign(body), 'x-github-delivery': 'big-' + Date.now() })
    let payload; try { payload = await r.json() } catch { payload = { error: 'payload too large' } }
    show('oversized', r, payload)
  },
}

for (const button of document.querySelectorAll('button[data-case]')) {
  button.addEventListener('click', () => cases[button.dataset.case]())
}
refresh()
</script>
</body>
</html>`
