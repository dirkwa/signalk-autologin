import { Type, Static } from '@sinclair/typebox'

export const ConfigSchema = Type.Object({
  adminUser: Type.String({
    default: '',
    title: 'Admin user to authenticate as',
    description:
      'Existing admin user whose identity every device is granted. ' +
      'Leave blank to auto-pick the first admin user in the security config. ' +
      'The plugin never creates users and never writes to security.json.'
  }),
  enableReadonlyFallback: Type.Boolean({
    default: true,
    title: 'Allow read-only access without the autologin cookie',
    description:
      'When enabled (default), a device that has not yet been granted the ' +
      'autologin cookie can still read data (no writes, no admin). This is ' +
      'a temporary in-memory change reverted when the plugin is disabled.'
  })
})

export type Config = Static<typeof ConfigSchema>

// SignalK uses schema `default` only to seed the config form, not the runtime
// config object — deep-merge these in start().
export const SCHEMA_DEFAULTS: Config = {
  adminUser: '',
  enableReadonlyFallback: true
}
