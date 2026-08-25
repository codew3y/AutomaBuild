# automa-durable-runner

A multi-step task engine that does not lose work when a machine dies, and does not repeat work it has already done.

> **Status:** in development. Part of the [AutomaBuild](https://github.com/codew3y/AutomaBuild) workflow-automation platform (component C of four). This is the core.

---

## The problem

Run a sequence of steps — call an API, transform the result, send an email — and one machine will eventually die in the middle of step three. Two obvious responses are both wrong:

- **Retry the whole run** → the email sends twice, the invoice is created twice.
- **Give up** → the work is silently lost, and nobody finds out until a customer asks.

The correct answer is to resume from exactly where it stopped. That requires knowing, after a crash, which steps completed — and *"the call was made but the answer never came back"* is a real state that is neither.

There is a further trap. No queue delivers a message exactly once. Every serious system — BullMQ, SQS, Temporal — delivers **at least once** and expects you to make the effect idempotent. Systems that claim exactly-once are describing at-least-once delivery plus an idempotent consumer. If your engine assumes exactly-once, duplicate side effects are not a bug you will fix; they are the design.

## What this does

- **Postgres is the source of truth.** Every step's status, input, output, attempt count and lease lives in a row. The queue carries only a pointer — "advance run R". A lost or duplicated pointer is harmless.
- **No dual write.** State change and enqueue happen in one transaction via an outbox table, so the database and the queue can never disagree.
- **Leases.** A worker claims a step with a conditional update. If two workers get the same message, exactly one wins and the other exits.
- **Idempotency keys**, deterministic across retries, changed only on a deliberate replay — threaded from the trigger through to the outbound HTTP call.
- **Honest at-most-once handling.** Actions that genuinely cannot be retried safely — SMTP, spreadsheet appends — are declared as such. After an ambiguous failure the run *pauses and asks* rather than guessing. Most platforms just retry and let you double-send.
- **Retry with full jitter** — `random(0, min(cap, base · 2^attempt))`, the strategy [AWS measured](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) as doing the least total work.
- **Timeouts at four layers**, each shorter than its parent.
- **Dead-letter queue**, cancellation, resume-from-step, and per-tenant concurrency limits.

## The demo

```bash
npm run demo:chaos
```

Starts a three-step run and kills a worker mid-step. The run completes on another worker. The API that was already called is not called again.

That test is the entire point of this repository.

## Error classes

Every failure maps to exactly one class, and the class decides what happens next:

| Class | Retryable | Consumes an attempt |
|---|---|---|
| `transient_network` | yes | yes |
| `rate_limited` | yes | **no** |
| `auth_expired` | yes, once | no |
| `client_error` | no | — |
| `timeout` | only if idempotent | yes |
| `unknown_outcome` | **no — pause and ask** | — |
| `poison` | no — straight to DLQ | — |

`unknown_outcome` is the class most implementations omit, and it is the one that causes duplicate invoices.

## Not included

No UI, no canvas, no connectors, no login. This is a library and a CLI. The visual editor is [automa-flow-canvas](https://github.com/codew3y/automa-flow-canvas); safe outbound HTTP is [automa-safe-fetch](https://github.com/codew3y/automa-safe-fetch).

## License

MIT
