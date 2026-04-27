import { watch, watchFile, unwatchFile, type FSWatcher } from "node:fs"
import { resolve } from "node:path"
import { scope, sleep, isStructuralCancellation } from "jolly-coop"

/**
 * Run a workflow in a watch loop. The inner runner is a closure that
 * `cli.ts` provides — it knows how to call `runWorkflow`/`runLoad` with
 * the right opts and a child signal.
 *
 * Architecture (mirrors CLAUDE.md § Architecture watch sketch):
 *
 *   scope({ signal: outer })           — outer (SIGINT)
 *   └── while !outer.aborted:
 *         scope({ signal: outer })     — inner (per run)
 *           └── innerRun(inner.signal)
 *         await fileChange | outer abort
 *         if eager → inner.cancel(reload sentinel)
 *         else → wait for inner to finish, then loop
 *
 * Eager: cancel mid-flight on file change → fast feedback, may abort in-flight requests.
 * Lazy: queue file changes, finish current run, then reload → no aborts but slower feedback.
 */

const DEBOUNCE_MS = 100
const RELOAD_REASON = Symbol("jolly-http.watch.reload")

export interface WatchOptions {
  signal: AbortSignal
  mode: "eager" | "lazy"
  quiet?: boolean
  /** Force fs.watchFile polling (for test environments where fs.watch is unreliable). */
  pollMs?: number
}

export type InnerRun = (signal: AbortSignal) => Promise<unknown>

/**
 * Returns the exit code (0 on graceful shutdown via SIGINT, 1 on inner-thrown
 * unrecoverable error, 130 on SIGINT).
 */
export async function runWatched(
  workflowPath: string,
  innerRun: InnerRun,
  opts: WatchOptions,
): Promise<number> {
  const abs = resolve(workflowPath)
  let exitCode = 0

  await scope({ signal: opts.signal }, async outer => {
    let runCount = 0
    let pendingReload = 0

    // File-change signal that the loop awaits between runs.
    const reloadCtl = makeReloadController()

    // Register the watcher as a scope resource so it's cleaned up on exit.
    const watcher = await outer.resource(
      startWatcher(abs, () => reloadCtl.fire(), opts.pollMs),
      w => w.close(),
    )
    void watcher  // resource registered for disposal; not used directly here

    while (!outer.signal.aborted) {
      runCount++
      if (!opts.quiet && runCount > 1) {
        const tag = pendingReload > 1 ? `reload (${pendingReload} changes)` : "reload"
        process.stderr.write(`\n─── ${tag} #${runCount} ${new Date().toLocaleTimeString()} ───\n`)
      } else if (!opts.quiet) {
        process.stderr.write(`\n─── watch #${runCount} ${new Date().toLocaleTimeString()} ───\n`)
      }
      pendingReload = 0
      reloadCtl.reset()

      // Fresh inner scope per run. Errors inside don't propagate (we want to
      // keep watching) — only outer SIGINT exits the loop.
      let innerHandle: { cancel: (r?: unknown) => void } | null = null

      const innerPromise = scope({ signal: outer.signal }, async inner => {
        innerHandle = { cancel: r => inner.cancel(r) }
        await innerRun(inner.signal)
      }).catch(err => {
        if (err === RELOAD_REASON || isStructuralCancellation(err)) return
        if (outer.signal.aborted) return
        // User-thrown error in workflow → log but keep watching, like nodemon.
        process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`)
      })

      // Now: race the inner run against (file change OR signal abort).
      const reloadPromise = reloadCtl.wait(outer.signal)
      if (opts.mode === "eager") {
        // Eager: as soon as a file change fires, cancel the inner run.
        const winner = await Promise.race([
          innerPromise.then(() => "inner" as const),
          reloadPromise.then(() => "reload" as const),
        ])
        if (winner === "reload") {
          if (innerHandle) (innerHandle as { cancel: (r?: unknown) => void }).cancel(RELOAD_REASON)
          await innerPromise
        }
        // Either path: wait for the next change (or abort) before re-looping.
        // Otherwise eager mode would busy-spin after a natural finish.
        if (!reloadCtl.hasFired() && !outer.signal.aborted) {
          await reloadCtl.wait(outer.signal)
        }
        pendingReload = reloadCtl.consumePending()
        await coolDown(outer.signal)
      } else {
        // Lazy: wait for inner to finish; if a reload arrived during the run,
        // pick it up immediately. Otherwise wait for one.
        await innerPromise
        if (!reloadCtl.hasFired() && !outer.signal.aborted) {
          await reloadPromise
        }
        pendingReload = reloadCtl.consumePending()
        await coolDown(outer.signal)
      }
    }
  }).catch(err => {
    if (isStructuralCancellation(err)) {
      exitCode = 130
    } else if (opts.signal.aborted) {
      exitCode = 130
    } else {
      const e = err as { message?: string }
      process.stderr.write(`watch error: ${e?.message ?? String(err)}\n`)
      exitCode = 1
    }
  })

  return exitCode
}

interface ReloadController {
  fire(): void
  wait(signal: AbortSignal): Promise<void>
  reset(): void
  hasFired(): boolean
  consumePending(): number
}

function makeReloadController(): ReloadController {
  let pending = 0
  let waiters: Array<() => void> = []
  return {
    fire() {
      pending++
      const w = waiters
      waiters = []
      for (const fn of w) fn()
    },
    wait(signal) {
      if (pending > 0) return Promise.resolve()
      return new Promise<void>(resolve => {
        const onFire = () => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }
        const onAbort = () => {
          waiters = waiters.filter(w => w !== onFire)
          resolve()
        }
        waiters.push(onFire)
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
    },
    reset() {
      pending = 0
    },
    hasFired() {
      return pending > 0
    },
    consumePending() {
      const n = pending
      pending = 0
      return n
    },
  }
}

interface CloseableWatcher {
  close(): void
}

function startWatcher(
  path: string,
  onChange: () => void,
  pollMs: number | undefined,
): CloseableWatcher {
  let timer: NodeJS.Timeout | undefined
  const debounced = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, DEBOUNCE_MS)
  }

  if (pollMs !== undefined) {
    watchFile(path, { interval: pollMs }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) debounced()
    })
    return {
      close() {
        if (timer !== undefined) clearTimeout(timer)
        unwatchFile(path)
      },
    }
  }

  let fsw: FSWatcher
  try {
    fsw = watch(path, { persistent: true }, () => debounced())
  } catch (err) {
    // Some platforms (e.g. some Linux filesystems on certain mounts) reject
    // watch() — fall back to polling.
    return startWatcher(path, onChange, 200)
  }
  return {
    close() {
      if (timer !== undefined) clearTimeout(timer)
      try { fsw.close() } catch { /* already closed */ }
    },
  }
}

async function coolDown(signal: AbortSignal): Promise<void> {
  try {
    await sleep(DEBOUNCE_MS, signal)
  } catch {
    // signal aborted → just return; outer loop will see signal.aborted
  }
}

/** Internal helpers exposed for unit tests; not part of the public API. */
export const _internals = {
  makeReloadController,
}
