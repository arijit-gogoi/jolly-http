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
  it("produces a frozen merge", () => {
    const e = buildEnv({ FOO: "override" })
    expect(Object.isFrozen(e)).toBe(true)
    expect(e.FOO).toBe("override")
  })
})

describe("withRuntime / currentContext", () => {
  it("provides a context to inner callbacks", async () => {
    const ctx = mkCtx()
    await withRuntime(ctx, async () => {
      expect(currentContext()).toBe(ctx)
    })
  })
  it("currentContext throws outside a runtime", () => {
    expect(() => currentContext()).toThrow(/outside a workflow/)
  })
  it("tryCurrentContext returns undefined outside", () => {
    expect(tryCurrentContext()).toBeUndefined()
  })
})
