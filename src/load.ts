import { scope, sleep, yieldNow, isStructuralCancellation } from "jolly-coop"
import { buildEnv, withRuntime, type RuntimeContext } from "./runtime.js"
import { createSampleSink } from "./output.js"
import { loadWorkflowModule, resolveEnvLayers, validateRequiredEnv } from "./run.js"
import { createCookieJar, loadCookieJar, saveCookieJar, cookieJarPath, type CookieJar } from "./cookies.js"
import { createHarRecorder, saveHar, harPath, loadHarReplay, type HarRecorder, type HarReplayer } from "./har.js"
import type { AfterFn, BeforeFn, LoadOptions, Sample, SampleSink, VuContext, WorkflowFn } from "./types.js"

/**
 * Summary stats computed across all per-request samples observed during the
 * load run. Shape is stable (consumed by cli.ts printLoadSummary).
 */
export interface StatsSnapshot {
  total: number
  success: number
  errors: number
  elapsedMs: number
  latency: { avg: number; p50: number; p95: number; p99: number; max: number; min: number }
  byStatus: Record<number, number>
  byError: Record<string, number>
  throughput: number
}

export type EndedBy = "drained" | "abort" | "error"

export interface LoadResult {
  endedBy: EndedBy
  snapshot: StatsSnapshot
  concurrency: number
  durationMs: number
  targetRps?: number
  achievedRps: number
  samples: number
  failure?: unknown
}

/**
 * Run a workflow under load. Single scope-tree owns deadline, sample sink,
 * progress printer, and the VU pool. Per-iteration errors are caught inside
 * the VU loop (error-as-value at the scenario boundary) so individual failures
 * don't cancel siblings — that's the load-tester contract.
 *
 * Per-request samples (one per `request.GET/POST/...`) are written via the
 * runtime's sink. VU-scenario outcomes (one per iteration) feed `Stats` for
 * the summary but are NOT written to the NDJSON sink — NDJSON stays
 * per-request per PLAN §4.
 */
