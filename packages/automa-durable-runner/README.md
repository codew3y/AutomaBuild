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

## Try it

```bash
docker compose up -d      # Postgres 18 with pg_partman + pg_cron, and Redis
npm ci && npm run db:migrate
npm run demo:chaos
```

## The demo

`npm run demo:chaos` forks worker processes, starts a batch of runs, and `SIGKILL`s a worker at random while steps are in flight. SIGKILL specifically — no handler runs, no lease is released, no result is written. From the database's point of view a step is `running`, owned by a process that no longer exists.

A recent run in CI:

```
workers SIGKILLed        57
runs succeeded           20/20
step attempts made       110  (for 80 steps)
steps re-executed        30
  ...effect already done 22  (deduplicated by key)
distinct side effects    80/80

PASS — no work lost, no effect repeated.
```

The line that matters is `effect already done`. Twenty-two times, a process died holding a side effect it had completed but not yet recorded — the exact state that produces a second invoice in an engine assuming exactly-once delivery. Another worker picked each step up, presented **the same idempotency key**, and the effect still happened once.

A run where nothing was re-executed has proved nothing, and the demo says so rather than printing a green tick.

That test is the entire point of this repository.

## The CLI

```bash
npm run cli -- run examples/hello.json --watch
npm run cli -- status <runId> <startedAt>
npm run cli -- resume <runId> <startedAt> <nodeId>   # re-run from a step
npm run cli -- dlq                                    # what needs a human
npm run cli -- replay <dlqEntryId>
npm run cli -- health                                 # partition headroom
```

A flow is a JSON file:

```json
{
  "nodes": [
    { "id": "fetch", "kind": "http", "idempotent": true,
      "config": { "url": "https://example.com/" } },
    { "id": "done",  "kind": "noop", "idempotent": true }
  ]
}
```

`idempotent` has no default, deliberately. It decides whether an ambiguous failure is retried or paused for a human, and guessing on your behalf is precisely the wrong call to make silently.

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

## Resume and replay

Because every step's input and output is persisted independently, resuming is a query rather than a feature. Resuming from step *N* marks the steps before it `skipped_resumed` — **keeping their outputs**, so downstream expressions still resolve — and resets the rest.

Resumed steps get a **new attempt group**, which changes their idempotency keys. That is the point: an automatic retry says *"this may already have happened, please deduplicate"*, while an operator replay says *"do it again, I have looked at it and I mean it"*. Reusing the old key would make the provider decline the very work being asked for.

## Not included

No UI, no canvas, no connectors, no login. This is a library and a CLI. The visual editor is [automa-flow-canvas](https://github.com/codew3y/automa-flow-canvas); safe outbound HTTP is [automa-safe-fetch](https://github.com/codew3y/automa-safe-fetch).

## License

MIT
