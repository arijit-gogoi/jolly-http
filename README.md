# jolly-http

Workflow-as-code HTTP tool built on [jolly-coop](https://github.com/arijit-gogoi/jolly-coop-js).

Simplicity of httpie, speed of xh, plus a thing neither has: **the same `.mjs` file is your debug script, your test, and your load scenario.**

## One file, three ways

```js
// flow.mjs
import { request, assert, env } from "jolly-http"

export default async function (vu, signal) {
  const login = await request.POST(`${env.API}/login`, {
    json: { user: vu.id },
    signal,
    timeout: "5s",
  })
  assert(login.status === 200, "login failed")

  const { token } = await login.json()

  const me = await request.GET(`${env.API}/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  assert(me.status === 200)
}
```

```sh
# Debug it.
jolly-http run flow.mjs

# Record real responses for offline replay.
jolly-http run flow.mjs --har ./fixtures

# Load-test it.
jolly-http run flow.mjs -c 50 -d 30s --out samples.ndjson
```

Same file. No rewriting, no separate load-test DSL, no second tool.

## Install

```sh
npm install -g jolly-http
```

Requires Node.js ≥ 22. Also runs on Bun and Deno via the published npm package.

## Modes

### Ad-hoc (httpie-shaped)

```sh
jolly-http GET https://api.github.com/users/arijit-gogoi
jolly-http POST https://httpbin.org/post name=ari age:=30 Auth:tok
jolly-http PUT https://api/users/1 --json '{"name":"ari"}'
```

Body shorthand:

| Form              | Effect                                        |
|-------------------|-----------------------------------------------|
| `key=value`       | JSON string field                             |
| `key:=value`      | JSON literal (number, bool, null, array, obj) |
| `Header:value`    | Request header                                |
| `key==value`      | Query parameter                               |
| `key@path`        | File upload (form field)                      |

### Workflow file (sequential)

The `flow.mjs` shown above. Run it with one VU, one iteration:

```sh
jolly-http run flow.mjs
```

### Under load

```sh
jolly-http run flow.mjs -c 50 -d 30s --out samples.ndjson
```

Same file. No rewriting, no separate load-test DSL. SIGINT propagates through the in-process load runner; per-request samples go to NDJSON.

### TypeScript directly

A workflow file can be `.ts` instead of `.mjs` on any runtime that strips types natively:

```sh
jolly-http run flow.ts                                       # Bun, Deno, Node ≥ 23
node --experimental-strip-types $(which jolly-http) run flow.ts   # Node 22.6+
```

```ts
// flow.ts
import { request, assert, env, type VuContext } from "jolly-http"

export default async function (vu: VuContext, signal: AbortSignal) {
  const r = await request.GET(`${env.API}/me`, { signal })
  assert(r.status === 200)
  return await r.json()
}
```

Type imports work the same as in any `.ts` module — `VuContext`, `RequestInit`, `Sample`, `HookFn` etc. are all exported from `"jolly-http"`. `request.GET` returns `Promise<Response>`, `assert` is typed `asserts cond` so it narrows for downstream code. No transpile step, no build dep — your runtime does it.

If your runtime can't strip types and the npm package's transpile-on-the-fly options aren't an option, use `.mjs`.

## Workflow API (frozen — permanent public surface)

```ts
default export: (vu: VuContext, signal: AbortSignal, ctx?: unknown) => Promise<any>
//                                                    ^^^^^^^^^^^^^ v0.5+: whatever before returned

vu:     { id: number, iteration: number, env: Readonly<Record<string,string>> }
signal: AbortSignal (from the scope — pass to every fetch)

import { request, assert, env, sleep, log } from "jolly-http"

request.GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS (url, init) → Response

init: {
  headers?: Record<string,string>
  json?: unknown                // sets body to JSON + content-type
  form?: Record<string,string>  // url-encoded
  body?: string | Uint8Array
  query?: Record<string, string | number | boolean>
  timeout?: string | number     // "5s", 1000
  signal?: AbortSignal          // composed with scope signal
  redirect?: "follow" | "manual" | "error"  // default: GET/HEAD/OPTIONS = follow,
                                            //          POST/PUT/PATCH/DELETE = manual (v0.5+)
  cookies?: boolean             // false → opt this request out of the jar
}

