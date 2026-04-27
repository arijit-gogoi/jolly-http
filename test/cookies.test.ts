import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCookieJar,
  loadCookieJar,
  saveCookieJar,
  cookieJarPath,
  type CookieJar,
} from "../src/cookies.js"

function mkHeaders(setCookieValues: string[]): Headers {
  const h = new Headers()
  // append() handles multi-cookie correctly (Node 18+ getSetCookie support)
  for (const v of setCookieValues) h.append("set-cookie", v)
  return h
}

let jar: CookieJar
beforeEach(() => {
  jar = createCookieJar()
})

describe("cookie jar — set/get round-trip", () => {
  it("stores and retrieves a simple cookie", () => {
    jar.setFromResponse(new URL("https://api.example.com/login"), mkHeaders(["sid=abc123; Path=/"]))
    const header = jar.getHeaderFor(new URL("https://api.example.com/me"))
    expect(header).toBe("sid=abc123")
  })

  it("multiple cookies on same response", () => {
    jar.setFromResponse(
      new URL("https://x.test/"),
      mkHeaders(["a=1; Path=/", "b=2; Path=/"]),
    )
    const header = jar.getHeaderFor(new URL("https://x.test/page"))
    // Order: longest path first; ties — insertion order
    expect(header).toMatch(/^a=1; b=2$|^b=2; a=1$/)
    expect(header).toContain("a=1")
    expect(header).toContain("b=2")
  })

  it("upserts on same name+domain+path", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=v1; Path=/"]))
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=v2; Path=/"]))
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBe("sid=v2")
  })
})

describe("cookie jar — domain matching", () => {
  it("hostOnly: no Domain attribute → exact host only", () => {
    jar.setFromResponse(new URL("https://api.example.com/"), mkHeaders(["sid=x; Path=/"]))
    expect(jar.getHeaderFor(new URL("https://api.example.com/"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://other.example.com/"))).toBeUndefined()
  })

  it("Domain attribute: matches subdomains", () => {
    jar.setFromResponse(
      new URL("https://api.example.com/"),
      mkHeaders(["sid=x; Domain=example.com; Path=/"]),
    )
    expect(jar.getHeaderFor(new URL("https://api.example.com/"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://www.example.com/"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://example.com/"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://attacker.com/"))).toBeUndefined()
  })

  it("Domain leading dot is normalized", () => {
    jar.setFromResponse(
      new URL("https://x.test/"),
      mkHeaders(["sid=x; Domain=.x.test; Path=/"]),
    )
    expect(jar.getHeaderFor(new URL("https://api.x.test/"))).toBe("sid=x")
  })

  it("does not leak across different sites", () => {
    jar.setFromResponse(new URL("https://a.test/"), mkHeaders(["sid=A; Path=/"]))
    jar.setFromResponse(new URL("https://b.test/"), mkHeaders(["sid=B; Path=/"]))
    expect(jar.getHeaderFor(new URL("https://a.test/"))).toBe("sid=A")
    expect(jar.getHeaderFor(new URL("https://b.test/"))).toBe("sid=B")
  })
})

describe("cookie jar — path matching", () => {
  it("matches subpaths", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=x; Path=/api"]))
    expect(jar.getHeaderFor(new URL("https://x.test/api"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://x.test/api/users"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://x.test/other"))).toBeUndefined()
  })

  it("partial-prefix is not a match (security)", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=x; Path=/api"]))
    // /apicake should NOT match /api
    expect(jar.getHeaderFor(new URL("https://x.test/apicake"))).toBeUndefined()
  })

  it("default path = directory of request URL", () => {
    jar.setFromResponse(new URL("https://x.test/foo/bar"), mkHeaders(["sid=x"]))
    expect(jar.getHeaderFor(new URL("https://x.test/foo/baz"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("https://x.test/other"))).toBeUndefined()
  })
})

describe("cookie jar — secure", () => {
  it("Secure cookie not sent over http", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=x; Path=/; Secure"]))
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBe("sid=x")
    expect(jar.getHeaderFor(new URL("http://x.test/"))).toBeUndefined()
  })
})

describe("cookie jar — expiry", () => {
  it("Max-Age=0 effectively unsets a cookie on next request", async () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=x; Path=/"]))
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBe("sid=x")
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=x; Path=/; Max-Age=0"]))
    // Max-Age=0 → expires=now → already expired by the time we check
    await new Promise(r => setTimeout(r, 5))
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBeUndefined()
  })

  it("Expires in past is filtered", () => {
    jar.setFromResponse(
      new URL("https://x.test/"),
      mkHeaders(["sid=x; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT"]),
    )
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBeUndefined()
  })

  it("Expires in future is honored", () => {
    jar.setFromResponse(
      new URL("https://x.test/"),
      mkHeaders(["sid=x; Path=/; Expires=Wed, 01 Jan 2099 00:00:00 GMT"]),
    )
    expect(jar.getHeaderFor(new URL("https://x.test/"))).toBe("sid=x")
  })
})

describe("cookie jar — persistence", () => {
  it("save → load round-trip preserves cookies", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["sid=abc; Path=/"]))
    const dir = mkdtempSync(join(tmpdir(), "jolly-cookies-"))
    const path = cookieJarPath(dir, 0)
    saveCookieJar(jar, path)
    const reloaded = loadCookieJar(path)
    expect(reloaded.getHeaderFor(new URL("https://x.test/"))).toBe("sid=abc")
  })

  it("missing file → empty jar", () => {
    const j = loadCookieJar("/nonexistent/cookies.json")
    expect(j.getHeaderFor(new URL("https://x.test/"))).toBeUndefined()
  })

  it("expired cookies pruned on save", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["fresh=1; Path=/"]))
    jar.setFromResponse(
      new URL("https://x.test/"),
      mkHeaders(["stale=2; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT"]),
    )
    const dir = mkdtempSync(join(tmpdir(), "jolly-cookies-"))
    const path = cookieJarPath(dir, 0)
    saveCookieJar(jar, path)
    const reloaded = loadCookieJar(path)
    expect(reloaded.size()).toBe(1)
  })
})

describe("cookie jar — malformed Set-Cookie tolerated", () => {
  it("ignores entries without =", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["nope"]))
    expect(jar.size()).toBe(0)
  })

  it("ignores entries with empty name", () => {
    jar.setFromResponse(new URL("https://x.test/"), mkHeaders(["=value"]))
    expect(jar.size()).toBe(0)
  })
})