export async function runLoad(opts: LoadOptions): Promise<LoadResult> {
  const mod = await loadWorkflowModule(opts.workflowPath)
  const fn = mod.default
  const layers = resolveEnvLayers(opts)
  const env = buildEnv(layers, opts.env)
  if (opts.requireEnvPath) validateRequiredEnv(env, opts.requireEnvPath)

  const stats = new Stats(opts.warmupMs ?? 0)
  const tZero = performance.now()
  const deadline = Date.now() + opts.durationMs
  const completed = { n: 0 }
  const rateLimiter = opts.rps !== undefined ? new RateLimiter(opts.rps) : undefined
  const userAgent = opts.userAgent ?? `jolly-http/0.5.0`

  let endedBy: EndedBy = "drained"
  let failure: unknown
  let samples = 0

  const outerSink = createSampleSink(opts.outPath)
  const sink: SampleSink = {
    write(s) {
      samples++
      outerSink.write(s)
    },
    close: () => outerSink.close(),
  }

  try {
    await scope({ deadline, signal: opts.signal }, async root => {
      await root.resource(sink, s => s.close())

      // Prologue / epilogue run once per process on the root scope. Each gets
      // its own synthetic single-VU runtime context with a fresh in-memory jar
      // (no per-VU jar sharing — hooks are about side-channel cleanup, not
      // session state shared with iterations). Epilogue is registered as a
      // resource BEFORE prologue runs so it fires even when prologue throws.
      const baseDefaults = {
        userAgent,
        perRequestTimeoutMs: opts.perRequestTimeoutMs,
        insecure: opts.insecure,
      }
      const mkHookCtx = (phase: "prologue" | "epilogue", iteration: number): RuntimeContext => {
        // Lazy-import here would create cycles — we already imported
        // createCookieJar above for VU jars. Fresh jar per hook.
        return {
          vu: { id: 0, iteration, env },
          sink,
          signal: root.signal,
          tZero,
          defaults: baseDefaults,
          cookieJar: createCookieJar(),
          phase,
        }
      }

      if (mod.epilogue) {
        const epi = mod.epilogue
        await root.resource(true, async () => {
          try {
            await withRuntime(mkHookCtx("epilogue", -2), async () => epi(env, root.signal))
          } catch (err) {
            process.stderr.write(
              `epilogue threw: ${(err as Error)?.message ?? String(err)}\n`,
            )
          }
        })
      }

      if (mod.prologue) {
        const pro = mod.prologue
        await withRuntime(mkHookCtx("prologue", -1), async () => pro(env, root.signal))
      }

      if (!opts.quiet) {
        root.spawn(() => runProgress(stats, root.signal, opts.durationMs))
      }

      await scope({ limit: opts.concurrency, signal: root.signal }, async pool => {
        for (let i = 0; i < opts.concurrency; i++) {
          // Per-VU resources: cookie jar + HAR recorder.
          // Jar is always present so each VU's session survives across
          // iterations within the run. v0.4 default semantics:
          //   --cookies <dir>        : start fresh, save on exit
          //   --cookies-resume <dir> : load from disk, save on exit
          //   neither                : in-memory only
          const persistDir = opts.cookiesDir ?? opts.cookiesResumeDir
          const cookieJar = persistDir
            ? await pool.resource(
                opts.cookiesResumeDir
                  ? loadCookieJar(cookieJarPath(opts.cookiesResumeDir, i))
                  : createCookieJar(),
                j => {
                  saveCookieJar(j, cookieJarPath(persistDir, i))
                },
              )
            : createCookieJar()
          const harRecorder = opts.harDir
            ? await pool.resource(createHarRecorder("0.5.0"), r => {
                saveHar(r, harPath(opts.harDir!, i))
              })
            : undefined
          // Replayer per VU. If path is a file (.har), loadHarReplay caches
          // and returns the same instance for every VU — shared in load mode.
          const harReplay = opts.harReplayPath
            ? loadHarReplay(opts.harReplayPath, i)
            : undefined
          pool.spawn(() =>
            runVu({
              vuId: i,
              fn,
              before: mod.before,
              after: mod.after,
              env,
              sink,
              signal: pool.signal,
              tZero,
              rateLimiter,
              completed,
              defaults: {
                userAgent,
                perRequestTimeoutMs: opts.perRequestTimeoutMs,
                insecure: opts.insecure,
              },
              cookieJar,
              harRecorder,
              harReplay,
              onOutcome: s => stats.push(s),
            }),
          )
        }
      })
      root.done()
    })
  } catch (err) {
    if (isStructuralCancellation(err)) endedBy = "drained"
    else if (opts.signal?.aborted) endedBy = "abort"
    else {
      endedBy = "error"
      failure = err
    }
  }

  if (opts.signal?.aborted && endedBy !== "error") endedBy = "abort"

  const snapshot = stats.snapshot()
  const achievedRps = snapshot.elapsedMs > 0 ? (snapshot.total / snapshot.elapsedMs) * 1_000 : 0

  return {
    endedBy,
    snapshot,
    concurrency: opts.concurrency,
    durationMs: opts.durationMs,
    targetRps: opts.rps,
    achievedRps,
    samples,
    failure,
  }
}

// ---------------- VU loop ----------------

interface VuCtx {
  vuId: number
  fn: WorkflowFn
  before?: BeforeFn
  after?: AfterFn
  env: Readonly<Record<string, string>>
  sink: SampleSink
  signal: AbortSignal
  tZero: number
  rateLimiter?: RateLimiter
  completed: { n: number }
  defaults: { userAgent: string; perRequestTimeoutMs?: number; insecure?: boolean }
  cookieJar?: CookieJar
  harRecorder?: HarRecorder
  harReplay?: HarReplayer
  onOutcome: (sample: Sample) => void
}

async function runVu(ctx: VuCtx): Promise<void> {
  let iteration = 0
  try {
    while (!ctx.signal.aborted) {
      const outcome = await oneIteration(ctx, iteration++)
      if (outcome) {
        ctx.onOutcome(outcome)
        ctx.completed.n++
      }
      if (ctx.rateLimiter && !ctx.signal.aborted) {
        const delay = ctx.rateLimiter.nextDelayMs(
          ctx.completed.n,
          performance.now() - ctx.tZero,
        )
        if (delay > 0) await sleep(delay, ctx.signal)
        else await yieldNow(ctx.signal)
      } else {
        await yieldNow(ctx.signal)
      }
    }
  } catch (err) {
    if (isStructuralCancellation(err)) return
    if (ctx.signal.aborted) return
    throw err
  }
}

