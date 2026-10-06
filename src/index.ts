/**
 * dsh-proxy host half (Smoothly Proxy / 思磨力代理插件): starts the loopback
 * forward proxy, points the process's egress traffic at it, and serves the
 * /proxy/api route the settings page reads and writes.
 *
 * Egress wiring (mirrors dsh-desktop's server-manager):
 *   NODE_USE_ENV_PROXY=1 makes undici's global fetch honor the *PROXY env vars
 *   (all of dsh's model/web-search requests ride undici); npm/git/pnpm/child
 *   CLIs inherit them natively. NO_PROXY keeps the local web server and
 *   loopback services direct. Routing (which hosts go through the optional
 *   upstream proxy) is decided LIVE inside the proxy from proxy.json, so
 *   toggling a host in the settings page takes effect immediately — no dsh
 *   restart needed.
 *
 * The settings page's model-provider list is read from the LIVE settings
 * document (ctx.get('settings').describe()) — the same source the GUI's own
 * pages render — with the pre-0.2 `<home>/settings.yaml` kept as the fallback
 * for harnesses that still have one.
 *
 * Timing note (honest limitation): in-process dsh `fetch()` calls that happen
 * BEFORE this bundle's apply() runs (e.g. a startup version check) may already
 * have materialized undici's global dispatcher without proxy awareness. The
 * env vars here cover everything spawned after apply() (subprocesses inherit
 * the live process env, and any fetch whose dispatcher is still lazy). If a
 * dsh-internal request does not route through the proxy, a dsh restart is the
 * documented remedy — the plugin sets the env at the earliest host hook, and
 * a restart gives dsh a clean dispatcher (same boundary the desktop shell
 * enforces by setting env before spawning dsh).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createPolicyImporter, installInProcessEgress, type EgressOutcome, type LaunchProxy } from './egress.ts'
import {
  createForwardProxy,
  readProxyConfig,
  type RouteMode,
  resolveProviderHosts,
  testUpstreamProxy,
  writeProxyConfig,
  type ProviderHost,
  type ProxyConfig,
  type UpstreamConfig,
} from './proxy-core.ts'

// Host plugin identity must equal the loader entry name (the npm package
// name, per cordis.patch.yml) so the loader's row resolves this module.
// Runtime business ids (settings.section id, locale NS, CSS prefix, style tag
// marker) stay 'dsh-proxy' — they are decoupled from the package identity.
export const name = '@karoc/dsh-proxy'
export const inject = ['webServer']

/** Resolve the harness home: $DSH_HOME (blank = unset) else ~/.dsh. */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  const selected = env !== undefined && env.trim().length > 0 ? env : join(homedir(), '.dsh')
  return resolve(selected)
}

/** The proxy config file (persisted, hand-editable, like dsh-desktop). */
export function proxyConfigPath(home: string = resolveDshHome()): string {
  return join(home, 'proxy.json')
}

/** The LEGACY dsh settings.yaml (dsh < 0.2), kept as the fallback provider source. */
export function settingsPath(home: string = resolveDshHome()): string {
  return join(home, 'settings.yaml')
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(value))
}

/** Collect a request body (bounded — proxy configs are tiny). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('dsh-proxy: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The settings page's full view of the proxy: persisted config + live
 * observed hosts + model-provider hosts from the LIVE settings document.
 */
export interface ProxyView {
  ok: boolean
  /** Port actually bound (null until the listener is up). */
  port: number | null
  /** Listen port in proxy.json now (0 = ephemeral); a change needs a restart. */
  listenPort: number
  /** Port the RUNNING listener was asked to bind. */
  portRequested: number
  /** Whether the running listener got the port it asked for. */
  portHonored: boolean
  /** Proxy URL the LAUNCH environment named, if any (credentials masked). */
  launchProxy: string | null
  /**
   * Whether dsh's own in-process requests (model calls, web fetch/search) ride
   * this proxy — true when this plugin installed the harness policy, or when the
   * launch environment names this very listener. False means they are NOT routed
   * through it, whatever the observed-host list below happens to show.
   */
  inProcessRouted: boolean
  /** What put dsh's own requests behind this proxy, or why nothing did. */
  egressStatus: 'self-installed' | 'launcher' | 'unavailable'
  /** Reason for a non-routing status (page copy); null when routed. */
  egressDetail: string | null
  upstream: UpstreamConfig
  proxiedHosts: string[]
  /** Which way `proxiedHosts` reads (see RouteMode). */
  routeMode: RouteMode
  knownHosts: string[]
  /** Hosts observed by the running proxy this session (live). */
  hosts: string[]
  /** [{name, host, displayName?}] from the active settings entries' llm-* values. */
  providers: ProviderHost[]
}

