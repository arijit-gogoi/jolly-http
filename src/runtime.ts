import { AsyncLocalStorage } from "node:async_hooks"
import { sleep as coopSleep } from "jolly-coop"
import { parseDuration } from "jolly-coop"
import type { Sample, SampleSink, VuContext } from "./types.js"
import type { CookieJar } from "./cookies.js"
import type { HarRecorder, HarReplayer } from "./har.js"

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssertionError"
  }
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
}

const STORE = new AsyncLocalStorage<RuntimeContext>()

export function withRuntime<T>(ctx: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  return STORE.run(ctx, fn)
}

export function currentContext(): RuntimeContext {
  const ctx = STORE.getStore()
  if (!ctx) {
    throw new Error(
      "jolly-http runtime used outside a workflow. Call request/assert/sleep " +
        "from inside the default-exported workflow function.",
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
  if (!cond) throw new AssertionError(message ?? "assertion failed")
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

export function buildEnv(overrides: Record<string, string> = {}): Readonly<Record<string, string>> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v
  }
  Object.assign(base, overrides)
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
