import { AsyncLocalStorage } from "node:async_hooks"
import { sleep as coopSleep } from "jolly-coop"
import { parseDuration } from "jolly-coop"
import type { Sample, SampleSink, VuContext } from "./types.js"
import type { CookieJar } from "./cookies.js"
import type { HarRecorder, HarReplayer } from "./har.js"

/**
 * Snapshot of the most recently seen response in the current runtime context.
 * Auto-appended to AssertionError messages so failures are debuggable without
 * scattering console.log() through workflows. Body is the FULL response — no
 * truncation. Debugging needs everything; the user is reading the error in a
 * terminal and can scroll.
 */
export interface LastResponseSnapshot {
  method: string
  url: string
  status: number
  headers: Record<string, string>
  bodyText: string
}

export class AssertionError extends Error {
  /** Set by the formatter when the runtime had a last-seen Response. */
  readonly lastResponse?: LastResponseSnapshot

  constructor(message: string, lastResponse?: LastResponseSnapshot) {
    super(formatAssertionMessage(message, lastResponse))
    this.name = "AssertionError"
    this.lastResponse = lastResponse
  }
}

function formatAssertionMessage(
  message: string,
  last: LastResponseSnapshot | undefined,
): string {
  if (!last) return message
  const headerLines = Object.entries(last.headers)
    .map(([k, v]) => `      ${k}: ${v}`)
    .join("\n")
  return [
    message,
    `  -> last request: ${last.method} ${last.url} ${last.status}`,
    headerLines ? `  -> response headers:\n${headerLines}` : `  -> response headers: (none)`,
    `  -> response body:`,
    last.bodyText,
  ].join("\n")
}

export interface RuntimeContext {
  vu: VuContext
  sink: SampleSink
  signal: AbortSignal
  tZero: number
  defaults: {
    userAgent: string
    perRequestTimeoutMs?: number
    insecure?: boolean
  }
  cookieJar?: CookieJar
  harRecorder?: HarRecorder
  harReplay?: HarReplayer
  /**
   * Most recent Response observed by performRequest in this VU's context.
   * Used by AssertionError to auto-append diagnostic context. Mutable on the
   * context object so each request overwrites the previous snapshot.
   */
  lastResponse?: LastResponseSnapshot
}

const STORE = new AsyncLocalStorage<RuntimeContext>()

export function withRuntime<T>(ctx: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  return STORE.run(ctx, fn)
}

export function currentContext(): RuntimeContext {
  const ctx = STORE.getStore()
  if (!ctx) {
    throw new Error(
      "jolly-http: request/assert/env/sleep can only be used from inside a workflow function.\n" +
        "Helper modules are fine, but the helper has to be CALLED from a workflow function,\n" +
        "not run at import time. Move the call inside your default export, prologue, or epilogue.",
    )
  }
  return ctx
}

export function tryCurrentContext(): RuntimeContext | undefined {
  return STORE.getStore()
}

export function emitSample(s: Sample): void {
  currentContext().sink.write(s)
}

export function assert(cond: unknown, message?: string): asserts cond {
  if (cond) return
  throw new AssertionError(message ?? "assertion failed", tryCurrentContext()?.lastResponse)
}

/**
 * Sleep helper, accepts ms number or duration string. Uses the current
 * runtime's signal so sleeps abort on scope cancel.
 */
export function sleep(duration: number | string): Promise<void> {
  const ms = typeof duration === "number" ? duration : parseDuration(duration)
  const ctx = tryCurrentContext()
  return coopSleep(ms, ctx?.signal)
}

let envCache: Readonly<Record<string, string>> | null = null

/**
 * Build the workflow's frozen env, layering sources by precedence (lowest → highest):
 *   1. dotenvLayers (in array order — first file is lowest, last is highest)
 *   2. process.env
 *   3. flagOverrides (--env KEY=VAL)
 *
 * Equivalent to dotenv/Next.js/Vite: file defaults lose to shell exports, which
 * lose to explicit per-run flags.
 */
export function buildEnv(
  dotenvLayers: Record<string, string>[] = [],
  flagOverrides: Record<string, string> = {},
): Readonly<Record<string, string>> {
  const base: Record<string, string> = {}
  for (const layer of dotenvLayers) Object.assign(base, layer)
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v
  }
  Object.assign(base, flagOverrides)
  return Object.freeze(base)
}

/**
 * Proxy that resolves env lookups against the current runtime's env.
 * Module-level `env` exports a value, so lookups must be late-bound.
 */
export const env: Readonly<Record<string, string>> = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined
      const ctx = tryCurrentContext()
      const src = ctx?.vu.env ?? (envCache ??= buildEnv())
      return src[prop]
    },
    has(_t, prop) {
      if (typeof prop !== "string") return false
      const ctx = tryCurrentContext()
      const src = ctx?.vu.env ?? (envCache ??= buildEnv())
      return prop in src
    },
    ownKeys() {
      const ctx = tryCurrentContext()
      const src = ctx?.vu.env ?? (envCache ??= buildEnv())
      return Object.keys(src)
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== "string") return undefined
      const ctx = tryCurrentContext()
      const src = ctx?.vu.env ?? (envCache ??= buildEnv())
      if (!(prop in src)) return undefined
      return { value: src[prop], enumerable: true, configurable: true, writable: false }
    },
    set() {
      throw new TypeError("env is read-only")
    },
    deleteProperty() {
      throw new TypeError("env is read-only")
    },
  },
) as Readonly<Record<string, string>>
