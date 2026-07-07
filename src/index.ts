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
  mintAdminToken,
  resolveAdminUsername,
  restoreStrategyMutations,
  type AutologinState,
  type SecurityStrategy
} from './autologin.js'

const PLUGIN_ID = 'signalk-autologin'

// Matches the server's cookie names (src/tokensecurity.ts).
const AUTH_COOKIE = 'JAUTHENTICATION'
const LOGININFO_COOKIE = 'skLoginInfo'
// ~10 years — the convenience cookie effectively never expires while enabled.
const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000

// The un-gated seeding routes are registered on the live Express app exactly
// once per process. Express has no public `app.unuse`, so the handlers guard
// on the module-scoped `active` flag and no-op when the plugin is stopped.
let routesRegistered = false
let active = false
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
    if (!active) {
      res.redirect('/admin/')
      return
    }
    if (req.query.logout === '1') {
      clearCookies(res)
    } else {
      seedCookies(req, res)
    }
    res.redirect('/admin/')
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
    routesRegistered = true
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Autologin (admin)',
    description:
      'Grants every device admin access without a login. The modern ' +
      'replacement for security-off. Trusted networks only.',
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

      registerSeedingRoutes()
      state = applyStrategyMutations(
        strategy,
        secConf,
        adminUsername,
        token,
        config.enableReadonlyFallback
      )
      active = true

      app.setPluginStatus(
        `Autologin active — every device is admin "${adminUsername}". Trusted networks only.`
      )
    },

    stop() {
      active = false
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
          adminUser: currentAdminUser ?? null,
          seedUrl: '/signalk-autologin/session',
          logoutUrl: '/signalk-autologin/session?logout=1'
        })
      })
    }
  }

  return plugin
}
