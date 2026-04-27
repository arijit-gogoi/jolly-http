import { request, assert, env } from "jolly-http"

// Login flow that relies on cookies. Run with --cookies ./jar to persist
// across invocations. Second invocation reuses the session cookie.
//
//   node dist/cli.js run examples/cookies-persist.mjs --cookies ./jar
//
// Cookies are auto-included on the second request (request.GET inherits the
// jar from the runtime). To opt out per-call: request.GET(url, { cookies: false }).

export default async function (vu, signal) {
  const base = env.API ?? "https://httpbin.org"

  // First request: server may set a cookie via Set-Cookie header.
  const login = await request.GET(`${base}/cookies/set?session=demo-${vu.id}`, { signal })
  assert(login.status === 200 || login.status === 302, `login: ${login.status}`)

  // Second request: cookie sent automatically. Try /cookies to verify.
  const me = await request.GET(`${base}/cookies`, { signal })
  assert(me.status === 200, `me: ${me.status}`)
  const body = await me.json()
  return { cookies: body.cookies ?? body }
}
