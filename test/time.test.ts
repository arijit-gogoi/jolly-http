import { describe, it, expect } from "vitest"
import { parseDuration } from "jolly-coop"
import { formatMs } from "../src/time.js"

describe("parseDuration", () => {
  it("parses ms", () => {
    expect(parseDuration("500ms")).toBe(500)
  })
  it("parses s", () => {
    expect(parseDuration("30s")).toBe(30_000)
  })
  it("parses m", () => {
    expect(parseDuration("2m")).toBe(120_000)
  })
  it("parses h", () => {
    expect(parseDuration("1h")).toBe(3_600_000)
  })
  it("accepts numeric input", () => {
    expect(parseDuration(5_000)).toBe(5_000)
  })
  it("throws on invalid (incl. fractional)", () => {
    expect(() => parseDuration("abc")).toThrow()
    expect(() => parseDuration("")).toThrow()
    expect(() => parseDuration("-5s")).toThrow()
    expect(() => parseDuration("5d")).toThrow()
    expect(() => parseDuration(-1)).toThrow()
    expect(() => parseDuration(Number.NaN)).toThrow()
    expect(() => parseDuration("1.5s")).toThrow()
  })
})

describe("formatMs", () => {
  it("formats sub-ms", () => {
    expect(formatMs(0.5)).toMatch(/0\.50ms/)
  })
  it("formats ms", () => {
    expect(formatMs(42)).toBe("42.0ms")
  })
  it("formats seconds", () => {
    expect(formatMs(1_500)).toBe("1.50s")
  })
  it("formats minutes", () => {
    expect(formatMs(120_000)).toBe("2.00m")
  })
})
