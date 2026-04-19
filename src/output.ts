import { createWriteStream, type WriteStream } from "node:fs"
import type { Sample, SampleSink } from "./types.js"

export function createSampleSink(path?: string): SampleSink {
  if (!path) return nullSink
  const stream = createWriteStream(path, { flags: "a" })
  return new FileSink(stream)
}

export const nullSink: SampleSink = {
  write() {},
  async close() {},
}

class FileSink implements SampleSink {
  constructor(private stream: WriteStream) {}

  write(s: Sample): void {
    this.stream.write(JSON.stringify(s) + "\n")
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
}

function statusColor(status: number): string {
  if (status < 300) return ANSI.green
  if (status < 400) return ANSI.cyan
  if (status < 500) return ANSI.yellow
  return ANSI.red
}

/**
 * Format an HTTP Response for ad-hoc single-request mode. Status line +
 * headers + body (JSON pretty if content-type is JSON; raw otherwise).
 * ANSI colors only when stdout is a TTY.
 */
export async function formatResponse(res: Response, useColor: boolean): Promise<string> {
  const C = useColor ? ANSI : (Object.fromEntries(Object.keys(ANSI).map(k => [k, ""])) as typeof ANSI)
  const sc = useColor ? statusColor(res.status) : ""

  const statusLine = `${C.bold}HTTP/1.1 ${sc}${res.status}${C.reset}${C.bold} ${res.statusText || ""}${C.reset}`.trimEnd()

  const headerLines: string[] = []
  res.headers.forEach((value, name) => {
    headerLines.push(`${C.cyan}${name}${C.reset}: ${value}`)
  })

  const body = await formatBody(res)

  const parts = [statusLine, ...headerLines]
  if (body) parts.push("", body)
  return parts.join("\n")
}

async function formatBody(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? ""
  const text = await res.text().catch(() => "")
  if (!text) return ""
  if (ct.includes("application/json") || ct.includes("+json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  return text
}

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}
