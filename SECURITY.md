# Security policy

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting: the [Security tab](https://github.com/codew3y/automa-durable-runner/security) → *Report a vulnerability*. Please do not open a public issue.

This is a personal project. There is no bounty and no guaranteed remediation window beyond a good-faith effort.

## What counts here

This engine's security properties are mostly correctness properties, and the interesting reports are about durability rather than about access:

- **A way to make a step's effect happen twice.** Anything that causes a retry to present a *different* idempotency key for the same logical work, or that lets two workers hold a live claim on one step simultaneously.
- **A way to lose work.** A non-terminal run that no sweep will ever reschedule — the janitor's three cases missing a fourth.
- **A way to make a step run that should not have.** Cancellation not observed at a transition, or a resumed step executing something before the resume point.
- **SSRF through the HTTP step.** The step uses [automa-safe-fetch](https://github.com/codew3y/automa-safe-fetch); a bypass belongs in that project's tracker, but tell me if this one uses it unsafely — for example by passing a caller-controlled option that disables a check.
- **SQL injection.** Every query here is parameterised. One that is not is a bug worth reporting even without a working exploit.

A failing test in the shape of those in `test/engine.test.ts` is the most useful possible report.

## What does not count

- **Multi-tenancy is a `tenant_id` column and concurrency keyed on it.** There is no row-level security and no authentication, deliberately and per the project's scope. A caller that passes another tenant's id reads that tenant's rows. Authorisation belongs to whatever embeds this.
- **The demo credentials.** `automa`/`automa` in `docker-compose.yml` are for a local container that binds to a non-standard port. They are not a secret and are not used anywhere else.
- **`chaos_effects`.** A scratch table the demo creates and drops. Not part of the schema.
- **Anything requiring control of the flow definition.** A flow author can already make the engine call any URL; that is the product. The relevant control is the SSRF layer in the HTTP step, not the ability to define a step.

## A note on what this engine promises

It does not promise exactly-once execution, and neither does anything else. Delivery is at-least-once, and effects are made idempotent — that combination is what produces an exactly-once *outcome*. Steps whose connector cannot support an idempotency key are declared `idempotent: false`, and an ambiguous failure on one of those **pauses the run and asks a human** rather than guessing.

A report that the engine executed a step twice is interesting. A report that a step was *attempted* twice is the design working: `npm run demo:chaos` prints exactly that number every run.
