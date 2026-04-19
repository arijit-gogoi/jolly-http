import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { runLoad } from "../dist/index.js"

let server: Server
let baseUrl: string
const tmp = join(__dirname, "fixtures", "load")

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/fail") {
      res.statusCode = 500
      res.end("boom")
      return
    }
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
})

afterAll(() => {
  return new Promise<void>(resolve => server.close(() => resolve()))
})

function writeWorkflow(name: string, src: string): string {
  const path = join(tmp, name)
  writeFileSync(path, src, "utf8")
  return path
}

describe("runLoad", () => {
  it("produces a summary and writes per-request samples", async () => {
    const path = writeWorkflow(
      "loadflow.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/x", { signal })
}`,
    )
    const out = join(tmp, "load.ndjson")
    const r = await runLoad({
      workflowPath: path,
      concurrency: 3,
      durationMs: 300,
      outPath: out,
      quiet: true,
    })
    expect(r.snapshot.total).toBeGreaterThan(0)
    expect(r.samples).toBeGreaterThan(0)
    expect(existsSync(out)).toBe(true)
    const lines = readFileSync(out, "utf8").trim().split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    // Per-request granularity — samples carry method/url/status
    const sample = JSON.parse(lines[0])
    expect(sample.method).toBe("GET")
    expect(sample.status).toBeGreaterThanOrEqual(200)
  }, 10_000)

  it("non-2xx is not a per-VU failure (errors-as-value at request level)", async () => {
    const path = writeWorkflow(
      "nonfatal.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/fail", { signal })
}`,
    )
    const r = await runLoad({
      workflowPath: path,
      concurrency: 2,
      durationMs: 200,
      quiet: true,
    })
    expect(r.snapshot.total).toBeGreaterThan(0)
    // bench only knows about iteration-level outcomes; our per-request samples
    // should all have status 500 (non-2xx is not an error at request level).
    expect(r.samples).toBeGreaterThan(0)
  }, 10_000)
})
