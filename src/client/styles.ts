/**
 * Design-token styles for the Proxy settings section.
 *
 * The plugin is external (not part of the DSH repository), so it cannot import
 * the built-in CSS modules; instead it re-declares the same rules against the
 * shared `--dsw-alias-*` tokens, namespaced under `dsh-proxy-` to avoid any
 * collision with host styles. Injected once at module evaluation, tagged by
 * plugin id so repeated mounts stay idempotent.
 */

export const PROXY_STYLES = `
.dsh-proxy-section { display: flex; flex-direction: column; gap: 20px; max-width: 720px; padding: 4px 2px 20px; }
.dsh-proxy-group { display: flex; flex-direction: column; gap: 10px; }
.dsh-proxy-group > h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-proxy-group > p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-proxy-upstream { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l3); }
.dsh-proxy-row { display: flex; align-items: center; gap: 8px; }
.dsh-proxy-check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; }
.dsh-proxy-check input { accent-color: var(--dsw-alias-button-primary-fill); cursor: pointer; }
.dsh-proxy-proto { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsh-proxy-selector { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 10px; border: none; border-radius: 16px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.dsh-proxy-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-proxy-selector:disabled { opacity: 0.6; cursor: default; }
.dsh-proxy-inputs { display: grid; grid-template-columns: 1fr 120px; gap: 8px; }
.dsh-proxy-inputs input { width: 100%; }
.dsh-proxy-search { margin-bottom: 4px; }
.dsh-proxy-hostlist { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; scrollbar-width: none; }
.dsh-proxy-hostlist::-webkit-scrollbar { display: none; }
.dsh-proxy-host { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dsh-proxy-host:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-proxy-host input { accent-color: var(--dsw-alias-button-primary-fill); cursor: pointer; }
.dsh-proxy-host-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-proxy-host-route { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-proxy-empty { padding: 16px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-proxy-actions { display: flex; align-items: center; gap: 12px; }
.dsh-proxy-status { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-proxy-status-ok { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary)); }
.dsh-proxy-status-err { color: var(--dsw-alias-state-error-primary); }
.dsh-proxy-heading { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
.dsh-proxy-heading h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-proxy-heading .dsh-proxy-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
`

/**
 * Inject {@link PROXY_STYLES} once, tagged by plugin id so re-evaluation
 * and repeated mounts stay idempotent (mirrors how the loader handles plugin
 * CSS). Called from the client `apply`.
 */
export function injectProxyStyles(pluginId: string): void {
  if (typeof document === 'undefined') return
  const selector = `style[data-dsh-plugin-css="${pluginId}"]`
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-dsh-plugin-css', pluginId)
  tag.textContent = PROXY_STYLES
  document.head.appendChild(tag)
}

// Inject at module evaluation rather than from an `apply` closure. The loader
// executes this factory after the DOM head exists, and a module-top-level call
// is a preserved side effect: the whole module cannot be tree-shaken away
// leaving a dangling reference, which is what a closure-only use allowed
// rolldown to do.
injectProxyStyles('dsh-proxy')
