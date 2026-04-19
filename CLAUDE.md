# jolly-http

Workflow-as-code HTTP tool built on [jolly-coop](https://github.com/arijit-gogoi/jolly-coop-js).

**Authoritative contract:** [spec/SPEC.md](spec/SPEC.md) — CLI shape, workflow API, NDJSON schema, out-of-scope list. Frozen post-v0.1.0.

This file is implementation guidance: rules a contributor needs to respect, architecture notes, and project conventions that aren't user-facing.

## What this is

A single CLI with three modes that share one mental model:

```
jolly-http GET https://api/users                    # ad-hoc, like httpie/xh
jolly-http run flow.mjs                             # workflow file, sequential
jolly-http run flow.mjs -c 50 -d 30s                # workflow under load
jolly-http run flow.mjs --watch                     # rerun on file change (v0.2)
```

The workflow file is a normal `.mjs` module exporting `default async function (vu, signal) => any`. That signature is the frozen contract (see [spec/SPEC.md § 3](spec/SPEC.md#3-workflow-file-format-frozen)).

## Positioning

> jolly-http is what curl/Postman/k6 should have been if they had been built ten years apart with the benefit of structured concurrency: one tool, one file format, one mental model — debug your API, version your workflow, run it under load, all from the same `.mjs`.

The wedge is the `.mjs` file. Real JavaScript, not a DSL. The single-request CLI mode is a degenerate case (constructs a one-line workflow internally).

## Dependencies

- `jolly-coop@^0.3.4` — structured concurrency runtime, only runtime dep. Authoritative sources, in order:
  - Local spec: `../jolly-coop-js/spec/jolly-coop.md` (sibling checkout)
  - Installed types: `node_modules/jolly-coop/dist/index.d.ts` (TSDoc on all public types)
  - GitHub: https://github.com/arijit-gogoi/jolly-coop-js

Load-runner primitives (`Stats`, `PercentileBuffer`, `RateLimiter`, progress printer, VU loop) are inlined in `src/load.ts` — no jolly-bench dep. Keep them here; don't refactor into a separate package without a strong reason.

## Jolly rules that matter for this codebase

**Signals are explicit.** Every await that should honor cancellation must receive a signal:

- `await fetch(url, { signal })` — always pass it; the workflow function takes signal as a parameter
- `await sleep(ms, s.signal)` — for retry/backoff
- Nested scope inside a workflow: `scope({ signal: parent.signal }, async ...)` — explicit
- The workflow's `signal` parameter is the scope's signal; threading it everywhere is non-negotiable

**Workflow assertion failures are fail-fast errors, not error-as-value.** A failed `assert(...)` should throw; the scope rejects; the run reports the failure. Do NOT wrap assertions in error-as-value patterns — that turns failed assertions into successful samples, which is wrong.

**Per-request errors in load mode ARE error-as-value.** When the same workflow runs in 50 VUs, an individual request error becomes a Sample (success | failure), not a scope-killer. `runWorkflow` in single mode throws on first error; the VU loop in `src/load.ts` catches thrown errors at the iteration boundary and records a failed Sample instead.

**The same workflow file MUST work in both modes.** This is the central invariant. If a workflow runs cleanly via `jolly-http run` and fails via `jolly-http run -c 50 -d 30s` (or vice versa), something is wrong with the runner, not the workflow.

**Resource cleanup is LIFO.** Cookie jar, response history file, HAR recorder — register in dependency order, dispose in reverse on scope exit.

**`done()` for graceful shutdown, `cancel()` for fatal errors.** Watch mode uses `done()` when the user Ctrl-Cs; single-run mode uses `cancel()` only on unexpected failure.

## API stability discipline

**The workflow function signature is permanent.** `default async function (vu, signal) => any` is the public API. Changing it breaks every workflow file users have written. Treat this signature like a published library export — no breaking changes after v0.1.0.

**The `request` and `assert` exports are the API.** Same deal. Add features carefully. Keep the surface tiny — Hurl and httpyac drowned in feature creep.

When in doubt: the workflow file is the API; everything else is implementation.

## Architecture

```
CLI (src/cli.ts) — arg parsing via src/cli-args.ts, AbortController for SIGINT
  ↓
mode dispatch:
  ├── ad-hoc: src/adhoc.ts builds one-line workflow → runWorkflowFn
  ├── run flow.mjs: src/run.ts — runWorkflow
  │     scope({ signal })
  │       ├── resource: NDJSON sink
  │       └── withRuntime(ctx, () => fn(vu, signal))
  │
  └── run flow.mjs -c N -d T: src/load.ts — runLoad
        scope({ deadline, signal })
          ├── resource: NDJSON sink
          ├── spawn: progress printer
          └── scope({ limit: concurrency, signal })
                └── spawn × N: runVu (withRuntime + iteration loop)
```

Per-VU runtime state (sink, signal, defaults) flows through `AsyncLocalStorage` in `src/runtime.ts`. The workflow author's module-level `request.GET/assert/env/sleep` imports discover their VU via `currentContext()` — this is what lets one `.mjs` file run correctly in all three modes.

Watch mode (v0.2) will add a parent scope around the current runner, cancelling the inner scope on file change and spawning a new one.

## Commands

- `npm test` — unit tests (vitest)
- `npm run build` — tsup → `dist/cli.js` (with shebang) + `dist/index.js`
- `npm run typecheck` — `tsc --noEmit`

## Commit discipline

- Conventional Commits: `<type>(scope): description`
- Pre-1.0 breaking changes go in minor position (0.x.y)
- The git log explains *why*, not just *what*
