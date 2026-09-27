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

// ---------------------------------------------------------------------------
// Token sign-in: a browser that holds a token for an existing user (a kiosk
// set up by the universal installer's `signalk kiosk`) is signed in as that
// user alone. Works with or without the network-wide admin grant above.
// ---------------------------------------------------------------------------

// Where to send the browser after seeding: an absolute path on this server,
// or the fallback. Anything with a scheme, a protocol-relative `//host`, or a
// backslash (browsers read `/\host` as `//host`) would turn the seeding
// routes into an open redirect, as would control characters.
export function safeNextPath(next: unknown, fallback: string): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 2048) {
    return fallback
  }
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return fallback
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) {
    return fallback
  }
  return next
}

// The token from an `Authorization: Bearer <token>` header.
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') {
    return undefined
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : undefined
}

// The user a sign-in token names — when the server's own secret signed it,
// it has not expired, and that user still exists. The server applies the same
// checks to the cookie on every later request; running them here rejects a
// bad token at sign-in instead of planting a cookie that fails on the next
// page load.
export function verifyUserToken(
  token: string,
  config: SecurityConfiguration
): string | undefined {
  let payload: unknown
  try {
    payload = jwt.verify(token, config.secretKey)
  } catch {
    return undefined
  }
  const id =
    typeof payload === 'object' && payload !== null
      ? (payload as { id?: unknown }).id
      : undefined
  if (typeof id !== 'string' || id === '') {
    return undefined
  }
  return (config.users ?? []).some((u) => u.username === id) ? id : undefined
}
