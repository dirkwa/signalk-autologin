import { describe, it, expect, beforeEach, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  bearerToken,
  safeNextPath,
  verifyUserToken,
  type SecurityConfiguration
} from '../src/autologin.js'
import { SEED_PAGE } from '../src/seedPage.js'

const SECRET = 'test-secret-key'

function makeConfig(): SecurityConfiguration {
  return {
    secretKey: SECRET,
    users: [
      { username: 'admin', type: 'admin' },
      { username: 'signalk-kiosk', type: 'readwrite' }
    ],
    allow_readonly: false
  }
}

// Paths the redirect must accept, and ones that would make it an open
// redirect (or worse) if they got through.
const SAFE = [
  '/',
  '/admin/',
  '/@mxtommy/kip/',
  '/@signalk/freeboard-sk/?zoom=12'
]
const UNSAFE = [
  '',
  'https://evil.test/',
  '//evil.test/',
  '/\\evil.test/',
  'javascript:alert(1)',
  'admin/',
  '/admin/\u0000x',
  '/' + 'a'.repeat(3000)
]

describe('safeNextPath', () => {
  it.each(SAFE)('accepts %s', (p) => {
    expect(safeNextPath(p, '/fallback')).toBe(p)
  })
  it.each(UNSAFE)('rejects %j', (p) => {
    expect(safeNextPath(p, '/fallback')).toBe('/fallback')
  })
  it('rejects a non-string', () => {
    expect(safeNextPath(['/admin/'], '/fallback')).toBe('/fallback')
    expect(safeNextPath(undefined, '/fallback')).toBe('/fallback')
  })
})

describe('seed page redirect check agrees with safeNextPath', () => {
  // The seed page redirects in the browser, so it carries its own copy of the
  // rule. Evaluate that copy against the same inputs.
  const src =
    /if \(next\.length > 2048 \|\| !(\/\^.*\$\/)\.test\(next\)\)/.exec(
      SEED_PAGE
    )
  it('the page contains the check', () => {
    expect(src).not.toBeNull()
  })
  const pattern = src ? src[1] : '/^$/'
  const re = new RegExp(pattern.slice(1, -1))
  const pageAccepts = (p: string) => p.length <= 2048 && re.test(p)
  it.each([...SAFE, ...UNSAFE.filter((p) => p !== '')])('%j', (p) => {
    expect(pageAccepts(p)).toBe(safeNextPath(p, '') === p)
  })
})

