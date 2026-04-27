// Minimal flow for demonstrating watch mode. Run with --watch:
//
//   node dist/cli.js run examples/watch-loop.mjs --watch
//
// Then edit this file in another terminal — the run reruns on save.
// Try also: --watch-mode lazy (queue file changes, finish current run first).

import { request, assert, env } from "jolly-http"

export default async function (vu, signal) {
  const url = env.URL ?? "https://httpbin.org/uuid"
  const res = await request.GET(url, { signal })
  assert(res.status === 200)
  const body = await res.json()
  return { vu: vu.id, iter: vu.iteration, sample: body }
}
