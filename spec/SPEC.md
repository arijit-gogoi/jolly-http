# jolly-http specification

The contract. Frozen post-v0.1.0 — breaking changes require a major version bump.

For implementation notes (architecture, internal modules, runtime context plumbing) see [CLAUDE.md](../CLAUDE.md). For project rationale and positioning see that file's top section. This file is pure contract: what the tool accepts, what it emits, what it promises users.

## 1. Product

A single CLI that does three things from one workflow file format:

1. **Ad-hoc HTTP** — `jolly-http GET https://api/users` (httpie-shaped)
2. **Workflow run** — `jolly-http run flow.mjs` (sequential, with assertions)
3. **Workflow under load** — `jolly-http run flow.mjs -c 50 -d 30s`

**Central invariant:** the same `.mjs` file works in modes 2 and 3 unchanged.

## 2. CLI shape

```
# Ad-hoc (httpie-style)
jolly-http <METHOD> <url> [body shorthand] [options]
jolly-http GET https://api/users
jolly-http POST https://api/users name=ari age:=30 active:=true
jolly-http PUT https://api/users/1 --json '{"name":"ari"}'
jolly-http DELETE https://api/users/1

# Workflow
jolly-http run <flow.mjs> [options]
jolly-http run flow.mjs                               # one VU, one iteration
jolly-http run flow.mjs -c 50 -d 30s                  # load mode
jolly-http run flow.mjs --env API=https://staging/    # env injection
jolly-http run flow.mjs --out responses.ndjson        # record per-request samples
```

### Common options

- `--header, -H <k:v>` (repeatable)
- `--timeout <dur>` — per-request, applies to all requests in workflow
- `--insecure, -k` — skip TLS validation (v0.3; parsed but not yet wired)
- `--user-agent <str>` — default `jolly-http/${VERSION}`
- `--quiet, -q` — suppress per-request output
- `--out <path>` — NDJSON sample file
- `--env KEY=VAL` (repeatable) — set one workflow env var
- `--env-file <path>` (repeatable) — load env vars from a file. Later files override earlier. If unset, `./.env` is auto-loaded if present.
- `--no-env-file` — disable auto-loading `./.env`
- `--require-env <path>` — fail-fast if any key from `<path>` is unset or empty in the merged env. Designed for `.env.example` files.
- `--cookies <dir>` — persist cookies as `<dir>/vu-N.json` (per-VU files)
- `--har <dir>` — record HAR as `<dir>/vu-N.har` (per-VU files)
- `--har-replay <path>` — replay responses from a recorded HAR; `*.har` file is shared across VUs, directory is per-VU. Strict match on method + url + body. Misses throw `HarReplayMissError`. Cannot be combined with `--har`.
- `--help, -h`, `--version, -V`

### Load-mode options

- `-c, --concurrency <n>` — virtual users
- `-d, --duration <dur>` — total duration
- `--rps <n>` — target aggregate requests/sec
- `--warmup <dur>` — exclude first N from stats

### Watch-mode options (run only)

- `--watch` — rerun the workflow file on change
- `--watch-mode <eager|lazy>` — `eager` (default) cancels in-flight runs on file change; `lazy` queues changes and waits for the current run to finish first

### Body shorthand (httpie-compatible subset)

| Form              | Effect                                                   |
|-------------------|----------------------------------------------------------|
| `key=value`       | JSON string field                                        |
| `key:=value`      | JSON literal (number, bool, null, array, object)         |
| `Header:value`    | Request header                                           |
| `key==value`      | Query parameter                                          |
| `key@path`        | File upload (form field; triggers form encoding)         |

### Exit codes

| Code | Meaning                                  |
|------|------------------------------------------|
| 0    | success                                  |
| 1    | fatal error or workflow assertion failed |
| 2    | bad CLI arguments                        |
| 130  | SIGINT (Ctrl-C)                          |

## 3. Workflow file format (frozen)

```js
// flow.mjs
import { request, assert, env, sleep } from "jolly-http"

export default async function (vu, signal) {
  // vu = { id: number, iteration: number, env: Readonly<Record<string,string>> }
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

  return { ok: true }   // optional — surfaced in single-run stdout
}
```

### Frozen API surface (permanent post-v0.1.0)

- **default export** — `async function (vu, signal) => any`
- **`vu` parameter** — `{ id: number, iteration: number, env: Readonly<Record<string,string>> }`
- **`signal` parameter** — the scope's `AbortSignal`; thread to every `fetch`/`sleep` that should honor cancellation
- **`request.GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS(url, init): Promise<Response>`** — `Response` is `globalThis.Response`-shaped (`.status`, `.headers`, `.json()`, `.text()`, `.arrayBuffer()`)
- **`assert(cond: unknown, msg?: string): void`** — throws `AssertionError` on falsy
- **`env`** — frozen proxy over `process.env` + `--env` flag overrides
- **`sleep(ms: number | "30s" | "2m"): Promise<void>`** — signal-aware via runtime context

### `request` init options

```ts
interface RequestInit {
  headers?: Record<string, string>
  json?: unknown                           // sets body + content-type: application/json
  form?: Record<string, string>            // sets body + content-type: application/x-www-form-urlencoded
  body?: string | Uint8Array               // raw body (overrides json/form)
  query?: Record<string, string | number | boolean>
  timeout?: string | number                // "5s", 1000 — per-request
  signal?: AbortSignal                     // composed with scope signal
  redirect?: "follow" | "manual" | "error"
  cookies?: boolean                        // false → opt this request out of the per-VU jar (v0.2+)
}
```

