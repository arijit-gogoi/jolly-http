import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createHarRecorder,
  saveHar,
  harPath,
  loadHarReplay,
  HarReplayMissError,
} from "../src/har.js"

function mkRecorder() {
  return createHarRecorder("0.2.0")
}

describe("HAR recorder — basics", () => {
  it("empty recorder has no entries", () => {
    const r = mkRecorder()
    const doc = r.finalize()
    expect(doc.log.version).toBe("1.2")
    expect(doc.log.creator.name).toBe("jolly-http")
    expect(doc.log.creator.version).toBe("0.2.0")
    expect(doc.log.entries).toEqual([])
  })

  it("records request → response pair", async () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "GET",
      url: "https://x.test/users?page=2",
      headers: new Headers({ "user-agent": "test/1" }),
      body: undefined,
      vu: 0,
      iteration: 0,
      t: 0.001,
    })
    const res = new Response('{"ok":true}', {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    })
    const buf = new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer
    r.recordResponse(id, res, buf, 12.5)
    const doc = r.finalize()
    expect(doc.log.entries).toHaveLength(1)
    const e = doc.log.entries[0]
    expect(e.request.method).toBe("GET")
    expect(e.request.url).toBe("https://x.test/users?page=2")
    expect(e.request.queryString).toEqual([{ name: "page", value: "2" }])
    expect(e.response.status).toBe(200)
    expect(e.response.statusText).toBe("OK")
    expect(e.response.content.text).toBe('{"ok":true}')
    expect(e.response.content.mimeType).toContain("application/json")
    expect(e.time).toBe(12.5)
    expect(e.timings.wait).toBe(12.5)
    expect(e._jolly).toEqual({ vu: 0, iteration: 0, t: 0.001 })
  })

  it("records request → error", () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
      body: undefined,
      vu: 1,
      iteration: 5,
      t: 0,
    })
    r.recordError(id, Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }), 30)
    const doc = r.finalize()
    expect(doc.log.entries).toHaveLength(1)
    expect(doc.log.entries[0]._jollyError).toEqual({
      name: "TypeError",
      message: "connect ECONNREFUSED",
    })
    expect(doc.log.entries[0].response.status).toBe(0)
  })

  it("orphan request (no response/error) is dropped from finalize()", () => {
    const r = mkRecorder()
    r.recordRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
      body: undefined,
      vu: 0,
      iteration: 0,
      t: 0,
    })
    const doc = r.finalize()
    expect(doc.log.entries).toHaveLength(0)
  })

  it("body capture for textual content", () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "POST",
      url: "https://x.test/",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ a: 1 }),
      vu: 0,
      iteration: 0,
      t: 0,
    })
    const res = new Response("hi", { status: 200, headers: { "content-type": "text/plain" } })
    r.recordResponse(id, res, new TextEncoder().encode("hi").buffer as ArrayBuffer, 5)
    const e = r.finalize().log.entries[0]
    expect(e.request.postData?.text).toBe('{"a":1}')
    expect(e.response.content.text).toBe("hi")
  })

  it("body truncated past 64 KB", () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
      body: undefined,
      vu: 0,
      iteration: 0,
      t: 0,
    })
    const huge = "x".repeat(100_000)
    const res = new Response(huge, { status: 200, headers: { "content-type": "text/plain" } })
    const buf = new TextEncoder().encode(huge).buffer as ArrayBuffer
    r.recordResponse(id, res, buf, 5)
    const e = r.finalize().log.entries[0]
    expect(e.response.content.size).toBe(100_000)
    expect(e.response.content.text!.length).toBe(64 * 1024)
    expect(e.response.content.comment).toMatch(/truncated/)
  })

  it("binary content is not captured as text", () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
      body: undefined,
      vu: 0,
      iteration: 0,
      t: 0,
    })
    const res = new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })
    const buf = new Uint8Array([0xff, 0xd8, 0xff]).buffer as ArrayBuffer
    r.recordResponse(id, res, buf, 5)
    const e = r.finalize().log.entries[0]
    expect(e.response.content.text).toBeUndefined()
    expect(e.response.content.comment).toMatch(/binary/)
  })
})

describe("HAR recorder — persistence", () => {
  it("saves to disk, valid JSON, loadable", () => {
    const r = mkRecorder()
    const id = r.recordRequest({
      method: "GET",
      url: "https://x.test/",
      headers: new Headers(),
      body: undefined,
      vu: 0,
      iteration: 0,
      t: 0,
    })
    r.recordResponse(id, new Response("ok", { status: 200 }), new TextEncoder().encode("ok").buffer as ArrayBuffer, 1)
    const dir = mkdtempSync(join(tmpdir(), "jolly-har-"))
    const path = harPath(dir, 0)
    saveHar(r, path)
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.log.version).toBe("1.2")
    expect(parsed.log.entries).toHaveLength(1)
  })

  it("empty recorder does not write a file", () => {
    const r = mkRecorder()
    const dir = mkdtempSync(join(tmpdir(), "jolly-har-empty-"))
    const path = harPath(dir, 0)
    saveHar(r, path)
    // No exception, no file. Test by reading and expecting throw.
    expect(() => readFileSync(path, "utf8")).toThrow()
  })
})

// ---------------- HAR replay ----------------

