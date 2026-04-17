# jolly-http

Workflow-as-code HTTP tool built on [jolly-coop](https://github.com/arijit-gogoi/jolly-coop-js).

## What this is

A single CLI with three modes that share one mental model:

```
jolly-http GET https://api/users                    # ad-hoc, like httpie/xh
jolly-http run flow.mjs                             # workflow file, sequential
jolly-http run flow.mjs -c 50 -d 30s                # workflow under load
jolly-http run flow.mjs --watch                     # rerun on file change
```

The workflow file is a normal `.mjs` module exporting `default async function (vu, signal) => any`. That signature is the contract: it composes with jolly-coop's scope/signal model, and it's the same shape as a jolly-bench scenario.

## Positioning

> jolly-http is what curl/Postman/k6 should have been if they had been built ten years apart with the benefit of structured concurrency: one tool, one file format, one mental model — debug your API, version your workflow, run it under load, all from the same `.mjs`.

The wedge is the `.mjs` file. Real JavaScript, not a DSL. The single-request CLI mode is a degenerate case (constructs a one-line workflow internally).

## Dependencies

- `jolly-coop@^0.3.3` — structured concurrency runtime. Authoritative sources, in order:
  - Local spec: `../jolly-coop-js/spec/jolly-coop.md` (sibling checkout)
  - Installed types: `node_modules/jolly-coop/dist/index.d.ts` (TSDoc on all public types)
  - GitHub: https://github.com/arijit-gogoi/jolly-coop-js
- (planned) `jolly-bench@^0.1.0` — load mode delegates to it, either as subprocess or library

## Jolly rules that matter for this codebase

**Signals are explicit.** Every await that should honor cancellation must receive a signal:

- `await fetch(url, { signal })` — always pass it; the workflow function takes signal as a parameter
- `await sleep(ms, s.signal)` — for retry/backoff
- Nested scope inside a workflow: `scope({ signal: parent.signal }, async ...)` — explicit
- The workflow's `signal` parameter is the scope's signal; threading it everywhere is non-negotiable

**Workflow assertion failures are fail-fast errors, not error-as-value.** A failed `assert(...)` should throw; the scope rejects; the run reports the failure. Do NOT wrap assertions in error-as-value patterns — that turns failed assertions into successful samples, which is wrong.

**Per-request errors in load mode ARE error-as-value.** When the same workflow runs in 50 VUs, an individual request error becomes a Sample (success | failure), not a scope-killer. This is the jolly-bench discipline — `runWorkflow` in single mode throws on first error; `runWorkflow` invoked by jolly-bench's VU loop catches and records.

**The same workflow file MUST work in both modes.** This is the central invariant. If a workflow runs cleanly via `jolly-http run` and fails via `jolly-http run -c 50 -d 30s` (or vice versa), something is wrong with the runner, not the workflow.

**Resource cleanup is LIFO.** Cookie jar, response history file, HAR recorder — register in dependency order, dispose in reverse on scope exit.

**`done()` for graceful shutdown, `cancel()` for fatal errors.** Watch mode uses `done()` when the user Ctrl-Cs; single-run mode uses `cancel()` only on unexpected failure.

## API stability discipline

**The workflow function signature is permanent.** `default async function (vu, signal) => any` is the public API. Changing it breaks every workflow file users have written. Treat this signature like a published library export — no breaking changes after v0.1.0.

**The `request` and `assert` exports are the API.** Same deal. Add features carefully. Keep the surface tiny — Hurl and httpyac drowned in feature creep.

When in doubt: the workflow file is the API; everything else is implementation.

## Architecture (planned)

```
scope({ signal: SIGINT })                       — root
├── resource: cookie jar (if --cookies)
├── resource: HAR recorder (if --record)
├── resource: history file (if --history)
└── mode dispatch:
    ├── single request: one-line workflow → invoke runWorkflow once
    ├── run flow.mjs: import workflow → invoke runWorkflow once
    ├── run flow.mjs -c -d: delegate to jolly-bench with workflow as scenario
    └── run flow.mjs --watch:
        └── scope({ signal: s.signal }) — watcher
            └── on file change: cancel previous run scope, spawn new
```

## Commands

- `npm test` — unit tests (vitest)
- `npm run build` — tsup → `dist/cli.js` (with shebang) + `dist/index.js`
- `npm run typecheck` — `tsc --noEmit`

## Commit discipline

- Conventional Commits: `<type>(scope): description`
- Pre-1.0 breaking changes go in minor position (0.x.y)
- The git log explains *why*, not just *what*
