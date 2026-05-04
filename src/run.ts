import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { scope, isStructuralCancellation } from "jolly-coop"
import { buildEnv, withRuntime, type RuntimeContext } from "./runtime.js"
import { createSampleSink } from "./output.js"
import { createCookieJar, loadCookieJar, saveCookieJar, cookieJarPath } from "./cookies.js"
import { createHarRecorder, saveHar, harPath, loadHarReplay } from "./har.js"
import { loadEnvFile, readEnvKeys } from "./dotenv.js"
import type { RunOptions, RunResult, WorkflowFn } from "./types.js"

/**
 * Resolve env file paths into a list of parsed `.env` records, in order
 * (earlier loses to later when merged by buildEnv).
 *
 * Behavior:
 *  - If `envFiles` is set, use it (do NOT auto-load ./.env — explicit wins).
 *    Any explicit file that doesn't exist throws.
 *  - Else, if `noEnvFile` is false (default), try ./.env. Missing → silent.
 *  - Else, no layers.
 */
export function resolveEnvLayers(opts: {
  envFiles?: string[]
  noEnvFile?: boolean
}): Record<string, string>[] {
  if (opts.envFiles && opts.envFiles.length > 0) {
    return opts.envFiles.map(p => loadEnvFile(p, { throwOnMissing: true }))
  }
  if (opts.noEnvFile) return []
  const auto = resolve(process.cwd(), ".env")
  if (existsSync(auto)) return [loadEnvFile(auto)]
  return []
}

/**
 * After env layers are merged, validate every key in `requireEnvPath` is set
 * to a non-empty string. Fails fast with all missing keys at once (not first-fail).
 */
export function validateRequiredEnv(
  merged: Readonly<Record<string, string>>,
  requireEnvPath: string,
): void {
  if (!existsSync(requireEnvPath)) {
    throw new Error(`--require-env file not found: ${requireEnvPath}`)
  }
  const keys = readEnvKeys(readFileSync(requireEnvPath, "utf8"))
  const missing: string[] = []
  for (const k of keys) {
    if (merged[k] === undefined || merged[k] === "") missing.push(k)
  }
  if (missing.length > 0) {
    const list = missing.map(k => `  - ${k}`).join("\n")
    throw new Error(
      `missing required env vars from ${requireEnvPath}:\n${list}\nset them in .env, export them, or pass --env KEY=VAL`,
    )
  }
}

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
  let layers: Record<string, string>[]
  try {
    layers = resolveEnvLayers(opts)
  } catch (err) {
    return { ok: false, error: err, samples: 0 }
  }
  const env = buildEnv(layers, opts.env)
  if (opts.requireEnvPath) {
    try {
      validateRequiredEnv(env, opts.requireEnvPath)
    } catch (err) {
      return { ok: false, error: err, samples: 0 }
    }
  }
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
    // Single-run uses vu-0.* — same naming as load for tooling consistency.
    // The jar is always present so cookies flow within a workflow run
    // (login → me-call works without any flag). v0.4 default semantics:
    //   --cookies <dir>        : start fresh, save on exit (audit trail)
    //   --cookies-resume <dir> : load from disk, save on exit (continuity)
    //   neither                : in-memory only, discarded on exit
    // Persistent jars register a scope resource so save fires on cancel/abort/done.
    const persistDir = opts.cookiesDir ?? opts.cookiesResumeDir
    const cookieJar = persistDir
      ? await s.resource(
          opts.cookiesResumeDir
            ? loadCookieJar(cookieJarPath(opts.cookiesResumeDir, 0))
            : createCookieJar(),
          j => {
            saveCookieJar(j, cookieJarPath(persistDir, 0))
          },
        )
      : createCookieJar()
    const harRecorder = opts.harDir
      ? await s.resource(createHarRecorder("0.3.1"), r => {
          saveHar(r, harPath(opts.harDir!, 0))
        })
      : undefined
    const harReplay = opts.harReplayPath ? loadHarReplay(opts.harReplayPath, 0) : undefined
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
      cookieJar,
      harRecorder,
      harReplay,
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
