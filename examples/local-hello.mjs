import { request, assert, env } from "jolly-http"

export default async function (vu, signal) {
  const url = env.URL ?? "http://127.0.0.1:9999/users"
  const res = await request.GET(url, { signal })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  return { status: res.status, vu: vu.id }
}
