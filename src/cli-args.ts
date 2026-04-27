import { parseArgs } from "node:util"
import { parseDuration } from "jolly-coop"

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

export interface CliArgs {
  mode: "adhoc" | "run" | "help" | "version"
  method?: string
  url?: string
  workflow?: string
  shorthand: string[]
  headers: Record<string, string>
  env: Record<string, string>
  json?: string
  form: boolean
  timeoutMs?: number
  insecure: boolean
  userAgent?: string
  quiet: boolean
  outPath?: string
  concurrency?: number
  durationMs?: number
  rps?: number
  warmupMs?: number
  watch: boolean
  watchMode: "eager" | "lazy"
  cookiesDir?: string
  harDir?: string
  harReplayPath?: string
}

export class CliError extends Error {
  constructor(msg: string, public readonly exitCode: number) {
    super(msg)
    this.name = "CliError"
  }
}

export function parseCli(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        header: { type: "string", short: "H", multiple: true },
        json: { type: "string" },
        form: { type: "boolean" },
        timeout: { type: "string" },
        insecure: { type: "boolean", short: "k" },
        "user-agent": { type: "string" },
        quiet: { type: "boolean", short: "q" },
        out: { type: "string" },
        env: { type: "string", multiple: true },
        concurrency: { type: "string", short: "c" },
        duration: { type: "string", short: "d" },
        rps: { type: "string" },
        warmup: { type: "string" },
        watch: { type: "boolean" },
        "watch-mode": { type: "string" },
        cookies: { type: "string" },
        har: { type: "string" },
        "har-replay": { type: "string" },
      },
    })
  } catch (err) {
    throw new CliError(`bad args: ${(err as Error).message}`, 2)
  }

  const values = parsed.values as Record<string, string | boolean | string[] | undefined>
  const positionals = parsed.positionals

  if (values.help) return baseArgs({ mode: "help" })
  if (values.version) return baseArgs({ mode: "version" })

  const headers = parseKeyVal(values.header, (raw: string) => {
    const idx = raw.indexOf(":")
    if (idx <= 0) throw new CliError(`bad --header: ${raw} (expected Key:Value)`, 2)
    return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]
  })
  const envFlags = parseKeyVal(values.env, (raw: string) => {
    const idx = raw.indexOf("=")
    if (idx <= 0) throw new CliError(`bad --env: ${raw} (expected KEY=VAL)`, 2)
    return [raw.slice(0, idx), raw.slice(idx + 1)]
  })

  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined
  const concurrency =
    typeof values.concurrency === "string" ? parseInt(values.concurrency, 10) : undefined
  const durationMs =
    typeof values.duration === "string" ? parseDuration(values.duration) : undefined
  const rps = typeof values.rps === "string" ? parseFloat(values.rps) : undefined
  const warmupMs = typeof values.warmup === "string" ? parseDuration(values.warmup) : undefined

  const watch = values.watch === true
  const watchModeRaw = strOrUndef(values["watch-mode"])
  if (watchModeRaw !== undefined && watchModeRaw !== "eager" && watchModeRaw !== "lazy") {
    throw new CliError(`bad --watch-mode: ${watchModeRaw} (expected eager|lazy)`, 2)
  }
  const watchMode: "eager" | "lazy" = (watchModeRaw as "eager" | "lazy" | undefined) ?? "eager"
  const cookiesDir = strOrUndef(values.cookies)
  const harDir = strOrUndef(values.har)
  const harReplayPath = strOrUndef(values["har-replay"])
  if (harDir !== undefined && harReplayPath !== undefined) {
    throw new CliError("--har and --har-replay cannot be combined (chained record-from-replay is unsupported)", 2)
  }

  if (positionals.length === 0) throw new CliError("no arguments — see --help", 2)
  const first = positionals[0]

  if (first === "run") {
    if (positionals.length < 2) throw new CliError("run: missing workflow path", 2)
    return baseArgs({
      mode: "run",
      workflow: positionals[1],
      headers,
      env: envFlags,
      timeoutMs,
      insecure: values.insecure === true,
      userAgent: strOrUndef(values["user-agent"]),
      quiet: values.quiet === true,
      outPath: strOrUndef(values.out),
      concurrency,
      durationMs,
      rps,
      warmupMs,
      watch,
      watchMode,
      cookiesDir,
      harDir,
      harReplayPath,
    })
  }
  if (watch) throw new CliError("--watch only valid with `run` subcommand", 2)

  const upper = first.toUpperCase()
  if (METHODS.has(upper)) {
    if (positionals.length < 2) throw new CliError(`${upper}: missing URL`, 2)
    const url = positionals[1]
    if (!/^https?:\/\//.test(url)) throw new CliError(`invalid URL: ${url}`, 2)
    const shorthand = positionals.slice(2)
    return baseArgs({
      mode: "adhoc",
      method: upper,
      url,
      shorthand,
      headers,
      json: strOrUndef(values.json),
      form: values.form === true,
      timeoutMs,
      insecure: values.insecure === true,
      userAgent: strOrUndef(values["user-agent"]),
      quiet: values.quiet === true,
      outPath: strOrUndef(values.out),
      env: envFlags,
      cookiesDir,
      harDir,
      harReplayPath,
    })
  }

  throw new CliError(`unknown mode: ${first} (expected METHOD or "run")`, 2)
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function baseArgs(partial: Partial<CliArgs> & { mode: CliArgs["mode"] }): CliArgs {
  return {
    mode: partial.mode,
    method: partial.method,
    url: partial.url,
    workflow: partial.workflow,
    shorthand: partial.shorthand ?? [],
    headers: partial.headers ?? {},
    env: partial.env ?? {},
    json: partial.json,
    form: partial.form ?? false,
    timeoutMs: partial.timeoutMs,
    insecure: partial.insecure ?? false,
    userAgent: partial.userAgent,
    quiet: partial.quiet ?? false,
    outPath: partial.outPath,
    concurrency: partial.concurrency,
    durationMs: partial.durationMs,
    rps: partial.rps,
    warmupMs: partial.warmupMs,
    watch: partial.watch ?? false,
    watchMode: partial.watchMode ?? "eager",
    cookiesDir: partial.cookiesDir,
    harDir: partial.harDir,
    harReplayPath: partial.harReplayPath,
  }
}

function parseKeyVal(
  raw: string | string[] | boolean | undefined,
  split: (s: string) => [string, string],
): Record<string, string> {
  if (!raw) return {}
  const list = Array.isArray(raw) ? raw : [raw as string]
  const out: Record<string, string> = {}
  for (const item of list) {
    const [k, v] = split(item)
    out[k] = v
  }
  return out
}

export const USAGE = `jolly-http — workflow-as-code HTTP tool

USAGE
  jolly-http <METHOD> <url> [shorthand...] [options]
  jolly-http run <flow.mjs> [options]

MODES
  Ad-hoc:     jolly-http GET https://api/users
              jolly-http POST https://api/users name=ari age:=30
  Workflow:   jolly-http run flow.mjs
  Load:       jolly-http run flow.mjs -c 50 -d 30s

SHORTHAND (ad-hoc body)
  key=value          JSON string field
  key:=value         JSON literal (number, bool, null, array, object)
  Header:value       Request header
  key==value         Query parameter

OPTIONS
  --header, -H <k:v>        Add a header (repeatable)
  --json <str>              Set body to this JSON string (overrides shorthand)
  --form                    Use form encoding instead of JSON
  --timeout <dur>           Per-request timeout (e.g. 5s, 500ms)
  --insecure, -k            [v0.3] Skip TLS validation (not yet wired)
  --user-agent <str>        Override User-Agent
  --quiet, -q               Suppress per-request output
  --out <path>              Write NDJSON samples to path
  --env KEY=VAL             Set env var for workflow (repeatable)
  --cookies <dir>           Persist cookies as <dir>/vu-N.json (per-VU files)
  --har <dir>               Record HAR as <dir>/vu-N.har (per-VU files)
  --har-replay <path>       Replay responses from a recorded HAR.
                            file (*.har) → shared across VUs;
                            directory     → per-VU (<dir>/vu-N.har).
                            Strict match: method + url + body. Misses throw.

LOAD MODE
  -c, --concurrency <n>     Virtual users (default 1)
  -d, --duration <dur>      Total duration (e.g. 30s, 2m)
  --rps <n>                 Target requests/sec
  --warmup <dur>            Exclude first N from stats

WATCH MODE (run only)
  --watch                   Rerun workflow on file change
  --watch-mode <mode>       eager (cancel mid-flight, default) | lazy (queue)

  --help, -h                Show this help
  --version, -V             Show version

EXAMPLES
  jolly-http GET https://api.github.com/users/arijit-gogoi
  jolly-http POST https://httpbin.org/post name=ari age:=30 Auth:tok
  jolly-http run examples/auth.mjs --env API=https://staging/
  jolly-http run examples/auth.mjs -c 50 -d 30s --out samples.ndjson
  jolly-http run examples/auth.mjs --watch --cookies ./jar
  jolly-http run examples/auth.mjs --har ./har-out
  jolly-http run examples/auth.mjs --har-replay ./har-out
`
