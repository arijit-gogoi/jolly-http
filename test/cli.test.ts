import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { join } from "node:path"
import { parseCli, CliError } from "../src/cli-args.js"

const run = promisify(execFile)
const cliPath = join(__dirname, "..", "dist", "cli.js")

describe("parseCli", () => {
  it("no args → CliError with exit 2", () => {
    expect(() => parseCli([])).toThrow(CliError)
    try {
      parseCli([])
    } catch (e) {
      expect((e as CliError).exitCode).toBe(2)
    }
  })

  it("--help → help mode", () => {
    const a = parseCli(["--help"])
    expect(a.mode).toBe("help")
  })

  it("--version → version mode", () => {
    const a = parseCli(["--version"])
    expect(a.mode).toBe("version")
  })

  it("GET url → adhoc", () => {
    const a = parseCli(["GET", "http://x/"])
    expect(a.mode).toBe("adhoc")
    expect(a.method).toBe("GET")
    expect(a.url).toBe("http://x/")
  })

  it("lowercase method uppercased", () => {
    const a = parseCli(["post", "http://x/"])
    expect(a.method).toBe("POST")
  })

  it("shorthand captured", () => {
    const a = parseCli(["POST", "http://x/", "name=ari", "age:=30"])
    expect(a.shorthand).toEqual(["name=ari", "age:=30"])
  })

  it("run flow.mjs → run mode", () => {
    const a = parseCli(["run", "flow.mjs"])
    expect(a.mode).toBe("run")
    expect(a.workflow).toBe("flow.mjs")
  })

  it("run with -c and -d → load-capable run", () => {
    const a = parseCli(["run", "f.mjs", "-c", "5", "-d", "10s"])
    expect(a.concurrency).toBe(5)
    expect(a.durationMs).toBe(10_000)
  })

  it("headers --header X:y repeatable", () => {
    const a = parseCli(["GET", "http://x/", "--header", "A:1", "--header", "B:2"])
    expect(a.headers).toEqual({ A: "1", B: "2" })
  })

  it("env --env A=1", () => {
    const a = parseCli(["run", "f.mjs", "--env", "A=1", "--env", "B=2"])
    expect(a.env).toEqual({ A: "1", B: "2" })
  })

  it("bad URL → CliError", () => {
    expect(() => parseCli(["GET", "not-a-url"])).toThrow(/invalid URL/)
  })

  it("unknown first positional → CliError", () => {
    expect(() => parseCli(["frob", "x"])).toThrow(/unknown mode/)
  })

  it("GET without URL → CliError", () => {
    expect(() => parseCli(["GET"])).toThrow(/missing URL/)
  })

  it("run without workflow → CliError", () => {
    expect(() => parseCli(["run"])).toThrow(/missing workflow/)
  })

  it("--header without colon → CliError", () => {
    expect(() => parseCli(["GET", "http://x/", "--header", "noColonHere"])).toThrow(/bad --header/)
  })

  it("--timeout parsed", () => {
    const a = parseCli(["GET", "http://x/", "--timeout", "500ms"])
    expect(a.timeoutMs).toBe(500)
  })

  it("--quiet / --insecure", () => {
    const a = parseCli(["GET", "http://x/", "-q", "-k"])
    expect(a.quiet).toBe(true)
    expect(a.insecure).toBe(true)
  })
})

let server: Server
let baseUrl: string
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe("cli subprocess", () => {
  it("--version prints version", async () => {
    const { stdout } = await run(process.execPath, [cliPath, "--version"])
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("--help prints usage", async () => {
    const { stdout } = await run(process.execPath, [cliPath, "--help"])
    expect(stdout).toContain("USAGE")
    expect(stdout).toContain("jolly-http")
  })

  it("ad-hoc GET → exit 0 and prints JSON body", async () => {
    const { stdout } = await run(process.execPath, [cliPath, "GET", `${baseUrl}/users`])
    expect(stdout).toContain("HTTP/1.1")
    expect(stdout).toContain("200")
    expect(stdout).toContain('"ok": true')
  })

  it("bad args → exit 2", async () => {
    await expect(run(process.execPath, [cliPath, "GET"])).rejects.toMatchObject({ code: 2 })
  })

  it("no args → exit 2", async () => {
    await expect(run(process.execPath, [cliPath])).rejects.toMatchObject({ code: 2 })
  })
}, 20_000)
