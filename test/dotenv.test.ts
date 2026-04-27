import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDotenv, readEnvKeys, loadEnvFile } from "../src/dotenv.js"

describe("parseDotenv — basic", () => {
  it("KEY=value", () => {
    expect(parseDotenv("FOO=bar")).toEqual({ FOO: "bar" })
  })

  it("multiple lines", () => {
    expect(parseDotenv("A=1\nB=2\nC=3")).toEqual({ A: "1", B: "2", C: "3" })
  })

  it("empty value KEY=", () => {
    expect(parseDotenv("FOO=")).toEqual({ FOO: "" })
  })

  it("empty file", () => {
    expect(parseDotenv("")).toEqual({})
  })

  it("only comments and blanks", () => {
    expect(parseDotenv("# a comment\n\n  # indented\n\n")).toEqual({})
  })

  it("trailing newline tolerated", () => {
    expect(parseDotenv("FOO=bar\n")).toEqual({ FOO: "bar" })
  })

  it("CRLF line endings", () => {
    expect(parseDotenv("A=1\r\nB=2")).toEqual({ A: "1", B: "2" })
  })

  it("whitespace around key/value", () => {
    expect(parseDotenv("  FOO   =   bar")).toEqual({ FOO: "bar" })
  })

  it("trailing whitespace stripped from bare values", () => {
    expect(parseDotenv("FOO=bar   ")).toEqual({ FOO: "bar" })
  })

  it("export prefix stripped", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" })
  })

  it("export prefix with tab", () => {
    expect(parseDotenv("export\tFOO=bar")).toEqual({ FOO: "bar" })
  })
})

describe("parseDotenv — comments", () => {
  it("full-line comments ignored", () => {
    expect(parseDotenv("# top\nFOO=bar\n# bottom")).toEqual({ FOO: "bar" })
  })

  it("inline comment in unquoted value", () => {
    expect(parseDotenv("FOO=bar # inline")).toEqual({ FOO: "bar" })
  })

  it("# inside double-quoted is literal", () => {
    expect(parseDotenv('FOO="hash # inside"')).toEqual({ FOO: "hash # inside" })
  })

  it("# inside single-quoted is literal", () => {
    expect(parseDotenv("FOO='hash # inside'")).toEqual({ FOO: "hash # inside" })
  })
})

describe("parseDotenv — quoting", () => {
  it("double-quoted with spaces", () => {
    expect(parseDotenv('FOO="bar baz"')).toEqual({ FOO: "bar baz" })
  })

  it("single-quoted with spaces", () => {
    expect(parseDotenv("FOO='bar baz'")).toEqual({ FOO: "bar baz" })
  })

  it("escape sequences in double-quoted", () => {
    expect(parseDotenv('FOO="a\\nb\\tc"')).toEqual({ FOO: "a\nb\tc" })
  })

  it("multiline double-quoted preserves newlines", () => {
    const input = `FOO="line1
line2
line3"`
    expect(parseDotenv(input)).toEqual({ FOO: "line1\nline2\nline3" })
  })

  it("multiline single-quoted preserves newlines", () => {
    const input = `FOO='line1
line2'`
    expect(parseDotenv(input)).toEqual({ FOO: "line1\nline2" })
  })

  it("RSA-key style multiline", () => {
    const input = `KEY="-----BEGIN-----
abc
def
-----END-----"`
    expect(parseDotenv(input).KEY).toContain("BEGIN")
    expect(parseDotenv(input).KEY).toContain("END")
    expect(parseDotenv(input).KEY).toContain("\n")
  })
})

describe("parseDotenv — interpolation", () => {
  it("${VAR} resolves to earlier key", () => {
    expect(parseDotenv("HOST=example.com\nURL=https://${HOST}/v1")).toEqual({
      HOST: "example.com",
      URL: "https://example.com/v1",
    })
  })

  it("${VAR} unresolved stays literal", () => {
    expect(parseDotenv("URL=${UNDEFINED}/path").URL).toBe("${UNDEFINED}/path")
  })

  it("\\$ escapes literal dollar", () => {
    expect(parseDotenv('FOO="\\${LITERAL}"').FOO).toBe("${LITERAL}")
  })

  it("bare $VAR is NOT interpolated", () => {
    expect(parseDotenv("FOO=$1 $@").FOO).toBe("$1 $@")
  })

  it("forward references not resolved", () => {
    // X defined after Y → ${X} in Y's value stays literal.
    expect(parseDotenv("Y=${X}\nX=actual")).toEqual({
      Y: "${X}",
      X: "actual",
    })
  })

  it("single-quoted disables interpolation", () => {
    expect(parseDotenv("HOST=example.com\nFOO='${HOST}'")).toEqual({
      HOST: "example.com",
      FOO: "${HOST}",
    })
  })

  it("interpolation in bare values", () => {
    expect(parseDotenv("A=1\nB=${A}+${A}").B).toBe("1+1")
  })

  it("interpolate: false disables substitution", () => {
    expect(parseDotenv("A=1\nB=${A}", { interpolate: false }).B).toBe("${A}")
  })
})

describe("parseDotenv — malformed input tolerated", () => {
  it("key without = is ignored", () => {
    expect(parseDotenv("LONELY\nFOO=bar")).toEqual({ FOO: "bar" })
  })

  it("garbage line ignored", () => {
    expect(parseDotenv("===\nFOO=bar")).toEqual({ FOO: "bar" })
  })

  it("unterminated double quote — best effort", () => {
    expect(parseDotenv('FOO="unclosed\nBAR=baz').FOO).toContain("unclosed")
  })
})

describe("readEnvKeys", () => {
  it("returns a Set of keys, ignoring values", () => {
    const keys = readEnvKeys("A=1\nB=2\n# comment\nC=")
    expect(keys.has("A")).toBe(true)
    expect(keys.has("B")).toBe(true)
    expect(keys.has("C")).toBe(true)
    expect(keys.size).toBe(3)
  })
})

describe("loadEnvFile", () => {
  it("missing file → {}", () => {
    expect(loadEnvFile("/nonexistent/.env")).toEqual({})
  })

  it("missing file with throwOnMissing → throws", () => {
    expect(() => loadEnvFile("/nonexistent/.env", { throwOnMissing: true })).toThrow(/not found/)
  })

  it("reads from disk and parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "jolly-dotenv-"))
    const path = join(dir, ".env")
    writeFileSync(path, "FOO=bar\nBAZ=${FOO}!", "utf8")
    const out = loadEnvFile(path)
    expect(out).toEqual({ FOO: "bar", BAZ: "bar!" })
  })
})
