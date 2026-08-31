/**
 * Proxy settings plugin (DSH Smoothly Proxy / DSH SP), browser half (external,
 * not part of the DSH repository). Registers a Settings page that configures
 * the loopback forward proxy for model providers (upstream proxy + per-host
 * routing), reading and writing <DSH_HOME>/proxy.json through the host half's
 * /proxy/api route. It rides the same `settings.section` slot seam the
 * built-in Models page uses, so official updates to the repository never touch
 * it.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ProxySection, type ProxySectionInjected } from './ProxySection.tsx'
// Side-effect import: injects the design-token styles at module evaluation
// (module-top-level side effects survive tree-shaking, unlike a closure-only
// call, which rolldown dropped and crashed the whole web client).
import './styles.ts'
import { en, zh, type ProxyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Proxy settings page copy. */
    'dsh-proxy': ProxyKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-proxy'

/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings; registration depends on it through `slots.inject()`. */
export const inject = ['slots', 'locale']

/**
 * Register the Proxy section once the `settings.section` declaration is on
 * the ledger. No settingsScope/connection: the section talks to the host
 * half's /proxy/api route with plain same-origin fetch.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy: copy dictionaries')

  const t = ctx.locale.bind(NS) as ProxySectionInjected['t']
  const injected = (): ProxySectionInjected => ({ t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-proxy',
    order: 25,
    label: () => t('nav'),
    inject: injected,
  }, ProxySection))
}
