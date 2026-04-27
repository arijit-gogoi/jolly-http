import type { RequestInit } from "./types.js"
import { parseDuration } from "jolly-coop"
import { currentContext, type RuntimeContext } from "./runtime.js"
import { HarReplayMissError } from "./har.js"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
type MethodName = (typeof METHODS)[number]

type MethodFn = (url: string, init?: RequestInit) => Promise<Response>

export const request: Record<MethodName, MethodFn> = {
  GET: (url, init) => performRequest("GET", url, init),
  POST: (url, init) => performRequest("POST", url, init),
  PUT: (url, init) => performRequest("PUT", url, init),
  PATCH: (url, init) => performRequest("PATCH", url, init),
  DELETE: (url, init) => performRequest("DELETE", url, init),
  HEAD: (url, init) => performRequest("HEAD", url, init),
  OPTIONS: (url, init) => performRequest("OPTIONS", url, init),
}

export async function performRequest(
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const ctx = currentContext()
  const finalUrl = appendQuery(url, init.query)
  const useCookies = init.cookies !== false && ctx.cookieJar !== undefined
  const headers = buildHeaders(
    ctx.defaults.userAgent,
    init.headers,
    init.json,
    init.form,
    useCookies ? ctx.cookieJar!.getHeaderFor(new URL(finalUrl)) : undefined,
  )
  const body = buildBody(init)

  const perReqTimeoutMs =
    init.timeout !== undefined ? parseDuration(init.timeout) : ctx.defaults.perRequestTimeoutMs
  const { signal, cleanup } = composeSignal(ctx.signal, init.signal, perReqTimeoutMs)

  const t = (performance.now() - ctx.tZero) / 1_000
  const started = performance.now()
  const ts = new Date().toISOString()

  const harId = ctx.harRecorder?.recordRequest({
    method,
    url: finalUrl,
    headers,
    body,
    vu: ctx.vu.id,
    iteration: ctx.vu.iteration,
    t,
  })

  // Replay short-circuit. Hits skip fetch entirely; misses emit a failure
  // sample (so byError stats see them in load mode) and throw — workflow
  // assert/error path handles the rest.
  if (ctx.harReplay) {
    const matched = ctx.harReplay.match(method, finalUrl, body)
    if (!matched) {
      cleanup()
      const duration_ms = performance.now() - started
      const err = new HarReplayMissError(
        `no HAR entry for ${method} ${finalUrl}`,
        method,
        finalUrl,
      )
      if (harId !== undefined && ctx.harRecorder) {
        ctx.harRecorder.recordError(harId, err, duration_ms)
      }
      ctx.sink.write({
        ok: false,
        t,
        vu: ctx.vu.id,
        iteration: ctx.vu.iteration,
        method,
        url: finalUrl,
        duration_ms,
        error: err.name,
        message: err.message,
        ts,
      })
      throw err
    }
    const synthetic = new Response(matched.body, {
      status: matched.status,
      statusText: matched.statusText,
      headers: matched.headers.reduce<Record<string, string>>((o, h) => ((o[h.name] = h.value), o), {}),
    })
    cleanup()
    return finalizeSuccess(ctx, synthetic, matched.body, started, t, ts, method, finalUrl, useCookies, harId)
  }

  let res: Response
  try {
    res = await fetch(finalUrl, {
      method,
      headers,
      body,
      signal,
      redirect: init.redirect ?? "follow",
    })
  } catch (err) {
    cleanup()
    const duration_ms = performance.now() - started
    const e = err as { name?: string; message?: string }
    if (harId !== undefined && ctx.harRecorder) {
      ctx.harRecorder.recordError(harId, err as Error, duration_ms)
    }
    ctx.sink.write({
      ok: false,
      t,
      vu: ctx.vu.id,
      iteration: ctx.vu.iteration,
      method,
      url: finalUrl,
      duration_ms,
      error: e?.name ?? "Error",
      message: e?.message ?? String(err),
      ts,
    })
    throw err
  }

  const clone = res.clone()
  const buf = await clone.arrayBuffer().catch(() => new ArrayBuffer(0))
  cleanup()
  return finalizeSuccess(ctx, res, buf, started, t, ts, method, finalUrl, useCookies, harId)
}

/**
 * Common success-path: emit per-request sample, store cookies, finish HAR
 * recording. Used by both the live-fetch and HAR-replay branches.
 */
function finalizeSuccess(
  ctx: RuntimeContext,
  res: Response,
  buf: ArrayBuffer,
  started: number,
  t: number,
  ts: string,
  method: string,
  finalUrl: string,
  useCookies: boolean,
  harId: number | undefined,
): Response {
  const duration_ms = performance.now() - started
  if (useCookies) {
    ctx.cookieJar!.setFromResponse(new URL(finalUrl), res.headers)
  }
  if (harId !== undefined && ctx.harRecorder) {
    ctx.harRecorder.recordResponse(harId, res, buf, duration_ms)
  }
  ctx.sink.write({
    ok: true,
    t,
    vu: ctx.vu.id,
    iteration: ctx.vu.iteration,
    method,
    url: finalUrl,
    status: res.status,
    duration_ms,
    size: buf.byteLength,
    ts,
  })
  return res
}

function appendQuery(url: string, query?: Record<string, string | number | boolean>): string {
  if (!query) return url
  const entries = Object.entries(query)
  if (entries.length === 0) return url
  const sep = url.includes("?") ? "&" : "?"
  const encoded = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&")
  return url + sep + encoded
}

function buildHeaders(
  userAgent: string,
  h: Record<string, string> | undefined,
  json: unknown,
  form: Record<string, string> | undefined,
  cookieHeader: string | undefined,
): Headers {
  const headers = new Headers()
  if (!hasHeader(h, "user-agent")) headers.set("user-agent", userAgent)
  if (json !== undefined && !hasHeader(h, "content-type")) headers.set("content-type", "application/json")
  if (form !== undefined && !hasHeader(h, "content-type"))
    headers.set("content-type", "application/x-www-form-urlencoded")
  if (json !== undefined && !hasHeader(h, "accept")) headers.set("accept", "application/json")
  // Cookie header from jar, applied before user headers so user can override.
  if (cookieHeader && !hasHeader(h, "cookie")) headers.set("cookie", cookieHeader)
  if (h) for (const [k, v] of Object.entries(h)) headers.set(k, v)
  return headers
}

function hasHeader(h: Record<string, string> | undefined, name: string): boolean {
  if (!h) return false
  const n = name.toLowerCase()
  return Object.keys(h).some(k => k.toLowerCase() === n)
}

function buildBody(init: RequestInit): BodyInit | undefined {
  if (init.body !== undefined) return init.body as BodyInit
  if (init.json !== undefined) return JSON.stringify(init.json)
  if (init.form !== undefined) {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(init.form)) usp.append(k, v)
    return usp.toString()
  }
  return undefined
}

function composeSignal(
  scopeSig: AbortSignal,
  userSig: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const parts: AbortSignal[] = [scopeSig]
  if (userSig) parts.push(userSig)
  let timer: NodeJS.Timeout | undefined
  let timeoutCtl: AbortController | undefined
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutCtl = new AbortController()
    timer = setTimeout(() => {
      timeoutCtl!.abort(new DOMException(`request timed out after ${timeoutMs}ms`, "TimeoutError"))
    }, timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    parts.push(timeoutCtl.signal)
  }
  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  if (parts.length === 1) return { signal: parts[0], cleanup }
  return { signal: AbortSignal.any(parts), cleanup }
}
