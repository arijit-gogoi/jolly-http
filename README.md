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
--insecure, -k         [v0.2] Skip TLS validation (flag parsed, not yet wired)
--user-agent <str>     Override User-Agent
--quiet, -q            Suppress per-request output
--out <path>           Append NDJSON samples to path
--env KEY=VAL          Set workflow env var (repeatable)

Load mode:
  -c, --concurrency <n>  Virtual users
  -d, --duration <dur>   Total duration ("30s", "2m")
  --rps <n>              Target requests/sec
  --warmup <dur>         Exclude first N from stats
```

Exit codes: `0` success · `1` fatal or assertion failure · `2` bad args · `130` SIGINT.

## NDJSON schema

Each line is one HTTP request (success or error) emitted by the workflow's `request.*` calls:

```json
{"ok":true,"t":0.142,"vu":7,"iteration":0,"method":"POST","url":"https://api/login","status":200,"duration_ms":38.2,"size":312,"ts":"2026-04-18T03:14:15.926Z"}
{"ok":false,"t":0.191,"vu":3,"iteration":1,"method":"GET","url":"https://api/me","duration_ms":501.1,"error":"AbortError","message":"request timed out after 500ms","ts":"2026-04-18T03:14:16.427Z"}
```

The same shape in single-run and load mode — any tool that reads one reads both.

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
