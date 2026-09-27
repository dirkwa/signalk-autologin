# signalk-autologin

Convenience **autologin** for Signal K Server. When enabled, every device that can reach the
server is treated as an authenticated **admin** — no login, regardless of device. It is the
modern, per-install replacement for the old "security off" mode: you keep the full security
subsystem in place and simply toggle credential-free admin access on a trusted network.

> ## ⚠️ WARNING — this defeats authentication
>
> Every device that can reach this server is granted full **ADMIN** access with no login.
> Only use on a trusted, isolated network (e.g. the boat's own Wi-Fi). **Do NOT enable on any
> server exposed to the internet or an untrusted LAN.** Disable this plugin to restore normal
> per-user login.

## How it works

Signal K's HTTP and WebSocket authentication both accept a `JAUTHENTICATION` session cookie
holding a JWT that the server signs with its own secret key. This plugin mints such a token for
an existing **admin** user and hands it to your browser through an unauthenticated seeding
endpoint. From then on, every HTTP request and the WebSocket handshake verify that cookie
through the server's normal path and resolve to admin — no server patching required.

The plugin **never creates users** and **never writes to `security.json`**. It reuses an
existing admin identity and makes only in-memory, fully-reversible changes while enabled.

## Usage

1. Install the plugin. It is **enabled by default** on install.
2. Ensure at least one **admin** user exists (Security → Users). If none exists, the plugin
   stays inert and says so in its status line.
3. Navigate to the server (or open the plugin config and click **Seed this browser now**). Your
   browser receives the admin cookie and lands in the Admin UI already logged in.

To turn it off, **disable the plugin**. Original authentication behaviour is restored and any
in-memory changes are reverted. Use **Clear autologin cookie** in the config panel (or visit
`/signalk-autologin/session?logout=1`) to remove the cookie from a browser.

## Configuration

- **Grant admin to every device** — on (default) grants admin to every device as described
  above. Off: only token sign-in (see below), and the two settings that follow have no effect.
  Turning it off signs out no browser: one this plugin already signed in holds an admin cookie
  the server itself accepts, until the cookie expires (Chromium caps it at 400 days) or
  **Clear autologin cookie** removes it in that browser.
- **Admin user to authenticate as** — the existing admin user whose identity every device is
  granted. Leave blank to auto-pick the first admin user.
- **Allow read-only access without the autologin cookie** — when on (default), a device that
  has not yet been seeded can still read data (no writes, no admin). Reverted on disable.

## Token sign-in (kiosks)

Turn **Grant admin to every device** off and the plugin stops signing anyone in by itself.
It then only signs in a browser that presents a sign-in token — a JWT the server issued for an
existing user — and only as that user. Every other device logs in normally. This is how the
[universal installer's `signalk kiosk`](https://github.com/dirkwa/signalk-universal-installer/blob/master/docs/kiosk.md)
gets a keyboard-less screen past the login form without opening admin to the whole network.

A browser signs in by opening:

```text
/signalk-autologin/seed#token=<token>&next=/@signalk/freeboard-sk/
```

The token rides in the URL **fragment**, which the browser never sends to the server — as a
query string it would land in the server's request log, and from there in shared bug-report
bundles. The page removes the fragment from the address bar, sends the token to
`POST /signalk-autologin/session` in an `Authorization: Bearer` header, and the response sets
the httpOnly session cookie. The plugin checks the token the way the server checks the cookie
on every later request: signed with this server's secret, not expired, naming a user that still
exists. `next` must be a path on this server; anything else lands on `/`.

Mint a token for a user with `signalk-generate-token -u <user> -e 10y -s <path to security.json>`.
Deleting the user revokes every token issued for it. A token names the user and nothing else, so
once a user of the same name exists again, tokens issued before work again.

The access is exactly the user's: a `readwrite` user can use webapps such as Freeboard-SK with
live data, but the Admin UI shows its login form for anyone who is not admin, because it treats
the first 401 from its admin-only calls as a logged-out session.

Chromium caps a cookie's lifetime at 400 days, so a kiosk should open `/seed` at every browser
start rather than rely on the cookie; `signalk kiosk` does.

## The one limitation

The server's HTTP authentication gate runs **before** any plugin, so the very first request
from a brand-new browser that carries no cookie and has never hit `/signalk-autologin/session`
cannot be retroactively authorized for admin/write routes. Navigating to the server seeds the
cookie on that first hit and redirects into the Admin UI, so in practice browsers "just work".
A raw API or WebSocket client that never sends the cookie and never hits the seeding endpoint
must present the cookie or a token itself. Read-only paths work immediately when the read-only
fallback is enabled.

## Requirements

- Signal K Server **≥ 2.27.0** (the config panel uses the host's shared React instance,
  available from that version).

## License

signalk-autologin 1.0.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in non-commercial education and research; and provide professional
services to others who use it under these terms.

**You may not**: redistribute modified versions or derivative works, or publish
them to npm or anywhere else. Unmodified official releases may be mirrored,
cached and redistributed verbatim as long as the notices stay intact and the
license terms are included.

Versions 0.1.0 and earlier remain available under the Apache-2.0 license
(see [LICENSE-Apache-2.0-through-v0.x.txt](LICENSE-Apache-2.0-through-v0.x.txt)).
