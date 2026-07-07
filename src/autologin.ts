import jwt from 'jsonwebtoken'

// ---------------------------------------------------------------------------
// Minimal shapes of the server's (untyped-to-plugins) security strategy.
// Only the members this plugin reads or mutates are declared. Sourced from
// signalk-server src/tokensecurity.ts + src/security.ts.
// ---------------------------------------------------------------------------

export interface SecurityUser {
  username: string
  type: string // 'admin' | 'readwrite' | 'readonly'
}

export interface SecurityConfiguration {
  secretKey: string
  users: SecurityUser[]
  allow_readonly: boolean
  expiration?: string
}

export interface WSRequest {
  skPrincipal?: { identifier: string; permissions: string }
  skIsAuthenticated?: boolean
}

export type AuthorizeWS = (req: WSRequest) => void
export type GetLoginStatus = (req: unknown) => Record<string, unknown>

export interface SecurityStrategy {
  isDummy?: () => boolean
  getConfiguration: () => SecurityConfiguration
  authorizeWS?: AuthorizeWS
  getLoginStatus?: GetLoginStatus
}

// The JAUTHENTICATION payload the server signs on login is simply { id }.
// A long expiry mirrors the server's rememberMe '10y' default so the
// convenience cookie effectively never expires while the plugin is enabled.
const TOKEN_EXPIRY = '10y'

export function resolveAdminUsername(
  config: SecurityConfiguration,
  preferred: string
): string | undefined {
  const users = config.users ?? []
  const wanted = preferred.trim()
  if (wanted) {
    const match = users.find((u) => u.username === wanted && u.type === 'admin')
    if (match) {
      return match.username
    }
  }
  return users.find((u) => u.type === 'admin')?.username
}

export function mintAdminToken(
  secretKey: string,
  adminUsername: string
): string {
  return jwt.sign({ id: adminUsername }, secretKey, { expiresIn: TOKEN_EXPIRY })
}

// ---------------------------------------------------------------------------
// Reversible mutation of the live strategy. Captures originals up front and
// restores them identity-guarded on teardown, so a later wrapper (another
// plugin) is never clobbered and security.json is never touched.
// ---------------------------------------------------------------------------

export interface AutologinState {
  adminUsername: string
  token: string
  readonlyFallback: boolean
  originalAllowReadonly: boolean
  originalAuthorizeWS?: AuthorizeWS
  wrappedAuthorizeWS?: AuthorizeWS
  originalGetLoginStatus?: GetLoginStatus
  wrappedGetLoginStatus?: GetLoginStatus
}

export function applyStrategyMutations(
  strategy: SecurityStrategy,
  config: SecurityConfiguration,
  adminUsername: string,
  token: string,
  readonlyFallback: boolean
): AutologinState {
  const state: AutologinState = {
    adminUsername,
    token,
    readonlyFallback,
    originalAllowReadonly: config.allow_readonly,
    originalAuthorizeWS: strategy.authorizeWS,
    originalGetLoginStatus: strategy.getLoginStatus
  }

  if (readonlyFallback) {
    // In-memory only — a cookie-less READ resolves immediately. Reverted on stop.
    config.allow_readonly = true
  }

  // Wrap the mutable authorizeWS. This covers the secondary WS re-auth calls
  // (login / access-request) that read app.securityStrategy.authorizeWS at
  // call time. The primary WS handshake captures the reference by value at
  // boot, so the admin cookie remains essential there — see README.
  const original = state.originalAuthorizeWS
  const wrappedWS: AuthorizeWS = (req: WSRequest) => {
    if (original) {
      try {
        original(req)
      } catch {
        // ignore — we grant admin below regardless of the original outcome
      }
    }
    req.skPrincipal = { identifier: adminUsername, permissions: 'admin' }
    req.skIsAuthenticated = true
  }
  strategy.authorizeWS = wrappedWS
  state.wrappedAuthorizeWS = wrappedWS

  // Cosmetic: make the admin UI's /loginStatus report logged-in so it does not
  // show a login prompt. The cookie is what actually authenticates requests.
  const originalStatus = state.originalGetLoginStatus
  if (originalStatus) {
    const wrappedStatus: GetLoginStatus = (req: unknown) => {
      const base = originalStatus(req)
      return {
        ...base,
        status: 'loggedIn',
        userLevel: 'admin',
        username: adminUsername
      }
    }
    strategy.getLoginStatus = wrappedStatus
    state.wrappedGetLoginStatus = wrappedStatus
  }

  return state
}

export function restoreStrategyMutations(
  strategy: SecurityStrategy,
  config: SecurityConfiguration,
  state: AutologinState
): void {
  // Identity-guard: only restore if our wrapper is still installed, so we
  // never overwrite a newer wrapper another plugin layered on top.
  if (
    state.wrappedAuthorizeWS &&
    strategy.authorizeWS === state.wrappedAuthorizeWS
  ) {
    strategy.authorizeWS = state.originalAuthorizeWS
  }
  if (
    state.wrappedGetLoginStatus &&
    strategy.getLoginStatus === state.wrappedGetLoginStatus
  ) {
    strategy.getLoginStatus = state.originalGetLoginStatus
  }
  if (state.readonlyFallback) {
    config.allow_readonly = state.originalAllowReadonly
  }
}
