import { describe, it, expect } from "vitest"
import { _internals } from "../src/watch.js"

// Integration tests for runWatched (file-watching, scope plumbing) are
// intentionally manual — see spec/SPEC.md and the v0.2 plan smoke section.
// Unit tests cover the pure parts (the reload controller).

const { makeReloadController } = _internals

describe("ReloadController", () => {
  it("starts with no pending", () => {
    const c = makeReloadController()
    expect(c.hasFired()).toBe(false)
    expect(c.consumePending()).toBe(0)
  })

  it("fire → wait resolves immediately", async () => {
    const c = makeReloadController()
    const ac = new AbortController()
    c.fire()
    await c.wait(ac.signal) // should resolve, not hang
    expect(c.hasFired()).toBe(true)
  })

  it("fire-while-waiting wakes the waiter", async () => {
    const c = makeReloadController()
    const ac = new AbortController()
    let resolved = false
    const p = c.wait(ac.signal).then(() => { resolved = true })
    expect(resolved).toBe(false)
    c.fire()
    await p
    expect(resolved).toBe(true)
  })

  it("signal abort wakes the waiter", async () => {
    const c = makeReloadController()
    const ac = new AbortController()
    let resolved = false
    const p = c.wait(ac.signal).then(() => { resolved = true })
    expect(resolved).toBe(false)
    ac.abort()
    await p
    expect(resolved).toBe(true)
    expect(c.hasFired()).toBe(false) // signal != fire
  })

  it("already-aborted signal resolves immediately", async () => {
    const c = makeReloadController()
    const ac = new AbortController()
    ac.abort()
    await c.wait(ac.signal) // must not hang
  })

  it("consumePending counts and resets", () => {
    const c = makeReloadController()
    c.fire()
    c.fire()
    c.fire()
    expect(c.consumePending()).toBe(3)
    expect(c.hasFired()).toBe(false)
    expect(c.consumePending()).toBe(0)
  })

  it("reset clears pending without firing waiters", async () => {
    const c = makeReloadController()
    const ac = new AbortController()
    c.fire()
    c.reset()
    expect(c.hasFired()).toBe(false)
    let resolved = false
    const p = c.wait(ac.signal).then(() => { resolved = true })
    // Wait one tick — should still be unresolved because reset cleared pending.
    await new Promise(r => setImmediate(r))
    expect(resolved).toBe(false)
    ac.abort()
    await p
  })
})
