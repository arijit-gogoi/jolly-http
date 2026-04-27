import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Minimal RFC 6265 cookie jar — parses Set-Cookie response headers, emits a
 * Cookie request header for outgoing requests against matching origins.
 *
 * Scope: enough for typical login/session flows. NOT a browser-grade jar:
 * - No public-suffix list (so `Domain=co.uk` would be accepted; we accept that).
 * - No same-site enforcement (workflow code is the trust boundary, not HTTP).
 * - No third-party cookie blocking.
 *
 * Persistence is a flat JSON array of {name, value, domain, path, expires?,
 * secure, httpOnly}. Loading a missing file is fine — we start empty.
 */

export interface StoredCookie {
  name: string
  value: string
  domain: string        // canonical lowercase, no leading dot
  path: string
  expires?: number      // epoch ms; undefined = session cookie
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean     // true when no Domain attribute was sent
}

export interface SerializedJar {
  version: 1
  cookies: StoredCookie[]
}

export interface CookieJar {
  setFromResponse(url: URL, headers: Headers): void
  getHeaderFor(url: URL): string | undefined
  toJSON(): SerializedJar
  size(): number
}

class InMemoryJar implements CookieJar {
  private cookies: StoredCookie[] = []

  static fromJSON(s: SerializedJar): InMemoryJar {
    const j = new InMemoryJar()
    if (s && Array.isArray(s.cookies)) j.cookies = s.cookies.filter(notExpired)
    return j
  }

  size(): number {
    return this.cookies.length
  }

  toJSON(): SerializedJar {
    return { version: 1, cookies: this.cookies.filter(notExpired) }
  }

  setFromResponse(url: URL, headers: Headers): void {
    // Headers.getSetCookie() returns string[]; preserves comma-bearing values.
    const raw = typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : splitSetCookieFallback(headers.get("set-cookie"))
    for (const line of raw) {
      const parsed = parseSetCookie(line, url)
      if (parsed) this.upsert(parsed)
    }
  }

  getHeaderFor(url: URL): string | undefined {
    const matches: StoredCookie[] = []
    for (const c of this.cookies) {
      if (!notExpired(c)) continue
      if (!domainMatches(url.hostname, c.domain, c.hostOnly)) continue
      if (!pathMatches(url.pathname, c.path)) continue
      if (c.secure && url.protocol !== "https:") continue
      matches.push(c)
    }
    if (matches.length === 0) return undefined
    // Longest path first (RFC 6265 §5.4.2)
    matches.sort((a, b) => b.path.length - a.path.length)
    return matches.map(c => `${c.name}=${c.value}`).join("; ")
  }

  private upsert(c: StoredCookie): void {
    const idx = this.cookies.findIndex(
      x => x.name === c.name && x.domain === c.domain && x.path === c.path,
    )
    if (idx >= 0) this.cookies[idx] = c
    else this.cookies.push(c)
  }
}

export function createCookieJar(): CookieJar {
  return new InMemoryJar()
}

export function loadCookieJar(path: string): CookieJar {
  if (!existsSync(path)) return createCookieJar()
  try {
    const raw = readFileSync(path, "utf8")
    const obj = JSON.parse(raw) as SerializedJar
    return InMemoryJar.fromJSON(obj)
  } catch {
    // Corrupt file → start fresh rather than crash. User can `rm` it.
    return createCookieJar()
  }
}

export function saveCookieJar(jar: CookieJar, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(jar.toJSON(), null, 2), "utf8")
}

export function cookieJarPath(dir: string, vuId: number): string {
  return join(dir, `vu-${vuId}.json`)
}

function notExpired(c: StoredCookie): boolean {
  return c.expires === undefined || c.expires > Date.now()
}

/** RFC 6265 §5.1.3 domain matching. */
function domainMatches(host: string, cookieDomain: string, hostOnly: boolean): boolean {
  const h = host.toLowerCase()
  const d = cookieDomain.toLowerCase()
  if (hostOnly) return h === d
  if (h === d) return true
  return h.endsWith("." + d) && !isIp(h)
}

/** RFC 6265 §5.1.4 path matching. */
function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true
  if (!reqPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith("/")) return true
  return reqPath.charAt(cookiePath.length) === "/"
}

function isIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")
}

/** RFC 6265 §5.2 Set-Cookie parser. Returns null on syntactically broken input. */
function parseSetCookie(raw: string, url: URL): StoredCookie | null {
  const semi = raw.indexOf(";")
  const nv = (semi === -1 ? raw : raw.slice(0, semi)).trim()
  const eq = nv.indexOf("=")
  if (eq <= 0) return null
  const name = nv.slice(0, eq).trim()
  const value = nv.slice(eq + 1).trim()
  if (!name) return null

  let domain: string | undefined
  let path: string | undefined
  let expires: number | undefined
  let secure = false
  let httpOnly = false

  if (semi !== -1) {
    const attrs = raw.slice(semi + 1).split(";")
    for (const a of attrs) {
      const i = a.indexOf("=")
      const key = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase()
      const v = (i === -1 ? "" : a.slice(i + 1)).trim()
      if (key === "domain" && v) {
        domain = v.startsWith(".") ? v.slice(1) : v
      } else if (key === "path" && v.startsWith("/")) {
        path = v
      } else if (key === "expires" && v) {
        const t = Date.parse(v)
        if (!Number.isNaN(t)) expires = t
      } else if (key === "max-age" && v) {
        const sec = parseInt(v, 10)
        if (!Number.isNaN(sec)) expires = Date.now() + sec * 1000
      } else if (key === "secure") {
        secure = true
      } else if (key === "httponly") {
        httpOnly = true
      }
    }
  }

  const hostOnly = domain === undefined
  const finalDomain = (domain ?? url.hostname).toLowerCase()
  const finalPath = path ?? defaultPath(url.pathname)
  return { name, value, domain: finalDomain, path: finalPath, expires, secure, httpOnly, hostOnly }
}

/** RFC 6265 §5.1.4 default path: directory of request URL. */
function defaultPath(reqPath: string): string {
  if (!reqPath || !reqPath.startsWith("/")) return "/"
  const last = reqPath.lastIndexOf("/")
  if (last <= 0) return "/"
  return reqPath.slice(0, last)
}

/** Fallback for runtimes that don't expose Headers.getSetCookie(). */
function splitSetCookieFallback(raw: string | null): string[] {
  if (!raw) return []
  // Best-effort split: Node concatenates with ", " but cookie expiry contains ", "
  // too. Heuristic: split on /,\s+(?=[A-Za-z0-9_-]+=)/ — comma followed by name=.
  return raw.split(/,\s+(?=[A-Za-z0-9_-]+=)/)
}