assert(cond, msg?)              // throws AssertionError when falsy
log.event(name, data?)          // emit a structured trace point to NDJSON (v0.5+)
env.FOO                         // --env flags + process.env + .env files
sleep("200ms" | 200)            // signal-aware
```

When an `assert(...)` fails inside a workflow, the thrown `AssertionError` auto-includes the most recently completed request's URL, status, headers, and full response body. Debugging assertion failures usually means staring at the error message and that's it — no `console.log` cargo-culting required.

## Setup and teardown

Two optional named exports run once per process around the iteration loop:

```js
// flow.mjs
import { request, env } from "jolly-http"

let testUserId               // module-level state, shared across hooks (real JS)

export async function prologue(env, signal) {
  // Runs ONCE before any iteration. throw to abort the run.
  const r = await request.POST(`${env.API}/test-users`, {
    json: { email: "test@example.com" },
    signal,
  })
  testUserId = (await r.json()).id
}

export default async function (vu, signal) {
  // Runs per VU per iteration (or once in single-run mode).
  await request.POST(`${env.API}/login`, { json: { id: testUserId }, signal })
  // ...
}

export async function epilogue(env, signal) {
  // Runs ONCE after iterations. ALWAYS fires — including on Ctrl-C and
  // even when prologue threw. Use for cleanup that must happen regardless.
  if (testUserId) {
    await request.DELETE(`${env.API}/test-users/${testUserId}`, { signal })
  }
}
```

The contract:

- **`prologue` runs before any iteration.** Throwing aborts the run with exit 1.
- **`epilogue` ALWAYS runs.** Including: prologue threw, default threw, abort/Ctrl-C. This matches `jest beforeAll/afterAll`, `pytest fixtures`, etc. — partial-setup teardown is the point. Implemented as a scope resource registered before prologue, so cleanup is guaranteed.
- **State across hooks** uses module-level `let`. There is no separate state-passing API. Real JS, the wedge.
- **`request.*` / `assert` / `env` / `sleep` work inside hooks.** They run inside their own runtime context; samples emitted from hooks carry `phase: "prologue"` or `phase: "epilogue"` in the NDJSON output (omitted for iteration samples).
- **A workflow file with only `prologue`/`epilogue` and no `default` export is invalid** — that's a script, not a workflow.

### Per-iteration setup and teardown (v0.5+)

`prologue`/`epilogue` are once-per-process. For setup that runs **once per iteration** — typical of E2E suites where each iteration creates and tears down its own fixture (test user, draft post, transient row) — use `before` and `after`:

```js
// flow.mjs
import { request } from "jolly-http"

export async function before(vu, signal) {
  // Runs before `default` for every iteration. Returns a context object.
  const r = await request.POST("/test-users", { json: { vu: vu.id }, signal })
  const { id, email } = await r.json()
  return { userId: id, createdEmails: [email] }
}

export default async function (vu, signal, ctx) {
  // ctx is what before returned; mutate freely.
  ctx.createdEmails.push(`alt-${vu.iteration}@example.com`)
  await request.POST("/some-flow", { json: { user: ctx.userId }, signal })
}

export async function after(vu, signal, ctx) {
  // ALWAYS runs — including when before or default threw, or on Ctrl-C.
  for (const email of ctx.createdEmails) {
    await request.DELETE(`/test-users/${encodeURIComponent(email)}`, { signal })
  }
}
```

The contract:

- **`before` runs before `default`** for every iteration. Returns a context object passed as the third argument to `default` and `after`. Returning `undefined` means `{}` is threaded.
- **`after` ALWAYS runs.** Including when `before` threw, when `default` threw, on signal abort. This is the iteration-scale equivalent of `epilogue` — implemented as a scope resource registered before `before` runs.
- **The cookie jar is SHARED** across `before`/`default`/`after` within an iteration. A login in `before` is visible to `default`; `after` can issue authenticated DELETE.
- **`AssertionError` last-response is ISOLATED per phase.** A failed assert in `after` shows `after`'s last request, not `before`'s.
- **State within an iteration** flows through the `ctx` object. **State between iterations** is your problem — that's the point of "per-iteration."
- **Composes with `prologue`/`epilogue`.** Both tiers can coexist: `prologue` → (`before` → `default` → `after`) × N → `epilogue`.

This eliminates the hand-rolled `try/finally { await cleanupUser(email) }` boilerplate that every real E2E suite ends up writing.

### Structured trace points: `log.event` (v0.5+)

Mid-test trace points belong in the same NDJSON stream as request samples — same envelope (`vu`, `iteration`, `t`, `ts`, optional `phase`), parseable with the same tools.

```js
import { request, log } from "jolly-http"

