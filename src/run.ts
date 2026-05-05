import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { scope, isStructuralCancellation } from "jolly-coop"
import { buildEnv, withRuntime, type RuntimeContext } from "./runtime.js"
import { createSampleSink } from "./output.js"
import { createCookieJar, loadCookieJar, saveCookieJar, cookieJarPath } from "./cookies.js"
import { createHarRecorder, saveHar, harPath, loadHarReplay } from "./har.js"
import { loadEnvFile, readEnvKeys } from "./dotenv.js"
import type { AfterFn, BeforeFn, HookFn, RunOptions, RunResult, WorkflowFn } from "./types.js"

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

/**
 * Workflow module shape — default export plus optional named hooks.
 *
 * Two tiers of hooks:
 *  - Process-level: `prologue` / `epilogue` run once around the entire run.
 *  - Per-iteration (v0.5+): `before` / `after` run for every iteration.
 *
 * `epilogue` and `after` are guaranteed to run even when their respective
 * setup phase threw (via scope.resource registered before the setup phase
 * is invoked).
 */
export interface LoadedWorkflow {
  default: WorkflowFn
  prologue?: HookFn
  epilogue?: HookFn
  before?: BeforeFn
  after?: AfterFn
}

export async function loadWorkflow(path: string): Promise<WorkflowFn> {
  const w = await loadWorkflowModule(path)
  return w.default
}

export async function loadWorkflowModule(path: string): Promise<LoadedWorkflow> {
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
  // Default takes (vu, signal, ctx?) — third arg is the per-iteration ctx
  // object (v0.5+). Anything beyond 3 is suspicious.
  if ((fn as Function).length > 3) {
    process.stderr.write(
      `warn: workflow ${path}: default export takes ${(fn as Function).length} args (expected: vu, signal, ctx?)\n`,
    )
  }
  const prologue = mod.prologue
  const epilogue = mod.epilogue
  const before = mod.before
  const after = mod.after
  if (prologue !== undefined && typeof prologue !== "function") {
    throw new Error(`workflow ${path}: prologue must be a function, got ${typeof prologue}`)
  }
  if (epilogue !== undefined && typeof epilogue !== "function") {
    throw new Error(`workflow ${path}: epilogue must be a function, got ${typeof epilogue}`)
  }
  if (before !== undefined && typeof before !== "function") {
    throw new Error(`workflow ${path}: before must be a function, got ${typeof before}`)
  }
  if (after !== undefined && typeof after !== "function") {
    throw new Error(`workflow ${path}: after must be a function, got ${typeof after}`)
  }
  return {
    default: fn as WorkflowFn,
    prologue: prologue as HookFn | undefined,
    epilogue: epilogue as HookFn | undefined,
    before: before as BeforeFn | undefined,
    after: after as AfterFn | undefined,
  }
}

/**
 * Run a workflow file once (single VU, single iteration). Assertion failures
 * and any thrown error propagate out as rejection. Samples flush via the
 * registered sink resource even on abort/failure.
 */
export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  let mod: LoadedWorkflow
  try {
    mod = await loadWorkflowModule(opts.workflowPath)
  } catch (err) {
    return { ok: false, error: err, samples: 0 }
  }
  return runWorkflowFn(mod.default, opts, {
    prologue: mod.prologue,
    epilogue: mod.epilogue,
    before: mod.before,
    after: mod.after,
  })
}

export interface WorkflowHooks {
  prologue?: HookFn
  epilogue?: HookFn
  before?: BeforeFn
  after?: AfterFn
}

