/**
 * The "Smoothly Proxy" settings section (external plugin).
 *
 * A companion page to the built-in Models page: it configures a loopback
 * forward proxy that routes model-provider traffic (and any other selected
 * host) through an optional upstream proxy, per host. The host half runs the
 * proxy and serves /proxy/api; this page reads and writes it with plain
 * same-origin fetch (no settingsScope — the proxy config lives in
 * <DSH_HOME>/proxy.json, not in the dsh settings document).
 *
 * UI mirrors the dsh-desktop settings window: upstream card (enabled /
 * protocol selector / host / port / username / password / test connection),
 * a "model providers" list derived from the LIVE settings document, and an "other
 * observed hosts" list, each with a per-host checkbox. A search box filters
 * both lists. Saving writes the config; the running proxy re-reads proxy.json
 * on every request, so changes take effect immediately.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconGlobeOutlineRegular,
  IconLinkOutlineRegular,
  Input,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'

/** One model provider derived from the live settings document by the host. */
export interface ProviderHost {
  name: string
  host: string
  displayName?: string
}

/** The /proxy/api GET view. */
export interface ProxyView {
  ok: boolean
  port: number | null
  /** Listen port in proxy.json now (0 = ephemeral); a change needs a restart. */
  listenPort: number
  /** Port the running listener was asked to bind. */
  portRequested: number
  /** Whether the running listener got the port it asked for. */
  portHonored: boolean
  /** Proxy URL the launch environment named, if any (credentials masked). */
  launchProxy: string | null
  /** Whether dsh's own in-process requests (model calls) ride this proxy. */
  inProcessRouted: boolean
  /** What put dsh's own requests behind this proxy, or why nothing did. */
  egressStatus: 'self-installed' | 'launcher' | 'unavailable'
  /** Reason for a non-routing status; shown to the user. */
  egressDetail: string | null
  upstream: UpstreamDraft
  proxiedHosts: string[]
  knownHosts: string[]
  hosts: string[]
  providers: ProviderHost[]
}

/** Upstream draft as edited in the form. */
export interface UpstreamDraft {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string
  password: string
}

/** Injected dependencies of {@link ProxySection} (slot `inject`). */
export interface ProxySectionInjected {
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export interface ProxySectionProps {
  t?: (key: keyof typeof en) => string
  close?: () => void
}

const PROTOCOLS: Array<{ id: UpstreamDraft['protocol']; label: string }> = [
  { id: 'http', label: 'HTTP' },
  { id: 'https', label: 'HTTPS' },
  { id: 'socks5', label: 'SOCKS5' },
]

/** Fetch helper bound to the same-origin /proxy/api endpoint. */
async function proxyApi<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/proxy/api', init)
  const body = await res.json() as T & { error?: string }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `proxy/api failed with ${res.status}`)
  return body
}

/** A protocol selector: a pill button opening a Menu (never a native <select>). */
function ProtocolSelector(props: {
  value: UpstreamDraft['protocol']
  onChange: (v: UpstreamDraft['protocol']) => void
  disabled?: boolean
  t: (key: keyof typeof en) => string
}): ReactNode {
  const { value, onChange, disabled, t } = props
  const [open, setOpen] = useState(false)
  const matched = PROTOCOLS.find((o) => o.id === value)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={PROTOCOLS.map((o) => ({ id: o.id, label: o.label }))}
      selectedId={value}
      onSelect={(id) => { onChange(id as UpstreamDraft['protocol']); setOpen(false) }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className="dsh-proxy-selector"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen((v) => !v) }}
        >
          <span>{matched?.label ?? t('protocolHttp')}</span>
          <IconChevronDownOutlineRegular />
        </button>
      )}
    />
  )
}

