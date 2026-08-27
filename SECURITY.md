# Security policy

## Reporting a vulnerability

Privately, through GitHub's private vulnerability reporting: the [Security tab](https://github.com/codew3y/automa-webhook-gate/security) → *Report a vulnerability*. Please do not open a public issue.

This is a personal project. There is no bounty and no guaranteed remediation window beyond a good-faith effort.

## What counts

This library exists to answer one question — *did this request really come from who it claims, and have I already handled it?* — so the interesting reports are ways to get a "yes" you should not have got:

- **A forgery that verifies.** Any input where a signature we did not compute is accepted.
- **A downgrade.** Getting a verifier to check a weaker algorithm, or to accept a signature under a version we do not actually verify.
- **A replay that gets through.** Two copies of one delivery both accepted — particularly under concurrency, which is what the `ON CONFLICT` in the Postgres store is for.
- **A timing leak.** Any comparison on a signature path that is not constant-time. Every one goes through `timingSafeEqual`; a route around it is a bug.
- **Locking out a genuine delivery.** Making the gate treat a real request as a duplicate — for instance by getting a rejected delivery recorded, so its key is already taken when the real one arrives.

A failing test in the shape of `test/verify.test.ts` is the most useful report possible.

## What does not count

- **The demo's secret.** `src/demo.ts` ships a known secret and hands it to the browser, because both sides of the demo are the demo. It is not used anywhere else and the file says so.
- **`MemoryReplayStore` providing no cross-process protection.** That is documented, and the class refuses to construct under `NODE_ENV=production` for exactly that reason.
- **Endpoint authorisation.** This library verifies senders. Deciding who may register an endpoint, and what an event is allowed to trigger, belongs to whatever embeds it.
- **Retention shorter than the tolerance.** Guarded by an assertion at construction rather than left to chance, but a caller who overrides both can still create a gap.

## What this does not do

It hands back a verified, de-duplicated event and stops. It does not parse provider-specific payloads, does not decide what an event means, and does not run anything. If a report depends on what happens *after* the handoff, it is about the consumer rather than this.
