import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  resolveAdminUsername,
  mintAdminToken,
  applyStrategyMutations,
  restoreStrategyMutations,
  type SecurityConfiguration,
  type SecurityStrategy,
  type WSRequest,
  type AuthorizeWS,
  type GetLoginStatus
} from '../src/autologin.js'

function makeConfig(
  overrides: Partial<SecurityConfiguration> = {}
): SecurityConfiguration {
  return {
    secretKey: 'test-secret-key',
    users: [
      { username: 'admin', type: 'admin' },
      { username: 'bob', type: 'readonly' }
    ],
    allow_readonly: false,
    ...overrides
  }
}

describe('resolveAdminUsername', () => {
  it('uses the preferred user when it exists and is admin', () => {
    const config = makeConfig({
      users: [
        { username: 'admin', type: 'admin' },
        { username: 'skipper', type: 'admin' }
      ]
    })
    expect(resolveAdminUsername(config, 'skipper')).toBe('skipper')
  })

  it('falls back to the first admin when the preferred user is not admin', () => {
    expect(resolveAdminUsername(makeConfig(), 'bob')).toBe('admin')
  })

  it('falls back to the first admin when preferred is blank', () => {
    expect(resolveAdminUsername(makeConfig(), '')).toBe('admin')
    expect(resolveAdminUsername(makeConfig(), '   ')).toBe('admin')
  })

  it('returns undefined when no admin user exists', () => {
    const config = makeConfig({
      users: [{ username: 'bob', type: 'readonly' }]
    })
    expect(resolveAdminUsername(config, '')).toBeUndefined()
  })
})

describe('mintAdminToken', () => {
  it('signs a token that verifies with the same secret and maps to the admin id', () => {
    const token = mintAdminToken('a-secret', 'admin')
    const decoded = jwt.verify(token, 'a-secret') as { id: string; exp: number }
    expect(decoded.id).toBe('admin')
    // long-lived: expiry is far in the future
    expect(decoded.exp * 1000).toBeGreaterThan(
      Date.now() + 365 * 24 * 3600 * 1000
    )
  })

  it('does not verify against a different secret', () => {
    const token = mintAdminToken('a-secret', 'admin')
    expect(() => jwt.verify(token, 'other-secret')).toThrow()
  })
})

function makeStrategy(config: SecurityConfiguration): {
  strategy: SecurityStrategy
  originalAuthorizeWS: AuthorizeWS
  originalGetLoginStatus: GetLoginStatus
} {
  const originalAuthorizeWS: AuthorizeWS = (req: WSRequest) => {
    req.skPrincipal = { identifier: 'orig', permissions: 'readonly' }
  }
  const originalGetLoginStatus: GetLoginStatus = () => ({
    status: 'notLoggedIn'
  })
  return {
    strategy: {
      isDummy: () => false,
      getConfiguration: () => config,
      authorizeWS: originalAuthorizeWS,
      getLoginStatus: originalGetLoginStatus
    },
    originalAuthorizeWS,
    originalGetLoginStatus
  }
}

describe('applyStrategyMutations / restoreStrategyMutations', () => {
  it('grants admin over WS and flips allow_readonly, then fully restores', () => {
    const config = makeConfig()
    const { strategy, originalAuthorizeWS, originalGetLoginStatus } =
      makeStrategy(config)

    const state = applyStrategyMutations(strategy, config, 'admin', 'tok', true)

    // allow_readonly flipped on
    expect(config.allow_readonly).toBe(true)

    // wrapped authorizeWS grants admin (and still calls the original)
    const req: WSRequest = {}
    strategy.authorizeWS!(req)
    expect(req.skPrincipal).toEqual({
      identifier: 'admin',
      permissions: 'admin'
    })
    expect(req.skIsAuthenticated).toBe(true)

    // getLoginStatus reports admin loggedIn
    expect(strategy.getLoginStatus!({})).toMatchObject({
      status: 'loggedIn',
      userLevel: 'admin',
      username: 'admin'
    })

    restoreStrategyMutations(strategy, config, state)

    expect(config.allow_readonly).toBe(false)
    expect(strategy.authorizeWS).toBe(originalAuthorizeWS)
    expect(strategy.getLoginStatus).toBe(originalGetLoginStatus)
  })

  it('leaves allow_readonly untouched when the fallback is disabled', () => {
    const config = makeConfig({ allow_readonly: false })
    const { strategy } = makeStrategy(config)
    const state = applyStrategyMutations(
      strategy,
      config,
      'admin',
      'tok',
      false
    )
    expect(config.allow_readonly).toBe(false)
    restoreStrategyMutations(strategy, config, state)
    expect(config.allow_readonly).toBe(false)
  })

  it('does not clobber a later wrapper installed on top of ours', () => {
    const config = makeConfig()
    const { strategy } = makeStrategy(config)
    const state = applyStrategyMutations(strategy, config, 'admin', 'tok', true)

    // Another plugin wraps authorizeWS after us.
    const laterWrapper: AuthorizeWS = () => {}
    strategy.authorizeWS = laterWrapper

    restoreStrategyMutations(strategy, config, state)

    // identity guard: our restore must not overwrite the newer wrapper
    expect(strategy.authorizeWS).toBe(laterWrapper)
  })
})
