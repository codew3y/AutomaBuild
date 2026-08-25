# AutomaBuild

Design and engineering plan for a multi-tenant workflow automation platform — a "mini-Zapier". Built as four independent components, each usable on its own.

This repository holds the architecture. The code lives in four sibling repositories.

---

## The components

| | Repository | What it is | Status |
|---|---|---|---|
| **A** | [automa-safe-fetch](https://github.com/codew3y/automa-safe-fetch) | HTTP client that fetches user-supplied URLs without allowing access to internal networks (SSRF defence) | Not started |
| **C** | [automa-durable-runner](https://github.com/codew3y/automa-durable-runner) | Multi-step task engine that survives machine failure without repeating completed work | Not started |
| **B** | [automa-webhook-gate](https://github.com/codew3y/automa-webhook-gate) | Webhook receiver with signature verification and replay protection | Not started |
| **D** | [automa-flow-canvas](https://github.com/codew3y/automa-flow-canvas) | Drag-and-drop editor for building automations | Not started |

Read in that order. **A** is used by **C** whenever a step calls an API. **B** is what starts a run. **D** draws what **C** executes.

## The plan

**[autobuild-engineering-plan.md](./autobuild-engineering-plan.md)** — the full design, ~200 KB, researched and cited throughout. Fourteen sections:

| § | |
|---|---|
| 0 | Pushback — seven arguments against the original brief, including why the queue should not own workflow state |
| 1 | Feature scope: MVP / v1 / stretch, and what is deliberately left out |
| 2 | Architecture — components, request lifecycle, queue topology, where state lives between steps |
| 3 | **Execution semantics** — idempotency, delivery guarantees, retry, timeouts, cancellation, scheduler reliability |
| 4 | PostgreSQL schema, partitioning and retention |
| 5 | Frontend — canvas state, undo/redo, validation, data mapping |
| 6 | Connectors and OAuth 2.0 + PKCE |
| 7 | **Security** — threat model, SSRF, credential encryption, mapped against OWASP Top 10 2025 and API Top 10 |
| 8 | Compliance — GDPR obligations, and an honest account of what SOC 2 does and does not permit a project like this to claim |
| 9 | Observability and operations |
| 10 | Testing strategy |
| 11 | Delivery roadmap (AI-assisted estimates) |
| 12 | **Decision log** — every significant choice, the alternatives, and why they were rejected |
| 13 | Riskiest unknowns |
| 14 | Assumptions and unverified claims |

Two sections are worth reading even if you skip the rest. **§12** records why BullMQ was chosen over Temporal and pg-boss, why the flow graph is JSONB with a relational projection rather than one or the other, and why user-supplied JavaScript is not executed anywhere. **§14** lists what could not be verified from a primary source — because a plan that does not distinguish between what is known and what is assumed is not a plan.

## A note on the estimates

§11 assumes AI-assisted development throughout, and splits the work into three compression bands rather than applying a flat discount. The interesting result is that the compression is uneven: scaffolding, schema and test corpora compress 60–70%, while the execution-engine semantics compress under 30%. The project does not shrink uniformly — the plumbing evaporates and the hard parts stay hard.

## Status of the claims in here

This is a design document for a personal project. It is architected against the OWASP Top 10 and GDPR obligations are addressed in §8, but **no security audit or compliance examination has been performed on any of it**, and §8.3 explains in detail why a single-person project cannot claim otherwise.

## License

Plan: CC BY 4.0. Code in the component repositories: MIT.
