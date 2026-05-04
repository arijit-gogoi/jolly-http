import { describe, it, expect } from "vitest"
import { AssertionError, assert, buildEnv, env, withRuntime, currentContext, tryCurrentContext, type RuntimeContext } from "../src/runtime.js"
import type { SampleSink } from "../src/types.js"

const nullSink: SampleSink = { write() {}, async close() {} }

function mkCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    vu: { id: 0, iteration: 0, env: Object.freeze({ FOO: "bar" }) },
    sink: nullSink,
    signal: new AbortController().signal,
    tZero: performance.now(),
    defaults: { userAgent: "jolly-http/test" },
    ...overrides,
  }
}

describe("assert", () => {
  it("is a no-op when true", () => {
    assert(true)
    assert(1)
    assert("x")
  })
  it("throws AssertionError when false", () => {
    expect(() => assert(false)).toThrow(AssertionError)
    expect(() => assert(false, "nope")).toThrow(/nope/)
    try {
      assert(false, "bad")
    } catch (e) {
      expect((e as Error).name).toBe("AssertionError")
    }
  })
  it("appends last-response context when present in runtime", async () => {
    const ctx = mkCtx({
      lastResponse: {
        method: "GET",
        url: "https://api.example.com/me",
        status: 404,
        headers: { "content-type": "application/json", "x-trace-id": "abc123" },
        bodyText: '{"error":"not authenticated"}',
      },
    })
    let captured: Error | undefined
    await withRuntime(ctx, async () => {
      try {
        assert(false, "C5: expected 200, got 404")
      } catch (e) {
        captured = e as Error
      }
    })
    expect(captured).toBeInstanceOf(AssertionError)
    const msg = captured!.message
    expect(msg).toContain("C5: expected 200, got 404")
    expect(msg).toContain("-> last request: GET https://api.example.com/me 404")
    expect(msg).toContain("content-type: application/json")
    expect(msg).toContain("x-trace-id: abc123")
    expect(msg).toContain('{"error":"not authenticated"}')
    expect((captured as AssertionError).lastResponse?.status).toBe(404)
  })
  it("does not append context when no prior response in this runtime", async () => {
    const ctx = mkCtx() // no lastResponse
    let captured: Error | undefined
    await withRuntime(ctx, async () => {
      try {
        assert(false, "no request yet")
      } catch (e) {
        captured = e as Error
      }
    })
    expect(captured!.message).toBe("no request yet")
    expect((captured as AssertionError).lastResponse).toBeUndefined()
  })
  it("does not truncate the response body in the appended context", async () => {
    const huge = "x".repeat(10_000)
    const ctx = mkCtx({
      lastResponse: {
        method: "POST",
        url: "https://api/post",
        status: 500,
        headers: {},
        bodyText: huge,
      },
    })
    let captured: Error | undefined
    await withRuntime(ctx, async () => {
      try {
        assert(false, "boom")
      } catch (e) {
        captured = e as Error
      }
    })
    expect(captured!.message).toContain(huge)
  })
})

describe("env", () => {
  it("reads from current runtime context", async () => {
    await withRuntime(mkCtx(), async () => {
      expect(env.FOO).toBe("bar")
    })
  })
  it("returns undefined for missing keys", async () => {
    await withRuntime(mkCtx(), async () => {
      expect((env as Record<string, string>).NOPE).toBeUndefined()
    })
  })
  it("reflects overrides", async () => {
    await withRuntime(mkCtx({ vu: { id: 1, iteration: 0, env: Object.freeze({ A: "1" }) } }), async () => {
      expect(env.A).toBe("1")
    })
  })
  it("is read-only", async () => {
    await withRuntime(mkCtx(), async () => {
      expect(() => {
        ;(env as Record<string, string>).X = "y"
      }).toThrow()
    })
  })
  it("falls back to process.env when outside a runtime", () => {
    process.env.__JOLLY_HTTP_TEST__ = "abc"
    expect(env.__JOLLY_HTTP_TEST__).toBe("abc")
    delete process.env.__JOLLY_HTTP_TEST__
  })
})

describe("buildEnv", () => {
  it("produces a frozen merge with flag overrides only", () => {
    const e = buildEnv([], { FOO: "override" })
    expect(Object.isFrozen(e)).toBe(true)
    expect(e.FOO).toBe("override")
  })

  it("layers: dotenv < process.env < flags", () => {
    process.env.__JOLLY_LAYER_TEST__ = "from-process"
    const e = buildEnv(
      [{ __JOLLY_LAYER_TEST__: "from-dotenv" }],
      { ANOTHER: "flag-only" },
    )
    // process.env wins over dotenv layer
    expect(e.__JOLLY_LAYER_TEST__).toBe("from-process")
    expect(e.ANOTHER).toBe("flag-only")
    delete process.env.__JOLLY_LAYER_TEST__
  })

  it("flag overrides win over process.env", () => {
    process.env.__JOLLY_FLAG_TEST__ = "from-process"
    const e = buildEnv([], { __JOLLY_FLAG_TEST__: "from-flag" })
    expect(e.__JOLLY_FLAG_TEST__).toBe("from-flag")
    delete process.env.__JOLLY_FLAG_TEST__
  })

  it("multiple dotenv layers — later wins", () => {
    const e = buildEnv([{ X: "1" }, { X: "2" }, { X: "3" }], {})
    expect(e.X).toBe("3")
  })
})

describe("withRuntime / currentContext", () => {
  it("provides a context to inner callbacks", async () => {
    const ctx = mkCtx()
    await withRuntime(ctx, async () => {
      expect(currentContext()).toBe(ctx)
    })
  })
  it("currentContext throws outside a runtime with a helpful message", () => {
    expect(() => currentContext()).toThrow(/can only be used from inside a workflow function/)
    expect(() => currentContext()).toThrow(/Move the call inside your default export/)
  })
  it("tryCurrentContext returns undefined outside", () => {
    expect(tryCurrentContext()).toBeUndefined()
  })
})