/** Environment names a launcher may have used to point dsh at a proxy, in resolution order. */
const LAUNCH_PROXY_NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const

/**
 * Read the launch-time proxy variable, before {@link startProxy} publishes this
 * plugin's own values into the environment. dsh resolves its egress policy from
 * the launch environment BEFORE plugins mount, so this snapshot is the only
 * evidence of whether the harness's own requests are routed here.
 */
function readLaunchProxy(): LaunchProxy | null {
  for (const name of LAUNCH_PROXY_NAMES) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return { name, value: value.trim() }
  }
  return null
}

/** Mask credentials in a proxy URL before it leaves the process (the page shows this). */
export function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') {
      url.username = '***'
      url.password = '***'
    }
    return url.toString()
  } catch {
    return value.replace(/\/\/[^@/]*@/, '//***:***@')
  }
}

/**
 * The loopback port a launch proxy names, when that proxy is this plugin.
 *
 * A launcher that declares `HTTP_PROXY=http://127.0.0.1:<port>` did so because
 * it expects THIS proxy to be at that address (that is the 0.1.7 contract), so an
 * ephemeral configuration adopts it rather than leaving the launcher pointed at
 * nothing. A port already serving something else simply fails to bind, and the
 * plugin falls back to an ephemeral one — which is also the correct outcome when
 * the launch proxy is a *different* local proxy, since that one keeps owning
 * egress.
 */
export function launchProxyLoopbackPort(launch: LaunchProxy | null): number {
  if (launch === null) return 0
  try {
    const url = new URL(launch.value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return 0
    const port = Number(url.port)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0
  } catch {
    return 0
  }
}

/** Whether a launch proxy URL addresses `port` on loopback. */
export function launchProxyTargetsPort(launch: LaunchProxy | null, port: number | null): boolean {
  if (launch === null || port === null || port <= 0) return false
  try {
    const url = new URL(launch.value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && url.port === String(port)
  } catch {
    return false
  }
}

/**
 * The live settings document, when this composition exposes one. `settings.
 * describe()` answers with every active entry's CURRENT values — the same call
 * the GUI's own settings pages read — so the provider list follows the running
 * configuration instead of a file whose name and shape upstream is free to
 * change (dsh ≥ 0.2 moved it into the profile document and deleted the legacy
 * `settings.yaml`, which is exactly how this list went empty).
 *
 * `undefined` when no settings service is in the composition or the read
 * throws: the caller then falls back to the legacy `<home>/settings.yaml`.
 */
function liveSettingsDocument(ctx: Context): unknown {
  try {
    const settings = ctx.get('settings') as { describe?: () => unknown } | undefined
    if (settings === undefined || typeof settings.describe !== 'function') return undefined
    return settings.describe()
  } catch {
    return undefined
  }
}

/** Build the fresh settings view. */
function viewOf(forwardProxy: ForwardProxyHandle, providers: () => ProviderHost[], launch: LaunchProxy | null, egress: () => EgressOutcome): ProxyView {
  const cfg = forwardProxy.config()
  const port = forwardProxy.currentPort
  const policy = egress()
  return {
    ok: true,
    port,
    listenPort: cfg.listenPort,
    portRequested: forwardProxy.requestedPort,
    portHonored: forwardProxy.portHonored(),
    launchProxy: launch === null ? null : maskProxyUrl(launch.value),
    inProcessRouted: policy.status === 'self-installed' || launchProxyTargetsPort(launch, port),
    egressStatus: policy.status,
    egressDetail: policy.detail,
    upstream: cfg.upstream,
    proxiedHosts: cfg.proxiedHosts,
    routeMode: cfg.routeMode,
    knownHosts: cfg.knownHosts,
    hosts: forwardProxy.hosts(),
    providers: providers(),
  }
}

/** Minimal structural type of the proxy handle (avoid importing node:http types twice). */
export interface ForwardProxyHandle {
  port: Promise<number>
  currentPort: number | null
  /** Port this instance was asked to bind (0 = ephemeral). */
  requestedPort: number
  /** Whether the requested port is the one bound. */
  portHonored: () => boolean
  hosts: () => string[]
  config: () => ProxyConfig
  persistKnownHosts: () => void
  forgetHosts: () => void
  close: () => void
}

/** Start the loopback forward proxy and re-point the process at it. */
function startProxy(opts: { configFile: string; launch: LaunchProxy | null; log: (line: string) => void }): ForwardProxyHandle {
  const { configFile, launch, log } = opts
  let currentPort: number | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  // The listen port has to be known before the proxy starts: a launcher names it
  // in the environment, so it cannot come from the live view. An unconfigured
  // port adopts the one the launch environment points at — that address is what
  // the launcher (and dsh's already-installed policy) expects this proxy to be.
  const configuredPort = readProxyConfig(configFile).listenPort
  const adoptedPort = configuredPort > 0 ? 0 : launchProxyLoopbackPort(launch)
  const requestedPort = configuredPort > 0 ? configuredPort : adoptedPort
  if (adoptedPort > 0) log(`dsh-proxy: adopting the launch environment's proxy port 127.0.0.1:${adoptedPort}`)
  const handle = createForwardProxy({
    configFile,
    listenPort: requestedPort,
    onHosts: (hosts) => {
      // Debounced persist of observed hosts into proxy.json (UI candidate list).
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        try { handle.persistKnownHosts() } catch { /* best-effort */ }
      }, 2000)
      log(`dsh-proxy: observed hosts: ${hosts.join(', ')}`)
    },
    log,
  })

  const wrapped: ForwardProxyHandle = {
    port: handle.port,
    currentPort,
    requestedPort: handle.requestedPort,
    portHonored: handle.portHonored,
    hosts: handle.hosts,
    config: handle.config,
    persistKnownHosts: handle.persistKnownHosts,
    forgetHosts: handle.forgetHosts,
    close: () => {
      if (persistTimer) clearTimeout(persistTimer)
      handle.close()
    },
  }

  void handle.port.then((port) => {
    if (port <= 0) {
      // Nothing is listening: publishing HTTP_PROXY would send every child to a
      // dead port. Stay out of the environment and say so.
      log('dsh-proxy: forward proxy could not bind any port — leaving the environment untouched')
      return
    }
    wrapped.currentPort = port
    log(`dsh-proxy: forward proxy on 127.0.0.1:${port}${handle.portHonored() ? '' : ` (requested ${handle.requestedPort}; a launcher pointing at it will not reach this proxy)`}`)
    // The process's single egress point. NODE_USE_ENV_PROXY makes undici's
    // global fetch honor the *PROXY vars; child CLIs inherit them natively.
    process.env.NODE_USE_ENV_PROXY = '1'
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`
    process.env.ALL_PROXY = `http://127.0.0.1:${port}`
    process.env.NO_PROXY = ['127.0.0.1', 'localhost', '::1', process.env.NO_PROXY].filter(Boolean).join(',')
  }).catch((error) => {
    log(`dsh-proxy: forward proxy start failed (continuing without it): ${(error as Error).message}`)
  })

  return wrapped
}

