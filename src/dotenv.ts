import { existsSync, readFileSync } from "node:fs"

/**
 * Minimal dotenv-dialect parser. Supports the subset that Twelve-Factor
 * projects actually use:
 *
 *   KEY=value                       — bare value
 *   KEY="value with spaces"         — double-quoted (interpolation enabled)
 *   KEY='no $interpolation'         — single-quoted (literal, no expansion)
 *   KEY=                            — empty value (treated as "" / unset)
 *   KEY=${OTHER}/path               — ${...} interpolation, only against
 *                                     keys defined earlier in same file
 *   export KEY=value                — bash compat; `export` prefix stripped
 *   # comment                       — full-line comment
 *   KEY=value # inline              — end-of-line comment (unquoted only)
 *
 * Multiline values are supported when wrapped in `"..."` or `'...'`.
 *
 * NOT supported (out of scope):
 *   - Bare $VAR interpolation (only ${...}); avoids eating $1, $@, etc.
 *   - Cross-file or process.env substitution; ${X} only resolves against
 *     keys parsed earlier IN THIS FILE.
 *   - Heredocs.
 *   - Shell command substitution `$(cmd)`.
 */

export interface ParseOptions {
  /** Resolve `${VAR}` against keys parsed earlier in the same file. Default true. */
  interpolate?: boolean
}

/**
 * Parse a .env file's contents into a flat record. Pure — no fs.
 * Lines that don't look like assignments (no `=`) are silently ignored,
 * matching dotenv conventions. Empty values are kept as "".
 */
export function parseDotenv(input: string, opts: ParseOptions = {}): Record<string, string> {
  const interpolate = opts.interpolate !== false
  const out: Record<string, string> = {}

  // Normalize CRLF to LF first; preserves multiline content correctness.
  const text = input.replace(/\r\n/g, "\n")
  let i = 0
  const N = text.length

  while (i < N) {
    // Skip leading whitespace on the line.
    while (i < N && (text[i] === " " || text[i] === "\t")) i++
    if (i >= N) break

    // Full-line comment or blank line → consume to next \n.
    if (text[i] === "#" || text[i] === "\n") {
      while (i < N && text[i] !== "\n") i++
      i++ // consume \n
      continue
    }

    // Optional `export ` prefix.
    if (text.startsWith("export ", i) || text.startsWith("export\t", i)) {
      i += 7
      while (i < N && (text[i] === " " || text[i] === "\t")) i++
    }

    // Read key — letters, digits, underscore. Stops at `=` or whitespace.
    const keyStart = i
    while (i < N && isKeyChar(text[i])) i++
    const key = text.slice(keyStart, i)
    if (!key) {
      // Garbage line; skip to end.
      while (i < N && text[i] !== "\n") i++
      i++
      continue
    }

    // Skip whitespace then expect `=`.
    while (i < N && (text[i] === " " || text[i] === "\t")) i++
    if (text[i] !== "=") {
      // Key with no `=` — skip line, dotenv ignores these.
      while (i < N && text[i] !== "\n") i++
      i++
      continue
    }
    i++ // consume `=`

    // Skip whitespace after `=` (but NOT newlines — empty values are valid).
    while (i < N && (text[i] === " " || text[i] === "\t")) i++

    // Read value.
    let value: string
    if (text[i] === '"') {
      // Double-quoted: multiline OK, escape sequences, ${...} interpolation.
      i++ // open quote
      const buf: string[] = []
      while (i < N && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < N) {
          const next = text[i + 1]
          if (next === "n") buf.push("\n")
          else if (next === "r") buf.push("\r")
          else if (next === "t") buf.push("\t")
          else if (next === '"') buf.push('"')
          else if (next === "\\") buf.push("\\")
          else if (next === "$") buf.push("$") // \$ → literal $
          else buf.push(next)
          i += 2
          continue
        }
        buf.push(text[i])
        i++
      }
      if (text[i] === '"') i++ // close quote
      value = buf.join("")
      if (interpolate) value = interpolateString(value, out)
      // Skip optional inline comment after closing quote.
      while (i < N && text[i] !== "\n") i++
    } else if (text[i] === "'") {
      // Single-quoted: literal, no interpolation, multiline OK.
      i++
      const start = i
      while (i < N && text[i] !== "'") i++
      value = text.slice(start, i)
      if (text[i] === "'") i++
      while (i < N && text[i] !== "\n") i++
    } else {
      // Bare value: until \n or unquoted `#` (inline comment).
      const start = i
      while (i < N && text[i] !== "\n" && text[i] !== "#") i++
      value = text.slice(start, i).replace(/[ \t]+$/, "")
      if (interpolate) value = interpolateString(value, out)
      while (i < N && text[i] !== "\n") i++
    }
    if (i < N && text[i] === "\n") i++ // consume \n

    out[key] = value
  }

  return out
}

/** Read `KEY=` keys from a .env-like file body, ignore values. For `--require-env`. */
export function readEnvKeys(input: string): Set<string> {
  const parsed = parseDotenv(input, { interpolate: false })
  return new Set(Object.keys(parsed))
}

/**
 * Load and parse a .env file from disk.
 * - throwOnMissing: if true and file does not exist, throws. Default false (return {}).
 */
export function loadEnvFile(
  path: string,
  opts: { throwOnMissing?: boolean } = {},
): Record<string, string> {
  if (!existsSync(path)) {
    if (opts.throwOnMissing) throw new Error(`env file not found: ${path}`)
    return {}
  }
  const text = readFileSync(path, "utf8")
  return parseDotenv(text)
}

function isKeyChar(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "_" ||
    c === "."
  )
}

/**
 * Resolve `${VAR}` references against the given context. Bare `$VAR` is left
 * as-is (deliberate — avoids eating `$1`, `$@`, currency strings). `\${VAR}`
 * is treated as a literal `${VAR}`.
 *
 * Unresolved keys remain as the literal `${KEY}` — no error, no warning.
 * Predictable behavior; users notice immediately when something is wrong.
 */
function interpolateString(value: string, ctx: Record<string, string>): string {
  // Walk the string; emit either literal chars or resolved ${...} refs.
  let out = ""
  let i = 0
  while (i < value.length) {
    if (value[i] === "\\" && value[i + 1] === "$") {
      out += "$"
      i += 2
      continue
    }
    if (value[i] === "$" && value[i + 1] === "{") {
      const end = value.indexOf("}", i + 2)
      if (end === -1) {
        out += value.slice(i)
        break
      }
      const ref = value.slice(i + 2, end)
      if (ref in ctx) {
        out += ctx[ref]
      } else {
        // Keep literal — predictable, easy to spot.
        out += "${" + ref + "}"
      }
      i = end + 1
      continue
    }
    out += value[i]
    i++
  }
  return out
}
