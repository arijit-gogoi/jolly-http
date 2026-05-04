import { request, type VuContext } from "jolly-http"

interface User { id: number; name: string }

export default async function (vu: VuContext, signal: AbortSignal): Promise<{ id: number; status: number }> {
  const r = await request.GET("https://example.com/", { signal })
  const _u: User = { id: vu.id, name: "test" }
  return { id: _u.id, status: r.status }
}
