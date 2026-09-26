import type { Plugin, ServerAPI } from '@signalk/server-api'
import type {
  Request,
  Response,
  IRouter,
  CookieOptions,
  Application
} from 'express'
import { Config, ConfigSchema, SCHEMA_DEFAULTS } from './config/schema.js'
import {
  applyStrategyMutations,
  bearerToken,
  mintAdminToken,
  resolveAdminUsername,
  restoreStrategyMutations,
  safeNextPath,
  verifyUserToken,
  type AutologinState,
  type SecurityStrategy
} from './autologin.js'
import { SEED_PAGE } from './seedPage.js'

const PLUGIN_ID = 'signalk-autologin'

// Matches the server's cookie names (src/tokensecurity.ts).
const AUTH_COOKIE = 'JAUTHENTICATION'
const LOGININFO_COOKIE = 'skLoginInfo'
// ~10 years requested. Chromium caps a cookie's lifetime at 400 days whatever
// is asked for, so a browser absent that long is simply seeded again on its
// next visit (and a kiosk re-seeds on every browser start anyway).
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000

// The un-gated seeding routes are registered on the live Express app exactly
// once per process. Express has no public `app.unuse`, so the handlers guard
// on the module-scoped `active` flag and no-op when the plugin is stopped.
let routesRegistered = false
let active = false
// true: every device is admin (the original mode). false: token sign-in only.
let networkWide = false
let currentToken: string | undefined
let currentAdminUser: string | undefined

interface AppWithSecurity extends ServerAPI {
  securityStrategy?: SecurityStrategy
}

