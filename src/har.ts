import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Minimal HAR 1.2 emitter — just enough fields to be loadable in browser
 * DevTools and standard HAR viewers (Chrome's network panel, Firefox's
 * Network monitor, https://toolbox.googleapps.com/apps/har_analyzer/).
 *
 * One recorder per VU; entries are appended on each request and finalized to
 * disk on scope exit (success, failure, or abort — registered as a scope
 * resource in run.ts/load.ts).
 *
 * Body content is truncated to 64 KB to keep file sizes manageable in long
 * load runs. The truncation is recorded in `content.text` with a comment.
 */

const BODY_LIMIT_BYTES = 64 * 1024

export interface HarEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    cookies: never[]
    headers: { name: string; value: string }[]
    queryString: { name: string; value: string }[]
    postData?: { mimeType: string; text: string }
    headersSize: number
    bodySize: number
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    cookies: never[]
    headers: { name: string; value: string }[]
    content: { size: number; mimeType: string; text?: string; comment?: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
  _jolly?: { vu: number; iteration: number; t: number }
  _jollyError?: { name: string; message: string }
}

export interface Har12Document {
  log: {
    version: "1.2"
    creator: { name: string; version: string }
    pages: never[]
    entries: HarEntry[]
  }
}

export type RequestId = number

export interface HarRecorder {
  recordRequest(opts: {
    method: string
    url: string
    headers: Headers
    body: BodyInit | undefined
    vu: number
    iteration: number
    t: number
  }): RequestId
  recordResponse(id: RequestId, res: Response, body: ArrayBuffer, durationMs: number): void
  recordError(id: RequestId, error: Error, durationMs: number): void
  finalize(): Har12Document
  size(): number
}

class InMemoryRecorder implements HarRecorder {
  private entries: Partial<HarEntry>[] = []
  private starts: number[] = []

  constructor(private creatorVersion: string) {}

  size(): number {
    return this.entries.length
  }

  recordRequest(opts: {
    method: string
    url: string
    headers: Headers
    body: BodyInit | undefined
    vu: number
    iteration: number
    t: number
  }): RequestId {
    const u = new URL(opts.url)
    const queryString = Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }))
    const headersArr: { name: string; value: string }[] = []
    opts.headers.forEach((value, name) => headersArr.push({ name, value }))
    const id = this.entries.length
    const partial: Partial<HarEntry> = {
      startedDateTime: new Date().toISOString(),
      request: {
        method: opts.method,
        url: opts.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: headersArr,
        queryString,
        postData: opts.body !== undefined ? buildPostData(opts.headers, opts.body) : undefined,
        headersSize: -1,
        bodySize: bodySize(opts.body),
      },
      cache: {},
      _jolly: { vu: opts.vu, iteration: opts.iteration, t: opts.t },
    }
    this.entries.push(partial)
    this.starts.push(performance.now())
    return id
  }

  recordResponse(id: RequestId, res: Response, body: ArrayBuffer, durationMs: number): void {
    const entry = this.entries[id]
    if (!entry) return
    const headersArr: { name: string; value: string }[] = []
    res.headers.forEach((value, name) => headersArr.push({ name, value }))
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream"
    const text = bufferToText(body, mimeType)
    entry.time = durationMs
    entry.response = {
      status: res.status,
      statusText: res.statusText ?? "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: headersArr,
      content: text,
      redirectURL: res.headers.get("location") ?? "",
      headersSize: -1,
      bodySize: body.byteLength,
    }
    entry.timings = { send: 0, wait: durationMs, receive: 0 }
  }

  recordError(id: RequestId, error: Error, durationMs: number): void {
    const entry = this.entries[id]
    if (!entry) return
    entry.time = durationMs
    entry.response = {
      status: 0,
      statusText: error.message,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    }
    entry.timings = { send: 0, wait: durationMs, receive: 0 }
    entry._jollyError = { name: error.name, message: error.message }
  }

  finalize(): Har12Document {
    return {
      log: {
        version: "1.2",
        creator: { name: "jolly-http", version: this.creatorVersion },
        pages: [],
        entries: this.entries.filter(e => e.response !== undefined) as HarEntry[],
      },
    }
  }
}

export function createHarRecorder(version: string): HarRecorder {
  return new InMemoryRecorder(version)
}

export function harPath(dir: string, vuId: number): string {
  return join(dir, `vu-${vuId}.har`)
}

export function saveHar(recorder: HarRecorder, path: string): void {
  if (recorder.size() === 0) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(recorder.finalize(), null, 2), "utf8")
}

function buildPostData(headers: Headers, body: BodyInit): { mimeType: string; text: string } {
  const mimeType = headers.get("content-type") ?? "application/octet-stream"
  const text = typeof body === "string"
    ? body
    : body instanceof Uint8Array
      ? bufferToString(body)
      : "[non-text body]"
  return { mimeType, text: truncate(text) }
}

function bodySize(body: BodyInit | undefined): number {
  if (body === undefined) return 0
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  if (body instanceof Uint8Array) return body.byteLength
  return -1
}

