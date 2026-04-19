import { describe, it, expect } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSampleSink, nullSink, formatResponse } from "../src/output.js"
import type { Sample } from "../src/types.js"

const sampleOk: Sample = {
  ok: true,
  t: 0.1,
  vu: 0,
  iteration: 0,
  method: "GET",
  url: "http://x/",
  status: 200,
  duration_ms: 10,
  size: 5,
  ts: "2026-04-18T00:00:00Z",
}

describe("createSampleSink", () => {
  it("with no path returns the null sink", async () => {
    const sink = createSampleSink()
    expect(sink).toBe(nullSink)
    sink.write(sampleOk)
    await sink.close()
  })

  it("with a path writes NDJSON lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-http-out-"))
    const file = join(dir, "out.ndjson")
    const sink = createSampleSink(file)
    sink.write(sampleOk)
    sink.write({ ...sampleOk, status: 500 })
    await sink.close()
    const content = readFileSync(file, "utf8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, status: 200 })
    expect(JSON.parse(lines[1])).toMatchObject({ ok: true, status: 500 })
  })
})

describe("formatResponse", () => {
  it("renders status line + headers + JSON body", async () => {
    const res = new Response(JSON.stringify({ x: 1 }), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    })
    const out = await formatResponse(res, false)
    expect(out).toContain("HTTP/1.1 200")
    expect(out).toContain("content-type: application/json")
    expect(out).toContain('"x": 1')
  })

  it("renders plain text body as-is", async () => {
    const res = new Response("hello", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/plain" },
    })
    const out = await formatResponse(res, false)
    expect(out).toContain("404")
    expect(out).toContain("hello")
  })

  it("omits body section when empty", async () => {
    const res = new Response(null, { status: 204 })
    const out = await formatResponse(res, false)
    expect(out).toContain("204")
    expect(out.trim().endsWith("204") || out.includes(":")).toBe(true)
  })
})