export default function (app: ServerAPI): Plugin {
  const appWithSecurity = app as AppWithSecurity
  const expressApp = app as unknown as Application

  let state: AutologinState | undefined

  function sessionCookieOptions(req: Request): CookieOptions {
    // Mirror the server's setSessionCookie (src/tokensecurity.ts:468).
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
    return {
      sameSite: 'strict',
      secure,
      maxAge: COOKIE_MAX_AGE_MS
    }
  }

  function seedCookies(req: Request, res: Response): void {
    if (!active || !currentToken || !currentAdminUser) {
      return
    }
    const opts = sessionCookieOptions(req)
    res.cookie(AUTH_COOKIE, currentToken, { ...opts, httpOnly: true })
    res.cookie(
      LOGININFO_COOKIE,
      JSON.stringify({ status: 'loggedIn', user: currentAdminUser }),
      opts
    )
  }

  function clearCookies(res: Response): void {
    res.clearCookie(AUTH_COOKIE)
    res.clearCookie(LOGININFO_COOKIE)
  }

  function handleSession(req: Request, res: Response): void {
    const next = safeNextPath(req.query.next, '/admin/')
    if (!active) {
      res.redirect(next)
      return
    }
    if (req.query.logout === '1') {
      clearCookies(res)
    } else if (networkWide) {
      seedCookies(req, res)
    }
    res.redirect(next)
  }

  // GET /signalk-autologin/seed — the page a token-holding browser opens.
  // See src/seedPage.ts for why the token rides in the fragment.
  function handleSeedPage(_req: Request, res: Response): void {
    if (!active) {
      res.status(404).type('text/plain').send('Autologin is not active.')
      return
    }
    res.set('Cache-Control', 'no-store')
    res.type('html').send(SEED_PAGE)
  }

  // POST /signalk-autologin/session with `Authorization: Bearer <token>`.
  // Signs this one browser in as the user the token names, whatever the mode:
  // the token is proof the holder was given that user's access.
  function handleTokenSession(req: Request, res: Response): void {
    res.set('Cache-Control', 'no-store')
    if (!active) {
      res.status(404).json({ error: 'autologin is not active' })
      return
    }
    const token = bearerToken(req.headers.authorization)
    const secConf = appWithSecurity.securityStrategy?.getConfiguration()
    const user = token && secConf ? verifyUserToken(token, secConf) : undefined
    if (!token || !user) {
      res.status(401).json({ error: 'sign-in token rejected' })
      return
    }
    const opts = sessionCookieOptions(req)
    res.cookie(AUTH_COOKIE, token, { ...opts, httpOnly: true })
    res.cookie(
      LOGININFO_COOKIE,
      JSON.stringify({ status: 'loggedIn', user }),
      opts
    )
    res.status(204).end()
  }

  function registerSeedingRoutes(): void {
    if (routesRegistered) {
      return
    }
    // Un-gated: mounted on the live app at a NON-admin path, so http_authorize
    // at '/' (forLoginStatus mode) calls next() rather than 401 for a
    // cookie-less request, letting a fresh browser reach here to be seeded.
    expressApp.get('/signalk-autologin/session', handleSession)
    expressApp.get('/signalk-autologin/', handleSession)
    expressApp.get('/signalk-autologin/seed', handleSeedPage)
    expressApp.post('/signalk-autologin/session', handleTokenSession)
    routesRegistered = true
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Autologin (admin)',
    description:
      'Grants every device admin access without a login — the modern ' +
      'replacement for security-off, trusted networks only — or, with that ' +
      'turned off, signs in only browsers that hold a sign-in token.',
    schema: () => ConfigSchema,

    start(partial: object) {
      const config: Config = { ...SCHEMA_DEFAULTS, ...(partial as Config) }

      const strategy = appWithSecurity.securityStrategy
      if (!strategy || strategy.isDummy?.()) {
        app.setPluginStatus(
          'Security is disabled on this server — nothing to do.'
        )
        return
      }

      // Registered in both modes: token sign-in works either way.
      registerSeedingRoutes()

      if (!config.networkWideAdmin) {
        networkWide = false
        active = true
        // Switching this mode on revokes nothing: a cookie seeded while every
        // device was admin is a valid admin JWT the server itself verifies.
        app.setPluginStatus(
          'Token sign-in only — a browser holding a sign-in token is signed in as its user. ' +
            'Browsers this plugin signed in as admin before stay admin until their cookie ' +
            'expires or is cleared (/signalk-autologin/session?logout=1 in that browser).'
        )
        return
      }

      const secConf = strategy.getConfiguration()
      const adminUsername = resolveAdminUsername(secConf, config.adminUser)
      if (!adminUsername) {
        app.setPluginError(
          'Inactive: no admin user exists. Create an admin user in Security → Users first, then restart this plugin.'
        )
        return
      }

      const token = mintAdminToken(secConf.secretKey, adminUsername)
      currentToken = token
      currentAdminUser = adminUsername

      state = applyStrategyMutations(
        strategy,
        secConf,
        adminUsername,
        token,
        config.enableReadonlyFallback
      )
      networkWide = true
      active = true

      app.setPluginStatus(
        `Autologin active — every device is admin "${adminUsername}". Trusted networks only.`
      )
    },

    stop() {
      active = false
      networkWide = false
      const strategy = appWithSecurity.securityStrategy
      if (strategy && state) {
        restoreStrategyMutations(strategy, strategy.getConfiguration(), state)
      }
      state = undefined
      currentToken = undefined
      currentAdminUser = undefined
      app.setPluginStatus('Stopped — original authentication restored.')
    },

    registerWithRouter(router: IRouter) {
      // Behind admin auth (mounted at /plugins/signalk-autologin). Used by the
      // config panel to show resolved state.
      router.get('/status', (_req: Request, res: Response) => {
        res.json({
          active,
          mode: networkWide ? 'network-wide' : 'token',
          adminUser: currentAdminUser ?? null,
          seedUrl: '/signalk-autologin/session',
          tokenSeedUrl: '/signalk-autologin/seed',
          logoutUrl: '/signalk-autologin/session?logout=1'
        })
      })
    }
  }

  return plugin
}