/** One host checkbox row (label + route status). */
function HostRow(props: {
  host: string
  label: string
  checked: boolean
  proxied: boolean
  onToggle: (host: string) => void
}): ReactNode {
  const { host, label, checked, proxied, onToggle } = props
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)

  // Detect whether the label is actually truncated (ellipsized) — only then
  // attach the hover tooltip, so short labels never pop an empty bubble.
  // The measurement runs on every commit (no dependency array) so the state
  // converges: setState(true) re-renders, the follow-up commit re-measures and
  // bails out once stable. RO + fonts.ready + resize are belt-and-braces for
  // late webfont loads that change scrollWidth without a layout-box change.
  useLayoutEffect(() => {
    const el = labelRef.current
    if (el === null) return
    const check = () => {
      const over = el.scrollWidth > el.clientWidth + 1
      setOverflowing((prev) => (prev === over ? prev : over))
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    document.fonts?.ready?.then(check).catch(() => { /* unsupported */ })
    window.addEventListener('resize', check)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', check)
    }
  })

  const labelNode = (
    <span ref={labelRef} className="dsh-proxy-host-label">{label}</span>
  )

  return (
    <label className="dsh-proxy-host">
      <input type="checkbox" checked={checked} onChange={() => { onToggle(host) }} />
      {overflowing
        ? (
          // Custom hover bubble (never the native title tooltip). Shows the
          // full label — all display names plus the host — for rows whose text
          // the ellipsis truncates.
          <Tooltip label={label} side="top" maxWidth={480} delayMs={300}>{labelNode}</Tooltip>
        )
        : labelNode}
      <span className="dsh-proxy-host-route">{proxied ? 'via upstream' : 'direct'}</span>
    </label>
  )
}

