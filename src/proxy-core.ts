/**
 * dsh-proxy core: a loopback forward proxy with per-host routing, ported
 * verbatim from dsh-desktop's scripts/proxy.mjs (behavior preserved).
 *
 * The proxy is the SINGLE egress point for the host's outbound traffic:
 * dsh model fetch (undici), web search, npm install/update, git, child CLIs.
 * The host points everything at it via HTTP(S)_PROXY=http://127.0.0.1:<port>
 * + NODE_USE_ENV_PROXY=1 + NO_PROXY=127.0.0.1,localhost,::1.
 *
 * Routing is per-host and read LIVE from <DSH_HOME>/proxy.json on every
 * request, so toggling a host in the settings page takes effect immediately
 * (no dsh restart needed):
 *   {
 *     "upstream": { "enabled": bool, "protocol": "http"|"https"|"socks5",
 *                   "host": "", "port": 0, "username": "", "password": "" },
 *     "proxiedHosts": ["api.deepseek.com", ...],   // hosts that go upstream
 *     "knownHosts":  ["api.deepseek.com", ...]     // observed, for the UI
 *   }
 * Default: everything connects DIRECT. Only hosts in `proxiedHosts` (with
 * `upstream.enabled`) are forwarded to the upstream proxy, optionally with
 * Basic auth (Proxy-Authorization).
 *
 * Hard safety rules:
 *   * loopback targets are ALWAYS direct (never sent to an upstream proxy);
 *   * an upstream pointing back at this very proxy is treated as disabled
 *     (self-loop guard);
 *   * the proxy itself uses raw net/http (never undici's env-proxy), so it can
 *     never route its own outbound connections back through itself.
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/i

/** Upstream proxy protocol, defaulting to http (legacy configs have no field). */
export function upstreamProtocol(cfg: ProxyConfig): string {
  return String(cfg?.upstream?.protocol || 'http').toLowerCase()
}

/** Read exactly n bytes from a socket (SOCKS5 fixed-size frames). */
function readExactly(socket: Socket, n: number, timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error('upstream handshake timeout')) }, timeoutMs)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) { cleanup(); resolvePromise(buf) }
    }
    const onErr = (e: Error) => { cleanup(); rejectPromise(e) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

/** Read until a byte terminator (HTTP CONNECT response headers). */
function readUntil(socket: Socket, terminator: string, timeoutMs = 10_000): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error('upstream handshake timeout')) }, timeoutMs)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf(terminator)
      if (idx >= 0) {
        cleanup()
        resolvePromise({ head: buf.slice(0, idx + terminator.length).toString(), rest: buf.slice(idx + terminator.length) })
      }
    }
    const onErr = (e: Error) => { cleanup(); rejectPromise(e) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

/**
 * SOCKS5 handshake against the upstream: greeting (with optional RFC1929
 * user/pass auth), then CONNECT to the target. Resolves once the tunnel is
 * ready (BND.ADDR consumed).
 */
async function socks5Handshake(socket: Socket, upstream: UpstreamConfig, targetHost: string, targetPort: number): Promise<void> {
  const hasAuth = Boolean(upstream.username)
  const methods = hasAuth ? [0x00, 0x02] : [0x00]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const methodResp = await readExactly(socket, 2)
  if (methodResp[0] !== 0x05) throw new Error(`socks5: bad version ${methodResp[0]}`)
  const method = methodResp[1]
  if (method === 0xff) throw new Error('socks5: no acceptable auth method')
  if (method === 0x02) {
    const user = Buffer.from(upstream.username || '', 'utf8')
    const pass = Buffer.from(upstream.password || '', 'utf8')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const authResp = await readExactly(socket, 2)
    if (authResp[0] !== 0x01 || authResp[1] !== 0x00) throw new Error('socks5: auth failed')
  } else if (method !== 0x00) {
    throw new Error(`socks5: unsupported auth method ${method}`)
  }
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(targetHost)
  let addrPart
  if (isIpv4) {
    addrPart = Buffer.concat([Buffer.from([0x01]), ...targetHost.split('.').map((o) => Buffer.from([Number(o) & 0xff]))])
  } else {
    const name = Buffer.from(targetHost, 'ascii')
    addrPart = Buffer.concat([Buffer.from([0x03, name.length]), name])
  }
  const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]))
  const connResp = await readExactly(socket, 4)
  if (connResp[0] !== 0x05 || connResp[1] !== 0x00) {
    throw new Error(`socks5: CONNECT failed (code ${connResp[1]})`)
  }
  // Consume BND.ADDR/BND.PORT (variable length by atyp).
  const atyp = connResp[3]
  if (atyp === 0x03) {
    const lenByte = await readExactly(socket, 1)
    await readExactly(socket, 1 + lenByte[0] + 2)
  } else if (atyp === 0x01) {
    await readExactly(socket, 4 + 2)
  } else if (atyp === 0x04) {
    await readExactly(socket, 16 + 2)
  }
}