function recordOne(
  dir: string,
  vuId: number,
  opts: {
    method: string
    url: string
    body?: string
    status?: number
    statusText?: string
    responseBody?: string
    responseMime?: string
  },
): string {
  const r = createHarRecorder("0.2.0")
  const headers = new Headers()
  if (opts.body !== undefined) headers.set("content-type", "application/json")
  const id = r.recordRequest({
    method: opts.method,
    url: opts.url,
    headers,
    body: opts.body,
    vu: vuId,
    iteration: 0,
    t: 0,
  })
  const respBody = opts.responseBody ?? '{"ok":true}'
  const res = new Response(respBody, {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: { "content-type": opts.responseMime ?? "application/json" },
  })
  const buf = new TextEncoder().encode(respBody).buffer as ArrayBuffer
  r.recordResponse(id, res, buf, 5)
  const path = harPath(dir, vuId)
  saveHar(r, path)
  return path
}

describe("loadHarReplay — file vs directory autodetect", () => {
  it("path ending in .har → shared file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-file-"))
    const path = recordOne(dir, 0, { method: "GET", url: "https://x.test/users" })
    const r1 = loadHarReplay(path, 0)
    const r2 = loadHarReplay(path, 5)
    // Same URL recorded — both replayers find a match (cached/shared).
    expect(r1.match("GET", "https://x.test/users", undefined)).not.toBeNull()
    expect(r2.match("GET", "https://x.test/users", undefined)).not.toBeNull()
  })

  it("directory path → per-VU files", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-dir-"))
    recordOne(dir, 0, { method: "GET", url: "https://x.test/u0" })
    recordOne(dir, 1, { method: "GET", url: "https://x.test/u1" })
    const r0 = loadHarReplay(dir, 0)
    const r1 = loadHarReplay(dir, 1)
    expect(r0.match("GET", "https://x.test/u0", undefined)).not.toBeNull()
    expect(r0.match("GET", "https://x.test/u1", undefined)).toBeNull() // VU 0 doesn't see VU 1's data
    expect(r1.match("GET", "https://x.test/u1", undefined)).not.toBeNull()
  })

  it("missing file → empty replayer (every match misses)", () => {
    const r = loadHarReplay("/nonexistent/missing.har", 0)
    expect(r.size()).toBe(0)
    expect(r.match("GET", "https://x.test/", undefined)).toBeNull()
  })

  it("missing directory file → empty replayer", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-empty-"))
    const r = loadHarReplay(dir, 99) // vu-99.har doesn't exist
    expect(r.size()).toBe(0)
    expect(r.match("GET", "https://x.test/", undefined)).toBeNull()
  })

  it("corrupt file → empty replayer (graceful)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-corrupt-"))
    const path = harPath(dir, 0)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, "{not valid json", "utf8")
    const r = loadHarReplay(dir, 0)
    expect(r.size()).toBe(0)
  })
})

describe("HarReplayer — strict matching", () => {
  it("method case-insensitive, url-with-query strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-match-"))
    recordOne(dir, 0, { method: "GET", url: "https://x.test/users?page=2" })
    const r = loadHarReplay(dir, 0)
    expect(r.match("GET", "https://x.test/users?page=2", undefined)).not.toBeNull()
    expect(r.match("get", "https://x.test/users?page=2", undefined)).not.toBeNull()
    expect(r.match("POST", "https://x.test/users?page=2", undefined)).toBeNull()
    expect(r.match("GET", "https://x.test/users?page=3", undefined)).toBeNull() // strict
    expect(r.match("GET", "https://x.test/users", undefined)).toBeNull() // strict on query
  })

  it("body strict — different bodies do not match", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-body-"))
    recordOne(dir, 0, {
      method: "POST",
      url: "https://x.test/login",
      body: '{"u":"a"}',
    })
    const r = loadHarReplay(dir, 0)
    expect(r.match("POST", "https://x.test/login", '{"u":"a"}')).not.toBeNull()
    expect(r.match("POST", "https://x.test/login", '{"u":"b"}')).toBeNull()
    expect(r.match("POST", "https://x.test/login", undefined)).toBeNull()
  })

  it("first-match-wins — same entry replays for multiple iterations", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-loop-"))
    recordOne(dir, 0, { method: "GET", url: "https://x.test/loop" })
    const r = loadHarReplay(dir, 0)
    for (let i = 0; i < 3; i++) {
      const m = r.match("GET", "https://x.test/loop", undefined)
      expect(m).not.toBeNull()
      expect(m!.status).toBe(200)
    }
  })

  it("matched body is fresh — multiple matches return independent buffers", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-replay-buf-"))
    recordOne(dir, 0, {
      method: "GET",
      url: "https://x.test/data",
      responseBody: '{"x":1}',
    })
    const r = loadHarReplay(dir, 0)
    const a = r.match("GET", "https://x.test/data", undefined)!
    const b = r.match("GET", "https://x.test/data", undefined)!
    expect(a.body).not.toBe(b.body) // different ArrayBuffer instances
    expect(new TextDecoder().decode(a.body)).toBe('{"x":1}')
    expect(new TextDecoder().decode(b.body)).toBe('{"x":1}')
  })
})

describe("HarReplayMissError", () => {
  it("preserves method + url for catch-side inspection", () => {
    const err = new HarReplayMissError("missing", "POST", "https://x.test/foo")
    expect(err.name).toBe("HarReplayMissError")
    expect(err.method).toBe("POST")
    expect(err.url).toBe("https://x.test/foo")
    expect(err.message).toBe("missing")
    expect(err instanceof Error).toBe(true)
  })
})