### Behavioral contract

- **Non-2xx responses do not throw.** `request.GET` returns a `Response` for any completed HTTP transaction; callers assert as needed.
- **Network errors throw.** Connection refused, DNS failure, TLS error → exception.
- **Timeout throws.** Exceeding `init.timeout` (or CLI `--timeout`) → `AbortError`-shaped exception.
- **Scope abort throws.** If the parent scope's signal aborts, in-flight requests throw.
- **Assertion failures are fail-fast.** A failed `assert(...)` throws; the scope rejects; the CLI exits 1. This is NOT error-as-value.
- **Per-request errors in load mode are error-as-value at the VU boundary.** A thrown error inside one VU becomes a failed `Sample`; it does NOT cancel sibling VUs.

## 4. NDJSON sample schema (frozen)

When `--out <path>` is set, one line per HTTP request issued by the workflow.

### Success

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"method":"POST","url":"https://api/login","status":200,"duration_ms":38.2,"size":312,"ts":"2026-04-18T03:14:15.926Z"}
```

### Error

```json
{"ok":false,"t":0.191,"vu":3,"iteration":1,"method":"GET","url":"https://api/me","duration_ms":501.1,"error":"AbortError","message":"request timed out after 500ms","ts":"2026-04-18T..."}
```

### Field dictionary

| Field         | Type    | Meaning                                                  |
|---------------|---------|----------------------------------------------------------|
| `ok`          | boolean | Discriminator — `true` for success, `false` for error    |
| `t`           | number  | Seconds since run start (monotonic)                      |
| `vu`          | number  | Virtual user id — `0` in single-run mode                 |
| `iteration`   | number  | Iteration index within the VU                            |
| `method`      | string  | HTTP method                                              |
| `url`         | string  | Fully resolved URL (query params included)               |
| `status`      | number  | HTTP status code (success only)                          |
| `duration_ms` | number  | Wall-clock time from request start to response complete  |
| `size`        | number  | Response body size in bytes (success only)               |
| `error`       | string  | Error class name, e.g. `"AbortError"` (error only)       |
| `message`     | string  | Error message (error only)                               |
| `ts`          | string  | ISO 8601 timestamp at request start                      |

**Schema stability:** same shape in single-run and load mode. Downstream tools (diff, stats, dashboards) read one schema.

## 5. Architecture pointer

The internal scope tree, resource discipline, and runtime-context plumbing is implementation detail — see [CLAUDE.md § Architecture](../CLAUDE.md) and the in-source docstrings. Workflow authors never need to know these details; the frozen API in §3 is the entire user-facing contract.

## 6. Out of scope (deliberate)

Features explicitly NOT part of the current release. Listed here so the boundary is visible, not hidden:

**Deferred to v0.4 (planned):**

- `--insecure` wiring — flag is parsed but inert pending undici-dispatcher integration
- Cookie domain/public-suffix list (PSL) handling
- HAR replay matching modes beyond strict (loose, sequential, permissive miss)
- Mode-based env file chains (`.env.production`, `.env.production.local`)

**Deferred indefinitely:**

- HTTP/2, HTTP/3, WebSockets, Server-Sent Events
- Output formats beyond raw + JSON (use `jq`/`yq`/`miller`)
- Mocking / fixtures
- GUI
- OpenAPI generation / inference
- Response diffing
- Auth helpers (OAuth2 flows, AWS SigV4, etc.) — workflow authors write their own
- Retry helpers — workflow authors write their own
- Multi-file workflow imports

**Shipped in v0.2:** `--watch`, cookie jar with `--cookies <dir>`, HAR recording with `--har <dir>`, HAR replay with `--har-replay <path>`.

**Shipped in v0.3:** `.env` file loading with `--env-file <path>` (repeatable, with auto-load of `./.env`), `--no-env-file` opt-out, `--require-env <path>` validation against a `.env.example` schema.

### Environment file precedence

```
--env KEY=VAL  >  process.env  >  --env-file files (later > earlier)  >  auto-loaded ./.env
```

Higher precedence overrides lower. Each `.env` file supports the dotenv dialect: `KEY=value`, double/single-quoted values (`"..."`/`'...'`), `${VAR}` interpolation against earlier keys *in the same file*, multiline values inside `"..."`, `# comments`, and `export KEY=value` (bash-compat prefix). Bare `$VAR` interpolation is **not** supported (avoids eating `$1`, `$@`, currency strings).

### Principle

The workflow file is real JavaScript. Anything that can be expressed as a few lines of workflow code does not belong in the CLI. This is the wedge vs. Hurl / httpyac / k6 — the power comes from the `.mjs` file, not from growing CLI surface.

## 7. Jolly rules (ground truth)

See [CLAUDE.md § Jolly rules that matter for this codebase](../CLAUDE.md) for the five rules that govern cancellation, error discipline, resource cleanup, and single-vs-load mode equivalence. Those rules inform the behavioral contract in §3 — they're not redundant, but CLAUDE.md is the authoritative copy.