export default async function (vu, signal) {
  log.event("checkout.started")
  await request.POST("/cart/add", { json: {...}, signal })
  log.event("autosave.flushed", { postId: 7, attempt: 3 })
}
```

Each call writes one NDJSON line:

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"event":"checkout.started","ts":"..."}
{"ok":true,"t":0.250,"vu":7,"iteration":0,"event":"autosave.flushed","data":{"postId":7,"attempt":3},"ts":"..."}
```

Discriminate events from request samples with `"event" in sample`. They survive 50 concurrent VUs cleanly because the sink already serializes line-by-line.

## Common options

```
--header, -H <k:v>     Add a header (repeatable)
--json <str>           Body as JSON string (overrides shorthand)
--form                 Send x-www-form-urlencoded
--timeout <dur>        Per-request timeout ("500ms", "30s", "2m")
--user-agent <str>     Override User-Agent
--quiet, -q            Suppress per-request output
--out <path>           Append NDJSON samples to path
--env KEY=VAL          Set workflow env var (repeatable)
--env-file <path>      Load env vars from a file (repeatable; later wins)
--no-env-file          Skip auto-loading ./.env
--require-env <path>   Fail-fast if any key from <path> is unset/empty
--cookies <dir>        Save jar to <dir>/vu-N.json on exit (fresh-each-run default)
--cookies-resume <dir> Load jar on startup AND save on exit (cross-run continuity)
--har <dir>            Record HAR as <dir>/vu-N.har
--har-replay <path>    Replay responses from a recorded HAR (file or dir)
--insecure, -k         (no-op; see "Self-signed certs" below)

Load mode:
  -c, --concurrency <n>  Virtual users
  -d, --duration <dur>   Total duration ("30s", "2m")
  --rps <n>              Target requests/sec
  --warmup <dur>         Exclude first N from stats

Watch mode (run only):
  --watch                Rerun workflow on file change
  --watch-mode <mode>    eager (cancel mid-flight, default) | lazy (queue)
```

Exit codes: `0` success · `1` fatal or assertion failure · `2` bad args · `130` SIGINT.

## NDJSON schema

One line per HTTP request emitted by `request.*`:

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"method":"POST","url":"https://api/login","status":200,"duration_ms":38.2,"size":312,"ts":"2026-04-18T03:14:15.926Z"}
{"ok":false,"t":0.191,"vu":3,"iteration":1,"method":"GET","url":"https://api/me","duration_ms":501.1,"error":"AbortError","message":"request timed out after 500ms","ts":"2026-04-18T03:14:16.427Z"}
```

Same shape in single-run and load mode — any tool that reads one reads both.

## Cookies

**Cookies are on by default.** Each workflow run gets a per-VU jar that auto-includes cookies on outbound requests and absorbs `Set-Cookie` headers from responses. A login → me-call workflow Just Works without configuration.

```js
await request.GET(`${env.API}/login`)            // jar absorbs Set-Cookie
await request.GET(`${env.API}/me`)               // cookie sent automatically
await request.GET(`${env.API}/public`, { cookies: false })  // opt out per call
```

**Every run starts with an empty jar.** No flags = in-memory jar, discarded when the run ends. Two flags persist to disk; both write per-VU files (`vu-0.json`, `vu-1.json`, …):

| Flag | On startup | On exit |
|------|------------|---------|
| (none) | empty jar | discarded |
| `--cookies <dir>` | empty jar | save to `<dir>/vu-N.json` |
| `--cookies-resume <dir>` | load from `<dir>/vu-N.json` if present | save to `<dir>/vu-N.json` |

Pick by intent:

- **`--cookies <dir>`** is for *audit / inspection*. Run finishes (or `Ctrl-C`s), you have a snapshot of every cookie the server set. Useful for debugging Set-Cookie behavior, sharing reproducers, CI artifacts.

- **`--cookies-resume <dir>`** is for *cross-run session continuity*, the `httpie --session=name` / `xh --session=name` / `curl --cookie-jar` model. Use when you want to log in once and amortize across multiple ad-hoc commands or workflow runs.

The two flags are mutually exclusive — pick one shape per invocation.

> **v0.4 breaking change.** Pre-0.4, `--cookies <dir>` loaded prior-session jars on startup. That made flaky CI runs inherit stale logged-in state from previous failures. The default is now fresh-each-run; pass `--cookies-resume <dir>` for the old behavior.

The jar implements RFC 6265 (Domain/Path/Secure/HttpOnly/Expires/Max-Age). It does not handle the public-suffix list or third-party cookie blocking — those are browser concerns.

## Environment files

`./.env` is auto-loaded from cwd if present. Read values via the frozen `env` import:

```js
const res = await request.GET(`${env.API_BASE}/users`, {
  headers: { authorization: `Bearer ${env.API_TOKEN}` },
  signal,
})
```

### Precedence (highest wins)

```
--env KEY=VAL  >  process.env  >  --env-file files (later > earlier)  >  auto ./.env
```

Same as dotenv, Next.js, Vite, every modern framework.

```sh
jolly-http run flow.mjs --env-file .env.staging              # one file, no auto-load
jolly-http run flow.mjs --env-file .env --env-file .env.local # later overrides earlier
jolly-http run flow.mjs --no-env-file                        # skip ./.env
```

Explicit `--env-file` disables auto-loading `./.env`.

### Validation with `--require-env`

Pair a committed `.env.example` (placeholder values, in git) with a gitignored `.env`:

```sh
# .env.example          # .env (gitignored)
API_BASE=               API_BASE=https://api.example.com
API_TOKEN=              API_TOKEN=tok-xyz

