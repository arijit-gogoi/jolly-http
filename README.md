# jolly-http

Workflow-as-code HTTP tool built on [jolly-coop](https://github.com/arijit-gogoi/jolly-coop-js).

Simplicity of httpie, speed of xh, plus a thing neither has: **the same `.mjs` file is your debug script, your test, and your load scenario.**

## Install

```sh
npm install -g jolly-http
```

Requires Node.js ≥ 22.

## Three modes, one mental model

### 1. Ad-hoc (httpie-shaped)

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

### 2. Workflow file (sequential)

```sh
jolly-http run flow.mjs
```

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

  return { ok: true }
}
```

### 3. Same workflow, under load

```sh
jolly-http run flow.mjs -c 50 -d 30s --out samples.ndjson
```

The same file. No rewriting, no separate load-test DSL. Load mode delegates to [jolly-bench](https://github.com/arijit-gogoi/jolly-bench) in-process, so `SIGINT` still propagates cleanly and per-request samples go to NDJSON.

## Workflow API (frozen — permanent public surface)

```ts
default export: (vu: VuContext, signal: AbortSignal) => Promise<any>

vu:     { id: number, iteration: number, env: Readonly<Record<string,string>> }
signal: AbortSignal (from the scope — pass to every fetch)

import { request, assert, env, sleep } from "jolly-http"

request.GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS (url, init) → Response

init: {
  headers?: Record<string,string>
  json?: unknown           // sets body to JSON + content-type
  form?: Record<string,string>  // url-encoded
  body?: string | Uint8Array
  query?: Record<string, string | number | boolean>
  timeout?: string | number     // "5s", 1000
  signal?: AbortSignal          // composed with scope signal
  cookies?: boolean             // false → opt out of the per-VU cookie jar
}

assert(cond, msg?) → throws AssertionError when falsy
env.FOO                         // read environment (--env flags + process.env)
sleep("200ms" | 200)            // signal-aware
```

## Common options

```
--header, -H <k:v>     Add a header (repeatable)
--json <str>           Body as JSON string (overrides shorthand)
--form                 Send x-www-form-urlencoded
--timeout <dur>        Per-request timeout ("500ms", "30s", "2m")
--insecure, -k         [v0.3] Skip TLS validation (flag parsed, not yet wired)
--user-agent <str>     Override User-Agent
--quiet, -q            Suppress per-request output
--out <path>           Append NDJSON samples to path
--env KEY=VAL          Set workflow env var (repeatable)
--cookies <dir>        Persist cookies as <dir>/vu-N.json
--har <dir>            Record HAR as <dir>/vu-N.har
--har-replay <path>    Replay responses from a recorded HAR (file or dir)

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

Each line is one HTTP request (success or error) emitted by the workflow's `request.*` calls:

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"method":"POST","url":"https://api/login","status":200,"duration_ms":38.2,"size":312,"ts":"2026-04-18T03:14:15.926Z"}
{"ok":false,"t":0.191,"vu":3,"iteration":1,"method":"GET","url":"https://api/me","duration_ms":501.1,"error":"AbortError","message":"request timed out after 500ms","ts":"2026-04-18T03:14:16.427Z"}
```

The same shape in single-run and load mode — any tool that reads one reads both.

## Cookies

Cookies are auto-included on outbound requests when a per-VU jar is present, and the jar absorbs `Set-Cookie` headers from responses. Pass `--cookies <dir>` to persist:

```sh
jolly-http run flow.mjs --cookies ./jar
ls jar/    # → vu-0.json (per-VU files in load mode: vu-0.json, vu-1.json, …)
```

Run again with the same `--cookies <dir>` to reuse the previous session.

Opt out per-call with `init.cookies: false`:

```js
const r = await request.GET(`${env.API}/public`, { signal, cookies: false })
```

The jar implements RFC 6265 (Domain/Path/Secure/HttpOnly/Expires/Max-Age). It deliberately does not handle public-suffix-list (PSL) restrictions or third-party cookie blocking — those are browser concerns.

## Watch mode

Rerun on workflow file change:

```sh
jolly-http run flow.mjs --watch                       # eager (default)
jolly-http run flow.mjs --watch --watch-mode lazy     # queue, finish current run first
```

- **eager**: file change cancels in-flight requests immediately and starts a new run. Matches `nodemon`/`vitest` UX. Fast feedback; may abort mid-flight requests.
- **lazy**: file change queues; current run finishes naturally, then reload. No aborts. Use when in-flight cancellation would corrupt downstream state.

Watch mode plays nicely with `-c` and `-d`: `jolly-http run flow.mjs --watch -c 50 -d 30s` reruns the load on every change.

Ctrl-C exits 130 cleanly.

## HAR recording

Capture full request/response pairs for inspection in DevTools or HAR viewers:

```sh
jolly-http run flow.mjs --har ./har-out
ls har-out/    # → vu-0.har (per-VU in load: vu-0.har, vu-1.har, …)
```

Each `.har` file is HAR 1.2 — open in Chrome DevTools (Network → Import HAR), Firefox, or any HAR viewer. Bodies are truncated to 64 KB to keep files small in long load runs.

### Replay

Re-run a workflow against canned responses from a previously-recorded HAR — useful for offline debugging, deterministic CI, or sharing fixtures with teammates.

```sh
# Record once.
jolly-http run flow.mjs --har ./fixtures
# Replay anywhere — no network needed.
jolly-http run flow.mjs --har-replay ./fixtures
# Or share a single file across VUs.
jolly-http run flow.mjs --har-replay ./fixtures/vu-0.har
```

The path argument auto-detects:

- **File path ending in `.har`** → all VUs share the same HAR.
- **Directory path** → each VU reads `<dir>/vu-N.har` (mirrors the `--har` recording layout).

Matching is strict: `(method, full URL with query, request body)` must match an entry exactly. First-match-wins, no consume — workflows that loop over the same endpoint replay correctly.

When a request has no matching entry, `request.GET` throws `HarReplayMissError` with `.method` and `.url` for inspection. Workflows can catch it; CLI exits 1.

**Combining flags:** `--har` and `--har-replay` cannot both be set (chained record-from-replay would be confusing).

**Caveats:**

- Form bodies (`URLSearchParams`) match by exact string, so field order matters between record and replay. Use `json:` for canonical ordering.
- Request headers are not part of the match (so cookie drift between record and replay is tolerated).
- Multipart bodies have non-deterministic boundaries and aren't reliably replayable.

## Why `.mjs`?

Workflows are real JavaScript modules, not a DSL:

- **No parser divergence** — if it runs in Node, it works.
- **Editor support is free** — your ESLint, Prettier, TypeScript JSDoc, and go-to-definition all already work.
- **Helpers compose.** Write a retry wrapper, import it in three workflows.
- **Load and debug are the same file.** No "production config" drift vs. "test script" drift.

## Philosophy

Small surface, permanent contract. The workflow function signature (`(vu, signal)`) and the three runtime imports (`request`, `assert`, `env`) are the API. Everything else is implementation detail and can change.

Hurl and httpyac drowned in feature creep. jolly-http picks a different tradeoff: the power comes from the `.mjs` file being real JavaScript, not from a thousand config options.

## License

MIT — see [LICENSE](LICENSE).
