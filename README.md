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

## Usage

```ts
// API sketch — subject to change
import { verify } from 'automa-webhook-gate'

const result = await verify({
  scheme: 'stripe',
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  rawBody,            // Buffer, before JSON.parse
  headers,
  toleranceSeconds: 300,
})

if (!result.valid) return reply.code(400).send()
```

## Also outbound

Sends webhooks in the Standard Webhooks format, with two active secrets for zero-downtime rotation, jittered exponential backoff, and a dead-letter queue after exhaustion.

## License

MIT
