export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

export interface VuContext {
  id: number
  iteration: number
  env: Readonly<Record<string, string>>
}

export type WorkflowFn = (vu: VuContext, signal: AbortSignal) => Promise<unknown> | unknown

export interface SampleSuccess {
  ok: true
  t: number
  vu: number
  iteration: number
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
  method: string
  url: string
  duration_ms: number
  error: string
  message: string
  ts: string
}

export type Sample = SampleSuccess | SampleError

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