/** Register the /proxy/api route (GET view, POST save/test/persist). */
function registerWebApi(
  ctx: Context,
  forwardProxy: ForwardProxyHandle,
  providers: () => ProviderHost[],
  launch: LaunchProxy | null,
  egress: () => EgressOutcome,
): void {
  const server = ctx.get('webServer') as
    | { register: (route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void }
    | undefined
  if (server === undefined) return

  // Same door as the harness's own /api: when this composition has the connection
  // service, an unauthenticated caller must not read the upstream credentials or
  // rewrite the routing — on a shared machine any local process can reach
  // 127.0.0.1. Compositions without that service have no credential model to
  // consult, so they behave exactly as before.
  const admissionRejection = (req: IncomingMessage): 401 | 403 | undefined => {
    const connection = (ctx as { get?: (name: string) => unknown }).get?.('connection') as
      | { admit?: (request: { headers: unknown }) => { rejection?: number } }
      | undefined
    if (connection === undefined || typeof connection.admit !== 'function') return undefined
    try {
      const rejection = connection.admit(req)?.rejection
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      // An admission failure must not take the settings page down with it.
      return undefined
    }
  }

  server.register({
    kind: 'prefix',
    path: '/proxy/api',
    handler: (req, res) => {
      const rejection = admissionRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      void handle(req, res).catch((error) => {
        if (!res.writableEnded) {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      sendJson(res, 200, viewOf(forwardProxy, providers, launch, egress))
      return
    }
    if (method === 'POST') {
      const raw = await readBody(req)
      let body: {
        op?: string
        upstream?: unknown
        proxiedHosts?: string[]
        listenPort?: unknown
        routeMode?: unknown
      }
      try {
        body = JSON.parse(raw) as typeof body
      } catch (error) {
        sendJson(res, 400, { ok: false, error: `dsh-proxy: invalid JSON body: ${(error as Error).message}` })
        return
      }
      switch (body.op) {
        case 'save': {
          try {
            const cfg = writeProxyConfig(proxyConfigPath(), {
              upstream: body.upstream,
              ...Array.isArray(body.proxiedHosts) ? { proxiedHosts: body.proxiedHosts } : {},
              listenPort: body.listenPort,
              routeMode: body.routeMode,
            })
            sendJson(res, 200, { ...viewOf(forwardProxy, providers, launch, egress), upstream: cfg.upstream, proxiedHosts: cfg.proxiedHosts, routeMode: cfg.routeMode })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: `dsh-proxy: save failed: ${(error as Error).message}` })
          }
          return
        }
        case 'test': {
          const result = await testUpstreamProxy(body.upstream)
          sendJson(res, 200, { ok: result.ok, detail: result.detail })
          return
        }
        case 'persist': {
          try { forwardProxy.persistKnownHosts() } catch { /* best-effort */ }
          sendJson(res, 200, viewOf(forwardProxy, providers, launch, egress))
          return
        }
        case 'forget': {
          // Clear the observed-host list (both the live set and proxy.json's).
          try { forwardProxy.forgetHosts() } catch { /* best-effort */ }
          sendJson(res, 200, viewOf(forwardProxy, providers, launch, egress))
          return
        }
        default:
          sendJson(res, 400, { ok: false, error: `dsh-proxy: unknown op ${JSON.stringify(body.op)}` })
      }
      return
    }
    sendJson(res, 405, { ok: false, error: `dsh-proxy: method ${method} not allowed` })
  }
}

/**
 * Host plugin body: start the forward proxy, point the process at it, and
 * serve /proxy/api. Disposal closes the proxy (env vars are left as-is — the
 * process owns them for its lifetime).
 */
export function apply(ctx: Context): void {
  const log = (line: string): void => {
    // Host-side logging: route through ctx.logger when present, else no-op.
    try {
      (ctx as Context & { logger?: { info: (msg: string) => void } }).logger?.info(`[dsh-proxy] ${line}`)
    } catch { /* noop */ }
  }

  // Snapshot the LAUNCH environment BEFORE startProxy publishes this plugin's
  // own values into it: dsh installs its egress policy from that environment
  // before any plugin mounts, so only this snapshot says whether the harness's
  // own requests (model calls) are routed through this proxy.
  const launch = readLaunchProxy()
  const forwardProxy = startProxy({ configFile: proxyConfigPath(), launch, log })

  /**
   * Where the harness's policy package can be resolved from, most specific
   * first: the active profile (the harness resolved it from there, so importing
   * the same file shares one module instance — which is what makes
   * `proxyRouteFor` callers see this policy too), then the dsh entry point.
   */
  const policyAnchors = (): string[] => {
    const anchors: string[] = []
    try {
      const settings = ctx.get('settings') as { documentPath?: unknown } | undefined
      if (typeof settings?.documentPath === 'string') anchors.push(join(dirname(settings.documentPath), 'package.json'))
    } catch { /* no settings service — the other anchors still apply */ }
    const entry = process.argv[1]
    if (typeof entry === 'string' && isAbsolute(entry)) anchors.push(entry)
    anchors.push(join(process.cwd(), 'package.json'))
    return anchors
  }
  let outcome: EgressOutcome = { status: 'unavailable', detail: 'the forward proxy is not listening yet', dispose: null }
  // Install the harness's own egress policy once the listener is up, so dsh's
  // requests (model calls, web fetch) ride this proxy — see src/egress.ts for
  // why a plugin must do this rather than publish env vars.
  void forwardProxy.port.then(async (port) => {
    if (port <= 0) {
      outcome = { status: 'unavailable', detail: 'the forward proxy could not bind any port', dispose: null }
      return
    }
    outcome = await installInProcessEgress({
      proxyUrl: `http://127.0.0.1:${port}`,
      launch,
      importer: createPolicyImporter(policyAnchors()),
      log,
    })
    log(`dsh-proxy: in-process egress ${outcome.status}${outcome.detail === null ? '' : ` — ${outcome.detail}`}`)
  }).catch((error) => {
    outcome = { status: 'unavailable', detail: (error as Error).message, dispose: null }
  })
  // Read the provider list per request: a settings edit (add/rename a provider
  // route) reaches the page on the next load, like every other value here.
  const providers = (): ProviderHost[] => resolveProviderHosts({
    live: liveSettingsDocument(ctx),
    legacyPath: settingsPath(),
  })
  registerWebApi(ctx, forwardProxy, providers, launch, () => outcome)

  ctx.effect(() => () => {
    // Restore the previous egress policy BEFORE closing the listener: the other
    // order leaves a window where the installed policy points at a dead port.
    void (async () => {
      try { await outcome.dispose?.() } catch { /* policy already disposed */ }
      try { forwardProxy.close() } catch { /* already closed */ }
    })()
  }, 'dsh-proxy: teardown')
}
