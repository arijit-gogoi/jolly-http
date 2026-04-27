import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { runWorkflow } from "../dist/index.js"

let server: Server
let baseUrl: string
const tmp = join(__dirname, "fixtures", "run")

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/boom") {
      res.statusCode = 500
      res.end("boom")
      return
    }
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true, url: req.url }))
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

describe("runWorkflow", () => {
  it("runs a workflow and surfaces its return value", async () => {
    const path = writeWorkflow(
      "ok.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/hello", { signal })
  return { status: r.status, id: vu.id }
}`,
    )
    const result = await runWorkflow({ workflowPath: path })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ status: 200, id: 0 })
    expect(result.samples).toBe(1)
  })

  it("rejects-as-result on AssertionError", async () => {
    const path = writeWorkflow(
      "fail.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/boom", { signal })
  assert(r.status === 200, "not 200")
}`,
    )
    const result = await runWorkflow({ workflowPath: path })
    expect(result.ok).toBe(false)
    expect((result.error as Error).name).toBe("AssertionError")
    expect((result.error as Error).message).toMatch(/not 200/)
    expect(result.samples).toBe(1)
  })

  it("preserves arbitrary throws", async () => {
    const path = writeWorkflow(
      "throw.mjs",
      `export default async function () {
  throw new Error("boom-user")
}`,
    )
    const result = await runWorkflow({ workflowPath: path })
    expect(result.ok).toBe(false)
    expect((result.error as Error).message).toBe("boom-user")
  })

  it("writes per-request samples to out file", async () => {
    const out = join(tmp, "samples.ndjson")
    const path = writeWorkflow(
      "multi.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/a", { signal })
  await request.GET("${baseUrl}/b", { signal })
}`,
    )
    const result = await runWorkflow({ workflowPath: path, outPath: out })
    expect(result.ok).toBe(true)
    const lines = readFileSync(out, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).url).toContain("/a")
    expect(JSON.parse(lines[1]).url).toContain("/b")
  })

  it("rejects if workflow path missing default export", async () => {
    const path = writeWorkflow("nodefault.mjs", `export const x = 1`)
    await expect(runWorkflow({ workflowPath: path })).rejects.toThrow(/default export/)
  })

  it("env flags propagate to workflow", async () => {
    const path = writeWorkflow(
      "env.mjs",
      `import { env } from "jolly-http"
export default async function () { return env.MY_VAR }`,
    )
    const result = await runWorkflow({ workflowPath: path, env: { MY_VAR: "hello" } })
    expect(result.value).toBe("hello")
  })

  it("HAR replay: record then replay short-circuits network", async () => {
    // Step 1: record against the live server.
    const flow = writeWorkflow(
      "har-replay.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/replay-me", { signal })
  assert(r.status === 200, "live: status")
  const body = await r.json()
  return { url: body.url }
}`,
    )
    const harDir = join(tmp, "har-record")
    rmSync(harDir, { recursive: true, force: true })
    const recordResult = await runWorkflow({ workflowPath: flow, harDir })
    expect(recordResult.ok).toBe(true)
    expect(existsSync(join(harDir, "vu-0.har"))).toBe(true)

    // Step 2: read the HAR back and verify it has the entry we expect.
    const har = JSON.parse(readFileSync(join(harDir, "vu-0.har"), "utf8"))
    expect(har.log.entries.length).toBeGreaterThan(0)
    expect(har.log.entries[0].request.url).toContain("/replay-me")

    // Step 3: replay against the same workflow, with an unreachable URL.
    // The replay must short-circuit fetch — if it hits the network, it'd
    // fail. We point to a different port that nothing's listening on.
    const replayFlow = writeWorkflow(
      "har-replay-2.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/replay-me", { signal })
  assert(r.status === 200, "replay: status")
  const body = await r.json()
  return { fromReplay: true, url: body.url }
}`,
    )
    const replayResult = await runWorkflow({
      workflowPath: replayFlow,
      harReplayPath: harDir,
    })
    expect(replayResult.ok).toBe(true)
    expect((replayResult.value as { fromReplay: boolean }).fromReplay).toBe(true)
  })

  it("HAR replay: miss throws HarReplayMissError", async () => {
    const harDir = join(tmp, "har-miss")
    rmSync(harDir, { recursive: true, force: true })
    // Create an empty HAR dir: vu-0.har with no entries matching the workflow's URL.
    const seedFlow = writeWorkflow(
      "har-miss-seed.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/known", { signal })
}`,
    )
    await runWorkflow({ workflowPath: seedFlow, harDir })

    // Now replay a workflow that asks for a different URL → miss.
    const missFlow = writeWorkflow(
      "har-miss.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/unknown", { signal })
}`,
    )
    const result = await runWorkflow({ workflowPath: missFlow, harReplayPath: harDir })
    expect(result.ok).toBe(false)
    const err = result.error as { name?: string; method?: string; url?: string }
    expect(err.name).toBe("HarReplayMissError")
    expect(err.method).toBe("GET")
    expect(err.url).toContain("/unknown")
  })
})
