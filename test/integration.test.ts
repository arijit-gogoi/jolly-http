import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { join } from "node:path"
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs"

const run = promisify(execFile)
const cliPath = join(__dirname, "..", "dist", "cli.js")
const fixtures = join(__dirname, "fixtures", "integration")

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      if (req.url === "/login") {
        res.statusCode = 200
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ token: "tok-123" }))
        return
      }
      if (req.url === "/me") {
        const auth = req.headers.authorization
        if (auth === "Bearer tok-123") {
          res.statusCode = 200
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ user: "ari" }))
          return
        }
        res.statusCode = 401
        res.end()
        return
      }
      if (req.url === "/fail") {
        res.statusCode = 500
        res.end("boom")
        return
      }
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  if (existsSync(fixtures)) rmSync(fixtures, { recursive: true, force: true })
  mkdirSync(fixtures, { recursive: true })
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

function fixture(name: string, src: string): string {
  const path = join(fixtures, name)
  writeFileSync(path, src, "utf8")
  return path
}

describe("integration — end to end via built CLI", () => {
  it("ad-hoc GET → prints body, exits 0", async () => {
    const { stdout } = await run(process.execPath, [cliPath, "GET", `${baseUrl}/u`])
    expect(stdout).toContain("HTTP/1.1")
    expect(stdout).toContain("200")
  })

  it("ad-hoc POST with JSON shorthand → sends JSON", async () => {
    const { stdout } = await run(process.execPath, [
      cliPath,
      "POST",
      `${baseUrl}/u`,
      "name=ari",
      "age:=30",
    ])
    expect(stdout).toContain("HTTP/1.1")
    expect(stdout).toContain("200")
  })

  it("run flow.mjs → single-run success", async () => {
    const flow = fixture(
      "hello.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/u", { signal })
  assert(r.status === 200)
  return { hello: "world" }
}`,
    )
    const { stdout } = await run(process.execPath, [cliPath, "run", flow])
    expect(stdout).toContain('"hello": "world"')
  })

  it("run flow.mjs → assert failure exits 1 with message", async () => {
    const flow = fixture(
      "bad.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/fail", { signal })
  assert(r.status === 200, "not 200")
}`,
    )
    await expect(
      run(process.execPath, [cliPath, "run", flow]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AssertionError") })
  })

  it("run flow.mjs → multi-step auth flow", async () => {
    const flow = fixture(
      "auth.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const login = await request.POST("${baseUrl}/login", { json: {}, signal })
  assert(login.status === 200, "login failed")
  const { token } = await login.json()
  const me = await request.GET("${baseUrl}/me", {
    headers: { authorization: \`Bearer \${token}\` },
    signal,
  })
  assert(me.status === 200, \`me returned \${me.status}\`)
  const body = await me.json()
  return { user: body.user }
}`,
    )
    const { stdout } = await run(process.execPath, [cliPath, "run", flow])
    expect(stdout).toContain('"user": "ari"')
  }, 15_000)

  it("run flow.mjs -c 3 -d 500ms → load summary, exits 0", async () => {
    const flow = fixture(
      "load.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/u", { signal })
}`,
    )
    const out = join(fixtures, "samples.ndjson")
    const { stdout } = await run(process.execPath, [
      cliPath,
      "run",
      flow,
      "-c",
      "3",
      "-d",
      "500ms",
      "--out",
      out,
    ])
    expect(stdout).toMatch(/summary/)
    expect(stdout).toMatch(/iterations:\s+\d+/)
    expect(existsSync(out)).toBe(true)
    const lines = readFileSync(out, "utf8").trim().split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const sample = JSON.parse(lines[0])
    expect(sample).toMatchObject({ ok: true, method: "GET", status: 200 })
  }, 15_000)

  it("same workflow file works single AND load (API stability invariant)", async () => {
    const flow = fixture(
      "unified.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const r = await request.GET("${baseUrl}/u", { signal })
  assert(r.status === 200)
  return { ok: true }
}`,
    )
    // single
    const single = await run(process.execPath, [cliPath, "run", flow])
    expect(single.stdout).toContain('"ok": true')
    // load
    const load = await run(process.execPath, [cliPath, "run", flow, "-c", "2", "-d", "300ms"])
    expect(load.stdout).toMatch(/summary/)
  }, 15_000)
})
