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
  cookiesDir?: string
  harDir?: string
  harReplayPath?: string
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
  harDir?: string
  harReplayPath?: string
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
