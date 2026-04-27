// Example workflow that requires API_BASE and API_TOKEN to be set.
// Pair with examples/.env.example (committed) and examples/.env (gitignored, real values).
//
// Workflow:
//   cp examples/.env.example examples/.env
//   # edit examples/.env, fill in real values
//   jolly-http run examples/env-validate.mjs \
//     --env-file examples/.env \
//     --require-env examples/.env.example
//
// If any required key is missing or empty, the run fails BEFORE the request fires.

import { request, assert, env } from "jolly-http"

export default async function (vu, signal) {
  const res = await request.GET(`${env.API_BASE}/users/me`, {
    headers: { authorization: `Bearer ${env.API_TOKEN}` },
    signal,
  })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  return { vu: vu.id, status: res.status }
}
