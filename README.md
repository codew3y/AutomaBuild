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
npm run db:up          # two Postgres containers and a mail catcher
npm run db:migrate     # each library's own migrations, each to its own database

export WEBHOOK_SECRETS=whsec_demo_secret
export SMTP_HOST=127.0.0.1 SMTP_PORT=1025
export SMTP_FROM="AutomaBuild <flows@automabuild.test>"
npm start
```

Then open <http://localhost:8080>. Build a flow under **Builder**, read what ran
under **History**, and see what the email steps produced at
<http://localhost:8025>.

To see the whole path exercised and asserted:

```bash
npm run demo
```

which publishes a flow, sends a forged delivery, a stale one, a genuine one, and
then the genuine one again, and fails the process if any part misbehaves:

```
0. Published the demo flow: trigger → http → transform → email.

1. A forged signature is rejected, and says nothing about why.
   401 {"error":"rejected_signature"}

2. A correctly signed but stale delivery is rejected too.
   400 {"error":"rejected_timestamp"}

3. A genuine delivery (evt_30afbbe2-b96) starts a durable run.
   run 01a04287-… — succeeded
     succeeded    trigger 7ms
     succeeded    lookup 539ms
     succeeded    shape 6ms
     succeeded    notify 370ms

4. The same delivery again — no second run.
   runs before 9, after 9

5. The transform combined two sources, keeping types.
   {"repo":"nodejs/node","stars":119635,"amount":4200}

6. A real email was composed and accepted by an SMTP server.
   To:      finance@example.test
   Subject: Invoice paid — nodejs/node
   | Repository: nodejs/node
   | Stars:      119635
   | Amount:     4200 chf

7. Publishing a new version does not disturb the runs already done.
   cf3a16b9 → 2c4d7c6e
   run 01a04287 still renders against its own version

8. A flow that does not compile is refused, with every problem listed.
   422 ["An email step needs a body."]
```

### Sending real email

The email step sends over SMTP, so it works against anything that speaks it.
`docker compose` starts [Mailpit](https://mailpit.axllent.org/), which accepts
every message and delivers none — that is what the commands above use, and
nothing reaches a real inbox.

To send for real, point it at a relay:

```bash
export SMTP_HOST=smtp.example.com SMTP_PORT=587
export SMTP_USER=... SMTP_PASSWORD=...
export SMTP_FROM="Your Name <you@example.com>"
export SMTP_ALLOWED_RECIPIENTS="@yourcompany.com"
```

Set `SMTP_ALLOWED_RECIPIENTS` at the same time, not afterwards. A flow's
recipient comes from a user, and in a system where a webhook body can reach the
To field, an unrestricted relay is an open relay with extra steps. The list
matches whole addresses or whole domains, never substrings — otherwise
`@example.com` would permit `someone@example.com.evil.test`.

Without `SMTP_HOST` the email step reports itself unconfigured rather than
failing as though the feature were missing.

## The four step kinds

| Kind | What it does |
|---|---|
| **Trigger** | Publishes the payload that started the run, so later steps can refer to it as `{{ trigger.body.… }}`. |
| **HTTP** | Calls an API through `automa-safe-fetch`. A JSON response comes back as data, so `{{ steps.x.output.body.field }}` resolves. |
| **Transform** | Reshapes data. A JSON template whose string values hold references — renaming fields, picking a subset, combining sources, supplying defaults. It makes no external call. |
| **Email** | Sends over SMTP. |

A transform is deliberately not an expression language. User-supplied code in a
workflow engine is a sandbox problem, and a sandbox is a much larger thing to
get right than a template. What it does get right is types: it parses the
template *before* resolving references, so `{"stars": "{{ … }}"}` yields the
number `119635` rather than the string `"119635"`. Resolving first would
substitute into the text of the document and make every value a string, and a
later step comparing numbers would be comparing text.

## Publishing

The editor's Publish button has three states, because there are three:

| | |
|---|---|
| Nothing published | `Publish` |
| Published, no edits | `✓ Published` — a status, not a button |
| Published, edited | `Publish changes` · `Discard` |

Every publish **inserts** a new version rather than updating one. A run records
the `flowVersionId` it started on and the worker resolves the definition by that
id, so a run already in flight keeps finishing against the version it began
with — publishing never disturbs work in progress, and never needs to drain
first. Overwriting would rewrite history under a run still using it.

Discard goes through the store's temporal wrapper, so ctrl-Z brings the work
back. That is why it needs no confirmation dialog, and it is easy to lose by
"optimising" the reset to bypass the store.

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

**A delivery whose handoff failed was lost permanently.** The gate records a
delivery before handing it off — that ordering is what stops two simultaneous
copies both being accepted, and is not negotiable. But if the handoff then threw
(the database blinked, say), the record stood, the caller returned 500, and the
sender's retry was answered "duplicate". Verified, acknowledged as new, never
acted on, never offered again. `ReplayStore.release()` unwinds the record on
failure. The trade is a narrow window where a concurrent replay is treated as
new, which the engine's run idempotency key closes.

**A run's duration meant two different things.** The history list read it from
the server, which measures wall clock; the header summed step durations. The
same run showed two different totals on the same screen.

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
- **A `branch` step cannot be published.** The compiler refuses it rather than
  guessing, and says so with every other problem it found.
- **The worker runs in the web process.** That is a deployment choice, not a
  design one: `startWorker` takes a pool and a flow, and moving it to its own
  process changes no code.
- **The demo calls a real public API.** `automa-safe-fetch` blocks loopback, so
  a demo cannot call its own server — and turning that off to make a demo pass
  would defeat the point of having it.

## Licence

MIT.
