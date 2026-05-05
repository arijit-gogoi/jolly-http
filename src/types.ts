export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

export interface VuContext {
  id: number
  iteration: number
  env: Readonly<Record<string, string>>
}

/**
 * The default-exported workflow function. v0.5+ accepts an optional third
 * argument `ctx` — whatever `before` returned (or `{}` if there's no `before`
 * or `before` returned undefined). Existing 2-arg defaults are still valid;
 * the third arg is additive.
 */
export type WorkflowFn = (
  vu: VuContext,
  signal: AbortSignal,
  ctx?: unknown,
) => Promise<unknown> | unknown

/**
 * Hook function called once-per-process around the iteration loop.
 * `prologue` runs before any iteration; `epilogue` runs after all iterations
 * (including on abort/Ctrl-C, including when prologue threw).
 *
 * Hooks receive the merged `env` and the parent scope's `signal`. They run
 * inside a synthetic runtime context so `request.*` / `assert` / `sleep` /
 * `env` work normally — the same module-level imports used in the default
 * export. Module-level `let` bindings are the recommended way to carry state
 * between hooks (real JS, no separate state-passing API).
 */
export type HookFn = (
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<unknown> | unknown

/**
 * Per-iteration setup hook (v0.5+). Runs before `default` for every iteration.
 * Returns a context object passed as the third arg to `default` and `after`.
 * Returning `undefined` results in `{}` being threaded.
 */
export type BeforeFn = (
  vu: VuContext,
  signal: AbortSignal,
) => Promise<unknown> | unknown

/**
 * Per-iteration teardown hook (v0.5+). Runs after `default` for every iteration.
 * ALWAYS fires — including when `before` threw, when `default` threw, and on
 * abort/Ctrl-C. Receives the same context object `before` returned (or `{}`).
 * Implemented via scope.resource registered before `before` runs, so cleanup
 * is guaranteed by structural concurrency.
 */
export type AfterFn = (
  vu: VuContext,
  signal: AbortSignal,
  ctx: unknown,
) => Promise<void> | void

/** Phase label for samples emitted by each runtime context. */
export type SamplePhase =
  | "prologue"
  | "iteration"
  | "epilogue"
  | "before"
  | "after"

export interface SampleSuccess {
  ok: true
  t: number
  vu: number
  iteration: number
  /** Optional phase tag. Omitted on samples from the default workflow body
   *  (treated as `"iteration"`). Present on samples from prologue/epilogue.
   *  Old NDJSON consumers ignore unknown fields — additive, backward-compat. */
  phase?: SamplePhase
  method: string
  url: string
  status: number
  duration_ms: number
  size: number
  ts: string
}

export interface SampleError {
  ok: false
  t: number
  vu: number
  iteration: number
  phase?: SamplePhase
  method: string
  url: string
  duration_ms: number
  error: string
  message: string
  ts: string
}

/**
 * Workflow-emitted event (v0.5+) via `log.event(name, data?)`. Lives in the
 * same NDJSON stream as request samples so downstream tooling (jq, dashboards)
 * doesn't need to merge two streams. Discriminator: `"event" in sample`.
 *
 * `ok: true` so success-shape consumers don't trip when destructuring; the
 * `event` field's presence is the actual discriminator. Fields method/url/
 * status/size are absent.
 */
export interface SampleEvent {
  ok: true
  t: number
  vu: number
  iteration: number
  phase?: SamplePhase
  event: string
  data?: unknown
  ts: string
}

export type Sample = SampleSuccess | SampleError | SampleEvent

export interface SampleSink {
  write(s: Sample): void
  close(): Promise<void>
}

export interface RunOptions {
  workflowPath: string
  env?: Record<string, string>
  outPath?: string
  perRequestTimeoutMs?: number
  userAgent?: string
  insecure?: boolean
  quiet?: boolean
  signal?: AbortSignal
  /**
   * `--cookies <dir>`. Save the cookie jar to `<dir>/vu-N.json` on exit.
   * Each run STARTS WITH AN EMPTY JAR — fresh-each-run. v0.4 default.
   */
  cookiesDir?: string
  /**
   * `--cookies-resume <dir>`. Same as cookiesDir plus load any prior-session jar
   * from disk on startup (cross-run session continuity, httpie --session=name).
   * Mutually exclusive with cookiesDir at the CLI layer.
   */
  cookiesResumeDir?: string
  harDir?: string
  harReplayPath?: string
  /** Explicit --env-file paths, processed in order (later overrides earlier). */
  envFiles?: string[]
  /** Skip auto-loading ./.env (when no envFiles are given). */
  noEnvFile?: boolean
  /** Path to a .env.example-shaped file; every key in it must be set in the merged env. */
  requireEnvPath?: string
}

export interface LoadOptions extends RunOptions {
  concurrency: number
  durationMs: number
  rps?: number
  warmupMs?: number
}

export interface RunResult {
  ok: boolean
  value?: unknown
  error?: unknown
  samples: number
}

export interface AdhocOptions {
  method: string
  url: string
  shorthand: string[]
  headers?: Record<string, string>
  jsonBody?: string
  formMode?: boolean
  perRequestTimeoutMs?: number
  userAgent?: string
  insecure?: boolean
  quiet?: boolean
  outPath?: string
  signal?: AbortSignal
  cookiesDir?: string
  cookiesResumeDir?: string
  harDir?: string
  harReplayPath?: string
  envFiles?: string[]
  noEnvFile?: boolean
  requireEnvPath?: string
}

export interface RequestInit {
  headers?: Record<string, string>
  json?: unknown
  form?: Record<string, string>
  body?: string | Uint8Array
  query?: Record<string, string | number | boolean>
  timeout?: string | number
  signal?: AbortSignal
  redirect?: "follow" | "manual" | "error"
  /** Set to false to opt this request out of the per-VU cookie jar. Default: true. */
  cookies?: boolean
}
