import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { request } from "../src/request.js"
import { withRuntime, type RuntimeContext } from "../src/runtime.js"
import type { Sample, SampleSink } from "../src/types.js"

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", c => chunks.push(c))
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8")
      if (req.url === "/slow") {
        setTimeout(() => {
          res.statusCode = 200
          res.end("ok")
        }, 500)
        return
      }
      if (req.url === "/status/500") {
        res.statusCode = 500
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ error: "boom" }))
        return
      }
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: bodyStr,
        }),
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  return new Promise<void>(resolve => server.close(() => resolve()))
})

function mkCtx(sink: SampleSink, signal?: AbortSignal): RuntimeContext {
  return {
    vu: { id: 7, iteration: 1, env: Object.freeze({}) },
    sink,
    signal: signal ?? new AbortController().signal,
    tZero: performance.now(),
    defaults: { userAgent: "jolly-http/test" },
  }
}

function collector(): { samples: Sample[]; sink: SampleSink } {
  const samples: Sample[] = []
  return {
    samples,
    sink: {
      write(s) {
        samples.push(s)
      },
      async close() {},
    },
  }
}

describe("request", () => {
  it("GET returns a Response-shaped object", async () => {
    const { sink, samples } = collector()
    const res = await withRuntime(mkCtx(sink), () => request.GET(`${baseUrl}/users`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.method).toBe("GET")
    expect(body.url).toBe("/users")
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ ok: true, vu: 7, iteration: 1, method: "GET", status: 200 })
  })

  it("POST json sends JSON body and content-type", async () => {
    const { sink } = collector()
    const res = await withRuntime(mkCtx(sink), () =>
      request.POST(`${baseUrl}/u`, { json: { name: "ari" } }),
    )
    const body = await res.json()
    expect(body.headers["content-type"]).toContain("application/json")
    expect(JSON.parse(body.body)).toEqual({ name: "ari" })
  })

  it("non-2xx does not throw; returns Response", async () => {
    const { sink, samples } = collector()
    const res = await withRuntime(mkCtx(sink), () => request.GET(`${baseUrl}/status/500`))
    expect(res.status).toBe(500)
    expect(samples[0]).toMatchObject({ ok: true, status: 500 })
  })

  it("per-request timeout throws and records error sample", async () => {
    const { sink, samples } = collector()
    await expect(
      withRuntime(mkCtx(sink), () => request.GET(`${baseUrl}/slow`, { timeout: "50ms" })),
    ).rejects.toThrow()
    expect(samples[0]).toMatchObject({ ok: false })
  })

  it("external signal aborts request", async () => {
    const { sink } = collector()
    const ac = new AbortController()
    const p = withRuntime(mkCtx(sink, ac.signal), () => request.GET(`${baseUrl}/slow`))
    ac.abort(new Error("user abort"))
    await expect(p).rejects.toThrow()
  })

  it("query params appended", async () => {
    const { sink } = collector()
    const res = await withRuntime(mkCtx(sink), () =>
      request.GET(`${baseUrl}/q`, { query: { a: "1", b: "two" } }),
    )
    const body = await res.json()
    expect(body.url).toBe("/q?a=1&b=two")
  })

  it("custom headers override defaults", async () => {
    const { sink } = collector()
    const res = await withRuntime(mkCtx(sink), () =>
      request.GET(`${baseUrl}/h`, { headers: { "user-agent": "custom/1" } }),
    )
    const body = await res.json()
    expect(body.headers["user-agent"]).toBe("custom/1")
  })

  it("throws with clear error when called outside runtime", async () => {
    await expect(request.GET(`${baseUrl}/x`)).rejects.toThrow(/outside a workflow/)
  })
})