/**
 * Render the Proxy settings page.
 * @param props - the inject face.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ProxySection(props: ProxySectionProps): ReactNode {
  const { t } = props
  if (t === undefined) return null
  return <ProxySectionLoaded t={t} />
}

/** The mounted editor (all hooks run unconditionally here). */
function ProxySectionLoaded(props: { t: (key: keyof typeof en) => string }): ReactNode {
  const { t } = props

  const [view, setView] = useState<ProxyView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | undefined>(undefined)
  const [query, setQuery] = useState('')

  // Draft state for the upstream card (initialized from the loaded view).
  const [enabled, setEnabled] = useState(false)
  const [protocol, setProtocol] = useState<UpstreamDraft['protocol']>('http')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [listenPort, setListenPort] = useState('')
  // The listen port is an implementation detail, not a setting: this panel stays
  // collapsed unless something needs the user's attention (a launcher owning
  // egress, a failed self-install, a port that could not be bound, or a
  // configured port awaiting a restart).
  const [advancedOpen, setAdvancedOpen] = useState<boolean | undefined>(undefined)
  const [adoptedPort, setAdoptedPort] = useState(false)
  const [proxied, setProxied] = useState<Set<string>>(new Set())

  /** Load the config view from /proxy/api. */
  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await proxyApi<ProxyView>()
      setView(data)
      setError(undefined)
      setEnabled(data.upstream.enabled)
      setProtocol(data.upstream.protocol)
      setHost(data.upstream.host)
      setPort(data.upstream.port > 0 ? String(data.upstream.port) : '')
      setUsername(data.upstream.username)
      setPassword(data.upstream.password)
      setListenPort(data.listenPort > 0 ? String(data.listenPort) : '')
      setAdoptedPort(data.listenPort === 0 && data.portRequested > 0)
      setProxied(new Set(data.proxiedHosts))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // ── derived candidate lists (matching the desktop settings window) ────────
  const q = query.trim().toLowerCase()
  const match = (label: string): boolean => q === '' || label.toLowerCase().includes(q)

  const byHost = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of view?.providers ?? []) {
      if (!p.host) continue
      const label = p.displayName
        ?? (p.name === 'llm-deepseek' ? 'DeepSeek' : p.name.split('/').pop() ?? p.host)
      if (!map.has(p.host)) map.set(p.host, [])
      map.get(p.host)!.push(label)
    }
    return map
  }, [view])

  const providerHosts = useMemo(
    () => [...byHost.entries()].map(([host, names]) => ({ host, label: `${[...new Set(names)].join(' / ')}（${host}）` })),
    [byHost],
  )

  const otherHosts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const h of [...(view?.knownHosts ?? []), ...(view?.hosts ?? [])]) {
      const key = h.trim().toLowerCase()
      if (key === '' || byHost.has(key)) continue
      seen.set(key, h)
    }
    return [...seen.keys()].sort().map((h) => ({ host: h, label: h }))
  }, [view, byHost])

  const toggleHost = (host: string): void => {
    setSaved(false)
    setProxied((current) => {
      const next = new Set(current)
      if (!next.delete(host)) next.add(host)
      return next
    })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const body = await proxyApi<{ ok: boolean }>({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'save',
          upstream: {
            enabled,
            protocol,
            host: host.trim(),
            port: Number(port) || 0,
            username: username.trim(),
            password,
          },
          proxiedHosts: [...proxied],
          listenPort: Number(listenPort) || 0,
        }),
      })
      if (body.ok !== true) throw new Error('save rejected')
      setSaved(true)
      void load() // refresh the view (upstream + proxiedHosts canonical forms)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const body = await proxyApi<{ ok: boolean; detail: string }>({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'test',
          upstream: { enabled, protocol, host: host.trim(), port: Number(port) || 0, username: username.trim(), password },
        }),
      })
      setTestResult({ ok: body.ok === true, detail: body.detail })
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const providerFiltered = providerHosts.filter((e) => match(e.label))
  const otherFiltered = otherHosts.filter((e) => match(e.label))
  // The port a launch environment must name: the configured fixed port, or the
  // one currently bound when the user has not fixed it yet.
  const launchPort = (view?.listenPort ?? 0) > 0 ? view!.listenPort : view?.port ?? 0
  // Opened automatically only when the normal (self-installed, auto-port) state
  // is not what is happening — otherwise this stays a collapsed diagnostic.
  const diagnosticsNeedAttention = view !== undefined && (
    view.egressStatus === undefined
    || view.egressStatus !== 'self-installed'
    || (!view.portHonored && view.portRequested > 0)
    || (view.listenPort > 0 && view.listenPort !== view.portRequested)
  )
  const diagnosticsOpen = advancedOpen ?? diagnosticsNeedAttention

  return (
    <div className="dsh-proxy-section">
      <div className="dsh-proxy-group">
        <h3>{t('upstreamTitle')}</h3>
        <div className="dsh-proxy-upstream">
          <label className="dsh-proxy-check">
            <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false) }} />
            {t('upstreamEnabled')}
          </label>
          <div className="dsh-proxy-row">
            <span className="dsh-proxy-proto">{t('protocolLabel')}</span>
            <ProtocolSelector value={protocol} onChange={(v) => { setProtocol(v); setSaved(false) }} disabled={!enabled} t={t} />
          </div>
          <div className="dsh-proxy-inputs">
            <Input
              placeholder={t('hostPlaceholder')}
              value={host}
              onChange={(e) => { setHost(e.target.value); setSaved(false) }}
              disabled={!enabled}
              autoComplete="off"
              spellCheck={false}
            />
            <Input
              placeholder={t('portPlaceholder')}
              value={port}
              onChange={(e) => { setPort(e.target.value); setSaved(false) }}
              disabled={!enabled}
              type="number"
              min={1}
              max={65535}
            />
          </div>
          <div className="dsh-proxy-inputs">
            <Input
              placeholder={t('usernamePlaceholder')}
              value={username}
              onChange={(e) => { setUsername(e.target.value); setSaved(false) }}
              disabled={!enabled}
              autoComplete="off"
              spellCheck={false}
            />
            <Input
              placeholder={t('passwordPlaceholder')}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setSaved(false) }}
              disabled={!enabled}
              type="password"
              autoComplete="new-password"
            />
          </div>
          <p>{t('protoHint')}</p>
        </div>
      </div>

      <div className="dsh-proxy-group">
        <h3>{t('egressTitle')}</h3>
        <p>{t('egressHint')}</p>
        {view === undefined
          ? null
          : (
            <div className="dsh-proxy-egress">
              <div className={`dsh-proxy-note ${view.egressStatus === undefined ? '' : view.inProcessRouted ? 'dsh-proxy-note-ok' : 'dsh-proxy-note-warn'}`}>
                {view.egressStatus === undefined
                  ? t('egressUnknown')
                  : (view.inProcessRouted
                    ? (view.egressStatus === 'launcher' ? t('egressRoutedLauncher') : t('egressRoutedSelf'))
                    : (view.egressStatus === 'launcher' ? t('egressLauncherOther') : t('egressUnavailable')))
                    .replace('{port}', String(view.port ?? ''))
                    .replace('{proxy}', String(view.launchProxy ?? ''))
                    .replace('{detail}', String(view.egressDetail ?? ''))}
              </div>
              {!view.portHonored && view.portRequested > 0 && (
                <div className="dsh-proxy-note dsh-proxy-note-warn">
                  {t('portFallback').replace('{requested}', String(view.portRequested)).replace('{bound}', String(view.port ?? '?'))}
                </div>
              )}
              {view.listenPort > 0 && view.listenPort !== view.portRequested && (
                <div className="dsh-proxy-note dsh-proxy-note-warn">
                  {t('portRestartPending').replace('{listenPort}', String(view.listenPort)).replace('{port}', String(view.port ?? '?'))}
                </div>
              )}
              <button
                type="button"
                className="dsh-proxy-disclosure"
                aria-expanded={diagnosticsOpen}
                onClick={() => { setAdvancedOpen(!diagnosticsOpen) }}
              >
                <IconChevronDownOutlineRegular />
                {t('advancedToggle')}
              </button>
              {diagnosticsOpen && (
                <div className="dsh-proxy-diag">
                  <div className="dsh-proxy-note">
                    {(adoptedPort ? t('listenAddressAdopted') : t('listenAddress')).replace('{port}', String(view.port ?? '?'))}
                  </div>
                  <p>{t('diagHint')}</p>
                  {view.egressStatus === 'unavailable' && (
                    <>
                      <p>{t('egressSnippetLabel')}</p>
                      <div className="dsh-proxy-snippet">{`Environment="HTTP_PROXY=http://127.0.0.1:${launchPort}" "HTTPS_PROXY=http://127.0.0.1:${launchPort}" "ALL_PROXY=http://127.0.0.1:${launchPort}" "NO_PROXY=127.0.0.1,localhost,::1" "NODE_USE_ENV_PROXY=1"`}</div>
                    </>
                  )}
                  <div className="dsh-proxy-row">
                    <span className="dsh-proxy-proto">{t('listenPortLabel')}</span>
                    <Input
                      className="dsh-proxy-port"
                      placeholder={t('listenPortPlaceholder')}
                      value={listenPort}
                      onChange={(e) => { setListenPort(e.target.value); setSaved(false) }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <p>{t('listenPortHint')}</p>
                </div>
              )}
            </div>
          )}
      </div>

      <div className="dsh-proxy-group">
        <h3>{t('proxiedHostsTitle')}</h3>
        <p>{t('proxiedHostsHint')}</p>
        <Input
          className="dsh-proxy-search"
          icon={<IconGlobeOutlineRegular />}
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => { setQuery(e.target.value) }}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="dsh-proxy-heading">
          <h4>{t('providersHeading')}</h4>
          <span className="dsh-proxy-count">{providerHosts.length}</span>
        </div>
        <div className="dsh-proxy-hostlist">
          {providerFiltered.length === 0
            ? <div className="dsh-proxy-empty">{t('providersEmpty')}</div>
            : providerFiltered.map((e) => (
              <HostRow
                key={e.host}
                host={e.host}
                label={e.label}
                checked={proxied.has(e.host)}
                proxied={proxied.has(e.host)}
                onToggle={toggleHost}
              />
            ))}
        </div>
        <div className="dsh-proxy-heading">
          <h4>{t('othersHeading')}</h4>
          <span className="dsh-proxy-count">{otherHosts.length}</span>
        </div>
        <div className="dsh-proxy-hostlist">
          {otherFiltered.length === 0
            ? <div className="dsh-proxy-empty">{t('othersEmpty')}</div>
            : otherFiltered.map((e) => (
              <HostRow
                key={e.host}
                host={e.host}
                label={e.label}
                checked={proxied.has(e.host)}
                proxied={proxied.has(e.host)}
                onToggle={toggleHost}
              />
            ))}
        </div>
      </div>

      <p>{t('immediateHint')}</p>

      <div className="dsh-proxy-actions">
        <Button variant="outline" size="md" icon={<IconLinkOutlineRegular />} disabled={testing || !enabled} onClick={() => { void test() }}>
          {testing ? t('testing') : t('test')}
        </Button>
        {testResult !== undefined && (
          <span className={`dsh-proxy-status ${testResult.ok ? 'dsh-proxy-status-ok' : 'dsh-proxy-status-err'}`}>
            {testResult.ok ? t('testStatusOk') : t('testStatusFail')}{testResult.detail ? `（${testResult.detail}）` : ''}
          </span>
        )}
      </div>

      <div className="dsh-proxy-actions">
        <Button variant="primary" size="md" disabled={saving} onClick={() => { void save() }}>
          {saving ? t('saving') : t('save')}
        </Button>
        {saved && <span className="dsh-proxy-status dsh-proxy-status-ok">{t('saveStatus')}</span>}
        {error !== undefined && <span className="dsh-proxy-status dsh-proxy-status-err">{t('saveFailed')} {error}</span>}
      </div>
    </div>
  )
}