async function oneIteration(ctx: VuCtx, iteration: number): Promise<Sample | undefined> {
  const t = (performance.now() - ctx.tZero) / 1_000
  const started = performance.now()
  const ts = new Date().toISOString()
  const vu: VuContext = { id: ctx.vuId, iteration, env: ctx.env }

  // Phase-tagged context factory. Cookie jar / HAR shared across phases of
  // the same iteration (login in `before` is visible to default; after can
  // issue authenticated DELETE). lastResponse is per-context (separate slot).
  const mkPhaseCtx = (
    phase: "before" | "iteration" | "after",
    sig: AbortSignal,
  ): RuntimeContext => ({
    vu,
    sink: ctx.sink,
    signal: sig,
    tZero: ctx.tZero,
    defaults: ctx.defaults,
    cookieJar: ctx.cookieJar,
    harRecorder: ctx.harRecorder,
    harReplay: ctx.harReplay,
    ...(phase === "iteration" ? {} : { phase }),
  })

  // Per-iteration scope: `after` registered as resource BEFORE `before` runs
  // so it always fires (before threw, default threw, signal aborted) — same
  // LIFO trick as v0.4 epilogue. userCtx is captured by closure so after
  // sees what before returned, even when default throws mid-iteration.
  return await scope({ signal: ctx.signal }, async iterScope => {
    let userCtx: unknown = {}

    if (ctx.after) {
      const aft = ctx.after
      await iterScope.resource(true, async () => {
        try {
          await withRuntime(mkPhaseCtx("after", iterScope.signal), async () =>
            aft(vu, iterScope.signal, userCtx),
          )
        } catch (err) {
          // Structural cancellation (deadline, abort) propagates through
          // request.* inside the hook. That's not a hook bug — the run is
          // unwinding. Stay silent on it; surface only real exceptions.
          if (isStructuralCancellation(err) || ctx.signal.aborted) return
          process.stderr.write(
            `after threw: ${(err as Error)?.message ?? String(err)}\n`,
          )
        }
      })
    }

    try {
      if (ctx.before) {
        const bef = ctx.before
        const ret = await withRuntime(mkPhaseCtx("before", iterScope.signal), async () =>
          bef(vu, iterScope.signal),
        )
        if (ret !== undefined) userCtx = ret
      }
      await withRuntime(mkPhaseCtx("iteration", iterScope.signal), async () =>
        ctx.fn(vu, iterScope.signal, userCtx),
      )
      return {
        ok: true,
        t,
        vu: ctx.vuId,
        iteration,
        method: "",
        url: "",
        duration_ms: performance.now() - started,
        status: 0,
        size: 0,
        ts,
      } as Sample
    } catch (err) {
      if (ctx.signal.aborted || iterScope.signal.aborted) return undefined
      const e = err as { name?: string; message?: string }
      return {
        ok: false,
        t,
        vu: ctx.vuId,
        iteration,
        method: "",
        url: "",
        duration_ms: performance.now() - started,
        error: e?.name ?? "Error",
        message: e?.message ?? String(err),
        ts,
      } as Sample
    }
  })
}

// ---------------- Stats + percentiles ----------------

/**
 * Sorted-buffer percentile calculator. Insert is O(log n) binary search + O(n)
 * shift; acceptable up to ~100k samples. Upgrade to t-digest later if needed.
 */
export class PercentileBuffer {
  private buf: Float64Array
  private len = 0

  constructor(initialCapacity = 1024) {
    this.buf = new Float64Array(initialCapacity)
  }

  get count(): number { return this.len }
  get min(): number { return this.len === 0 ? Number.NaN : this.buf[0] }
  get max(): number { return this.len === 0 ? Number.NaN : this.buf[this.len - 1] }

  get mean(): number {
    if (this.len === 0) return Number.NaN
    let sum = 0
    for (let i = 0; i < this.len; i++) sum += this.buf[i]
    return sum / this.len
  }

  push(value: number): void {
    if (this.len === this.buf.length) this.grow()
    const idx = this.searchInsertIndex(value)
    this.buf.copyWithin(idx + 1, idx, this.len)
    this.buf[idx] = value
    this.len++
  }

