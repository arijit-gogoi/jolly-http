import type { RequestInit } from "./types.js"
import { parseDuration } from "jolly-coop"
import { currentContext, type RuntimeContext } from "./runtime.js"
import { HarReplayMissError } from "./har.js"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
type MethodName = (typeof METHODS)[number]

/**
 * Per-method redirect default. v0.5+ tradeoff: server-rendered apps (htmx,
 * Rails, Phoenix, Django, Axum) almost universally want POST/PUT/PATCH/DELETE
 * to STOP at a 303/302 so workflow code can assert on the redirect status.
 * Following them silently swallows the framework's actual response.
 *
 * GET/HEAD/OPTIONS continue to follow redirects (matches browsers, httpie, xh).
 *
 * Per-call `redirect: "follow"` overrides the default, restoring pre-v0.5
 * behavior on a per-request basis. v0.4 workflows that rely on POST→follow
 * must add `redirect: "follow"` to those calls.
 */
const REDIRECT_DEFAULT_BY_METHOD: Record<string, "follow" | "manual"> = Object.freeze({
  GET: "follow",
  HEAD: "follow",
  OPTIONS: "follow",
  POST: "manual",
  PUT: "manual",
  PATCH: "manual",
  DELETE: "manual",
})

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
        ...(ctx.phase ? { phase: ctx.phase } : {}),
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
      redirect: init.redirect ?? REDIRECT_DEFAULT_BY_METHOD[method] ?? "follow",
    })
  } catch (err) {
    cleanup()
    const duration_ms = performance.now() - started
    if (harId !== undefined && ctx.harRecorder) {
      ctx.harRecorder.recordError(harId, err as Error, duration_ms)
    }
    const { name, message } = classifyFetchError(err)
    ctx.sink.write({
      ok: false,
      t,
      vu: ctx.vu.id,
      iteration: ctx.vu.iteration,
      ...(ctx.phase ? { phase: ctx.phase } : {}),
      method,
      url: finalUrl,
      duration_ms,
      error: name,
      message,
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
 * recording, snapshot the response into runtime context for AssertionError
 * diagnostics. Used by both the live-fetch and HAR-replay branches.
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
  // Snapshot for AssertionError diagnostics. Stored on the context object
  // (mutable) so subsequent requests in the same VU overwrite it. Body is
  // decoded with utf-8; binary responses still produce something readable
  // enough for terminal output. No truncation — see runtime.ts comment.
  ctx.lastResponse = {
    method,
    url: finalUrl,
    status: res.status,
    headers: headersToRecord(res.headers),
    bodyText: bufToText(buf),
  }
  ctx.sink.write({
    ok: true,
    t,
    vu: ctx.vu.id,
    iteration: ctx.vu.iteration,
    ...(ctx.phase ? { phase: ctx.phase } : {}),
    method,
    url: finalUrl,
    status: res.status,
    duration_ms,
    size: buf.byteLength,
    ts,
  })
  return res
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

function bufToText(buf: ArrayBuffer): string {
  if (buf.byteLength === 0) return ""
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf)
  } catch {
    return `(${buf.byteLength} bytes, undecodable)`
  }
}

/**
 * Walk `err.cause` to classify a thrown fetch error into a structured
 * (name, message) pair surfaced in NDJSON Sample.error/Sample.message.
 *
 * undici throws bare `TypeError: fetch failed` for everything (DNS failure,
 * connection refused, abort, downstream timeout). The actionable diagnostic
 * is one or two .cause hops down. Common system errors expose a `code`
 * (ECONNREFUSED, ENOTFOUND, ECONNRESET, ETIMEDOUT, EHOSTUNREACH);
 * undici-internal errors keep their own UND_ERR_* names. AbortError is
 * preserved as-is at the top level.
 */
export function classifyFetchError(err: unknown): { name: string; message: string } {
  const top = err as { name?: string; message?: string; cause?: unknown }
  // AbortError comes through directly; never walk past it.
  if (top?.name === "AbortError" || top?.name === "TimeoutError") {
    return { name: top.name, message: top.message ?? String(err) }
  }
  // Find the deepest .cause that has a useful classifier.
  let cur: { name?: string; message?: string; code?: string; cause?: unknown } | undefined =
    top as typeof cur
  let hops = 0
  while (cur && hops < 5) {
    const code = typeof cur.code === "string" ? cur.code : undefined
    if (code) {
      // System errno (Node net layer): ECONNREFUSED, ENOTFOUND, etc.
      // Use the code as the structured name; preserve the message for
      // human context.
      return {
        name: code,
        message: cur.message ? `${code}: ${cur.message}` : code,
      }
    }
    if (cur.name && cur.name.startsWith("UND_ERR_")) {
      return { name: cur.name, message: cur.message ?? cur.name }
    }
    cur = cur.cause as typeof cur
    hops++
  }
  // Fall back to the top-level name and a chained message.
  const chain: string[] = []
  let walk: { message?: string; cause?: unknown } | undefined = top
  let h = 0
  while (walk && h < 5) {
    if (walk.message) chain.push(walk.message)
    walk = walk.cause as typeof walk
    h++
  }
  return {
    name: top?.name ?? "Error",
    message: chain.length > 0 ? chain.join(" -> ") : String(err),
  }
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
