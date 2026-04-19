import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { runAdhoc } from "../dist/index.js"

let server: Server
let baseUrl: string

let received: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined>; body?: string } = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      received = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      if (req.url?.startsWith("/status/404")) {
        res.statusCode = 404
        res.end("nope")
        return
      }
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  return new Promise<void>(resolve => server.close(() => resolve()))
})

describe("runAdhoc", () => {
  it("GET success", async () => {
    const r = await runAdhoc({
      method: "GET",
      url: `${baseUrl}/users`,
      shorthand: [],
      quiet: true,
    })
    expect(r.ok).toBe(true)
    expect(received.method).toBe("GET")
    expect(received.url).toBe("/users")
  })

  it("POST with JSON shorthand sends JSON body", async () => {
    await runAdhoc({
      method: "POST",
      url: `${baseUrl}/u`,
      shorthand: ["name=ari", "age:=30"],
      quiet: true,
    })
    expect(received.method).toBe("POST")
    expect(received.headers?.["content-type"]).toContain("application/json")
    expect(JSON.parse(received.body!)).toEqual({ name: "ari", age: 30 })
  })

  it("header shorthand sets headers", async () => {
    await runAdhoc({
      method: "GET",
      url: `${baseUrl}/h`,
      shorthand: ["X-Token:abc"],
      quiet: true,
    })
    expect(received.headers?.["x-token"]).toBe("abc")
  })

  it("query shorthand sets URL query", async () => {
    await runAdhoc({
      method: "GET",
      url: `${baseUrl}/s`,
      shorthand: ["q==hello"],
      quiet: true,
    })
    expect(received.url).toBe("/s?q=hello")
  })

  it("404 is success at adhoc level (status code is not a failure)", async () => {
    const r = await runAdhoc({
      method: "GET",
      url: `${baseUrl}/status/404`,
      shorthand: [],
      quiet: true,
    })
    expect(r.ok).toBe(true)
    expect((r.value as { status: number }).status).toBe(404)
  })

  it("explicit --json overrides shorthand", async () => {
    await runAdhoc({
      method: "POST",
      url: `${baseUrl}/j`,
      shorthand: [],
      jsonBody: '{"z":1}',
      quiet: true,
    })
    expect(JSON.parse(received.body!)).toEqual({ z: 1 })
  })
})
