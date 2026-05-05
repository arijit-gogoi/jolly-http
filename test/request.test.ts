import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { request, classifyFetchError } from "../src/request.js"
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
      if (req.url === "/r303") {
        res.statusCode = 303
        res.setHeader("location", "/landed")
        res.end("see other")
        return
      }
      if (req.url === "/landed") {
        res.statusCode = 200
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ landed: true, method: req.method }))
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
    await expect(request.GET(`${baseUrl}/x`)).rejects.toThrow(
      /can only be used from inside a workflow function/,
    )
  })

  describe("per-method redirect default (v0.5+)", () => {
    it("GET follows redirect (default unchanged)", async () => {
      const { sink } = collector()
      const res = await withRuntime(mkCtx(sink), () => request.GET(`${baseUrl}/r303`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.landed).toBe(true)
      expect(body.method).toBe("GET")
    })

    it("POST does not follow redirect (new default: manual)", async () => {
      const { sink } = collector()
      const res = await withRuntime(mkCtx(sink), () => request.POST(`${baseUrl}/r303`, { json: { x: 1 } }))
      expect(res.status).toBe(303)
      expect(res.headers.get("location")).toBe("/landed")
    })

    it("PUT/PATCH/DELETE all default to manual", async () => {
      const { sink } = collector()
      for (const method of ["PUT", "PATCH", "DELETE"] as const) {
        const res = await withRuntime(mkCtx(sink), () =>
          request[method](`${baseUrl}/r303`),
        )
        expect(res.status).toBe(303)
      }
    })

    it("HEAD and OPTIONS follow redirects (treated like GET)", async () => {
      const { sink } = collector()
      const head = await withRuntime(mkCtx(sink), () => request.HEAD(`${baseUrl}/r303`))
      expect(head.status).toBe(200)
      const opts = await withRuntime(mkCtx(sink), () => request.OPTIONS(`${baseUrl}/r303`))
      expect(opts.status).toBe(200)
    })

    it("explicit redirect: 'follow' overrides POST default", async () => {
      const { sink } = collector()
      const res = await withRuntime(mkCtx(sink), () =>
        request.POST(`${baseUrl}/r303`, { json: { x: 1 }, redirect: "follow" }),
      )
      expect(res.status).toBe(200)
    })

    it("explicit redirect: 'manual' on GET still works", async () => {
      const { sink } = collector()
      const res = await withRuntime(mkCtx(sink), () =>
        request.GET(`${baseUrl}/r303`, { redirect: "manual" }),
      )
      expect(res.status).toBe(303)
    })
  })

  it("connection refused → ECONNREFUSED in sample", async () => {
    const { sink, samples } = collector()
    // High unreserved port that nothing should listen on. (Node rejects low
    // ports like 1 with "bad port" before the TCP layer, no system errno
    // reaches us — useless for testing the classifier on a real refusal.)
    await expect(
      withRuntime(mkCtx(sink), () => request.GET("http://127.0.0.1:65000/")),
    ).rejects.toThrow()
    expect(samples).toHaveLength(1)
    expect(samples[0].ok).toBe(false)
    if (!samples[0].ok) {
      // On most platforms this is ECONNREFUSED. On some Windows + Node combos
      // it surfaces as ECONNRESET. Accept either, but reject the bare TypeError.
      expect(samples[0].error).toMatch(/^E[A-Z]+/)
      expect(samples[0].error).not.toBe("TypeError")
    }
  })
})

describe("classifyFetchError", () => {
  it("preserves AbortError at the top level", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" })
    expect(classifyFetchError(err)).toEqual({ name: "AbortError", message: "aborted" })
  })

  it("preserves TimeoutError at the top level", () => {
    const err = Object.assign(new Error("timed out"), { name: "TimeoutError" })
    expect(classifyFetchError(err)).toEqual({ name: "TimeoutError", message: "timed out" })
  })

  it("walks .cause to find a system errno code", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    })
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner })
    const r = classifyFetchError(outer)
    expect(r.name).toBe("ECONNREFUSED")
    expect(r.message).toContain("ECONNREFUSED")
    expect(r.message).toContain("127.0.0.1:1")
  })

  it("walks .cause for ENOTFOUND", () => {
    const inner = Object.assign(new Error("getaddrinfo ENOTFOUND no-such-host.invalid"), {
      code: "ENOTFOUND",
    })
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner })
    expect(classifyFetchError(outer).name).toBe("ENOTFOUND")
  })

  it("recognizes UND_ERR_* names", () => {
    const inner = Object.assign(new Error("body timeout"), { name: "UND_ERR_BODY_TIMEOUT" })
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner })
    expect(classifyFetchError(outer).name).toBe("UND_ERR_BODY_TIMEOUT")
  })

  it("falls back to top-level name when no classifier found", () => {
    const err = new TypeError("fetch failed")
    const r = classifyFetchError(err)
    expect(r.name).toBe("TypeError")
    expect(r.message).toBe("fetch failed")
  })

  it("chains messages when multiple .cause hops have no code", () => {
    const innermost = new Error("inner detail")
    const middle = Object.assign(new Error("middle wrap"), { cause: innermost })
    const outer = Object.assign(new TypeError("fetch failed"), { cause: middle })
    const r = classifyFetchError(outer)
    expect(r.message).toContain("fetch failed")
    expect(r.message).toContain("middle wrap")
    expect(r.message).toContain("inner detail")
  })

  it("does not loop forever on cyclic cause chains", () => {
    const a: Record<string, unknown> = { name: "A", message: "a" }
    const b: Record<string, unknown> = { name: "B", message: "b", cause: a }
    a.cause = b // cycle
    expect(() => classifyFetchError(a)).not.toThrow()
  })
})