export async function runWorkflowFn(
  fn: WorkflowFn,
  opts: RunOptions,
  hooks: WorkflowHooks = {},
): Promise<RunResult> {
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
      ? await s.resource(createHarRecorder("0.5.0"), r => {
          saveHar(r, harPath(opts.harDir!, 0))
        })
      : undefined
    const harReplay = opts.harReplayPath ? loadHarReplay(opts.harReplayPath, 0) : undefined
    const tZero = performance.now()
    const userAgent = opts.userAgent ?? `jolly-http/${(await getVersion())}`
    const baseDefaults = {
      userAgent,
      perRequestTimeoutMs: opts.perRequestTimeoutMs,
      insecure: opts.insecure,
    }

    // Build a phase-tagged context. Each phase (prologue, before, iteration,
    // after, epilogue) gets its own context instance — separate lastResponse,
    // separate phase tag stamped onto samples. The iteration phase OMITS the
    // phase tag (per SPEC §4 — additive optional field, samples without it
    // default to "iteration"). Other phases stamp the tag explicitly.
    //
    // Cookie jar SHARED across phases within the same run: a login in
    // prologue/before is visible to default; after can issue authenticated
    // DELETE. lastResponse is per-context (a failed assert in `after` doesn't
    // surface a request `before` made — unique scratch slot per phase ctx).
    //
    // vu.iteration sentinels: -1 prologue, -2 epilogue (process-level).
    // before/after carry the REAL iteration index; the phase tag is the
    // discriminator for those.
    const mkCtx = (
      phase: "prologue" | "iteration" | "epilogue" | "before" | "after",
      iteration: number,
      sig: AbortSignal = s.signal,
    ): RuntimeContext => ({
      vu: { id: 0, iteration, env },
      sink: wrappedSink,
      signal: sig,
      tZero,
      defaults: baseDefaults,
      cookieJar,
      harRecorder,
      harReplay,
      ...(phase === "iteration" ? {} : { phase }),
    })

    // Register epilogue as a scope resource BEFORE invoking prologue. This is
    // the discriminating decision: if prologue throws, the scope unwinds and
    // resources release in LIFO order. Because epilogue is registered AFTER
    // sink/jar, it releases FIRST — sink and jar are still alive while
    // epilogue runs (so it can emit samples and read/write cookies). And
    // because it's registered *before* prologue runs, it fires whether
    // prologue succeeded, threw, or was aborted.
    if (hooks.epilogue) {
      const epi = hooks.epilogue
      await s.resource(true, async () => {
        try {
          await withRuntime(mkCtx("epilogue", -2), async () => epi(env, s.signal))
        } catch (err) {
          // Epilogue failures are surfaced to stderr but don't override the
          // original error (if any). The scope's existing error wins.
          process.stderr.write(
            `epilogue threw: ${(err as Error)?.message ?? String(err)}\n`,
          )
        }
      })
    }

    if (hooks.prologue) {
      const pro = hooks.prologue
      await withRuntime(mkCtx("prologue", -1), async () => pro(env, s.signal))
    }

    // Per-iteration scope. Nested below the run scope so before/after wrap
    // the default function symmetrically with prologue/epilogue at the outer
    // level. Single-run mode runs ONE iteration (iteration index 0); load
    // mode does the same wiring per VU per iteration in load.ts.
    //
    // `after` is registered as a resource on the iteration scope BEFORE
    // `before` runs — same LIFO trick as epilogue. If before throws, the
    // iteration scope unwinds, the resource fires, and after still runs.
    // The userCtx ref captures the live value `before` returned (closure),
    // so even when default throws mid-iteration, after sees the populated ctx.
    return scope({ signal: s.signal }, async iterScope => {
      const iterCtx = mkCtx("iteration", 0, iterScope.signal)
      let userCtx: unknown = {}

      if (hooks.after) {
        const aft = hooks.after
        await iterScope.resource(true, async () => {
          try {
            await withRuntime(mkCtx("after", 0, iterScope.signal), async () =>
              aft(iterCtx.vu, iterScope.signal, userCtx),
            )
          } catch (err) {
            if (isStructuralCancellation(err) || s.signal.aborted) return
            process.stderr.write(
              `after threw: ${(err as Error)?.message ?? String(err)}\n`,
            )
          }
        })
      }

      if (hooks.before) {
        const bef = hooks.before
        const ret = await withRuntime(mkCtx("before", 0, iterScope.signal), async () =>
          bef(iterCtx.vu, iterScope.signal),
        )
        if (ret !== undefined) userCtx = ret
      }

      return withRuntime(iterCtx, async () => fn(iterCtx.vu, iterScope.signal, userCtx))
    })
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
