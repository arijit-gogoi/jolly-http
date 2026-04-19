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
})
