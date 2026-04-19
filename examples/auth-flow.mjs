import { request, assert, env } from "jolly-http"

const API = env.API ?? "https://httpbin.org"

export default async function (vu, signal) {
  const login = await request.POST(`${API}/post`, {
    json: { user: `vu-${vu.id}` },
    signal,
    timeout: "5s",
  })
  assert(login.status === 200, `login: ${login.status}`)

  const body = await login.json()
  const token = body.json.user // echo, stand-in for a real token

  const me = await request.GET(`${API}/get`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  assert(me.status === 200, "me call failed")

  return { token, iteration: vu.iteration }
}