describe('seed page keeps the token off the wire', () => {
  it('reads the token from the fragment, never from the query string', () => {
    expect(SEED_PAGE).toContain('location.hash')
    expect(SEED_PAGE).not.toContain('location.search.get')
    expect(SEED_PAGE).not.toContain('?token=')
  })
  it('drops the fragment from the address bar before anything else', () => {
    const replace = SEED_PAGE.indexOf('history.replaceState')
    const fetchAt = SEED_PAGE.indexOf('fetch(')
    expect(replace).toBeGreaterThan(-1)
    expect(replace).toBeLessThan(fetchAt)
  })
  it('sends the token in an Authorization header to the POST endpoint', () => {
    expect(SEED_PAGE).toContain("method: 'POST'")
    expect(SEED_PAGE).toContain("Authorization: 'Bearer ' + token")
    expect(SEED_PAGE).toContain("fetch('/signalk-autologin/session'")
  })
})

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken('bearer abc')).toBe('abc')
  })
  it('rejects anything else', () => {
    expect(bearerToken('Basic abc')).toBeUndefined()
    expect(bearerToken('Bearer a b')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe('verifyUserToken', () => {
  const config = makeConfig()
  it('returns the user for a token the server secret signed', () => {
    const t = jwt.sign({ id: 'signalk-kiosk' }, SECRET, { expiresIn: '10y' })
    expect(verifyUserToken(t, config)).toBe('signalk-kiosk')
  })
  it('rejects a token for a user that no longer exists', () => {
    const t = jwt.sign({ id: 'deleted-user' }, SECRET)
    expect(verifyUserToken(t, config)).toBeUndefined()
  })
  it('rejects a token signed with another secret', () => {
    const t = jwt.sign({ id: 'admin' }, 'another-secret')
    expect(verifyUserToken(t, config)).toBeUndefined()
  })
  it('rejects an expired token', () => {
    const t = jwt.sign(
      { id: 'admin', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET
    )
    expect(verifyUserToken(t, config)).toBeUndefined()
  })
  it('rejects a token with no user id (e.g. an access-request device token)', () => {
    const t = jwt.sign({ device: 'abc' }, SECRET)
    expect(verifyUserToken(t, config)).toBeUndefined()
  })
  it('rejects garbage', () => {
    expect(verifyUserToken('not-a-jwt', config)).toBeUndefined()
  })
})

// ── the routes, against a fake server ───────────────────────────────────────

type Handler = (req: FakeReq, res: FakeRes) => void
interface FakeReq {
  query: Record<string, unknown>
  headers: Record<string, string | undefined>
  secure: boolean
}
class FakeRes {
  statusCode = 200
  redirected: string | undefined
  cookies: Record<string, { value: string; opts: Record<string, unknown> }> = {}
  cleared: string[] = []
  body: unknown
  headers: Record<string, string> = {}
  status(c: number) {
    this.statusCode = c
    return this
  }
  redirect(u: string) {
    this.redirected = u
  }
  cookie(n: string, v: string, o: Record<string, unknown>) {
    this.cookies[n] = { value: v, opts: o }
  }
  clearCookie(n: string) {
    this.cleared.push(n)
  }
  json(b: unknown) {
    this.body = b
    return this
  }
  send(b: unknown) {
    this.body = b
    return this
  }
  type() {
    return this
  }
  set(k: string, v: string) {
    this.headers[k] = v
    return this
  }
  end() {
    return this
  }
}

function req(over: Partial<FakeReq> = {}): FakeReq {
  return { query: {}, headers: {}, secure: false, ...over }
}

// The plugin keeps its route registration and mode in module scope (Express
// cannot unregister routes), so each test loads a fresh copy of the module.
async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../src/index.js')
  const routes: Record<string, Handler> = {}
  const statuses: string[] = []
  const errors: string[] = []
  const config = makeConfig()
  const strategy = {
    isDummy: () => false,
    getConfiguration: () => config
  }
  const app = {
    securityStrategy: strategy,
    get: (p: string, h: Handler) => (routes[`GET ${p}`] = h),
    post: (p: string, h: Handler) => (routes[`POST ${p}`] = h),
    setPluginStatus: (m: string) => statuses.push(m),
    setPluginError: (m: string) => errors.push(m)
  }
  const plugin = mod.default(app as never)
  return { plugin, routes, statuses, errors, config }
}

describe('token sign-in routes', () => {
  let t: Awaited<ReturnType<typeof loadPlugin>>
  const kioskToken = jwt.sign({ id: 'signalk-kiosk' }, SECRET, {
    expiresIn: '10y'
  })

  beforeEach(async () => {
    t = await loadPlugin()
  })

  it('token mode signs in the token holder and nobody else', () => {
    t.plugin.start({ networkWideAdmin: false }, () => {})
    expect(t.statuses.at(-1)).toMatch(/^Token sign-in only/)

    const ok = new FakeRes()
    t.routes['POST /signalk-autologin/session'](
      req({ headers: { authorization: `Bearer ${kioskToken}` } }),
      ok
    )
    expect(ok.statusCode).toBe(204)
    expect(ok.cookies.JAUTHENTICATION.value).toBe(kioskToken)
    expect(ok.cookies.JAUTHENTICATION.opts.httpOnly).toBe(true)
    expect(JSON.parse(ok.cookies.skLoginInfo.value)).toEqual({
      status: 'loggedIn',
      user: 'signalk-kiosk'
    })

    // A plain visit — any other device — gets no cookie in this mode.
    const visit = new FakeRes()
    t.routes['GET /signalk-autologin/session'](req(), visit)
    expect(visit.cookies).toEqual({})
    expect(visit.redirected).toBe('/admin/')
  })

  it('rejects a bad token with 401 and sets no cookie', () => {
    t.plugin.start({ networkWideAdmin: false }, () => {})
    const res = new FakeRes()
    t.routes['POST /signalk-autologin/session'](
      req({
        headers: { authorization: `Bearer ${jwt.sign({ id: 'x' }, 'wrong')}` }
      }),
      res
    )
    expect(res.statusCode).toBe(401)
    expect(res.cookies).toEqual({})
  })

  it('serves the seed page, uncached', () => {
    t.plugin.start({ networkWideAdmin: false }, () => {})
    const res = new FakeRes()
    t.routes['GET /signalk-autologin/seed'](req(), res)
    expect(res.body).toBe(SEED_PAGE)
    expect(res.headers['Cache-Control']).toBe('no-store')
  })

  it('network-wide mode still seeds every device, and honours a safe ?next=', () => {
    t.plugin.start({ networkWideAdmin: true }, () => {})
    const res = new FakeRes()
    t.routes['GET /signalk-autologin/session'](
      req({ query: { next: '/@mxtommy/kip/' } }),
      res
    )
    expect(res.cookies.JAUTHENTICATION).toBeDefined()
    expect(res.redirected).toBe('/@mxtommy/kip/')
  })

  it('an unsafe ?next= falls back to /admin/', () => {
    t.plugin.start({ networkWideAdmin: true }, () => {})
    const res = new FakeRes()
    t.routes['GET /signalk-autologin/session'](
      req({ query: { next: '//evil.test/' } }),
      res
    )
    expect(res.redirected).toBe('/admin/')
  })

  it('existing configs without the setting keep the network-wide behaviour', () => {
    t.plugin.start({}, () => {})
    expect(t.statuses.at(-1)).toMatch(/every device is admin/)
  })

  it('after stop, the token endpoint signs nobody in', () => {
    t.plugin.start({ networkWideAdmin: false }, () => {})
    t.plugin.stop()
    const res = new FakeRes()
    t.routes['POST /signalk-autologin/session'](
      req({ headers: { authorization: `Bearer ${kioskToken}` } }),
      res
    )
    expect(res.statusCode).toBe(404)
    expect(res.cookies).toEqual({})
  })

  it('token mode leaves the security strategy untouched', () => {
    const before = { ...t.config }
    t.plugin.start({ networkWideAdmin: false }, () => {})
    expect(t.config.allow_readonly).toBe(before.allow_readonly)
  })
})

// ── the seed page itself, run against a fake browser ────────────────────────

// Runs the page's own script. `responses` are what the sign-in POST gets in
// turn: an HTTP status, or 'down' for no answer at all.
async function runSeedPage(hash: string, responses: Array<number | 'down'>) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(SEED_PAGE)?.[1] ?? ''
  const posts: Array<{ url: string; auth: string }> = []
  const timers: Array<() => void> = []
  const msg = { textContent: '' }
  let replaced: string | undefined
  const location = {
    hash,
    pathname: '/signalk-autologin/seed',
    search: '',
    replace: (u: string) => {
      replaced = u
    }
  }
  const fakeFetch = (
    url: string,
    init: { headers: { Authorization: string } }
  ) => {
    posts.push({ url, auth: init.headers.Authorization })
    const r = responses.shift() ?? 'down'
    return r === 'down'
      ? Promise.reject(new Error('connection refused'))
      : Promise.resolve({ status: r })
  }
  new Function(
    'location',
    'history',
    'document',
    'fetch',
    'setTimeout',
    script
  )(
    location,
    { replaceState: () => {} },
    { getElementById: () => msg },
    fakeFetch,
    (fn: () => void) => timers.push(fn)
  )
  // Let every pending promise settle, then fire the next retry timer.
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r))
    const next = timers.shift()
    if (!next) break
    next()
  }
  return { posts, message: msg.textContent, replaced }
}

