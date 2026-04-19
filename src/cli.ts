#!/usr/bin/env node
import { isStructuralCancellation } from "jolly-coop"
import { VERSION } from "./index.js"
import { runWorkflow } from "./run.js"
import { runAdhoc } from "./adhoc.js"
import { runLoad, type LoadResult } from "./load.js"
import { formatMs } from "./time.js"
import { parseCli, CliError, USAGE, type CliArgs } from "./cli-args.js"
import type { AdhocOptions, LoadOptions, RunOptions } from "./types.js"

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs
  try {
    args = parseCli(argv)
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`)
      return err.exitCode
    }
    throw err
  }

  if (args.mode === "help") {
    process.stdout.write(`jolly-http ${VERSION}\n`)
    process.stdout.write(USAGE)
    return 0
  }
  if (args.mode === "version") {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const ac = new AbortController()
  let interrupts = 0
  const onSig = () => {
    interrupts++
    if (interrupts === 1) {
      ac.abort(new Error("SIGINT"))
      process.stderr.write("\ninterrupted — finishing in-flight work (Ctrl-C again to force)\n")
    } else {
      process.exit(130)
    }
  }
  process.on("SIGINT", onSig)

  try {
    if (args.mode === "adhoc") {
      const opts: AdhocOptions = {
        method: args.method!,
        url: args.url!,
        shorthand: args.shorthand,
        headers: args.headers,
        jsonBody: args.json,
        formMode: args.form,
        perRequestTimeoutMs: args.timeoutMs,
        userAgent: args.userAgent,
        insecure: args.insecure,
        quiet: args.quiet,
        outPath: args.outPath,
        signal: ac.signal,
      }
      const result = await runAdhoc(opts)
      return result.ok ? 0 : 1
    }

    if (args.mode === "run") {
      const workflowPath = args.workflow!
      const isLoad = args.concurrency !== undefined && args.durationMs !== undefined
      if (isLoad) {
        const opts: LoadOptions = {
          workflowPath,
          env: args.env,
          outPath: args.outPath,
          perRequestTimeoutMs: args.timeoutMs,
          userAgent: args.userAgent,
          insecure: args.insecure,
          quiet: args.quiet,
          signal: ac.signal,
          concurrency: args.concurrency!,
          durationMs: args.durationMs!,
          rps: args.rps,
          warmupMs: args.warmupMs,
        }
        const load = await runLoad(opts)
        if (!args.quiet) printLoadSummary(load)
        return load.endedBy === "error" ? 1 : 0
      }

      const opts: RunOptions = {
        workflowPath,
        env: args.env,
        outPath: args.outPath,
        perRequestTimeoutMs: args.timeoutMs,
        userAgent: args.userAgent,
        insecure: args.insecure,
        quiet: args.quiet,
        signal: ac.signal,
      }
      const result = await runWorkflow(opts)
      if (!result.ok) {
        const err = result.error as { name?: string; message?: string }
        process.stderr.write(`${err?.name ?? "Error"}: ${err?.message ?? String(err)}\n`)
        return 1
      }
      if (!args.quiet && result.value !== undefined) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + "\n")
      }
      return 0
    }
    return 2
  } catch (err) {
    if (isStructuralCancellation(err) || ac.signal.aborted) return 130
    const e = err as { message?: string }
    process.stderr.write(`error: ${e?.message ?? String(err)}\n`)
    return 1
  } finally {
    process.off("SIGINT", onSig)
  }
}

function printLoadSummary(load: LoadResult): void {
  const s = load.snapshot
  const lines = [
    "",
    `───── summary ─────`,
    `  ended:       ${load.endedBy}`,
    `  duration:    ${formatMs(s.elapsedMs)}`,
    `  concurrency: ${load.concurrency}`,
    `  iterations:  ${s.total} (${s.success} ok, ${s.errors} errors)`,
    `  requests:    ${load.samples}`,
    `  throughput:  ${load.achievedRps.toFixed(1)} iter/s`,
    `  latency:     avg ${formatMs(s.latency.avg)}  p50 ${formatMs(s.latency.p50)}  p95 ${formatMs(s.latency.p95)}  p99 ${formatMs(s.latency.p99)}  max ${formatMs(s.latency.max)}`,
  ]
  if (Object.keys(s.byStatus).length > 0) {
    lines.push(`  statuses:    ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  }
  if (Object.keys(s.byError).length > 0) {
    lines.push(`  errors:      ${Object.entries(s.byError).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  }
  process.stdout.write(lines.join("\n") + "\n")
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
})