/**
 * Open a tunnel THROUGH the configured upstream proxy to target:port.
 * Returns { socket, rest } where `socket` is ready to pipe and `rest` holds
 * any bytes already read past the handshake (HTTP CONNECT responses).
 * Supports http / https / socks5 upstream protocols.
 */
function openUpstreamTunnel(cfg: ProxyConfig, targetHost: string, targetPort: number, authHeader: string | null): Promise<{ socket: Socket; rest: Buffer }> {
  const u = cfg.upstream
  const protocol = upstreamProtocol(cfg)
  return new Promise((resolvePromise, rejectPromise) => {
    let socket: Socket
    const fail = (e: Error) => { try { socket?.destroy() } catch { /* noop */ } rejectPromise(e) }
    if (protocol === 'https') {
      socket = tlsConnect({ host: u.host, port: Number(u.port), servername: u.host })
    } else {
      socket = tcpConnect({ host: u.host, port: Number(u.port) })
    }
    socket.on('error', fail)
    socket.on('connect', async () => {
      try {
        if (protocol === 'socks5') {
          await socks5Handshake(socket, u, targetHost, targetPort)
          resolvePromise({ socket, rest: Buffer.alloc(0) })
        } else {
          const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
          if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`)
          socket.write(lines.join('\r\n') + '\r\n\r\n')
          const { head, rest } = await readUntil(socket, '\r\n\r\n')
          if (!/^HTTP\/1\.[01]\s+2\d\d/.test(head)) {
            throw new Error(`upstream CONNECT rejected: ${head.split('\r\n')[0] || 'no status'}`)
          }
          resolvePromise({ socket, rest })
        }
      } catch (e) {
        fail(e as Error)
      }
    })
  })
}

/** Fresh default proxy config (factory so callers never share a mutable copy). */
export function defaultProxyConfig(): ProxyConfig {
  return {
    upstream: { enabled: false, protocol: 'http', host: '', port: 0, username: '', password: '' },
    proxiedHosts: [],
    knownHosts: [],
  }
}

/** Read <configFile> (proxy.json), tolerant of a missing/corrupt file. */
export function readProxyConfig(configFile: string): ProxyConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<ProxyConfig>
    return {
      ...defaultProxyConfig(),
      ...(raw ?? {}),
      upstream: { ...defaultProxyConfig().upstream, ...(raw?.upstream ?? {}) },
    }
  } catch {
    return defaultProxyConfig()
  }
}

/**
 * Best-effort extraction of model provider hosts from a dsh settings.yaml
 * (llm-deepseek.baseURL / llm-pi-ai.providers.<n>.baseURL / any other llm-*
 * namespace). Returns [{name, host, displayName?}]: `name` is the dsh
 * namespace (or `ns/provider`), `displayName` the friendly name when known
 * (llm-pi-ai providers carry a `displayName` field; llm-deepseek is fixed to
 * "DeepSeek"). Empty when unreadable — the proxy's observed-host list still
 * populates the settings UI.
 */
export function providerHostsFromSettings(settingsPath: string): Array<{ name: string; host: string; displayName?: string }> {
  const out: Array<{ name: string; host: string; displayName?: string }> = []
  let text: string
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    return out
  }
  const push = (current: { ns: string; provider: string | null; displayName: string | null; baseUrls: string[] }) => {
    // baseURL may carry a trailing comma or be a comma-separated fallback list
    // (e.g. "https://api.xxx.com," or "a,b"). Node's URL parser would swallow
    // the comma INTO the hostname ("api.xxx.com,"), which then never matches
    // the real CONNECT target and silently breaks proxying — split and parse
    // each candidate instead.
    const name = current.provider ? `${current.ns}/${current.provider}` : current.ns
    const displayName = current.displayName || (current.ns === 'llm-deepseek' ? 'DeepSeek' : null)
    for (const baseUrl of current.baseUrls) {
      for (const candidate of String(baseUrl).split(',').map((s) => s.trim()).filter(Boolean)) {
        try {
          const host = new URL(candidate).hostname
          if (host) out.push({ name, ...(displayName ? { displayName } : {}), host })
        } catch { /* malformed candidate — skip */ }
      }
    }
  }
  // Collect each provider block (baseURL list + displayName) and emit it as a
  // whole — ORDER-INDEPENDENT, because a real settings.yaml may list baseURL
  // BEFORE displayName and a naive sequential reader would miss the name.
  // Structure: llm-pi-ai → `providers:` (2sp) → provider key (4sp) → fields
  // (baseURL/displayName at any indent ≥2). Other llm-* namespaces (e.g.
  // llm-deepseek) put baseURL directly under the namespace (2sp).
  let ns: string | null = null
  let inProviders = false
  let current: { ns: string; provider: string | null; displayName: string | null; baseUrls: string[] } | null = null // { ns, provider, displayName, baseUrls: [] }
  const flush = () => {
    if (current && current.baseUrls.length) push(current)
    current = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '')
    const top = line.match(/^([A-Za-z0-9_.-]+):\s*$/)
    if (top) {
      flush()
      ns = top[1]
      inProviders = false
      continue
    }
    if (!ns?.startsWith('llm-')) continue
    const two = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/)
    if (two) {
      flush()
      inProviders = two[1] === 'providers'
      current = inProviders ? null : { ns, provider: two[1], displayName: null, baseUrls: [] }
      continue
    }
    const four = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*$/)
    if (four && inProviders) {
      flush()
      current = { ns, provider: four[1], displayName: null, baseUrls: [] }
      continue
    }
    if (current) {
      const dn = line.match(/^ {2,}displayName:\s*(.+)$/)
      if (dn) {
        current.displayName = String(dn[1]).trim().replace(/^['"]|['"]$/g, '')
        continue
      }
      const b = line.match(/^ {2,}baseURL:\s*(.+)$/)
      if (b) {
        current.baseUrls.push(b[1])
        continue
      }
    } else if (!inProviders) {
      // Non-provider llm-* namespaces (e.g. llm-deepseek) put baseURL directly
      // under the namespace at 2 spaces — collect it as a provider-less unit.
      const b = line.match(/^ {2}baseURL:\s*(.+)$/)
      if (b) {
        current = { ns, provider: null, displayName: null, baseUrls: [b[1]] }
      }
    }
  }
  flush()
  return out
}

/**
 * Pure routing decision: should `host` go through the upstream proxy?
 * Loopback targets are ALWAYS direct; an upstream pointing back at this very
 * proxy (same loopback + same port) is treated as disabled (self-loop guard).
 */
export function shouldProxy(cfg: ProxyConfig, host: string, selfPort?: number): boolean {
  const h = String(host ?? '').toLowerCase()
  if (LOOPBACK.test(h)) return false
  const u = cfg?.upstream
  const selfRef = u?.host && LOOPBACK.test(u.host.toLowerCase()) && Number(u.port) === selfPort
  return Boolean(u?.enabled) && !selfRef && (cfg?.proxiedHosts ?? []).includes(h)
}

/**
 * Start a forward proxy bound to 127.0.0.1:<random>.
 */
export function createForwardProxy(opts: {
  configFile: string
  onHosts?: (hosts: string[]) => void
  log?: (line: string) => void
}): {
  port: Promise<number>
  hosts: () => string[]
  config: () => ProxyConfig
  persistKnownHosts: () => void
  close: () => void
} {
  const { configFile, onHosts, log = () => {} } = opts
  const seenHosts = new Set<string>()
  let notifyTimer: NodeJS.Timeout | null = null

  const markHost = (host: string) => {
    const h = String(host ?? '').trim().toLowerCase()
    if (!h || LOOPBACK.test(h)) return
    if (seenHosts.has(h)) return
    seenHosts.add(h)
    if (notifyTimer) clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => onHosts?.([...seenHosts].sort()), 400)
  }

  const config = (): ProxyConfig => readProxyConfig(configFile)

  const upstreamAuth = (cfg: ProxyConfig): string | null => {
    const u = cfg.upstream
    if (u?.username) {
      return 'Basic ' + Buffer.from(`${u.username}:${u.password ?? ''}`).toString('base64')
    }
    return null
  }

  /** Decide the route for one target host. */
  const routeFor = (host: string, selfPort?: number) => {
    const cfg = config()
    return { via: shouldProxy(cfg, host, selfPort) ? 'upstream' : 'direct', cfg } as const
  }

  /** Bidirectional relay between two sockets; errors/close tear both down. */
  const pipeTunnel = (a: Socket | Duplex, b: Socket | Duplex) => {
    a.on('error', () => { try { b.destroy() } catch { /* noop */ } })
    b.on('error', () => { try { a.destroy() } catch { /* noop */ } })
    a.pipe(b)
    b.pipe(a)
    const cleanup = () => { try { a.destroy() } catch { /* noop */ }; try { b.destroy() } catch { /* noop */ } }
    a.on('close', cleanup)
    b.on('close', cleanup)
  }

  const server = createServer((req, res) => {
    // Plain-HTTP forward-proxy request: request-target is an absolute URI
    // ("GET http://host:port/path HTTP/1.1") — this is what undici sends for
    // http:// targets.
    let u: URL
    try {
      u = new URL(req.url ?? '')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('proxy: bad request-target')
      return
    }
    const host = u.hostname.toLowerCase()
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    if (!host || !port) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('proxy: missing host')
      return
    }
    markHost(host)
    const { via, cfg } = routeFor(host, (server.address() as { port: number } | null)?.port)

    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['connection']
    // SOCKS5 upstreams only speak CONNECT (no absolute-URI HTTP): a plain
    // http:// target through one falls back to direct so the request still
    // works (rare combination; noted in the manager log).
    let useUpstream = via === 'upstream'
    if (useUpstream && upstreamProtocol(cfg) === 'socks5') {
      log(`socks5 upstream: http target ${host} falls back to direct`)
      useUpstream = false
    }
    if (useUpstream) {
      const auth = upstreamAuth(cfg)
      if (auth) headers['proxy-authorization'] = auth
      const up = httpRequest(
        { host: cfg.upstream.host, port: Number(cfg.upstream.port), method: req.method, path: req.url ?? '', headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`proxy: upstream error: ${e.message}`)
      })
      req.pipe(up)
    } else {
      const up = httpRequest(
        { host, port, method: req.method, path: u.pathname + u.search, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`proxy: origin error: ${e.message}`)
      })
      req.pipe(up)
    }
  })

  server.on('connect', (req, clientSocket, head) => {
    // CONNECT host:port — the HTTPS tunnel every model request rides.
    const [hostRaw, portRaw] = String(req.url ?? '').split(':')
    const host = (hostRaw ?? '').toLowerCase()
    const port = Number(portRaw) || 443
    if (!host || !port) {
      clientSocket.destroy()
      return
    }
    markHost(host)
    const { via, cfg } = routeFor(host, (server.address() as { port: number } | null)?.port)

    // On connect failure, answer the client with a clean 502 (never leave it
    // hanging on a silently closed socket).
    const rejectClient = (reason: Error | string) => {
      const msg = String(typeof reason === 'object' && reason !== null ? reason.message ?? reason : reason).slice(0, 200).replace(/[\r\n]+/g, ' ')
      log(`connect ${host}:${port} failed: ${msg}`)
      try {
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
      } catch { /* socket already gone */ }
      try { clientSocket.destroy() } catch { /* socket already gone */ }
    }

    if (via === 'upstream') {
      // Tunnel through the configured upstream (http / https / socks5).
      openUpstreamTunnel(cfg, host, port, upstreamAuth(cfg))
        .then(({ socket: tunnel, rest }) => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head?.length) tunnel.write(head)
          if (rest.length) clientSocket.write(rest)
          pipeTunnel(clientSocket, tunnel)
        })
        .catch(rejectClient)
    } else {
      const origin = tcpConnect({ host, port })
      origin.on('error', rejectClient)
      origin.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) origin.write(head)
        pipeTunnel(clientSocket, origin)
      })
    }
  })

  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })

  return {
    port,
    hosts: () => [...seenHosts].sort(),
    config,
    /** Merge observed hosts into proxy.json's knownHosts (UI candidate list). */
    persistKnownHosts: () => {
      try {
        const cfg = config()
        const merged = [...new Set([...(cfg.knownHosts ?? []), ...seenHosts])].sort()
        writeFileSync(configFile, JSON.stringify({ ...cfg, knownHosts: merged }, null, 2) + '\n')
      } catch (e) {
        log(`proxy: persist known hosts failed: ${(e as Error).message}`)
      }
    },
    close: () => {
      if (notifyTimer) clearTimeout(notifyTimer)
      server.close()
    },
  }
}

// ── settings-panel support (host route side) ─────────────────────────────────

/**
 * Clean each host: trim, lowercase, drop a trailing comma (a historical
 * "api.xxx.com," never matches the real CONNECT target and silently breaks
 * routing — never let it back into proxy.json). Returns '' for unusable input.
 */
export function normalizeHost(h: string): string {
  const t = String(h ?? '').trim().toLowerCase().replace(/,\s*$/, '').trim()
  return t
}

/**
 * Sanitize an upstream object coming from the settings page: only known
 * fields, only valid types/ports (a hostile page must not smuggle extra keys
 * into proxy.json). Ported from dsh-desktop's Rust sanitize_upstream.
 */
export function sanitizeUpstream(v: unknown): UpstreamConfig {
  const obj = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const get = (k: string): string => (typeof obj[k] === 'string' ? obj[k] as string : '')
  const protocol = obj['protocol'] === 'https' ? 'https' : obj['protocol'] === 'socks5' ? 'socks5' : 'http'
  const rawPort = typeof obj['port'] === 'number' ? obj['port'] : typeof obj['port'] === 'string' ? Number(obj['port']) : 0
  const port = Number.isFinite(rawPort) ? Math.max(0, Math.min(rawPort, 65535)) : 0
  return {
    enabled: obj['enabled'] === true,
    protocol,
    host: get('host').trim(),
    port,
    username: get('username'),
    password: get('password'),
  }
}

/**
 * Persist a proxy config atomically from the settings page. Sanitizes the
 * upstream and normalizes the proxied host list (the page never writes
 * arbitrary keys). Takes effect immediately: the running proxy re-reads
 * proxy.json on every request.
 */
export function writeProxyConfig(configFile: string, upstream: unknown, proxiedHosts: string[]): ProxyConfig {
  const cfg = readProxyConfig(configFile)
  const hosts: string[] = []
  for (const h of proxiedHosts ?? []) {
    const t = normalizeHost(h)
    if (t !== '') hosts.push(t)
  }
  const next: ProxyConfig = { ...cfg, upstream: sanitizeUpstream(upstream), proxiedHosts: hosts }
  const text = JSON.stringify(next, null, 2)
  // Ensure the parent directory exists (a fresh DSH_HOME has no proxy.json
  // yet) — mirrors dsh-desktop's set_proxy_config create_dir_all.
  try { mkdirSync(dirname(configFile), { recursive: true }) } catch { /* already exists */ }
  writeFileSync(configFile, text + '\n')
  return next
}

// ── upstream connection test (settings page "测试连接") ──────────────────────

/**
 * Verify the configured upstream proxy is reachable and speaks its protocol.
 * HTTP/HTTPS: send a CONNECT probe (1.1.1.1:443); SOCKS5: handshake + CONNECT.
 * HTTPS upstreams can't be TLS-verified without a TLS crate — TCP reachability
 * is the honest signal available. Ported from dsh-desktop's Rust test_proxy.
 */
export function testUpstreamProxy(upstream: unknown): Promise<{ ok: boolean; detail: string }> {
  const u = sanitizeUpstream(upstream)
  const { host, port, protocol, username, password } = u
  if (host === '' || port === 0) {
    return Promise.resolve({ ok: false, detail: '请先填写代理主机和端口' })
  }
  const addr = `${host}:${port}`
  return new Promise((resolvePromise) => {
    const sock = tcpConnect({ host, port })
    const timeout = setTimeout(() => {
      try { sock.destroy() } catch { /* noop */ }
      resolvePromise({ ok: false, detail: `无法连接 ${addr}: timeout` })
    }, 5000)
    const fail = (e: Error) => {
      clearTimeout(timeout)
      try { sock.destroy() } catch { /* noop */ }
      resolvePromise({ ok: false, detail: `无法连接 ${addr}: ${e.message}` })
    }
    sock.on('error', fail)
    sock.setTimeout(5000, () => fail(new Error('timeout')))
    sock.on('connect', () => {
      try {
        if (protocol === 'socks5') {
          const hasAuth = username !== ''
          const methods = hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]
          sock.write(Buffer.from(methods))
          sock.once('data', (greeting: Buffer) => {
            if (greeting[0] !== 0x05) {
              clearTimeout(timeout)
              sock.destroy()
              resolvePromise({ ok: false, detail: `SOCKS5 版本异常 (${greeting[0]})` })
              return
            }
            const handleMethod = (method: number) => {
              if (method === 0xff) { clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: false, detail: '上游无可用认证方式' }); return }
              if (method === 0x02) {
                const user = Buffer.from(username, 'utf8')
                const pass = Buffer.from(password, 'utf8')
                const auth = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass])
                sock.write(auth)
                sock.once('data', (ar: Buffer) => {
                  if (ar[0] !== 0x01 || ar[1] !== 0x00) {
                    clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: false, detail: 'SOCKS5 认证失败' })
                  } else { sendConnect() }
                })
              } else if (method !== 0x00) {
                clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: false, detail: `不支持的认证方式 (${method})` })
              } else { sendConnect() }
            }
            const sendConnect = () => {
              // CONNECT 1.1.1.1:443 (IPv4 atyp=1, port 0x01bb)
              sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x01, 0xbb]))
              sock.once('data', (cr: Buffer) => {
                if (cr[0] !== 0x05 || cr[1] !== 0x00) {
                  clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: false, detail: `SOCKS5 CONNECT 失败 (code ${cr[1]})` })
                } else {
                  // BND.ADDR/PORT (IPv4): 6 bytes — consume and ignore.
                  let rest = cr.slice(4)
                  if (rest.length >= 6) {
                    clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: true, detail: 'SOCKS5 握手成功，可转发' })
                  } else {
                    sock.once('data', () => { clearTimeout(timeout); sock.destroy(); resolvePromise({ ok: true, detail: 'SOCKS5 握手成功，可转发' }) })
                  }
                }
              })
            }
            handleMethod(greeting[1])
          })
        } else if (protocol === 'https') {
          // No TLS crate in this shell: TCP reachability is what we can verify.
          clearTimeout(timeout)
          sock.destroy()
          resolvePromise({ ok: true, detail: '端口已连通（HTTPS 代理的 TLS 握手未验证）' })
        } else {
          // http proxy: CONNECT probe through the upstream.
          const target = '1.1.1.1:443'
          let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
          if (username !== '') {
            req += `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`
          }
          req += '\r\n'
          sock.write(req)
          let buf = ''
          const onData = (chunk: Buffer) => {
            buf += chunk.toString()
            if (!buf.includes('\r\n\r\n')) return
            sock.removeListener('data', onData)
            const statusLine = buf.split('\r\n')[0]
            clearTimeout(timeout)
            sock.destroy()
            if (/^HTTP\/1\.[01]\s+2/.test(statusLine)) {
              resolvePromise({ ok: true, detail: '上游代理可转发（CONNECT 2xx）' })
            } else if (statusLine.includes('407')) {
              resolvePromise({ ok: false, detail: '上游要求认证（407）' })
            } else {
              resolvePromise({ ok: false, detail: `上游响应异常: ${statusLine.trim()}` })
            }
          }
          sock.on('data', onData)
        }
      } catch (e) {
        fail(e as Error)
      }
    })
  })
}

// ── shared types ─────────────────────────────────────────────────────────────

export interface UpstreamConfig {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string
  password: string
}

export interface ProxyConfig {
  upstream: UpstreamConfig
  proxiedHosts: string[]
  knownHosts: string[]
}