  /** p in [0, 1] — e.g. 0.95 for p95. Nearest-rank. */
  p(q: number): number {
    if (this.len === 0) return Number.NaN
    if (q <= 0) return this.buf[0]
    if (q >= 1) return this.buf[this.len - 1]
    const rank = Math.ceil(q * this.len) - 1
    return this.buf[Math.max(0, Math.min(this.len - 1, rank))]
  }

  private grow(): void {
    const next = new Float64Array(this.buf.length * 2)
    next.set(this.buf)
    this.buf = next
  }

  private searchInsertIndex(value: number): number {
    let lo = 0
    let hi = this.len
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.buf[mid] <= value) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

export class Stats {
  private readonly latency = new PercentileBuffer(4096)
  private readonly byStatus = new Map<number, number>()
  private readonly byError = new Map<string, number>()
  private _total = 0
  private _success = 0
  private _errors = 0
  private readonly startMs = performance.now()
  private warmupEndMs: number

  constructor(public readonly warmupMs = 0) {
    this.warmupEndMs = this.startMs + warmupMs
  }

  /**
   * Records an iteration outcome (success or error) for stats roll-up.
   *
   * SampleEvent (workflow-emitted via log.event) is NOT an iteration outcome —
   * it represents a workflow trace point that lives in the NDJSON stream but
   * has no duration_ms / status / error. The "event" in sample guard skips
   * those defensively. Today nothing routes events through onOutcome; this
   * documents the invariant and protects against future refactors.
   */
  push(sample: Sample): void {
    if ("event" in sample) return
    if (performance.now() < this.warmupEndMs) return
    this._total++
    this.latency.push(sample.duration_ms)
    if (sample.ok) {
      this._success++
      this.byStatus.set(sample.status, (this.byStatus.get(sample.status) ?? 0) + 1)
    } else {
      this._errors++
      this.byError.set(sample.error, (this.byError.get(sample.error) ?? 0) + 1)
    }
  }

  get total(): number { return this._total }
  get errors(): number { return this._errors }
  get elapsedMs(): number { return performance.now() - this.startMs }

  snapshot(): StatsSnapshot {
    const elapsedMs = this.elapsedMs
    const elapsedSec = elapsedMs / 1_000
    return {
      total: this._total,
      success: this._success,
      errors: this._errors,
      elapsedMs,
      latency: {
        avg: this.latency.mean,
        p50: this.latency.p(0.5),
        p95: this.latency.p(0.95),
        p99: this.latency.p(0.99),
        max: this.latency.max,
        min: this.latency.min,
      },
      byStatus: Object.fromEntries(this.byStatus),
      byError: Object.fromEntries(this.byError),
      throughput: elapsedSec > 0 ? this._total / elapsedSec : 0,
    }
  }
}

// ---------------- Rate limiter ----------------

export class RateLimiter {
  constructor(public readonly targetRps: number) {
    if (!(targetRps > 0)) throw new Error("targetRps must be > 0")
  }

  /** ms to sleep before firing the next request. 0 if behind target. */
  nextDelayMs(completedSoFar: number, elapsedMs: number): number {
    const targetMs = (completedSoFar * 1_000) / this.targetRps
    const delay = targetMs - elapsedMs
    return delay > 0 ? delay : 0
  }
}

// ---------------- Progress ----------------

const PROGRESS_REFRESH_MS = 100

async function runProgress(stats: Stats, signal: AbortSignal, durationMs: number): Promise<void> {
  const out = process.stderr
  const isTTY = out.isTTY
  try {
    while (!signal.aborted) {
      writeProgressLine(stats, durationMs, isTTY)
      await sleep(PROGRESS_REFRESH_MS, signal)
    }
  } catch (err) {
    if (!isStructuralCancellation(err) && !signal.aborted) throw err
  } finally {
    if (isTTY) out.write("\n")
  }
}

function writeProgressLine(stats: Stats, durationMs: number, isTTY: boolean): void {
  const elapsedSec = stats.elapsedMs / 1_000
  const totalSec = durationMs / 1_000
  const rps = elapsedSec > 0 ? (stats.total / elapsedSec).toFixed(1) : "0.0"
  const line = `  ${stats.total.toLocaleString()} reqs  ${rps}/s  ${stats.errors} errs  ${elapsedSec.toFixed(1)}/${totalSec.toFixed(1)}s`
  if (isTTY) process.stderr.write(`\r${line.padEnd(72)}`)
  else process.stderr.write(line + "\n")
}
