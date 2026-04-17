# jolly-http — v0.1.0 build plan

This is the execution roadmap for the first shippable version. Read `CLAUDE.md` first for project rules and the architecture sketch. When something is already covered there, this file references it rather than duplicating.

## 1. Goal

A single CLI that does three things from one workflow file format:

1. **Ad-hoc HTTP** — `jolly-http GET https://api/users` (httpie-shaped)
2. **Workflow run** — `jolly-http run flow.mjs` (sequential, with assertions)
3. **Workflow under load** — `jolly-http run flow.mjs -c 50 -d 30s` (delegates to jolly-bench)

Plus watch mode (`--watch`) deferred to v0.2.

The same `.mjs` file works in modes 2 and 3 unchanged. That invariant is the product.

## 2. CLI shape (frozen for v0.1.0)

```
# Ad-hoc mode (httpie-style)
jolly-http <METHOD> <url> [body shorthand] [options]
jolly-http GET https://api/users
jolly-http POST https://api/users name=ari age:=30 active:=true
jolly-http PUT https://api/users/1 --json '{"name":"ari"}'
jolly-http DELETE https://api/users/1

# Workflow mode
jolly-http run <flow.mjs> [options]
jolly-http run flow.mjs                              # one VU, one iteration
jolly-http run flow.mjs -c 50 -d 30s                 # load mode (via jolly-bench)
jolly-http run flow.mjs --env API=https://staging/   # env injection
jolly-http run flow.mjs --out responses.ndjson       # record per-request samples
```

Common options:
- `--header <k:v>` (repeatable)
- `--timeout <dur>` (per-request, applies to all requests in workflow)
- `--insecure` (skip TLS validation)
- `--user-agent <str>` (default `jolly-http/${VERSION}`)
- `--quiet` (suppress per-request output)
- `--help`, `--version`

Body shorthand (httpie-compatible subset):
- `key=value` → form/JSON string field
- `key:=value` → JSON literal (number/bool/null/object/array)
- `Header:value` → request header
- `key==value` → query parameter
- `key@file` → upload file as field

Exit codes: 0 success, 1 fatal/assertion failure, 2 bad args, 130 SIGINT.

## 3. Workflow file format (THE API — frozen at v0.1.0)

```js
// flow.mjs
import { request, assert, env, sleep } from "jolly-http"

export default async function (vu, signal) {
  // vu = { id: number, iteration: number, env: object }
  // signal = AbortSignal from the scope; pass to every fetch

  const login = await request.POST(`${env.API}/login`, {
    json: { user: vu.id },
    signal,
    timeout: "5s",
  })
  assert(login.status === 200, "login failed")

  const token = (await login.json()).token

  const me = await request.GET(`${env.API}/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  assert(me.status === 200)
  assert((await me.json()).user, "user field missing")

  return { ok: true }   // optional return value, surfaced in single-run output
}
```

**Frozen API surface (cannot change post-v0.1.0 without major bump):**
- `default export` — `async function (vu, signal) => any`
- `vu` parameter shape: `{ id: number, iteration: number, env: object }`
- `signal` parameter is the scope's AbortSignal
- `request.GET/POST/PUT/PATCH/DELETE/HEAD(url, init): Promise<Response>` — `Response` is `globalThis.Response`-shaped (status, headers, .json(), .text(), .arrayBuffer())
- `assert(cond: boolean, msg?: string): void` — throws on false
- `env` — frozen object of env vars passed via `--env` flags + process env
- `sleep(ms | "30s" | "2m"): Promise<void>` — re-export of jolly-coop's sleep, signal optional (workflow author chooses)

**NOT in v0.1.0 (deliberately):**
- Retry helpers (write your own)
- Auth helpers beyond passing headers
- Capture/extract DSL (just use `.json()`)
- Hooks (beforeAll, etc.)
- Multi-file workflow imports

## 4. NDJSON sample schema (frozen)

When `--out` is set, one line per HTTP request issued by the workflow:

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"method":"POST","url":"https://api/login","status":200,"duration_ms":38.2,"size":312,"ts":"2026-04-18T..."}
{"ok":false,"t":0.191,"vu":3,"iteration":1,"method":"GET","url":"https://api/me","error":"AssertionError","message":"login failed","ts":"2026-04-18T..."}
```

This shape is jolly-bench-compatible — load mode produces the same NDJSON schema, so the same diff/analysis tools work.

## 5. Architecture

See `CLAUDE.md § Architecture`.

## 6. File layout

