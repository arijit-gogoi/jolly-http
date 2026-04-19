export interface ParsedShorthand {
  headers: Record<string, string>
  query: Record<string, string>
  jsonBody: Record<string, unknown>
  formBody: Record<string, string>
  files: Record<string, string>
  hasJson: boolean
  hasForm: boolean
}

type Kind = "header" | "query" | "jsonRaw" | "file" | "string"

interface Delim {
  kind: Kind
  key: string
  value: string
}

/**
 * Parse httpie-style body shorthand.
 *
 * Delimiters (two-char checked before one-char at each position so `:=`
 * doesn't get swallowed by `:` and `==` doesn't get swallowed by `=`):
 *   Header:value   → header
 *   key==value     → query parameter
 *   key:=value     → JSON-literal body field
 *   key@path       → file upload (form field)
 *   key=value      → string body field (JSON by default)
 *
 * Missing key → throws. Later duplicates overwrite.
 */
export function parseShorthand(args: string[]): ParsedShorthand {
  const out: ParsedShorthand = {
    headers: {},
    query: {},
    jsonBody: {},
    formBody: {},
    files: {},
    hasJson: false,
    hasForm: false,
  }

  for (const raw of args) {
    if (!raw) throw new Error("empty shorthand token")
    const delim = findDelimiter(raw)
    if (!delim) throw new Error(`not a shorthand token: ${raw}`)
    if (!delim.key) throw new Error(`missing key in shorthand: ${raw}`)
    apply(out, delim, raw)
  }
  return out
}

function apply(out: ParsedShorthand, d: Delim, raw: string): void {
  switch (d.kind) {
    case "header":
      out.headers[d.key] = d.value
      return
    case "query":
      out.query[d.key] = d.value
      return
    case "jsonRaw": {
      let parsed: unknown
      try {
        parsed = JSON.parse(d.value)
      } catch (err) {
        throw new Error(`invalid JSON in ${raw}: ${(err as Error).message}`)
      }
      out.jsonBody[d.key] = parsed
      out.hasJson = true
      return
    }
    case "file":
      out.files[d.key] = d.value
      out.hasForm = true
      return
    case "string":
      out.jsonBody[d.key] = d.value
      out.formBody[d.key] = d.value
      out.hasJson = true
      return
  }
}

/**
 * Walk the string one character at a time, checking for a 2-char delimiter
 * before a 1-char delimiter so `:=` beats `:`, `==` beats `=`.
 * The first matching position wins (left-most). Returns null if no delimiter.
 */
function findDelimiter(raw: string): Delim | null {
  for (let i = 0; i < raw.length; i++) {
    const two = raw.slice(i, i + 2)
    if (two === ":=") return { kind: "jsonRaw", key: raw.slice(0, i), value: raw.slice(i + 2) }
    if (two === "==") return { kind: "query", key: raw.slice(0, i), value: raw.slice(i + 2) }
    const one = raw[i]
    if (one === "=") return { kind: "string", key: raw.slice(0, i), value: raw.slice(i + 1) }
    if (one === ":") return { kind: "header", key: raw.slice(0, i), value: raw.slice(i + 1) }
    if (one === "@") return { kind: "file", key: raw.slice(0, i), value: raw.slice(i + 1) }
  }
  return null
}
