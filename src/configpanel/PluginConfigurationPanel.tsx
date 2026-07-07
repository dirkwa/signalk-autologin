import React, { CSSProperties, useCallback, useEffect, useState } from 'react'

interface PluginConfig {
  adminUser?: string
  enableReadonlyFallback?: boolean
}

interface PluginConfigurationPanelProps {
  /** Persisted plugin config from the Signal K admin host. May be partial
   *  during first-time setup before the user has saved anything. */
  configuration: Partial<PluginConfig>
  /** Persistence callback supplied by the host. Signal K's admin UI invokes
   *  the plugin's start() after this; the panel doesn't await it. */
  save: (next: Partial<PluginConfig>) => void
}

interface StatusResponse {
  active: boolean
  adminUser: string | null
  seedUrl: string
  logoutUrl: string
}

const S: Record<string, CSSProperties> = {
  root: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0',
    maxWidth: 720
  },
  warn: {
    border: '2px solid #c0392b',
    background: '#fdecea',
    color: '#7b241c',
    borderRadius: 8,
    padding: '14px 16px',
    marginBottom: 20,
    lineHeight: 1.45
  },
  warnTitle: {
    fontWeight: 700,
    fontSize: 15,
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 8
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 10,
    marginTop: 24
  },
  field: { marginBottom: 16 },
  label: { display: 'block', fontWeight: 600, marginBottom: 4 },
  hint: { color: '#777', fontSize: 13, marginTop: 4 },
  input: {
    padding: '6px 10px',
    border: '1px solid #ccc',
    borderRadius: 6,
    minWidth: 260,
    fontSize: 14
  },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    borderRadius: 6,
    border: '1px solid #2f7dd1',
    background: '#2f7dd1',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none'
  },
  btnGhost: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    borderRadius: 6,
    border: '1px solid #999',
    background: '#fff',
    color: '#444',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none'
  },
  btnRow: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' },
  status: {
    background: '#f4f6f8',
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 14
  },
  note: {
    color: '#555',
    fontSize: 13,
    lineHeight: 1.5,
    marginTop: 20,
    borderTop: '1px solid #eee',
    paddingTop: 14
  }
}

const STATUS_URL = '/plugins/signalk-autologin/status'

export default function PluginConfigurationPanel({
  configuration,
  save
}: PluginConfigurationPanelProps): React.ReactElement {
  const [adminUser, setAdminUser] = useState<string>(
    configuration.adminUser ?? ''
  )
  const [readonlyFallback, setReadonlyFallback] = useState<boolean>(
    configuration.enableReadonlyFallback ?? true
  )
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [saved, setSaved] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(STATUS_URL, { credentials: 'include' })
      if (res.ok) {
        setStatus((await res.json()) as StatusResponse)
      }
    } catch {
      // panel is best-effort; leave status null on failure
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const onSave = useCallback(() => {
    save({
      adminUser: adminUser.trim(),
      enableReadonlyFallback: readonlyFallback
    })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2500)
    window.setTimeout(() => void refreshStatus(), 1500)
  }, [adminUser, readonlyFallback, save, refreshStatus])

  const seedUrl = status?.seedUrl ?? '/signalk-autologin/session'
  const logoutUrl = status?.logoutUrl ?? '/signalk-autologin/session?logout=1'

  return (
    <div style={S.root}>
      <div style={S.warn}>
        <div style={S.warnTitle}>⚠️ Convenience autologin is ACTIVE</div>
        Every device that can reach this server is granted full{' '}
        <strong>ADMIN</strong> access with no login. Only use on a trusted,
        isolated network (e.g. the boat&apos;s own Wi-Fi). Do{' '}
        <strong>NOT</strong> enable on any server exposed to the internet or an
        untrusted LAN. Disable this plugin to restore normal per-user login.
      </div>

      <div style={S.status}>
        {status ? (
          status.active ? (
            <span>
              Status: <strong>active</strong> — every device is admin as{' '}
              <strong>{status.adminUser}</strong>.
            </span>
          ) : (
            <span>
              Status: <strong>inactive</strong>. Either security is disabled or
              no admin user exists — see the plugin status message above.
            </span>
          )
        ) : (
          <span>Loading status…</span>
        )}
      </div>

      <div style={S.sectionTitle}>Settings</div>

      <div style={S.field}>
        <label style={S.label} htmlFor="adminUser">
          Admin user to authenticate as
        </label>
        <input
          id="adminUser"
          style={S.input}
          type="text"
          value={adminUser}
          placeholder="(auto-pick first admin user)"
          onChange={(e) => setAdminUser(e.target.value)}
        />
        <div style={S.hint}>
          Existing admin user whose identity every device is granted. Leave
          blank to auto-pick the first admin user. The plugin never creates
          users and never writes to security.json.
        </div>
      </div>

      <div style={S.field}>
        <label style={S.row}>
          <input
            type="checkbox"
            checked={readonlyFallback}
            onChange={(e) => setReadonlyFallback(e.target.checked)}
          />
          <span style={{ fontWeight: 600 }}>
            Allow read-only access without the autologin cookie
          </span>
        </label>
        <div style={S.hint}>
          A device that has not yet been granted the autologin cookie can still
          read data (no writes, no admin). Reverted when the plugin is disabled.
        </div>
      </div>

      <div style={S.btnRow}>
        <button type="button" style={S.btn} onClick={onSave}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
        <a style={S.btnGhost} href={seedUrl}>
          Seed this browser now
        </a>
        <a style={S.btnGhost} href={logoutUrl}>
          Clear autologin cookie
        </a>
      </div>

      <div style={S.note}>
        <strong>How it works.</strong> The plugin gives your browser a
        long-lived admin session cookie via an unauthenticated endpoint, then
        every HTTP request and WebSocket connection is treated as admin.
        <br />
        <br />
        <strong>One limitation.</strong> The very first request from a brand-new
        browser that carries no cookie and has never hit{' '}
        <code>/signalk-autologin/session</code> cannot be retroactively made
        admin on admin/write routes — the server&apos;s HTTP auth gate runs
        before any plugin. Navigating to the server (or clicking{' '}
        <em>Seed this browser now</em>) sets the cookie; from then on all
        traffic is admin. &quot;Clear autologin cookie&quot; removes it from
        this browser.
      </div>
    </div>
  )
}
