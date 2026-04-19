import { request, assert } from "jolly-http"

export default async function (vu, signal) {
  const res = await request.GET("https://httpbin.org/get", { signal })
  assert(res.status === 200, `expected 200, got ${res.status}`)
  const body = await res.json()
  return { status: res.status, url: body.url }
}