jolly-http run flow.mjs --env-file .env --require-env .env.example
```

If any key listed in `.env.example` is unset or empty after the merge, the run fails fast *before* the workflow's first request, listing every missing key:

```
missing required env vars from .env.example:
  - API_TOKEN
set them in .env, export them, or pass --env KEY=VAL
```

### Format

Standard dotenv dialect:

```
# Comment
KEY=value
QUOTED="value with spaces"
SINGLE='no $interpolation here'
INTERPOLATED=${KEY}/path
MULTILINE="line1
line2"
export FOO=bar     # bash-compat prefix; "export " is stripped
```

`${VAR}` interpolation only resolves against keys defined earlier *in the same file*. Bare `$VAR` is literal — no eating of `$1`, `$@`, currency strings.

## Watch mode

Rerun on workflow file change:

```sh
jolly-http run flow.mjs --watch                       # eager (default)
jolly-http run flow.mjs --watch --watch-mode lazy     # queue, finish current first
```

- **eager** — cancel in-flight requests and start a new run. Matches `nodemon`/`vitest`. Fast feedback.
- **lazy** — queue file changes; current run finishes naturally, then reload.

Watch composes with load mode: `jolly-http run flow.mjs --watch -c 50 -d 30s` reruns the load on every change. Ctrl-C exits 130.

## HAR recording

Capture full request/response pairs for inspection in DevTools or HAR viewers:

```sh
jolly-http run flow.mjs --har ./har-out
ls har-out/    # → vu-0.har (per-VU in load: vu-0.har, vu-1.har, …)
```

HAR 1.2 — opens in Chrome DevTools (Network → Import HAR), Firefox, or any HAR viewer. Bodies truncated to 64 KB.

### Replay

Re-run a workflow against canned responses from a recorded HAR — useful for offline debugging, deterministic CI, or sharing fixtures:

```sh
jolly-http run flow.mjs --har ./fixtures              # record once
jolly-http run flow.mjs --har-replay ./fixtures       # replay (per-VU dir)
jolly-http run flow.mjs --har-replay ./fixtures/vu-0.har  # replay (single shared file)
```

Path auto-detects: `*.har` → shared file across VUs; directory → `<dir>/vu-N.har` per VU.

Matching is **strict**: `(method, full URL with query, request body)` must match an entry exactly. First-match-wins, no consume — workflows that loop over the same endpoint replay correctly. Misses throw `HarReplayMissError` (with `.method`, `.url`); CLI exits 1.

`--har` and `--har-replay` cannot both be set.

**Caveats:**
- Form bodies (`URLSearchParams`) match by exact string — field order matters. Use `json:` for canonical ordering.
- Headers are not part of the match (cookie drift between record/replay is tolerated).
- Multipart bodies have non-deterministic boundaries; not reliably replayable.

## Self-signed certs / internal CAs

To skip TLS validation, use your runtime's built-in flag — cross-runtime, zero-dep, properly scoped:

```sh
NODE_TLS_REJECT_UNAUTHORIZED=0 jolly-http run flow.mjs    # Node
bun --tls-no-verify run jolly-http run flow.mjs           # Bun
deno run --unsafely-ignore-certificate-errors jolly-http run flow.mjs  # Deno
```

Node prints a stderr warning — that's intentional UX. The proper fix for internal CAs is your system trust store; the runtime flags are an escape hatch for CI / dev iteration.

> The `--insecure, -k` CLI flag is a no-op and may be removed in a future major.

## Troubleshooting

### `TypeError: fetch failed` with no detail

undici (Node's fetch) wraps every network failure as `fetch failed`. jolly-http walks `.cause` and surfaces a structured error name in the NDJSON `error` field — `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, etc. for system errno; `UND_ERR_BODY_TIMEOUT` etc. for undici-internal; `AbortError` for cancellation. The thrown error retains its full `.cause` chain — workflows that catch can walk it.

