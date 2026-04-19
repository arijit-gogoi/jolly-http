import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { scope, isStructuralCancellation } from "jolly-coop"
import { buildEnv, withRuntime, type RuntimeContext } from "./runtime.js"
import { createSampleSink } from "./output.js"
import type { RunOptions, RunResult, WorkflowFn } from "./types.js"

export async function loadWorkflow(path: string): Promise<WorkflowFn> {
  const abs = resolve(path)
  const url = pathToFileURL(abs).href
  let mod: Record<string, unknown>
  try {
    mod = await import(url)
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    throw new Error(`failed to import workflow ${path}: ${msg}`)
  }
  const fn = mod.default
  if (typeof fn !== "function") {
    throw new Error(`workflow ${path}: default export must be a function, got ${typeof fn}`)
  }
  if (fn.length > 2) {
    process.stderr.write(
      `warn: workflow ${path}: default export takes ${fn.length} args (expected: vu, signal)\n`,
    )
  }
  return fn as WorkflowFn
}

/**
 * Run a workflow file once (single VU, single iteration). Assertion failures
 * and any thrown error propagate out as rejection. Samples flush via the
 * registered sink resource even on abort/failure.
 */
export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const fn = await loadWorkflow(opts.workflowPath)
  return runWorkflowFn(fn, opts)
}

export async function runWorkflowFn(fn: WorkflowFn, opts: RunOptions): Promise<RunResult> {
  const env = buildEnv(opts.env)
  let samples = 0

  const result = await scope({ signal: opts.signal }, async s => {
    const sink = await s.resource(createSampleSink(opts.outPath), sk => sk.close())
    const wrappedSink = {
      write: (sample: Parameters<typeof sink.write>[0]) => {
        samples++
        sink.write(sample)
      },
      close: () => sink.close(),
    }
    const ctx: RuntimeContext = {
      vu: { id: 0, iteration: 0, env },
      sink: wrappedSink,
      signal: s.signal,
      tZero: performance.now(),
      defaults: {
        userAgent: opts.userAgent ?? `jolly-http/${(await getVersion())}`,
        perRequestTimeoutMs: opts.perRequestTimeoutMs,
        insecure: opts.insecure,
      },
    }
    return withRuntime(ctx, async () => fn(ctx.vu, s.signal))
  }).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )

  if (result.ok) {
    return { ok: true, value: result.value, samples }
  }
  if (isStructuralCancellation(result.error)) {
    throw result.error
  }
  return { ok: false, error: result.error, samples }
}

async function getVersion(): Promise<string> {
  const { VERSION } = await import("./index.js")
  return VERSION
}