| File | Responsibility |
|---|---|
| `src/cli.ts` | arg parsing, mode dispatch (ad-hoc / run / version), SIGINT wiring, exit code logic |
| `src/adhoc.ts` | construct a one-line workflow from CLI args (METHOD, url, body shorthand, headers) and invoke runWorkflow |
| `src/run.ts` | sequential workflow runner — imports workflow, invokes once, surfaces return value or assertion error |
| `src/load.ts` | load-mode dispatcher — imports jolly-bench, hands it the workflow as a scenario |
| `src/runtime.ts` | the public API exposed *to workflow files*: `request`, `assert`, `env`, `sleep` |
| `src/request.ts` | `Request` builder + `fetch()` wrapper that records samples, applies per-request timeout |
| `src/response.ts` | `Response` wrapper (or pass-through global Response — TBD per investigation) |
| `src/shorthand.ts` | parse httpie body shorthand (`key=val`, `key:=val`, `Header:val`, `key==query`) |
| `src/output.ts` | NDJSON sample writer + pretty single-request response printer |
| `src/time.ts` | duration parsing — re-export from jolly-coop or local copy |
| `src/types.ts` | shared types: `WorkflowFn`, `VuContext`, `Sample`, `Options` |
| `src/index.ts` | public exports for the runtime API + types |
| `test/*.test.ts` | vitest |

**Target:** < 200 LOC per file, ~1500-2000 LOC total for v0.1.0.

## 7. Implementation milestones and parallel-execution plan

### Dependency graph

```
        M0: types + time + shorthand parser  (Track A — pure utilities)
                    ↓
              ┌─────┴─────┐
              ↓           ↓
       M1: runtime API   M2: request/response  (Track B — runtime)
       (assert, env)     (fetch wrapper, sample emit)
              └─────┬─────┘
                    ↓
              M3: output (NDJSON writer, pretty printer)
                    ↓
        ┌───────────┼────────────┐
        ↓           ↓            ↓
    M4: run     M5: adhoc    M6: load     (Track C — modes)
    (sequential) (one-line)   (jolly-bench
                              integration)
        └───────────┼────────────┘
                    ↓
              M7: cli (arg parsing, mode dispatch)
                    ↓
              M8: integration tests + smoke + docs (Track D)
```

### Parallel tracks

- **Track A (pure):** M0 — types, time, shorthand parser. No deps. Build first.
- **Track B (runtime):** M1 (assert/env) + M2 (request/response) — parallel after A. Both pure-ish; M2 hits real HTTP via fetch.
- **Track C (modes):** M3 (output) → M4/M5/M6 (modes, parallel). M4-M6 are independent of each other once M3 lands.
- **Track D (assembly):** M7 (cli) → M8 (integration).

**Recommended execution:** Track A → Track B (parallel pair) → M3 → Track C (M4+M5+M6 parallel) → Track D. **5 rounds total** for 9 milestones.

### Milestone detail

**M0 — types + time + shorthand**
- `src/types.ts`: `WorkflowFn`, `VuContext`, `Sample` (success | error variant), `RunOptions`, `LoadOptions`
- `src/time.ts`: re-export `parseDuration` from jolly-coop
- `src/shorthand.ts`: `parseShorthand(args: string[]): { headers, query, jsonBody, formBody, files }` — implements httpie's `key=val` / `key:=val` / `Header:val` / `key==query` / `key@file` rules
- Tests: `test/shorthand.test.ts`, `test/time.test.ts`
- Pure functions, fast tests.

**M1 — runtime API (assert + env)**
- `src/runtime.ts` exports `assert(cond, msg?)` and a frozen `env` object that's populated at workflow-import time
- `assert` throws an `AssertionError` (jolly-coop fail-fast handles the rest)
- `env` is `Object.freeze({ ...process.env, ...flagOverrides })` — passed via `--env KEY=VAL` flags
- Tests: `test/runtime.test.ts`

**M2 — request + response**
- `src/request.ts` exports `request.GET/POST/PUT/PATCH/DELETE/HEAD(url, init)`
- Each method returns a `Response`-shaped object (use globalThis.Response if possible)
- Per-request timeout via `init.timeout` (string duration or ms)
- Per-request signal via `init.signal` — composed with timeout signal via `AbortSignal.any([...])`
- Records a `Sample` to a per-VU collector (injected at runtime entry)
- **Decision:** never throw for non-2xx; the workflow author asserts. Network errors throw; AbortError throws.
- Tests: `test/request.test.ts` (mock fetch via `globalThis.fetch` override or local http server)

