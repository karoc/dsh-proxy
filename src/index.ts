/**
 * dsh-proxy host half: starts the loopback forward proxy, points the process's
 * egress traffic at it, and serves the /proxy/api route the settings page
 * reads and writes.
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
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  createForwardProxy,
  providerHostsFromSettings,
  testUpstreamProxy,
  writeProxyConfig,
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

/** The dsh settings.yaml this plugin derives model-provider hosts from. */
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
 * observed hosts + model-provider hosts from dsh settings.yaml.
 */
export interface ProxyView {
  ok: boolean
  port: number | null
  upstream: UpstreamConfig
  proxiedHosts: string[]
  knownHosts: string[]
  /** Hosts observed by the running proxy this session (live). */
  hosts: string[]
  /** [{name, host, displayName?}] derived from <home>/settings.yaml. */
  providers: Array<{ name: string; host: string; displayName?: string }>
}

/** Build the fresh settings view. */
function viewOf(forwardProxy: ForwardProxyHandle): ProxyView {
  const cfg = forwardProxy.config()
  return {
    ok: true,
    port: forwardProxy.currentPort,
    upstream: cfg.upstream,
    proxiedHosts: cfg.proxiedHosts,
    knownHosts: cfg.knownHosts,
    hosts: forwardProxy.hosts(),
    providers: providerHostsFromSettings(settingsPath()),
  }
}

/** Minimal structural type of the proxy handle (avoid importing node:http types twice). */
export interface ForwardProxyHandle {
  port: Promise<number>
  currentPort: number | null
  hosts: () => string[]
  config: () => ProxyConfig
  persistKnownHosts: () => void
  close: () => void
}

/** Start the loopback forward proxy and re-point the process at it. */
function startProxy(opts: { configFile: string; log: (line: string) => void }): ForwardProxyHandle {
  const { configFile, log } = opts
  let currentPort: number | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  const handle = createForwardProxy({
    configFile,
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
    hosts: handle.hosts,
    config: handle.config,
    persistKnownHosts: handle.persistKnownHosts,
    close: () => {
      if (persistTimer) clearTimeout(persistTimer)
      handle.close()
    },
  }

  void handle.port.then((port) => {
    wrapped.currentPort = port
    log(`dsh-proxy: forward proxy on 127.0.0.1:${port}`)
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
function registerWebApi(ctx: Context, forwardProxy: ForwardProxyHandle): void {
  const server = ctx.get('webServer') as
    | { register: (route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void }
    | undefined
  if (server === undefined) return

  server.register({
    kind: 'prefix',
    path: '/proxy/api',
    handler: (req, res) => {
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
      sendJson(res, 200, viewOf(forwardProxy))
      return
    }
    if (method === 'POST') {
      const raw = await readBody(req)
      let body: {
        op?: string
        upstream?: unknown
        proxiedHosts?: string[]
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
            const cfg = writeProxyConfig(
              proxyConfigPath(),
              body.upstream,
              Array.isArray(body.proxiedHosts) ? body.proxiedHosts : [],
            )
            sendJson(res, 200, { ...viewOf(forwardProxy), upstream: cfg.upstream, proxiedHosts: cfg.proxiedHosts })
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
          sendJson(res, 200, viewOf(forwardProxy))
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

  const forwardProxy = startProxy({ configFile: proxyConfigPath(), log })
  registerWebApi(ctx, forwardProxy)

  ctx.effect(() => () => {
    try { forwardProxy.close() } catch { /* already closed */ }
  }, 'dsh-proxy: teardown')
}