```js
try {
  await request.GET(url, { signal })
} catch (err) {
  console.error(err.cause?.code)  // e.g. "ECONNREFUSED"
}
```

### POST returned no error but my assertion on `.status` fails

**Fixed in v0.5.** `POST`/`PUT`/`PATCH`/`DELETE` now default to `redirect: "manual"`, so `assert(signup.status === 303)` works against server-rendered apps (htmx, Rails, Phoenix, Django, Axum) without any per-call ceremony. `GET`/`HEAD`/`OPTIONS` still default to `"follow"`. Pass `redirect: "follow"` explicitly to opt back into the old behavior on a per-call basis:

```js
const signup = await request.POST(`${env.API}/signup`, { json: { email }, signal })
assert(signup.status === 303, `expected 303, got ${signup.status}`)

// Want to follow the redirect chain? Opt in per call:
const browsed = await request.POST(`${env.API}/signup`, {
  json: { email },
  redirect: "follow",   // ← back to the v0.4 default
  signal,
})
```

If you're on v0.4 or earlier, every redirect-emitting POST needs `redirect: "manual"` explicitly; the default flip in v0.5 is exactly to remove that ceremony.

### `jolly-http: request/assert/env/sleep can only be used from inside a workflow function`

`request.*`, `assert`, `env`, `sleep` discover their state via an async-local runtime context. They work *only* when called from inside the workflow's `default` export, `prologue`, or `epilogue`. Helper modules are fine — but the helper has to be **called** from inside one of those, not run at module-import time.

Wrong (call at import time):
```js
// helper.mjs
import { request } from "jolly-http"
await request.GET("/")   // ← throws on import
```

Right (call from inside workflow):
```js
// helper.mjs
import { request } from "jolly-http"
export const fetchUser = (id) => request.GET(`/users/${id}`)

// flow.mjs
import { fetchUser } from "./helper.mjs"
export default async function () {
  await fetchUser(7)   // ← runs inside the workflow's runtime
}
```

### Missing env var

Use `--require-env <path>` against a committed `.env.example`:

```sh
jolly-http run flow.mjs --env-file .env --require-env .env.example
```

Fails fast before the workflow's first request, listing every missing key.

### Cookies surviving across runs

In v0.4+, that only happens with `--cookies-resume <dir>` (opt-in cross-run continuity). The default `--cookies <dir>` is fresh-each-run — every invocation starts with an empty jar. See [Cookies](#cookies).

### Structured logging in load mode

**Use `log.event` (v0.5+).** It writes to the same NDJSON stream as request samples, with the same envelope (`vu`, `iteration`, `t`, `ts`, optional `phase`):

```js
import { log } from "jolly-http"
log.event("step1.done", { recordId: 42 })
```

`console.log` lines garble across concurrent VUs. `process.stderr.write(JSON.stringify(...) + "\n")` works as a fallback on older versions but doesn't merge with the NDJSON output stream. See [Structured trace points](#structured-trace-points-logevent-v05).

### Assertion failure with no context

In v0.4+, `AssertionError` automatically includes the most recent request's URL, status, headers, and full response body. If you're seeing just the message and no context, you're likely on an older version — upgrade.

## Why `.mjs`?

Workflows are real JavaScript modules, not a DSL:

- **No parser divergence** — if it runs in Node, it works.
- **Editor support is free** — ESLint, Prettier, TypeScript JSDoc, go-to-definition all work.
- **Helpers compose.** Write a retry wrapper, import it in three workflows.
- **Load and debug are the same file.** No "production config" vs. "test script" drift.

## Philosophy

Small surface, permanent contract. The workflow function signature (`(vu, signal)`) and the four runtime imports (`request`, `assert`, `env`, `sleep`) are the API. Everything else is implementation detail and can change.

Hurl and httpyac drowned in feature creep. jolly-http picks a different tradeoff: power comes from the `.mjs` file being real JavaScript, not from a thousand config options.

## License

MIT — see [LICENSE](LICENSE).