describe('seed page sign-in', () => {
  const hash = '#token=T0K3N&next=%2F%40mxtommy%2Fkip%2F'

  it('posts the token once and lands on next', async () => {
    const r = await runSeedPage(hash, [204])
    expect(r.posts).toEqual([
      { url: '/signalk-autologin/session', auth: 'Bearer T0K3N' }
    ])
    expect(r.replaced).toBe('/@mxtommy/kip/')
  })

  it('keeps trying while the server is down or answers 5xx', async () => {
    const r = await runSeedPage(hash, ['down', 503, 502, 204])
    expect(r.posts).toHaveLength(4)
    expect(r.replaced).toBe('/@mxtommy/kip/')
  })

  it('takes a 401 as final', async () => {
    const r = await runSeedPage(hash, [401, 204])
    expect(r.posts).toHaveLength(1)
    expect(r.replaced).toBeUndefined()
    expect(r.message).toBe('Sign-in token rejected (HTTP 401).')
  })

  it('takes any other 4xx as final', async () => {
    const r = await runSeedPage(hash, [404, 204])
    expect(r.posts).toHaveLength(1)
    expect(r.message).toBe('Sign-in failed (HTTP 404).')
  })

  it('gives up after 20 attempts', async () => {
    const r = await runSeedPage(hash, Array<number>(25).fill(503))
    expect(r.posts).toHaveLength(20)
    expect(r.replaced).toBeUndefined()
    expect(r.message).toBe('The Signal K server answered HTTP 503.')
  })

  it('posts nothing without a token', async () => {
    const r = await runSeedPage('#next=%2Fadmin%2F', [204])
    expect(r.posts).toHaveLength(0)
    expect(r.message).toBe('No sign-in token in the address.')
  })
})
