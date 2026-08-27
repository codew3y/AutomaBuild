# AutomaBuild

A multi-tenant workflow automation platform, built as four independent
components and one application that joins them.

Each component is its own repository and stands on its own — the HTTP client is
published to npm and has no idea a workflow engine exists. `app/` is where they
meet, and it is deliberately thin: about six hundred lines, most of which is
translation between two vocabularies that were designed separately and had to
be made to agree.

```
  a signed webhook
        │
        ▼
  automa-webhook-gate ──── verify in constant time, reject replays
        │
        ▼
  automa-durable-runner ── a run, its steps, leases, retries, a DLQ
        │
        ▼
  automa-safe-fetch ────── every outbound call, SSRF-checked and pinned
        │
        ▼
  automa-flow-canvas ───── the editor, and the history of what ran
```

| Component | What it is | Where |
|---|---|---|
| **A** | `automa-safe-fetch` — an SSRF-hardened HTTP client. Resolves, validates every address, and pins the connection to the one it checked. Zero dependencies. | [npm](https://www.npmjs.com/package/automa-safe-fetch) · [repo](https://github.com/codew3y/automa-safe-fetch) |
| **B** | `automa-webhook-gate` — signature verification for Stripe, GitHub, Slack and Standard Webhooks, with a Postgres-backed replay store. | [repo](https://github.com/codew3y/automa-webhook-gate) |
| **C** | `automa-durable-runner` — a durable execution engine. Leases, at-least-once delivery with idempotent effects, partitioned tables, a janitor, a DLQ. | [repo](https://github.com/codew3y/automa-durable-runner) |
| **D** | `automa-flow-canvas` — the React Flow editor: build a flow, map fields between steps, read the history of what ran. | [repo](https://github.com/codew3y/automa-flow-canvas) · [live](https://codew3y.github.io/automa-flow-canvas/) |

The engineering plan that all of this was built against is in
[`autobuild-engineering-plan.md`](autobuild-engineering-plan.md), including two
dated corrections where the plan turned out to be wrong.

## Running it

Docker and Node 22.18+ (or 24) are the only requirements.

```bash
cd app
npm install
npm run db:up          # two Postgres containers
npm run db:migrate     # each library's own migrations, each to its own database
WEBHOOK_SECRETS=whsec_demo_secret npm start
```

Then open <http://localhost:8080>. The editor is on the left, the run history
under **History**.

To see the whole path exercised and asserted:

```bash
WEBHOOK_SECRETS=whsec_demo_secret npm run demo
```

which sends a forged delivery, a stale one, a genuine one, and then the genuine
one again, and fails the process if any of the four does not behave:

```
1. A forged signature is rejected, and says nothing about why.
   401 {"error":"rejected_signature"}

2. A correctly signed but stale delivery is rejected too.
   400 {"error":"rejected_timestamp"}

3. A genuine delivery (evt_2e047369-920) starts a durable run.
   200 {"ok":true,"duplicate":false}
   run 01a04253-0283-7e49-8c4f-91e14f872104 — succeeded
     succeeded    trigger 12ms
     succeeded    lookup 1752ms
     succeeded    record 459ms

4. The same delivery again — no second run.
   200 {"ok":true,"duplicate":true}
   runs before 4, after 4

5. The mapped URL resolved against real upstream output.
   record succeeded, so {{ steps.lookup.output.body.full_name }} resolved.
```

## What joining them actually took

Composing four libraries that were each finished and tested is where the
interesting bugs were, because a bug at a seam is invisible from either side of
it. Every one of these was found by wiring the system together and none of them
by the components' own suites:

**A permanently failed step did not stop the run.** The engine picks the lowest
unfinished step in topological order. A step that has failed for good is not
runnable, so it was skipped and the *next* step ran. The run still ended up
marked `failed` — the terminal failure is found once nothing is runnable — but
only after the entire rest of the chain had already executed. In a flow that is
"charge the card" then "send the receipt", that sends a receipt for a charge
that did not happen. Fixed in C; both directions are pinned by tests, because
a failure with a retry still pending must *not* stop the chain.

**The run input was write-only.** `createRun` accepted an `input` and wrote it
to the database from the first version. Nothing ever selected the column, so a
webhook body went in and the step meant to act on it could not reach it.

**An HTTP step returned JSON as a string.** The editor writes mappings like
`{{ steps.lookup.output.body.full_name }}`. Against a raw string that path
resolves to nothing, so mapping between two HTTP steps could not work at all.

**Step timings existed and were never surfaced.** `started_at`, `finished_at`
and `duration_ms` had been written since the first migration; the row mapper
had no fields for them. The run viewer had a duration column and nothing to put
in it.

**The gate forced Fastify on every consumer.** The library deliberately keeps
its Fastify integration out of the main entry point so that a project verifying
webhooks under Express does not pay for it — and then listed Fastify as a hard
dependency, which installed it anyway. It is an optional peer dependency now,
reachable at `automa-webhook-gate/fastify`.

And one that is not a seam bug but was worth stopping for: a `\b` in a regular
expression reached disk as a literal backspace byte, so the pattern read
`/<BS>json<BS>/` and matched nothing. Every tool rendered it as `/json/`,
because a backspace is invisible. `automa-durable-runner` now fails its
typecheck on any control character that is not tab, newline or return.

## The seams

Three pieces of translation, all in `app/src`:

**`flow.ts`** compiles a canvas graph into an engine flow definition. The two
disagree, and it says so rather than papering over it: the canvas is a graph
and the engine v1 runs a linear chain, so a drawing with a branch in it is a
valid drawing and not a runnable flow. It reports every problem it finds rather
than the first, because someone fixing a flow wants the list.

**`handlers.ts`** resolves the editor's `{{ }}` references against the upstream
outputs the engine hands each step, then delegates to the engine's own handler
— so SSRF checking, timeouts, idempotency keys and error classification are
untouched. Without it, the mapping panel's preview promises something the run
does not deliver, which is worse than not offering mapping at all.

**`runs.ts`** turns engine rows back into what the run viewer reads. The
mapping that matters is `pending`: in a live run that step is still coming, and
in a finished one it never happened. Reading the step status alone cannot tell
those apart, so the run status is part of the decision — and "the email never
went out" is exactly the question the viewer exists to answer.

## Deliberate limits

- **The engine runs a linear chain.** Branching interacts with retry,
  cancellation and concurrency in ways that are not obvious, and the compiler
  refuses a branch rather than guessing. `iterationIndex` exists throughout the
  schema anyway, because retrofitting it later would mean rewriting every
  partition.
- **`transform` and `email` steps compile, appear in the run, and do nothing.**
  They warn at startup. A step that silently does nothing is worse than one
  that is missing.
- **The worker runs in the web process.** That is a deployment choice, not a
  design one: `startWorker` takes a pool and a flow, and moving it to its own
  process changes no code.
- **The demo calls a real public API.** `automa-safe-fetch` blocks loopback, so
  a demo cannot call its own server — and turning that off to make a demo pass
  would defeat the point of having it.

## Licence

MIT.
