# Workspace — AutomaBuild

This folder is a **container for five separate git repositories**. It is not itself a repo.

```
autobuild/                                  # workspace root, not a repo
├── AutomaBuild/            → github.com/codew3y/AutomaBuild          (plan, this index, and app/ -- you are here)
├── automa-safe-fetch/      → github.com/codew3y/automa-safe-fetch    (A)
├── automa-webhook-gate/    → github.com/codew3y/automa-webhook-gate  (B)
├── automa-durable-runner/  → github.com/codew3y/automa-durable-runner(C)
└── automa-flow-canvas/     → github.com/codew3y/automa-flow-canvas   (D)
```

Each of the four component folders has:

- `README.md` — the public-facing document. Leads with the problem, not the stack. Rewrite as you build; this is a draft.
- `BRIEF.md` — the working scope contract. In scope, **out of scope**, exit criteria, risks. Not for publication — delete or gitignore it before going public if you prefer.
- `.gitignore` and `.env.example` — set up before the first commit, deliberately.

## Build order

**A → C → B → D.** A is quick and builds momentum. C is the valuable one, so do it while fresh. D is optional and goes last.

## Before your first commit in any repo

Already handled: `user.email` is set to `tongolwey@gmail.com` in all five, and remotes point at `codew3y/*`.

Still to do, once per repo:

1. Enable **secret scanning + push protection** in GitHub repo settings. Anything committed while private stays in the history after you go public.
2. Keep the repos **private until each one is finished**. Four empty public repos read worse than one finished one.
3. Keep CI lean while private — GitHub Free gives 2,000 Actions minutes/month on private repos; public repos are unlimited on standard runners.

## The rule that makes this work

`BRIEF.md` has an **out of scope** list in every project. That list is the whole point of splitting the work up. The failure mode here is Project C quietly turning back into the entire platform. When you feel the pull to add "just a small UI" to the runner — that is the moment the four-project plan dies.

Ship it, make it public, then start the next one.
