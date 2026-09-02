# automa-webhook-gate

A webhook receiver that verifies incoming notifications are genuine, recent, and not a replay — before your application acts on them.

> **Status:** in development. Part of the [AutomaBuild](https://github.com/codew3y/AutomaBuild) workflow-automation platform (component B of four).

---

## The problem

A webhook endpoint is a URL that anyone on the internet can POST to. When Stripe tells you a payment succeeded, that message arrives the same way a forged message would.

Three things can go wrong, and they need three different defences:

| Attack | What it looks like | Defence |
|---|---|---|
| **Forgery** | Anyone POSTs `{"event":"payment.succeeded"}` to your URL | Cryptographic signature over the raw body |
| **Replay** | An attacker captures one genuine notification and sends it a thousand times | Timestamp window + delivery de-duplication |
| **Resource abuse** | A 500 MB body, or ten thousand requests a second | Size cap enforced before reading, rate limiting |

Every major provider signs their webhooks — and each one does it differently. Getting any detail wrong silently disables the protection rather than producing an error, which is what makes this worth doing carefully.

## What this does

Verifies inbound webhooks against four signature schemes:

| Provider | Header | Signed content | Window |
|---|---|---|---|
| **Stripe** | `Stripe-Signature` | `timestamp + "." + raw_body` | 5 min default |
| **GitHub** | `X-Hub-Signature-256` | raw body | none — dedupes on `X-GitHub-Delivery` |
| **Slack** | `X-Slack-Signature` + timestamp header | `v0:<ts>:<raw_body>` | 5 min |
| **[Standard Webhooks](https://www.standardwebhooks.com/)** | `webhook-id` / `-timestamp` / `-signature` | `msg_id.timestamp.payload` | configurable |

Plus, on every request:

- **Raw body captured before any JSON parsing.** Re-serialising the body changes the bytes and breaks every signature — this is the single most common implementation bug.
- **Constant-time comparison.** A `===` on a signature leaks the correct value one byte at a time via response timing.
- **Replay protection** — a unique constraint on `(endpoint, event_id)`; a duplicate returns `200 {"duplicate": true}` rather than an error, because retrying is correct behaviour on the sender's part.
- **Body size cap enforced before reading**, not after.
- **Fast acknowledgement.** Accept, persist, return 202. Never do work inside the request — senders time out and retry, and now you have two.
- **Signature rotation support.** Stripe sends multiple valid signatures during a rotation window; a verifier that checks only the first breaks during rotation.

## Try it

```bash
docker compose up -d && npm ci && npm run db:migrate
npm run demo          # http://127.0.0.1:3000
```

Four buttons — genuine, forged, replayed, oversized — each sending a real
request and showing what came back:

```
genuine    200  {"ok":true,"duplicate":false}
forged     401  {"error":"rejected_signature"}
replay     200  {"ok":true,"duplicate":true}
oversized  413  Payload Too Large
```

The third is the interesting one. That request has a **valid signature** — it
really did come from the sender, byte for byte. Only the replay store knows it
is not new.

## Usage

```ts
import { createGate, createPool, PostgresReplayStore } from 'automa-webhook-gate'
import { registerRawBody, registerWebhookRoute } from 'automa-webhook-gate/fastify'

const gate = createGate({ store: new PostgresReplayStore(createPool()) })

registerRawBody(app)          // capture bytes before anything parses them
registerWebhookRoute(app, {
  gate,
  lookup: (id) => endpoints.get(id) ?? null,
  onAccepted: async (endpoint, request, result) => {
    await enqueue(result.dedupKey, request.rawBody)
  },
})
```

Or verify directly, with no framework:

```ts
import { verifyStripe } from 'automa-webhook-gate'

const result = verifyStripe({
  rawBody,                    // Buffer, before JSON.parse
  headers,
  secrets: [current, previous],   // both, during a rotation
  toleranceSeconds: 300,
})
if (!result.ok) return reply.code(401).send()
```

`secrets` is a list, not a value. During a rotation a sender may still be
signing with the old secret, and refusing those is a self-inflicted outage.

## Three ordering decisions

Each is a test, because this is where replay protection gets quietly undone.

**The signature is checked before the store is touched.** An unauthenticated
request must never write a row, or anyone who can reach the endpoint can fill
the table.

**Rejected deliveries are not recorded.** Otherwise an attacker burns a real
delivery's key by claiming it first with a forged signature — the genuine one
arrives moments later and is dismissed as a duplicate. Replay protection turned
into a denial of service.

**A duplicate returns 200, not 4xx.** A sender retrying because it never saw
your response is behaving correctly. An error makes it retry harder.

## On the replay store

`webhook_deliveries` is **deliberately not partitioned**, and the migration
explains why at length so nobody helpfully partitions it later.

A unique key on a partitioned table must contain the partition key. Partition
by `received_at` — which defaults to `now()` — and every insert produces a
distinct key: the constraint then rejects only two deliveries landing in the
same microsecond, which is not a thing that happens and is not what replay
protection is for. It reads correctly, passes review, and prevents nothing.

The check and the record are one `INSERT ... ON CONFLICT DO NOTHING`. A
`SELECT` then `INSERT` leaves a window where two copies of a replayed request
both find nothing and are both accepted. There is a test that fires ten
simultaneous copies and asserts exactly one gets through.

## Also outbound

Sends in the Standard Webhooks format, so recipients can verify with an
off-the-shelf library rather than writing HMAC code they will get subtly wrong.

Signed with **every** active secret, space-delimited, so a rotation is not an
outage for anyone who has not yet updated. Signed **once**, outside the retry
loop: re-signing per attempt would give each retry a new message id, and the
recipient would see three events rather than one delivered three times — the
exact duplicate you are asking them to catch.

Full-jitter backoff, because when a recipient recovers from an outage every
queued event retries at once and knocks them over again. 4xx is abandoned
rather than retried; 408 and 429 are "not now" rather than "not ever".

## License

MIT
