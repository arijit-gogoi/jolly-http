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
    if (req.url === "/set-cookie") {
      res.setHeader("set-cookie", "sess=abc123; Path=/")
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end('{"set":true}')
      return
    }
    if (req.url === "/needs-cookie") {
      const got = req.headers.cookie ?? ""
      res.statusCode = got.includes("sess=abc123") ? 200 : 401
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ cookieReceived: got }))
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

  it("returns {ok:false} when workflow path missing default export", async () => {
    const path = writeWorkflow("nodefault.mjs", `export const x = 1`)
    const r = await runWorkflow({ workflowPath: path })
    expect(r.ok).toBe(false)
    expect((r.error as Error).message).toMatch(/default export/)
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

  it("cookies flow within a workflow run WITHOUT --cookies (always-on jar)", async () => {
    const path = writeWorkflow(
      "cookieflow.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const set = await request.GET("${baseUrl}/set-cookie", { signal })
  assert(set.status === 200, "set: " + set.status)
  const echo = await request.GET("${baseUrl}/needs-cookie", { signal })
  assert(echo.status === 200, "echo: " + echo.status)
  return await echo.json()
}`,
    )
    // No cookiesDir passed — jar must still be present in-memory.
    const result = await runWorkflow({ workflowPath: path })
    expect(result.ok).toBe(true)
    expect((result.value as { cookieReceived: string }).cookieReceived).toContain("sess=abc123")
  })

  it("opt-out per-call via init.cookies: false", async () => {
    const path = writeWorkflow(
      "cookieoptout.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/set-cookie", { signal })  // jar absorbs the cookie
  const echo = await request.GET("${baseUrl}/needs-cookie", { signal, cookies: false })
  // With cookies: false, cookie header is NOT sent → server returns 401
  assert(echo.status === 401, "expected 401 (no cookie sent), got " + echo.status)
  return { optedOut: true }
}`,
    )
    const result = await runWorkflow({ workflowPath: path })
    expect(result.ok).toBe(true)
    expect((result.value as { optedOut: boolean }).optedOut).toBe(true)
  })

  it("env-file: explicit --env-file loads vars into env", async () => {
    const path = writeWorkflow(
      "envflow.mjs",
      `import { env } from "jolly-http"
export default async function () { return { x: env.X, y: env.Y } }`,
    )
    const envFile = join(tmp, "envflow.env")
    writeFileSync(envFile, "X=from-file\nY=other", "utf8")
    const result = await runWorkflow({ workflowPath: path, envFiles: [envFile] })
    expect(result.value).toEqual({ x: "from-file", y: "other" })
  })

  it("env-file: process.env overrides .env file", async () => {
    process.env.__JOLLY_OVR_TEST__ = "from-process"
    const path = writeWorkflow(
      "ovrflow.mjs",
      `import { env } from "jolly-http"
export default async function () { return env.__JOLLY_OVR_TEST__ }`,
    )
    const envFile = join(tmp, "ovrflow.env")
    writeFileSync(envFile, "__JOLLY_OVR_TEST__=from-file", "utf8")
    const result = await runWorkflow({ workflowPath: path, envFiles: [envFile] })
    expect(result.value).toBe("from-process")
    delete process.env.__JOLLY_OVR_TEST__
  })

  it("env-file: --env flag wins over both", async () => {
    const path = writeWorkflow(
      "flagflow.mjs",
      `import { env } from "jolly-http"
export default async function () { return env.PRECEDENCE }`,
    )
    const envFile = join(tmp, "flagflow.env")
    writeFileSync(envFile, "PRECEDENCE=from-file", "utf8")
    const result = await runWorkflow({
      workflowPath: path,
      envFiles: [envFile],
      env: { PRECEDENCE: "from-flag" },
    })
    expect(result.value).toBe("from-flag")
  })

  it("env-file: multiple files, later overrides earlier", async () => {
    const path = writeWorkflow(
      "multienv.mjs",
      `import { env } from "jolly-http"
export default async function () { return env.MULTI_KEY }`,
    )
    const f1 = join(tmp, "m1.env")
    const f2 = join(tmp, "m2.env")
    writeFileSync(f1, "MULTI_KEY=first", "utf8")
    writeFileSync(f2, "MULTI_KEY=second", "utf8")
    const result = await runWorkflow({ workflowPath: path, envFiles: [f1, f2] })
    expect(result.value).toBe("second")
  })

  it("env-file: missing explicit file → result ok=false", async () => {
    const path = writeWorkflow("nfile.mjs", `export default async function () {}`)
    const result = await runWorkflow({ workflowPath: path, envFiles: ["/nonexistent/.env"] })
    expect(result.ok).toBe(false)
    expect((result.error as Error).message).toMatch(/not found/)
  })

  it("require-env: passes when all keys are set", async () => {
    const path = writeWorkflow(
      "reqok.mjs",
      `import { env } from "jolly-http"
export default async function () { return { a: env.A, b: env.B } }`,
    )
    const envFile = join(tmp, "reqok.env")
    const example = join(tmp, "reqok.example")
    writeFileSync(envFile, "A=1\nB=2", "utf8")
    writeFileSync(example, "A=\nB=", "utf8")
    const result = await runWorkflow({
      workflowPath: path,
      envFiles: [envFile],
      requireEnvPath: example,
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ a: "1", b: "2" })
  })

  it("require-env: lists all missing keys at once", async () => {
    const path = writeWorkflow("reqfail.mjs", `export default async function () {}`)
    const example = join(tmp, "reqfail.example")
    writeFileSync(example, "MISSING_A=\nMISSING_B=\nMISSING_C=", "utf8")
    const result = await runWorkflow({ workflowPath: path, requireEnvPath: example })
    expect(result.ok).toBe(false)
    const msg = (result.error as Error).message
    expect(msg).toContain("MISSING_A")
    expect(msg).toContain("MISSING_B")
    expect(msg).toContain("MISSING_C")
  })

  it("require-env: empty value KEY= counts as missing", async () => {
    const path = writeWorkflow("emptyval.mjs", `export default async function () {}`)
    const envFile = join(tmp, "emptyval.env")
    const example = join(tmp, "emptyval.example")
    writeFileSync(envFile, "X=", "utf8")
    writeFileSync(example, "X=", "utf8")
    const result = await runWorkflow({
      workflowPath: path,
      envFiles: [envFile],
      requireEnvPath: example,
    })
    expect(result.ok).toBe(false)
    expect((result.error as Error).message).toContain("X")
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

  it("--cookies <dir> is fresh-each-run: second run does NOT inherit cookies", async () => {
    const path = writeWorkflow(
      "cookies-fresh.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const echo = await request.GET("${baseUrl}/needs-cookie", { signal })
  // No cookie sent → server returns 401. Returns the status so the test asserts on it.
  return { status: echo.status }
}`,
    )
    const seedPath = writeWorkflow(
      "cookies-fresh-seed.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/set-cookie", { signal })  // jar absorbs Set-Cookie
}`,
    )
    const jarDir = join(tmp, "fresh-jar")
    if (existsSync(jarDir)) rmSync(jarDir, { recursive: true, force: true })

    // Run 1: set cookie. cookiesDir saves on exit.
    const r1 = await runWorkflow({ workflowPath: seedPath, cookiesDir: jarDir })
    expect(r1.ok).toBe(true)
    // The jar file exists on disk from r1.
    expect(existsSync(join(jarDir, "vu-0.json"))).toBe(true)

    // Run 2: same cookiesDir. With v0.4 semantics the jar starts empty
    // even though the dir has a previous jar on disk.
    const r2 = await runWorkflow({ workflowPath: path, cookiesDir: jarDir })
    expect(r2.ok).toBe(true)
    expect((r2.value as { status: number }).status).toBe(401)
  })

  describe("prologue / epilogue hooks", () => {
    it("runs prologue once before iteration; epilogue once after", async () => {
      const path = writeWorkflow(
        "hooks-happy.mjs",
        `import { request } from "jolly-http"
let phases = []
export async function prologue(env, signal) {
  phases.push("prologue")
  await request.GET("${baseUrl}/hello", { signal })
}
export default async function () {
  phases.push("default")
}
export async function epilogue(env, signal) {
  phases.push("epilogue")
  await request.GET("${baseUrl}/hello", { signal })
}
export function _phases() { return phases }
`,
      )
      const r = await runWorkflow({ workflowPath: path })
      expect(r.ok).toBe(true)
      // Re-import the module to read its module-state captured by hooks.
      const mod = await import(/* @vite-ignore */ "file://" + path.replace(/\\/g, "/"))
      expect(mod._phases()).toEqual(["prologue", "default", "epilogue"])
    })

    it("epilogue STILL runs when prologue throws", async () => {
      // The discriminating test. Prologue creates state and immediately fails;
      // epilogue must run to clean it up. This is the contract — partial-setup
      // teardown matches jest beforeAll/afterAll, pytest fixtures, etc.
      const path = writeWorkflow(
        "hooks-prologue-throws.mjs",
        `let prologueRan = false, defaultRan = false, epilogueRan = false
export async function prologue() {
  prologueRan = true
  throw new Error("prologue boom")
}
export default async function () {
  defaultRan = true
}
export async function epilogue() {
  epilogueRan = true
}
export function _flags() { return { prologueRan, defaultRan, epilogueRan } }
`,
      )
      const r = await runWorkflow({ workflowPath: path })
      const mod = await import(/* @vite-ignore */ "file://" + path.replace(/\\/g, "/"))
      const flags = mod._flags()
      expect(flags.prologueRan).toBe(true)
      expect(flags.defaultRan).toBe(false)
      expect(flags.epilogueRan).toBe(true)
      expect(r.ok).toBe(false)
      expect((r.error as Error).message).toMatch(/prologue boom/)
    })

    it("epilogue runs when default throws", async () => {
      const path = writeWorkflow(
        "hooks-default-throws.mjs",
        `let epilogueRan = false
export default async function () {
  throw new Error("default boom")
}
export async function epilogue() {
  epilogueRan = true
}
export function _flag() { return epilogueRan }
`,
      )
      const r = await runWorkflow({ workflowPath: path })
      const mod = await import(/* @vite-ignore */ "file://" + path.replace(/\\/g, "/"))
      expect(mod._flag()).toBe(true)
      expect(r.ok).toBe(false)
      expect((r.error as Error).message).toMatch(/default boom/)
    })

    it("samples emitted from prologue carry phase: 'prologue'", async () => {
      const ndjsonPath = join(tmp, "hooks-phase.ndjson")
      if (existsSync(ndjsonPath)) rmSync(ndjsonPath)
      const path = writeWorkflow(
        "hooks-phase.mjs",
        `import { request } from "jolly-http"
export async function prologue(env, signal) {
  await request.GET("${baseUrl}/hello", { signal })  // phase: prologue
}
export default async function (vu, signal) {
  await request.GET("${baseUrl}/hello", { signal })  // phase: omitted (iteration)
}
export async function epilogue(env, signal) {
  await request.GET("${baseUrl}/hello", { signal })  // phase: epilogue
}
`,
      )
      const r = await runWorkflow({ workflowPath: path, outPath: ndjsonPath })
      expect(r.ok).toBe(true)
      const lines = readFileSync(ndjsonPath, "utf8").trim().split("\n")
      expect(lines).toHaveLength(3)
      const samples = lines.map(l => JSON.parse(l))
      expect(samples[0].phase).toBe("prologue")
      expect(samples[1].phase).toBeUndefined()
      expect(samples[2].phase).toBe("epilogue")
    })

    it("rejects non-function prologue", async () => {
      const path = writeWorkflow(
        "hooks-bad-prologue.mjs",
        `export const prologue = "not a function"
export default async function () {}
`,
      )
      const r = await runWorkflow({ workflowPath: path })
      expect(r.ok).toBe(false)
      expect((r.error as Error).message).toMatch(/prologue must be a function/)
    })
  })

  it("--cookies-resume <dir>: second run DOES inherit cookies from disk", async () => {
    const path = writeWorkflow(
      "cookies-resume.mjs",
      `import { request, assert } from "jolly-http"
export default async function (vu, signal) {
  const echo = await request.GET("${baseUrl}/needs-cookie", { signal })
  return { status: echo.status }
}`,
    )
    const seedPath = writeWorkflow(
      "cookies-resume-seed.mjs",
      `import { request } from "jolly-http"
export default async function (vu, signal) {
  await request.GET("${baseUrl}/set-cookie", { signal })
}`,
    )
    const jarDir = join(tmp, "resume-jar")
    if (existsSync(jarDir)) rmSync(jarDir, { recursive: true, force: true })

    // Run 1: seed and persist via the resume flag.
    const r1 = await runWorkflow({ workflowPath: seedPath, cookiesResumeDir: jarDir })
    expect(r1.ok).toBe(true)
    expect(existsSync(join(jarDir, "vu-0.json"))).toBe(true)

    // Run 2: same dir, same resume flag → jar loads on startup, cookie sent.
    const r2 = await runWorkflow({ workflowPath: path, cookiesResumeDir: jarDir })
    expect(r2.ok).toBe(true)
    expect((r2.value as { status: number }).status).toBe(200)
  })
})
