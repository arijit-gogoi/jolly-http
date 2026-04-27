// HAR recording: hits two endpoints, writes a HAR per VU. Open the file in
// Chrome DevTools (Network panel → Import HAR) or any HAR viewer.
//
//   node dist/cli.js run examples/har-debug.mjs --har ./har-out
//   ls har-out/    # → vu-0.har
//
// In load mode, each VU gets its own file: har-out/vu-0.har, vu-1.har, ...

import { request, assert, env } from "jolly-http"

export default async function (vu, signal) {
  const base = env.API ?? "https://httpbin.org"
  const a = await request.GET(`${base}/get?call=first`, { signal })
  assert(a.status === 200)
  const b = await request.POST(`${base}/post`, {
    json: { vu: vu.id, iter: vu.iteration },
    signal,
  })
  assert(b.status === 200)
  return { first: a.status, second: b.status }
}