function bufferToText(
  buf: ArrayBuffer,
  mimeType: string,
): { size: number; mimeType: string; text?: string; comment?: string } {
  const size = buf.byteLength
  if (size === 0) return { size, mimeType }
  if (size > BODY_LIMIT_BYTES) {
    const head = Buffer.from(buf, 0, BODY_LIMIT_BYTES).toString("utf8")
    return { size, mimeType, text: head, comment: `truncated to ${BODY_LIMIT_BYTES} of ${size} bytes` }
  }
  if (looksTextual(mimeType)) {
    return { size, mimeType, text: Buffer.from(buf).toString("utf8") }
  }
  return { size, mimeType, comment: "binary body omitted" }
}

function bufferToString(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8")
}

function looksTextual(mimeType: string): boolean {
  const lower = mimeType.toLowerCase()
  return (
    lower.startsWith("text/") ||
    lower.includes("json") ||
    lower.includes("xml") ||
    lower.includes("javascript") ||
    lower.includes("html") ||
    lower.includes("urlencoded")
  )
}

function truncate(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= BODY_LIMIT_BYTES) return s
  return Buffer.from(s, "utf8").subarray(0, BODY_LIMIT_BYTES).toString("utf8")
}

// ---------------- HAR replay ----------------

/**
 * Thrown when --har-replay is active and an outgoing request has no matching
 * entry in the HAR. The workflow's existing assert/error path catches this;
 * the CLI surfaces it and exits 1.
 */
export class HarReplayMissError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly url: string,
  ) {
    super(message)
    this.name = "HarReplayMissError"
  }
}

export interface MatchedEntry {
  status: number
  statusText: string
  headers: { name: string; value: string }[]
  body: ArrayBuffer
  mimeType: string
}

export interface HarReplayer {
  /** Returns a matching entry, or null if no match. First-match-wins. */
  match(method: string, url: string, body: BodyInit | undefined): MatchedEntry | null
  /** Number of entries available for matching. */
  size(): number
}

class InMemoryReplayer implements HarReplayer {
  constructor(private readonly entries: HarEntry[]) {}

  size(): number {
    return this.entries.length
  }

  match(method: string, url: string, body: BodyInit | undefined): MatchedEntry | null {
    const m = method.toUpperCase()
    const liveBody = normalizeBody(body)
    for (const e of this.entries) {
      if (e.request.method.toUpperCase() !== m) continue
      if (e.request.url !== url) continue
      const recordedBody = e.request.postData?.text ?? ""
      if (!bodiesMatch(liveBody, recordedBody, e.request.bodySize)) continue
      return {
        status: e.response.status,
        statusText: e.response.statusText,
        headers: e.response.headers,
        body: contentToBuffer(e.response.content),
        mimeType: e.response.content.mimeType,
      }
    }
    return null
  }
}

const EMPTY_REPLAYER: HarReplayer = new InMemoryReplayer([])

const fileCache = new Map<string, HarReplayer>()

/**
 * Load a replayer for the given path:
 * - Path ending in `.har` → single shared file (cached so multiple VUs share it).
 * - Otherwise (directory) → per-VU file at `<path>/vu-<vuId>.har`.
 *
 * Missing file → empty replayer (every request misses → throws).
 */
export function loadHarReplay(path: string, vuId: number): HarReplayer {
  const isFile = path.endsWith(".har")
  const filePath = isFile ? path : join(path, `vu-${vuId}.har`)

  if (isFile) {
    const cached = fileCache.get(filePath)
    if (cached) return cached
  }

  if (!existsSync(filePath)) {
    if (isFile) fileCache.set(filePath, EMPTY_REPLAYER)
    return EMPTY_REPLAYER
  }

  let doc: Har12Document
  try {
    doc = JSON.parse(readFileSync(filePath, "utf8")) as Har12Document
  } catch {
    if (isFile) fileCache.set(filePath, EMPTY_REPLAYER)
    return EMPTY_REPLAYER
  }
  const entries = doc?.log?.entries ?? []
  const replayer = new InMemoryReplayer(entries)
  if (isFile) fileCache.set(filePath, replayer)
  return replayer
}

function normalizeBody(body: BodyInit | undefined): string {
  if (body === undefined) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
  }
  if (body instanceof URLSearchParams) return body.toString()
  return ""
}

function bodiesMatch(live: string, recorded: string, recordedSize: number): boolean {
  if (live === recorded) return true
  // Recorded body was truncated (HAR keeps content.text up to 64KB) — match
  // by prefix if live's first 64KB equals the recorded.
  const liveBytes = Buffer.byteLength(live, "utf8")
  if (recorded.length === BODY_LIMIT_BYTES && liveBytes > BODY_LIMIT_BYTES) {
    const livePrefix = Buffer.from(live, "utf8").subarray(0, BODY_LIMIT_BYTES).toString("utf8")
    return livePrefix === recorded
  }
  // Binary body recorded as length only (no text) — compare sizes.
  if (recorded === "" && recordedSize > 0 && liveBytes === recordedSize) return true
  return false
}

function contentToBuffer(content: HarEntry["response"]["content"]): ArrayBuffer {
  if (content.text === undefined || content.text === "") return new ArrayBuffer(0)
  const buf = Buffer.from(content.text, "utf8")
  // Slice into a fresh ArrayBuffer so the consumer owns it.
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}
