# signalk-autologin

A Signal K Server plugin that grants **every device admin access without a login** while it
is enabled. It is the modern, per-install replacement for the old "security off" mode: the
full security subsystem stays in place, and this plugin flips credential-free admin access on
for a trusted network (e.g. a boat's own Wi-Fi).

**This plugin deliberately defeats authentication.** Treat that as the central design
constraint in every change: anything that widens the blast radius, persists a bypass, or
leaves state behind after `stop()` is a bug, not a feature.

## How it actually works (and why it can't work any other way)

The single most important fact about this repo lives in the _server_, not here. Signal K's
auth enforcement (`xxx_signalk-server/src/tokensecurity.ts`, `src/interfaces/ws.ts`) is
structured so that a plugin **cannot** transparently intercept it:

- **HTTP auth is a closure, not a swappable method.** `http_authorize()` and the admin/write
  gates (`adminAuthenticationMiddleware`, `writeAuthenticationMiddleware`) are closures created
  at boot and registered on `/`, `/plugins`, `/security`, the API paths, etc. **before any
  plugin starts**. A plugin's `app.use()` lands _after_ them in the chain, so it can neither
  replace them nor pre-empt a 401. Do not attempt to monkey-patch these — they are unreachable.
- **WS `authorizeWS` is captured by value at boot.** `ws.ts` reads `securityStrategy.authorizeWS`
  once and captures the function reference into the primus authorize closure. Reassigning
  `strategy.authorizeWS` afterwards does **not** reach the primary WS handshake.

**The only lever that reaches both HTTP and WS is the session cookie.** Both gates independently
`jwt.verify(token, secretKey)` then map the JWT `id` to an existing user via `getPrincipal`.
So the plugin:

1. Mints an admin JWT — `jwt.sign({ id: adminUsername }, secretKey, { expiresIn: '10y' })` —
   using the live `secretKey` read from `app.securityStrategy.getConfiguration()` (which returns
   the live `options` object **by reference**) and an **existing** admin user's name.
2. Seeds it as the `JAUTHENTICATION` cookie via an **un-gated** route registered on the live
   Express app (`/signalk-autologin/session`). That path is reachable cookie-less because
   `http_authorize` at `/` (forLoginStatus mode) calls `next()` rather than 401 for non-admin
   paths. The route sets the cookie and redirects to `/admin/`, so a fresh browser lands already
   admin. Both HTTP and the WS handshake (which reads `req.cookies.JAUTHENTICATION`) then verify
   it through the server's normal path — no server patching.

Defensive extras, all in-memory and reverted on `stop()`: flip `allow_readonly = true` so
cookie-less reads resolve, and wrap the mutable `authorizeWS` + `getLoginStatus` (the latter is
cosmetic — it makes the Admin UI show "logged in").

**The honest limitation** (documented in README + panel): a raw API/WS client that never carries
the cookie and never hits the seeding endpoint cannot be rescued on its first admin/write
request — the HTTP gate runs before any plugin. Browsers "just work" because navigating to the
server seeds the cookie. Do not try to "fix" this from plugin space; it is architectural.

## Architecture rules you must keep in mind

- **Never write to `security.json`.** Only mutate the in-memory `options` returned by
  `getConfiguration()`. Do not call `setConfig`/`saveSecurityConfig`. Uninstalling the plugin
  must leave the security config byte-for-byte unchanged.
- **Never create users.** The plugin reuses an existing admin identity. If no admin user exists,
  it stays inert with a clear status message (`setPluginError`) and makes zero changes.
- **`stop()` must fully restore original behaviour.** Capture originals in `applyStrategyMutations`
  before mutating; restore in `restoreStrategyMutations` with an **identity guard** (only restore
  a wrapped method if our wrapper is still the installed one, so a later wrapper from another
  plugin is never clobbered). `allow_readonly` is restored to its captured original.
- **The seeding routes can't be unregistered.** Express has no public `app.unuse`, so the route
  handlers guard on the module-scoped `active` flag and no-op (just redirect, no cookie) once the
  plugin is stopped. Register them exactly once per process (`routesRegistered` guard) so a
  start→stop→start cycle does not double-register.
- **The cookie recipe must mirror the server's `setSessionCookie`.** `JAUTHENTICATION` is
  httpOnly; `skLoginInfo` is non-httpOnly; both `sameSite: 'strict'`, `secure` matching the
  request (`req.secure || x-forwarded-proto === 'https'`), long `maxAge`. If the server changes
  its cookie names or options, mirror the change here.

## TypeScript

- All source is strict ESM TypeScript. Because the plugin is `module: node16`, **relative imports
  must carry the `.js` extension** (e.g. `import { x } from './autologin.js'`) even though the
  source is `.ts`.
- `@signalk/server-api`'s `ServerAPI` does **not** type `securityStrategy` — it is present on the
  runtime app object but untyped for plugins. Reach it via a narrow local interface plus a cast
  (`app as AppWithSecurity`), and declare only the strategy members this plugin reads/mutates
  (see `src/autologin.ts`). Keep those shapes in sync with the server's `tokensecurity.ts` /
  `security.ts` — they are the source of truth.
- `src/autologin.ts` is deliberately free of Express so its token-mint and save/wrap/restore logic
  stay unit-testable in isolation.

## Config panel (React 19, Vite + Module Federation)

- The panel is a federated remote exposing `./PluginConfigurationPanel`, discovered by the
  `signalk-plugin-configurator` keyword. It receives `{ configuration, save }` and owns its own
  save.
- **React is shared via the host-shim, not MF `shared`.** `vite.config.ts` aliases `react`,
  `react-dom`, `react-dom/client`, and `react/jsx-runtime` to the shim modules in
  `src/configpanel/host-shim/`, which re-export the host Admin UI's React from
  `globalThis.__SK_REACT__`. This avoids the vite-MF + React 19 hook-dispatcher mismatch
  ("Cannot read properties of null (reading 'useState')"). Do **not** add react to MF `shared` or
  bundle it — verify after any panel build that `public/` contains `__SK_REACT__` (shim present)
  and not a second React copy.
- Requires **signalk-server ≥ 2.27.0** (the version that exposes `window.__SK_REACT__`). Reflect
  that in `engines.signalk`.
- The panel and its host-shim are excluded from `tsc` (see `tsconfig.json` `exclude`) — Vite/esbuild
  transpiles the TSX. `tsc` only builds the plugin core under `src/` (minus `src/configpanel`).

## Build

- `npm run build` = `build:plugin` (`tsc` → `plugin/`) then `build:config` (`vite build` →
  `public/`). `main` is `plugin/index.js`.
- `plugin/` and `public/` are generated output — gitignored, but **shipped** in the npm tarball
  (see `files` in package.json). Do not commit them; do not exclude them from the tarball.
- Auto-enable on install is the top-level package.json field `"signalk-plugin-enabled-by-default":
true` — a boolean field, **not** a keyword.

## Local verification

There is no automated test suite yet; verify against a throwaway security-enabled server:

1. Create a disk-backed config dir (not `/tmp` — that's tmpfs on trixie) with a `security.json`
   (`strategy: "@signalk/sk-simple-token-security"`, one `type:'admin'` user, bcryptjs-hashed
   password) and `settings.json`. Symlink this repo into `<configdir>/node_modules/signalk-autologin`.
2. Start the server: `PORT=<port> <server>/bin/signalk-server -c <configdir>`.
3. Confirm: auto-enable (plugin-config-data shows `enabled:true`); cookie-less admin route → 401,
   read → 200 (allow_readonly), `GET /signalk-autologin/session` → 302 + `Set-Cookie`; with the
   cookie admin routes → 200 and a WS PUT → 405 (authorized) vs 403 without; disable → cookie-less
   read back to 401 and the seed route sets no cookie; `security.json` byte-unchanged.

## File layout

```
src/
  index.ts                      plugin entry — start/stop, un-gated seeding+bootstrap routes,
                                  registerWithRouter status endpoint
  autologin.ts                  token mint + strategy save/wrap/restore (Express-free, testable)
  config/schema.ts              typebox ConfigSchema + Config + SCHEMA_DEFAULTS
  configpanel/
    PluginConfigurationPanel.tsx  React 19 panel (red security banner, seed/clear buttons)
    host-shim/                    re-export host React via globalThis.__SK_REACT__ (4 shims + types.d.ts)
plugin/                         tsc output (generated, gitignored, shipped)
public/                         vite MF output remoteEntry.js + configpanel-entry.js (generated, shipped)
app-icon.svg                    logo referenced by signalk.appIcon
```

## Workflow Conventions

Maintained by Dirk Wahrheit. Follow strictly.

- Branch names use **hyphens**, never slashes (`feat-something`).
- **Angular conventional commits**: `<type>(<scope>): <subject>`, ≤50-char imperative subject,
  no period. Types: `feat|fix|docs|style|refactor|test|chore|perf`.
- No `Co-Authored-By` lines, no "Generated with Claude Code" attribution anywhere.
- One logical change per commit / PR. Version bumps go in their own `chore(release): X.Y.Z`.
- Never commit unasked; never push or publish without explicit approval.
- **NEVER change the version number** except in a deliberate release-bump commit.

### Pre-PR / pre-push checklist

1. `npm run format` — prettier `--write` + eslint `--fix`.
2. `npm run build` — `tsc` + `vite build` must both succeed; sanity-check the panel bundle did
   not bundle its own React (host-shim present).
3. `npm run lint` — read-only verification of step 1.
4. Verify the plugin end-to-end against a security-enabled server (see Local verification).

Only push after all pass, and only with explicit approval.
