import { describe, it, expect } from "vitest"
import { parseShorthand } from "../src/shorthand.js"

describe("parseShorthand", () => {
  it("key=value → JSON field", () => {
    const r = parseShorthand(["name=ari"])
    expect(r.jsonBody).toEqual({ name: "ari" })
    expect(r.hasJson).toBe(true)
  })

  it("key:=value → JSON literal", () => {
    const r = parseShorthand(["age:=30"])
    expect(r.jsonBody).toEqual({ age: 30 })
  })

  it("key:=bool → JSON boolean", () => {
    const r = parseShorthand(["active:=true"])
    expect(r.jsonBody).toEqual({ active: true })
  })

  it("key:=array", () => {
    const r = parseShorthand(["nested:=[1,2,3]"])
    expect(r.jsonBody).toEqual({ nested: [1, 2, 3] })
  })

  it("key:=object", () => {
    const r = parseShorthand(['meta:={"k":"v"}'])
    expect(r.jsonBody).toEqual({ meta: { k: "v" } })
  })

  it("Header:value → header", () => {
    const r = parseShorthand(["Auth:Bearer xyz"])
    expect(r.headers).toEqual({ Auth: "Bearer xyz" })
  })

  it("key==value → query param", () => {
    const r = parseShorthand(["q==hello"])
    expect(r.query).toEqual({ q: "hello" })
  })

  it("key@path → file upload", () => {
    const r = parseShorthand(["file@./data.txt"])
    expect(r.files).toEqual({ file: "./data.txt" })
    expect(r.hasForm).toBe(true)
  })

  it("mixed: JSON field + header + query", () => {
    const r = parseShorthand(["name=ari", "Auth:tok", "q==search"])
    expect(r.jsonBody).toEqual({ name: "ari" })
    expect(r.headers).toEqual({ Auth: "tok" })
    expect(r.query).toEqual({ q: "search" })
  })

  it("missing key throws", () => {
    expect(() => parseShorthand(["=value"])).toThrow(/missing key/)
    expect(() => parseShorthand([":=5"])).toThrow(/missing key/)
  })

  it("no delimiter throws", () => {
    expect(() => parseShorthand(["lonely"])).toThrow(/not a shorthand/)
  })

  it("invalid JSON for := throws", () => {
    expect(() => parseShorthand(["bad:={nope"])).toThrow(/invalid JSON/)
  })

  it(":= wins over : at same position via longest-match", () => {
    const r = parseShorthand(["age:=30"])
    expect(r.jsonBody).toEqual({ age: 30 })
    expect(r.headers).toEqual({})
  })

  it("== wins over = at same position", () => {
    const r = parseShorthand(["q==1"])
    expect(r.query).toEqual({ q: "1" })
    expect(r.jsonBody).toEqual({})
  })

  it("allows = inside value when earlier delimiter wins", () => {
    const r = parseShorthand(["Auth:Bearer a=b"])
    expect(r.headers).toEqual({ Auth: "Bearer a=b" })
  })
})
