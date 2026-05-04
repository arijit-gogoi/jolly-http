// Three-mode smoke for v0.4. Run via: node test/fixtures/smoke/smoke.mjs
// Verifies the just-built dist/cli.js end-to-end against an in-process server.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = resolve(fileURLToPath(import.meta.url), "..")
const repoRoot = resolve(here, "..", "..", "..")
const cli = join(repoRoot, "dist", "cli.js")

let setCookieCount = 0
let needsCookieCalls = 0
let promotedUserId = 0

const server = createServer((req, res) => {
  const url = req.url ?? ""
  if (url === "/hello") {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true, when: Date.now() }))
    return
  }
  if (url === "/login") {
    setCookieCount++
    res.setHeader("set-cookie", "sess=abc; Path=/")
    res.statusCode = 200
    res.end(JSON.stringify({ token: "tok-" + setCookieCount }))
    return
  }
  if (url === "/me") {
    needsCookieCalls++
    const got = req.headers.cookie ?? ""
    if (!got.includes("sess=abc")) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: "no cookie" }))
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({ user: "ari" }))
    return
  }
  if (url.startsWith("/test-users")) {
    if (req.method === "POST") {
      promotedUserId = Math.floor(Math.random() * 100000)
      res.statusCode = 201
      res.end(JSON.stringify({ id: promotedUserId }))
      return
    }
    if (req.method === "DELETE") {
      promotedUserId = 0
      res.statusCode = 204
      res.end()
      return
    }
  }
  res.statusCode = 404
  res.end()
})

await new Promise(r => server.listen(0, "127.0.0.1", r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

console.log(`smoke: server on ${base}`)

const tmp = join(here, "tmp")
if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

function runCli(args, opts = {}) {
  return new Promise((resolveProc, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", c => (stdout += c.toString()))
    child.stderr.on("data", c => (stderr += c.toString()))
    child.on("error", reject)
    child.on("close", code => resolveProc({ code, stdout, stderr }))
  })
}

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok    ${label}`)
  } else {
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`)
    failures++
  }
}

try {
  // ─────────────────────────────────────────────────────────────────────────
  // Mode 1: ad-hoc GET
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[1/3] ad-hoc GET")
  {
    const r = await runCli(["GET", `${base}/hello`, "-q"])
    check("ad-hoc exit 0", r.code === 0, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mode 2: single-run with prologue/epilogue + cookie default flip
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[2/3] single-run with hooks + cookie default flip")
  {
    const flow = join(tmp, "flow.mjs")
    writeFileSync(
      flow,
      `import { request, assert, env } from "jolly-http"
let testUserId
export async function prologue(env, signal) {
  const r = await request.POST("${base}/test-users", { json: {}, signal })
  testUserId = (await r.json()).id
}
export default async function (vu, signal) {
  await request.GET("${base}/login", { signal })       // jar absorbs Set-Cookie
  const me = await request.GET("${base}/me", { signal })
  assert(me.status === 200, "me failed in iteration")
  return { testUserId }
}
export async function epilogue(env, signal) {
  if (testUserId) {
    await request.DELETE("${base}/test-users/" + testUserId, { signal })
  }
}
`,
      "utf8",
    )

    // Run 1: cookies dir collects but does NOT load on next run.
    const jarDir = join(tmp, "jar")
    const r1 = await runCli(["run", flow, "--cookies", jarDir, "-q"])
    check("single-run exit 0", r1.code === 0, `code=${r1.code} stderr=${r1.stderr.slice(0, 200)}`)
    check(
      "jar persisted to disk",
      existsSync(join(jarDir, "vu-0.json")),
      "vu-0.json should exist after first run",
    )
    check(
      "epilogue ran (test user cleaned up)",
      promotedUserId === 0,
      `promotedUserId=${promotedUserId} after run; epilogue should have DELETE'd`,
    )

    // Run 2: same dir → fresh jar, login flow runs again (cookie not inherited).
    const callsBefore = setCookieCount
    const r2 = await runCli(["run", flow, "--cookies", jarDir, "-q"])
    check("single-run #2 exit 0", r2.code === 0)
    check(
      "fresh-each-run: /login was called again on run 2",
      setCookieCount === callsBefore + 1,
      `setCookieCount went ${callsBefore} -> ${setCookieCount}; expected +1`,
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mode 3: load with hooks; verify NDJSON phase tags
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n[3/3] load with phase-tagged samples")
  {
    const flow = join(tmp, "loadflow.mjs")
    writeFileSync(
      flow,
      `import { request } from "jolly-http"
export async function prologue(env, signal) {
  await request.GET("${base}/hello", { signal })   // phase: prologue
}
export default async function (vu, signal) {
  await request.GET("${base}/hello", { signal })   // phase: omitted (iteration)
}
export async function epilogue(env, signal) {
  await request.GET("${base}/hello", { signal })   // phase: epilogue
}
`,
      "utf8",
    )
    const out = join(tmp, "samples.ndjson")
    const r = await runCli([
      "run",
      flow,
      "-c", "4",
      "-d", "1s",
      "--out", out,
      "-q",
    ])
    check("load mode exit 0", r.code === 0, `stderr=${r.stderr.slice(0, 300)}`)
    check("NDJSON file written", existsSync(out))
    if (existsSync(out)) {
      const lines = readFileSync(out, "utf8").trim().split("\n")
      const samples = lines.map(l => JSON.parse(l))
      const prologueCount = samples.filter(s => s.phase === "prologue").length
      const epilogueCount = samples.filter(s => s.phase === "epilogue").length
      const iterationCount = samples.filter(s => s.phase === undefined).length
      check(
        "exactly 1 prologue sample",
        prologueCount === 1,
        `got ${prologueCount}`,
      )
      check(
        "exactly 1 epilogue sample",
        epilogueCount === 1,
        `got ${epilogueCount}`,
      )
      check(
        "many iteration samples (no phase field)",
        iterationCount >= 5,
        `got ${iterationCount} iteration samples in 1s × 4 VUs`,
      )
      // Sentinel iteration ids on hooks
      check(
        "prologue sample has iteration: -1",
        samples.find(s => s.phase === "prologue")?.iteration === -1,
      )
      check(
        "epilogue sample has iteration: -2",
        samples.find(s => s.phase === "epilogue")?.iteration === -2,
      )
    }
  }
} finally {
  await new Promise(r => server.close(r))
}

if (failures > 0) {
  console.error(`\nsmoke: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log("\nsmoke: all checks passed")