**M3 — output**
- `src/output.ts`: `createSampleSink(outPath?)` — if path, NDJSON writer; else no-op
- `formatResponse(response)` — pretty printer for ad-hoc single-request mode (status line, headers, body with JSON formatting)
- Tests: `test/output.test.ts`

**M4 — run (sequential workflow)**
- `src/run.ts` exports `runWorkflow(workflowPath, opts): Promise<RunResult>`
- Dynamic import of workflow file with `pathToFileURL()` for Windows compatibility
- Validates default export shape (async function, 1-2 args)
- Invokes inside `scope({ signal: opts.signal })` — single VU, single iteration
- Surfaces workflow return value, or AssertionError, or any thrown error
- Sequential mode: assertion failure → scope rejects → CLI exits 1
- Tests: `test/run.test.ts` with temp workflow files

**M5 — adhoc**
- `src/adhoc.ts`: takes parsed CLI args (METHOD, url, body shorthand, headers), constructs an *in-memory* workflow function that does one request, hands it to runWorkflow
- Pretty-prints the response (uses M3's formatResponse)
- Tests: `test/adhoc.test.ts` against local mock server

**M6 — load**
- `src/load.ts`: imports `jolly-bench` as a library (NOT subprocess — keeps cancellation/signal in-process)
- Hands the workflow file to jolly-bench's runBench as the `--scenario`
- jolly-bench's NDJSON output schema matches ours (M0 frozen) — they're already compatible by design
- **Decision rejected:** subprocess via spawnSync. Reason: would lose AbortSignal propagation across process boundary and complicate progress UI. Library import is cleaner.
- **Decision deferred:** does jolly-bench need a refactor to expose its scenario runner as a library? Investigate at start of M6; if yes, that's a separate jolly-bench commit before M6 lands.
- Tests: `test/load.test.ts` — small load run against local server

**M7 — cli**
- `src/cli.ts`: arg parsing via `node:util/parseArgs`
- Mode detection: first positional arg is METHOD (ad-hoc) or `run` (workflow) or `--help`/`--version`
- SIGINT wiring → AbortController → forwarded to chosen mode's runner
- Exit code logic per spec
- Tests: `test/cli.test.ts` — child_process invocations of built CLI

**M8 — integration + docs**
- `test/integration.test.ts`: real local http server, exercises ad-hoc + run + load end-to-end
- README full rewrite from the v0.0.1 placeholder
- Smoke test commits: `node dist/cli.js GET http://localhost:9999`, `node dist/cli.js run examples/hello.mjs`, etc.

## 8. Jolly rules to honor

See `CLAUDE.md § Jolly rules that matter for this codebase`. Five rules:
1. Explicit signals on every awaited operation
2. Workflow assertion failures are fail-fast (NOT error-as-value)
3. Per-request errors in load mode ARE error-as-value (jolly-bench discipline)
4. Same workflow file works in both single and load mode
5. LIFO resource cleanup, `done()` vs `cancel()` distinction

## 9. Enumerated test cases

### `test/shorthand.test.ts`
- `name=ari` → JSON `{"name": "ari"}`
- `age:=30` → JSON `{"age": 30}`
- `nested:='[1,2]'` → JSON `{"nested": [1,2]}`
- `Auth:Bearer xyz` → header `Authorization: Bearer xyz`
- `q==hello` → query string `?q=hello`
- `file@./data.txt` → multipart upload field
- mixed: `name=ari Auth:tok q==search` → all three combined correctly
- invalid: `=value` (no key) → throws
- precedence: form vs JSON when both present (default JSON unless --form)

### `test/time.test.ts`
- `30s`, `2m`, `1h`, `500ms` → correct ms
- invalid → throws

### `test/runtime.test.ts`
- `assert(true)` → no-op
- `assert(false, "msg")` → throws AssertionError with msg
- `env.FOO` returns the right value when set via flag override
- `env` is frozen (mutation throws in strict mode)

### `test/request.test.ts`
- `request.GET(url)` → returns Response with status, headers, .json(), .text()
- non-2xx returns Response (does not throw)
- network error throws (caller decides)
- timeout fires → throws AbortError-like
- signal abort mid-request → throws
- per-request timeout via `init.timeout: "5s"` works
- per-request signal composed with timeout via `AbortSignal.any`

### `test/output.test.ts`
- NDJSON writer: appends one line per write, valid JSON
- No path → no-op writer doesn't open files
- Pretty response printer: status line, headers, JSON body indented

### `test/run.test.ts`
- Valid workflow runs and returns its return value
- Workflow with failing assert → run rejects with AssertionError
- Workflow throwing arbitrary error → run rejects, error preserved
- SIGINT during run → run rejects with AbortError, partial samples flushed

### `test/adhoc.test.ts`
- `GET http://localhost:NNN/users` → success, prints response
- `POST http://localhost:NNN/users name=ari` → JSON body sent
- `--header X-Token:abc` → header on request
- `--insecure` → TLS validation skipped
- 404 response → exits 0 (status code is not a failure)

### `test/load.test.ts`
- `run flow.mjs -c 5 -d 2s` → produces summary, sample count > 0
- All-failing workflow under load → reports errors, exits non-zero
- SIGINT during load → graceful shutdown, partial summary

### `test/cli.test.ts`
- No args → exits 2 with usage
- Both ad-hoc and run mode args → exits 2
- `--help` → exits 0 with usage
- `--version` → exits 0 with version string
- Bad URL → exits 2

### `test/integration.test.ts`
- Real local server: ad-hoc GET success
- Real local server: workflow with sequential auth + me-call → success
- Real local server: workflow with deliberate assert failure → exits 1, error message printed
- Real local server: workflow under load → summary printed, exits 0

## 10. Out of scope for v0.1.0

Deliberately excluded:

- `--watch` mode (deferred to v0.2)
- HAR recording / replay (v0.2)
- Cookie jar persistence (v0.2)
- HTTP/2, HTTP/3, WebSockets, SSE
- Output formats beyond raw + JSON (use jq/yq/miller)
- Environment files (`.env` import) (v0.3)
- Mocking / fixtures
- GUI
- OpenAPI generation / inference
- Response diffing
- Auth helpers (OAuth2 flows, AWS sigv4)

## 11. Definition of done

- [ ] All test cases in §9 implemented and passing
- [ ] `npm run typecheck` clean
- [ ] `npm run build` produces `dist/cli.js` with shebang
- [ ] `node dist/cli.js GET http://localhost:9999` prints response, exits 0
- [ ] `node dist/cli.js POST http://localhost:9999/users name=ari` sends JSON body
- [ ] `node dist/cli.js run examples/hello.mjs` runs a one-step workflow
- [ ] `node dist/cli.js run examples/auth-flow.mjs` runs a multi-step workflow with assertions
- [ ] `node dist/cli.js run examples/auth-flow.mjs -c 5 -d 3s` runs under load, prints summary
- [ ] Ctrl-C during workflow exits 130 with partial output preserved
- [ ] README rewritten with usage examples + workflow file example

## 12. Verification commands

```sh
cd C:/Users/hp/claude-projects/jolly-http
npm run typecheck
npm test
npm run build

# Smoke server (other terminal):
node -e 'require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({ok:true,path:req.url}))}).listen(9999,()=>console.log("ready"))'

# Smoke tests:
node dist/cli.js GET http://localhost:9999/users
node dist/cli.js POST http://localhost:9999/users name=ari age:=30
node dist/cli.js run examples/hello.mjs
node dist/cli.js run examples/auth-flow.mjs -c 5 -d 3s
```

## 13. Commit cadence

Roughly one commit per milestone (Conventional Commits):

- `feat(types): shared types for workflows, samples, options (M0)`
- `feat(time): duration parsing (M0)`
- `feat(shorthand): httpie body shorthand parser (M0)`
- `feat(runtime): assert and env exports for workflow files (M1)`
- `feat(request): fetch wrapper with per-request timeout and signal composition (M2)`
- `feat(output): NDJSON sample sink and pretty response printer (M3)`
- `feat(run): sequential workflow runner with dynamic import (M4)`
- `feat(adhoc): ad-hoc one-line workflow constructor for CLI args (M5)`
- `feat(load): load mode via jolly-bench library integration (M6)`
- `feat(cli): mode dispatch, SIGINT wiring, exit codes (M7)`
- `test: integration suite against local server (M8)`
- `docs: README with usage and example workflows`
- `chore: bump version to 0.1.0`

Tag `v0.1.0`, push, `npm publish`.

## 14. Parallel execution guidance for new sessions

If starting fresh in this repo: check `git log` for the last milestone committed.

- M0 has 3 files, all parallel-safe (types, time, shorthand). Batch in one round.
- After M0: M1 + M2 in one round (Track B), 2 milestones.
- After M2: M3 alone.
- After M3: M4 + M5 + M6 in one round (Track C), 3 milestones.
- After Track C: M7 alone, then M8.

That's 5 rounds for 9 milestones. Do not fake serial cadence.

For M6 specifically: investigate first whether jolly-bench needs to expose its scenario runner as a library. If yes, that's a separate commit in jolly-bench, then jolly-bench bumps a patch version, then M6 lands here.
