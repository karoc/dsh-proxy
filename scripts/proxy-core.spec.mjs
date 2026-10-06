#!/usr/bin/env node
// Behavioral tests for the dsh-proxy forward proxy (src/proxy-core.ts),
// ported verbatim from dsh-desktop/scripts/test-proxy.mjs (12 scenarios) plus
// new coverage for the settings-page helpers (sanitizeUpstream /
// writeProxyConfig / normalizeHost):
//   - plain-HTTP absolute-URI forwarding: direct vs via upstream;
//   - CONNECT tunnel: direct vs via upstream (with Basic auth header);
//   - routing rules: loopback ALWAYS direct, self-loop upstream disabled;
//   - host observation + knownHosts persistence;
//   - upstream failure -> 502 on the client side.
// Uses fake upstream proxy + fake origin servers on 127.0.0.1 — no external
// network involved.
import { createServer, request as httpRequest } from 'node:http'
import { connect, createServer as netCreateServer } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  createForwardProxy, readProxyConfig, shouldProxy, providerHostsFromSettings,
  providerHostsFromEntries, resolveProviderHosts,
  sanitizeUpstream, writeProxyConfig, normalizeHost, defaultProxyConfig,
  normalizeListenPort, normalizeRouteMode, isLoopbackHost, normalizeHostForMatch,
  parseConnectAuthority, formatAuthority, ipv6ToBytes,
} from '../src/proxy-core.ts'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-'))

/** A tiny origin that answers with a canned body and records what it saw. */
function origin() {
  const seen = []
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] ?? null })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`origin:${req.method}:${req.url}`)
  })
  return { srv, seen, port: () => srv.address().port, listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', r)) }
}

/** A fake UPSTREAM proxy: records CONNECT targets / absolute-URI requests. */
function upstreamProxy() {
  const seen = []
  const srv = createServer((req, res) => {
    seen.push({ kind: 'http', method: req.method, url: req.url, auth: req.headers['proxy-authorization'] ?? null })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`upstream:${req.url}`)
  })
  srv.on('connect', (req, socket, head) => {
    seen.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] ?? null })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) socket.write(head)
    // After a successful CONNECT, answer any tunneled data with a canned
    // response so the client can prove it reached the upstream.
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
    })
  })
  return { srv, seen, port: () => srv.address().port, listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', r)) }
}

/** Raw CONNECT through a proxy; resolves on response headers OR socket close. */
function rawConnect(proxyPort, target, auth = null) {
  return new Promise((resolvePromise) => {
    const sock = connect({ host: '127.0.0.1', port: proxyPort })
    let head = ''
    let settled = false
    const done = (status) => {
      if (settled) return
      settled = true
      resolvePromise({ sock, status, rest: '' })
    }
    sock.on('connect', () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
      if (auth) lines.push(`Proxy-Authorization: ${auth}`)
      sock.write(lines.join('\r\n') + '\r\n\r\n')
    })
    const onData = (buf) => {
      head += buf.toString()
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      sock.removeListener('data', onData)
      done(head.slice(0, head.indexOf('\r\n')))
    }
    sock.on('data', onData)
    sock.on('close', () => done(head.slice(0, head.indexOf('\r\n'))))
    sock.on('error', () => done(''))
  })
}

const cfgFile = join(work, 'proxy.json')
const writeCfg = (cfg) => writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

// ── fixtures ────────────────────────────────────────────────────────────────
const o1 = origin()
const up = upstreamProxy()
await o1.listen()
await up.listen()
const O1 = `127.0.0.1:${o1.port()}`

let observedHosts = null
const proxy = createForwardProxy({
  configFile: cfgFile,
  onHosts: (h) => { observedHosts = h },
})
const proxyPort = await proxy.port

const httpViaProxy = (path) => new Promise((resolvePromise, rejectPromise) => {
  const req = httpRequest({
    host: '127.0.0.1', port: proxyPort,
    method: 'GET', path: `http://${O1}${path}`,
  }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolvePromise({ status: res.statusCode, body }))
  })
  req.on('error', rejectPromise)
  req.end()
})

// ── scenario 1: direct HTTP forwarding (no upstream configured) ─────────────
writeCfg({ upstream: { enabled: false, host: '', port: 0 }, proxiedHosts: ['example.com'], knownHosts: [] })
{
  const res = await httpViaProxy('/a')
  assert.equal(res.status, 200, 'direct HTTP proxy returns the origin status')
  assert.equal(res.body, 'origin:GET:/a', 'direct HTTP proxy relays to the origin')
  assert.equal(o1.seen.at(-1).url, '/a', 'origin receives origin-form request (proxy stripped absolute URI)')
  assert.equal(up.seen.length, 0, 'no upstream involved when none configured')
}

// ── scenario 2: direct CONNECT (no upstream configured) ─────────────────────
{
  const { sock, status } = await rawConnect(proxyPort, O1)
  assert.match(status, /200/, 'direct CONNECT establishes')
  await new Promise((r) => {
    sock.write('GET / HTTP/1.0\r\nHost: ' + O1 + '\r\n\r\n')
    let buf = ''
    sock.on('data', (d) => { buf += d })
    sock.on('close', r)
    setTimeout(() => { sock.destroy(); r() }, 500)
  })
  assert.ok(o1.seen.some((s) => s.method === 'GET'), 'origin saw the tunneled request')
}

// ── scenario 3: proxied HTTP through upstream with Basic auth ───────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: 'u', password: 'p' },
  proxiedHosts: ['example.com'],
  knownHosts: [],
})
// example.com doesn't resolve — the request must land on the upstream, which
// answers without contacting the origin.
const httpViaProxyHost = (host, path) => new Promise((resolvePromise, rejectPromise) => {
  const req = httpRequest({
    host: '127.0.0.1', port: proxyPort,
    method: 'GET', path: `http://${host}${path}`,
  }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolvePromise({ status: res.statusCode, body }))
  })
  req.on('error', rejectPromise)
  req.end()
})
{
  const res = await httpViaProxyHost('example.com', '/x')
  assert.equal(res.status, 200, 'proxied HTTP gets a response (from upstream)')
  assert.equal(res.body, 'upstream:http://example.com/x', 'upstream answered with the absolute-URI form')
  const hit = up.seen.find((s) => s.kind === 'http')
  assert.ok(hit, 'upstream saw the HTTP request')
  assert.equal(hit.url, 'http://example.com/x', 'upstream receives absolute-URI request-target')
  assert.equal(hit.auth, 'Basic ' + Buffer.from('u:p').toString('base64'), 'upstream receives Proxy-Authorization Basic header')
}

// ── scenario 4: proxied CONNECT through upstream + auth ─────────────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: 'u', password: 'p' },
  proxiedHosts: ['api.deepseek.com'],
  knownHosts: [],
})
{
  const { sock, status } = await rawConnect(proxyPort, 'api.deepseek.com:443')
  assert.match(status, /200/, 'proxied CONNECT establishes via upstream')
  const hit = up.seen.find((s) => s.kind === 'connect')
  assert.ok(hit, 'upstream saw the CONNECT')
  assert.equal(hit.target, 'api.deepseek.com:443', 'CONNECT target forwarded verbatim')
  assert.equal(hit.auth, 'Basic ' + Buffer.from('u:p').toString('base64'), 'CONNECT carries Proxy-Authorization')
  sock.destroy()
}

// ── scenario 5: routing — unlisted host goes direct even with upstream on ───
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
  proxiedHosts: ['api.deepseek.com'],
  knownHosts: [],
})
{
  const before = up.seen.length
  const res = await httpViaProxy('/unlisted')
  assert.equal(res.body, 'origin:GET:/unlisted', 'unlisted host routes DIRECT to origin')
  assert.equal(up.seen.length, before, 'upstream untouched for unlisted host')
}

// ── scenario 6: loopback NEVER proxied (even if listed) ─────────────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
  proxiedHosts: ['127.0.0.1'],
  knownHosts: [],
})
{
  const before = up.seen.length
  const res = await httpViaProxy('/loopback')
  assert.equal(res.body, 'origin:GET:/loopback', 'loopback target stays direct')
  assert.equal(up.seen.length, before, 'upstream never sees loopback traffic')
}

// ── scenario 7: self-loop upstream is treated as disabled ───────────────────
{
  // Pure routing checks — no network involved (avoids real DNS in the sandbox).
  const base = { upstream: { enabled: true, host: '127.0.0.1', port: 0 }, proxiedHosts: ['api.deepseek.com'] }
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'api.deepseek.com', 43210),
    false,
    'upstream pointing at this proxy port is disabled (self-loop guard)',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'api.deepseek.com', 43211),
    true,
    'same loopback, different port -> normal upstream',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, enabled: false, port: 43210 } }, 'api.deepseek.com', 43211),
    false,
    'disabled upstream never proxies',
  )
  // The loopback hosts are put INTO proxiedHosts on purpose: only then does the
  // result depend on the loopback guard. Asserting them against a list that does
  // not contain them would pass for the wrong reason (an unlisted host is direct
  // anyway) and would keep passing even if the guard were deleted — that is how
  // the 127/8 hole below stayed invisible.
  const listed = { ...base, proxiedHosts: ['127.0.0.1', '127.0.0.2', 'api.deepseek.com'] }
  assert.equal(
    shouldProxy({ ...listed, upstream: { ...listed.upstream, port: 43210 } }, 'api.deepseek.com', 43211),
    true,
    'positive control: a listed non-loopback host does go through the upstream',
  )
  assert.equal(
    shouldProxy({ ...listed, upstream: { ...listed.upstream, port: 43210 } }, '127.0.0.1', 43211),
    false,
    'loopback host is always direct even when listed',
  )
  assert.equal(
    shouldProxy({ ...listed, upstream: { ...listed.upstream, port: 43210 } }, '127.0.0.2', 43211),
    false,
    'loopback is the whole 127/8 block, not only 127.0.0.1',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'other.example', 43211),
    false,
    'unlisted host is direct',
  )
}

// ── scenario 8: host observation + knownHosts persistence ───────────────────
{
  await new Promise((r) => setTimeout(r, 600)) // debounced onHosts
  assert.ok(Array.isArray(observedHosts), 'onHosts fired with a host list')
  assert.ok(observedHosts.includes('api.deepseek.com'), 'observed hosts include the proxied CONNECT target')
  assert.ok(!observedHosts.includes('127.0.0.1'), 'loopback targets are never observed')
  proxy.persistKnownHosts()
  const persisted = readProxyConfig(cfgFile)
  assert.ok(persisted.knownHosts.includes('api.deepseek.com'), 'knownHosts persisted into proxy.json')
  assert.ok(!persisted.knownHosts.includes('127.0.0.1'), 'loopback never lands in knownHosts')
}

// ── scenario 9: upstream unreachable -> client gets a failure (no hang) ─────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: 1, username: '', password: '' }, // port 1: refused
  proxiedHosts: ['dead.example'],
  knownHosts: [],
})
{
  const start = Date.now()
  const { status } = await rawConnect(proxyPort, 'dead.example:443')
  assert.ok(status, 'dead upstream yields a terminal status')
  assert.ok(Date.now() - start < 5000, 'dead upstream fails fast (no hang)')
}

// ── scenario 10: config read LIVE (save-takes-effect) ───────────────────────
{
  // Start with host NOT proxied -> direct (origin). Then flip proxiedHosts to
  // include a fake host and confirm routing changes without recreating proxy.
  writeCfg({
    upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
    proxiedHosts: [],
    knownHosts: [],
  })
  const before = up.seen.length
  await httpViaProxyHost('routing.example', '/p')
  assert.equal(up.seen.length, before, 'fresh config with empty proxiedHosts routes direct')
  writeCfg({
    upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
    proxiedHosts: ['routing.example'],
    knownHosts: [],
  })
  await httpViaProxyHost('routing.example', '/p')
  assert.ok(up.seen.some((s) => s.kind === 'http' && s.url === 'http://routing.example/p'), 'live config flip takes effect on the next request')
}

// ── scenario 11: provider host extraction from settings.yaml ────────────────
{
  const settingsPath = join(work, 'settings.yaml')
  writeFileSync(settingsPath, [
    '# dsh settings',
    'llm-deepseek:',
    '  baseURL: https://api.deepseek.com',
    'llm-pi-ai:',
    '  providers:',
    '    acme:',
    '      displayName: "ACME 网关"',
    '      baseURL: https://gateway.acme.example/v1',
    'ui-theme:',
    '  theme: dark',
    '',
  ].join('\n'))
  const providers = providerHostsFromSettings(settingsPath)
  assert.deepEqual(providers, [
    { name: 'llm-deepseek', displayName: 'DeepSeek', host: 'api.deepseek.com' },
    { name: 'llm-pi-ai/acme', displayName: 'ACME 网关', host: 'gateway.acme.example' },
  ], 'settings.yaml provider hosts extracted with friendly displayNames (llm-* only)')
  assert.deepEqual(providerHostsFromSettings(join(work, 'missing.yaml')), [], 'missing settings.yaml -> empty list')
  // provider without displayName falls back to its key; non-llm namespaces ignored
  writeFileSync(settingsPath, [
    'llm-pi-ai:',
    '  providers:',
    '    bare:',
    '      baseURL: https://bare.example/v1',
    'web-search:',
    '  baseURL: https://search.example',
    '',
  ].join('\n'))
  const bare = providerHostsFromSettings(settingsPath)
  assert.deepEqual(bare, [
    { name: 'llm-pi-ai/bare', host: 'bare.example' },
  ], 'no displayName -> name is the provider key; non-llm namespaces skipped')
  // Trailing comma / comma-separated fallback list must NOT leak into the host
  // (Node's URL parser would swallow the comma, breaking proxying).
  writeFileSync(settingsPath, [
    'llm-pi-ai:',
    '  providers:',
    '    gw:',
    '      baseURL: https://api.xxx.com,',
    '    multi:',
    '      baseURL: https://api1.example,https://api2.example',
    '',
  ].join('\n'))
  const comma = providerHostsFromSettings(settingsPath)
  assert.deepEqual(comma, [
    { name: 'llm-pi-ai/gw', host: 'api.xxx.com' },
    { name: 'llm-pi-ai/multi', host: 'api1.example' },
    { name: 'llm-pi-ai/multi', host: 'api2.example' },
  ], 'trailing comma stripped; comma-separated list yields one host per candidate')
  // baseURL BEFORE displayName (the real settings.yaml key order) must still
  // yield the displayName — the reader is order-independent.
  writeFileSync(settingsPath, [
    'llm-pi-ai:',
    '  providers:',
    '    ark:',
    '      baseURL: https://ark.cn-beijing.volces.com',
    '      displayName: 方舟 Ark',
    '    token-plan:',
    '      baseURL: https://token-plan.cn-beijing.maas.aliyuncs.com',
    '      displayName: Token Plan',
    '',
  ].join('\n'))
  const reordered = providerHostsFromSettings(settingsPath)
  assert.deepEqual(reordered, [
    { name: 'llm-pi-ai/ark', displayName: '方舟 Ark', host: 'ark.cn-beijing.volces.com' },
    { name: 'llm-pi-ai/token-plan', displayName: 'Token Plan', host: 'token-plan.cn-beijing.maas.aliyuncs.com' },
  ], 'displayName extracted even when baseURL precedes it (order-independent)')
}

// ── scenario 12: SOCKS5 upstream ────────────────────────────────────────────
// A fake SOCKS5 proxy: greeting (no auth) -> CONNECT -> records the target and
// echoes tunneled bytes so the client can prove the tunnel works.
{
  const s5seen = []
  const s5 = netCreateServer((socket) => {
    let buf = Buffer.alloc(0)
    let stage = 'greeting' // greeting -> connect -> tunnel
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (stage === 'greeting') {
          if (buf.length < 2) return
          const nmethods = buf[1]
          if (buf.length < 2 + nmethods) return
          buf = buf.slice(2 + nmethods)
          socket.write(Buffer.from([0x05, 0x00])) // no auth
          stage = 'connect'
        } else if (stage === 'connect') {
          if (buf.length < 4) return
          const atyp = buf[3]
          let need = 0
          if (atyp === 0x01) need = 4 + 2
          else if (atyp === 0x03) need = 1 + buf[4] + 2
          else if (atyp === 0x04) need = 16 + 2
          if (buf.length < 4 + need) return
          let host = ''
          let port = 0
          if (atyp === 0x01) { host = [...buf.slice(4, 8)].join('.'); port = buf.readUInt16BE(8) }
          else if (atyp === 0x03) { const l = buf[4]; host = buf.slice(5, 5 + l).toString(); port = buf.readUInt16BE(5 + l) }
          else if (atyp === 0x04) { host = `ipv6:${buf.slice(4, 20).toString('hex')}`; port = buf.readUInt16BE(20) }
          s5seen.push(`${host}:${port}`)
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])) // success, BND 0.0.0.0:0
          buf = buf.slice(4 + need)
          stage = 'tunnel'
        } else {
          // Tunnel: answer tunneled bytes so the client can prove it works.
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
          buf = Buffer.alloc(0)
          return
        }
      }
    })
  })
  await new Promise((r) => s5.listen(0, '127.0.0.1', r))
  const s5Port = s5.address().port

  // CONNECT through a socks5 upstream must succeed.
  writeCfg({
    upstream: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: s5Port, username: '', password: '' },
    proxiedHosts: ['socks-target.example'],
    knownHosts: [],
  })
  {
    const { sock, status } = await rawConnect(proxyPort, 'socks-target.example:443')
    assert.match(status, /200/, 'CONNECT through socks5 upstream establishes')
    assert.ok(s5seen.includes('socks-target.example:443'), `socks5 upstream saw CONNECT to the target (got ${JSON.stringify(s5seen)})`)
    sock.destroy()
  }
  // An IPv6 target must go out as ATYP=4 with the 16 address bytes — not as a
  // domain name that no resolver can answer.
  {
    s5seen.length = 0
    writeCfg({
      upstream: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: s5Port, username: '', password: '' },
      proxiedHosts: ['2001:db8::1', '[2001:db8::1]', '::ffff:1.2.3.4'],
      knownHosts: [],
    })
    const compressed = await rawConnect(proxyPort, '[2001:db8::1]:443')
    compressed.sock.destroy()
    assert.ok(
      s5seen.includes('ipv6:20010db8000000000000000000000001:443'),
      `socks5: IPv6 target is sent as ATYP=4 with 16 address bytes (got ${JSON.stringify(s5seen)})`,
    )
    const mapped = await rawConnect(proxyPort, '[::ffff:1.2.3.4]:8443')
    mapped.sock.destroy()
    assert.ok(
      s5seen.includes('ipv6:00000000000000000000ffff01020304:8443'),
      `socks5: an IPv4-mapped IPv6 target keeps its embedded address (got ${JSON.stringify(s5seen)})`,
    )
    s5seen.length = 0
  }
  // A plain http:// target with a socks5 upstream falls back to DIRECT.
  {
    s5seen.length = 0
    writeCfg({
      upstream: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: s5Port, username: '', password: '' },
      proxiedHosts: ['socks-target.example', '127.0.0.1'],
      knownHosts: [],
    })
    const res = await httpViaProxy('/socks-http')
    assert.equal(res.body, 'origin:GET:/socks-http', 'http target with socks5 upstream falls back to direct')
    assert.equal(s5seen.length, 0, 'socks5 upstream not touched for an http target')
  }
  s5.close()
}

// ── scenario 12b: IPv6 text -> 16 wire bytes (SOCKS5 ATYP=4) ────────────────
{
  assert.equal(ipv6ToBytes('::1').toString('hex'), '00000000000000000000000000000001', '::1 expands')
  assert.equal(ipv6ToBytes('2001:db8::1').toString('hex'), '20010db8000000000000000000000001', 'the compressed form expands')
  assert.equal(ipv6ToBytes('2001:0db8:0000:0000:0000:0000:0000:0001').toString('hex'), '20010db8000000000000000000000001', 'the full form expands to the same bytes')
  assert.equal(ipv6ToBytes('::ffff:1.2.3.4').toString('hex'), '00000000000000000000ffff01020304', 'an embedded IPv4 tail expands')
  assert.equal(ipv6ToBytes('fe80::1%eth0').toString('hex'), 'fe800000000000000000000000000001', 'a zone id is dropped (it has no wire form)')
  assert.equal(ipv6ToBytes('1:2:3'), null, 'a short form without :: is rejected')
  assert.equal(ipv6ToBytes('not:an:address'), null, 'garbage is rejected')
  assert.equal(ipv6ToBytes(''), null, 'empty input is rejected')
}

// ── scenario 13: settings-page helpers (sanitize / write / normalize) ───────
{
  // sanitizeUpstream: whitelist fields, collapse unknown protocols, clamp port.
  assert.deepEqual(
    sanitizeUpstream({ enabled: true, protocol: 'https', host: ' 127.0.0.1 ', port: 7890, username: 'u', password: 'p', extra: 'x' }),
    { enabled: true, protocol: 'https', host: '127.0.0.1', port: 7890, username: 'u', password: 'p' },
    'sanitize keeps known fields, trims host, drops extras',
  )
  assert.deepEqual(
    sanitizeUpstream({ enabled: true, protocol: 'gopher', host: 'h', port: 999999, username: 'u' }),
    { enabled: true, protocol: 'http', host: 'h', port: 65535, username: 'u', password: '' },
    'unknown protocol collapses to http; port clamps to 65535',
  )
  assert.deepEqual(sanitizeUpstream(null), defaultProxyConfig().upstream, 'null upstream sanitizes to defaults')
  // normalizeHost: trim, lowercase, strip trailing comma.
  assert.equal(normalizeHost('  API.DeepSeek.COM, '), 'api.deepseek.com', 'normalize trims/lowercases/drops trailing comma')
  assert.equal(normalizeHost('   '), '', 'blank host normalizes to empty')
  // writeProxyConfig: persists sanitized config and returns the saved shape.
  const saved = writeProxyConfig(cfgFile, {
    upstream: { enabled: true, protocol: 'socks5', host: 'proxy.example', port: 1080, username: 'a', password: 'b' },
    proxiedHosts: ['API.DeepSeek.com,', '  example.org  ', '', '127.0.0.1'],
  })
  assert.deepEqual(saved, {
    ...defaultProxyConfig(),
    upstream: { enabled: true, protocol: 'socks5', host: 'proxy.example', port: 1080, username: 'a', password: 'b' },
    proxiedHosts: ['api.deepseek.com', 'example.org', '127.0.0.1'],
  }, 'writeProxyConfig normalizes proxied hosts (drops empties, keeps loopback — routing bypasses it at request time)')
  const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8'))
  assert.deepEqual(onDisk.proxiedHosts, ['api.deepseek.com', 'example.org', '127.0.0.1'], 'written proxy.json holds normalized hosts (loopback kept, routing ignores it)')
}

// ── scenario 14: provider hosts from the LIVE settings document ─────────────
// Why this scenario exists: dsh ≥ 0.2 imports <home>/settings.yaml into the
// active profile's config document and deletes the file, so a reader pinned to
// that file silently answered [] and the settings page showed 0 providers.
// The fixture mirrors the shape the running harness really answers with —
// captured from GET /api/settings/describe on 2026-10-06 (`result.value
// .namespaces[] = {ns, value, …}`, llm-pi-ai.value.providers.<key>.{displayName,
// baseURL}) — so the assertions cannot pass against a shape nobody produces.
{
  const liveNamespaces = [
    { ns: 'llm-pi-ai', value: { providers: {
      'volcengine-agent-plan-k': { displayName: '火山方舟 Agent Plan K', baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3' },
      'opencode-go-self': { displayName: 'OC Go 自定义', baseURL: 'https://opencode.ai/zen/go/v1' },
      'local-sub2api-oai-chat': { displayName: '本地 OAI Chat', baseURL: 'http://127.0.0.1:37780/v1' },
      multi: { baseURL: 'https://api1.example,https://api2.example' },
      bare: { baseURL: 'https://bare.example/v1' },
      broken: { displayName: 'Broken', baseURL: 'not a url' },
      endpointless: { displayName: 'Opaque' },
      scalar: 'nope',
    } } },
    { ns: 'llm-deepseek', value: { baseURL: 'https://api.deepseek.com/anthropic' } },
    // A non-llm-* entry that also carries a baseURL: the document holds every
    // plugin's entry, and this list is the MODEL PROVIDER list.
    { ns: 'web-search-deepseek', value: { baseURL: 'https://search.example' } },
    { ns: 'ui-theme', value: { fontSize: 16 } },
    { ns: 'not-an-entry' },
  ]
  const expected = [
    { name: 'llm-pi-ai/volcengine-agent-plan-k', displayName: '火山方舟 Agent Plan K', host: 'ark.cn-beijing.volces.com' },
    { name: 'llm-pi-ai/opencode-go-self', displayName: 'OC Go 自定义', host: 'opencode.ai' },
    { name: 'llm-pi-ai/multi', host: 'api1.example' },
    { name: 'llm-pi-ai/multi', host: 'api2.example' },
    { name: 'llm-pi-ai/bare', host: 'bare.example' },
    { name: 'llm-deepseek', displayName: 'DeepSeek', host: 'api.deepseek.com' },
  ]
  // Rules first, each with the smallest case that can fail — the layer order
  // below is also what makes the negative controls name the exact assertion.
  assert.deepEqual(providerHostsFromEntries(undefined), [], 'no live document -> no provider hosts')
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: { local: { baseURL: 'http://localhost:11434/v1' } } } }] }),
    [],
    'loopback provider hosts are never offered as proxy targets',
  )
  // The same classification on the LEGACY path: a loopback target can never go
  // upstream, so it is not offered there either.
  const legacyWithLoopback = join(work, 'legacy-loopback.yaml')
  writeFileSync(legacyWithLoopback, [
    'llm-pi-ai:',
    '  providers:',
    '    local:',
    '      baseURL: http://127.0.0.1:11434/v1',
    '    remote:',
    '      baseURL: https://remote.example/v1',
    '',
  ].join('\n'))
  assert.deepEqual(
    providerHostsFromSettings(legacyWithLoopback),
    [{ name: 'llm-pi-ai/remote', host: 'remote.example' }],
    'legacy loopback provider hosts are dropped too',
  )
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: [] } }, { ns: 'llm-retry', value: null }] }),
    [],
    'malformed provider values are skipped, not fatal',
  )
  // The DeepSeek route resolves its endpoint from a runtime constant, so the
  // document carries no host: without a fallback the provider that carries real
  // traffic never appears.
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: [{ ns: 'llm-deepseek', value: { models: [{ id: 'deepseek-flash' }] } }] }),
    [{ name: 'llm-deepseek', displayName: 'DeepSeek', host: 'api.deepseek.com' }],
    'llm-deepseek without a configured baseURL keeps its public endpoint in the list',
  )
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: [{ ns: 'llm-deepseek', value: { baseURL: 'https://my-gateway.example/v1' } }] }),
    [{ name: 'llm-deepseek', displayName: 'DeepSeek', host: 'my-gateway.example' }],
    'a configured baseURL wins over the public endpoint',
  )
  // IPv6 endpoints are loopback too, in every spelling.
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: {
      six: { baseURL: 'http://[::1]:11434/v1' },
      mapped: { baseURL: 'http://[::ffff:127.0.0.1]:11434/v1' },
      remote: { baseURL: 'http://[2001:db8::1]:8080/v1' },
    } } }] }),
    [{ name: 'llm-pi-ai/remote', host: '[2001:db8::1]' }],
    'IPv6 loopback endpoints are never offered, bracketed or IPv4-mapped',
  )
  assert.deepEqual(
    providerHostsFromEntries(liveNamespaces),
    expected,
    'live settings entries yield provider hosts (llm-* only, displayName, comma lists)',
  )
  // The container form the client RPC answers with must work too.
  assert.deepEqual(
    providerHostsFromEntries({ namespaces: liveNamespaces }),
    expected,
    'live settings container form ({ namespaces }) yields the same provider hosts',
  )
  // Layering: a readable live document wins, even when a legacy file still exists.
  const staleLegacy = join(work, 'stale-settings.yaml')
  writeFileSync(staleLegacy, ['llm-pi-ai:', '  providers:', '    stale:', '      baseURL: https://stale.example/v1', ''].join('\n'))
  assert.deepEqual(
    resolveProviderHosts({ live: liveNamespaces, legacyPath: staleLegacy }),
    expected,
    'live settings document wins over a stale legacy settings.yaml',
  )
  assert.deepEqual(
    resolveProviderHosts({ live: [], legacyPath: staleLegacy }),
    [],
    'an empty live document is still authoritative — the legacy file is not resurrected',
  )
  assert.deepEqual(
    resolveProviderHosts({ live: undefined, legacyPath: staleLegacy }),
    [{ name: 'llm-pi-ai/stale', host: 'stale.example' }],
    'legacy settings.yaml is read only when no live settings document exists',
  )
  assert.deepEqual(resolveProviderHosts({ live: undefined, legacyPath: join(work, 'nope.yaml') }), [], 'no source at all -> empty list')
}

// ── scenario 15b: the routing rule (which way the checkboxes read) ──────────
// Why: "everything except the checked hosts" inverts a promise the whole page
// makes ("checked hosts go upstream"). The inversion has to be explicit and
// pinned, and an unreadable stored value must fall back to the SAFE direction
// (nothing proxied) rather than to "send everything upstream".
{
  const base = {
    ...defaultProxyConfig(),
    upstream: { enabled: true, protocol: 'http', host: 'up.example', port: 8080, username: '', password: '' },
    proxiedHosts: ['a.example'],
  }
  assert.equal(shouldProxy({ ...base, routeMode: 'only-listed' }, 'a.example'), true, 'only-listed: a checked host goes upstream')
  assert.equal(shouldProxy({ ...base, routeMode: 'only-listed' }, 'b.example'), false, 'only-listed: an unchecked host goes direct')
  assert.equal(shouldProxy({ ...base, routeMode: 'except-listed' }, 'b.example'), true, 'except-listed: an unchecked host goes upstream')
  assert.equal(shouldProxy({ ...base, routeMode: 'except-listed' }, 'a.example'), false, 'except-listed: a checked host connects directly')
  assert.equal(
    shouldProxy({ ...base, routeMode: 'except-listed', upstream: { ...base.upstream, enabled: false } }, 'b.example'),
    false,
    'disabled upstream never proxies in except-listed mode',
  )
  assert.equal(shouldProxy({ ...base, routeMode: 'except-listed' }, '127.0.0.1'), false, 'loopback stays direct in except-listed mode')
  assert.equal(normalizeRouteMode('except-listed'), 'except-listed', 'a stored except-listed rule survives')
  assert.equal(normalizeRouteMode('nonsense'), 'only-listed', 'an unknown route mode falls back to only-listed, never to all-upstream')
  assert.equal(defaultProxyConfig().routeMode, 'only-listed', 'the default rule proxies nothing until asked')

  const rulePath = join(work, 'rule.json')
  writeProxyConfig(rulePath, { routeMode: 'except-listed' })
  assert.equal(readProxyConfig(rulePath).routeMode, 'except-listed', 'the rule round-trips through proxy.json')
  writeProxyConfig(rulePath, {})
  assert.equal(readProxyConfig(rulePath).routeMode, 'except-listed', 'a save that omits the rule keeps it')
  writeProxyConfig(rulePath, { routeMode: 'nonsense' })
  assert.equal(readProxyConfig(rulePath).routeMode, 'only-listed', 'a garbage rule is stored as the safe default')
}

// ── scenario 14b: IPv6 spellings of loopback ────────────────────────────────
// Why: `new URL('http://[::1]:1/').hostname` is `[::1]`, Node rewrites an
// IPv4-mapped literal to `::ffff:7f00:1`, and a CONNECT authority is
// `[::1]:443`. Only the bare `::1` used to count, so a bracketed loopback target
// could be handed to the upstream proxy — against the guarantee that loopback is
// always direct — and `split(':')` made the observed-host list collect `[`.
{
  assert.equal(normalizeHostForMatch('[::1]'), '::1', 'a bracketed IPv6 literal unwraps')
  assert.equal(normalizeHostForMatch('[::ffff:127.0.0.1]'), '127.0.0.1', 'an IPv4-mapped literal becomes its IPv4 form')
  assert.equal(normalizeHostForMatch('::ffff:7f00:1'), '127.0.0.1', "Node's normalized mapped form is recognised too")
  assert.equal(normalizeHostForMatch(' Example.ORG '), 'example.org', 'ordinary hosts are just trimmed and lowercased')
  for (const spelling of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '0.0.0.0']) {
    assert.equal(isLoopbackHost(spelling), true, `every loopback spelling is loopback: ${spelling}`)
  }
  for (const spelling of ['example.org', '[2001:db8::1]', '10.0.0.1', '127.0.0.1.evil.example']) {
    assert.equal(isLoopbackHost(spelling), false, `not loopback: ${spelling}`)
  }
  assert.deepEqual(parseConnectAuthority('[::1]:443'), { host: '::1', port: 443 }, 'a bracketed CONNECT authority keeps its address intact')
  assert.deepEqual(parseConnectAuthority('example.org:8443'), { host: 'example.org', port: 8443 }, 'a plain CONNECT authority parses')
  assert.deepEqual(parseConnectAuthority('[2001:db8::1]:9443'), { host: '2001:db8::1', port: 9443 }, 'a remote IPv6 authority parses')
  assert.equal(parseConnectAuthority('[::1]').port, 443, 'a missing port defaults to 443')
  assert.equal(parseConnectAuthority('nonsense'), null, 'an unparseable authority is rejected')
  assert.equal(formatAuthority('2001:db8::1', 443), '[2001:db8::1]:443', 'IPv6 is bracketed on the wire')
  assert.equal(formatAuthority('example.org', 443), 'example.org:443', 'ordinary hosts are not bracketed')

  // Routing: no spelling of loopback ever goes upstream, even when listed.
  const cfg = {
    ...defaultProxyConfig(),
    upstream: { enabled: true, protocol: 'http', host: 'up.example', port: 8080, username: '', password: '' },
    proxiedHosts: ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '[2001:db8::1]'],
  }
  for (const spelling of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(shouldProxy(cfg, spelling), false, `loopback stays direct even when listed: ${spelling}`)
  }
  assert.equal(shouldProxy(cfg, '[2001:db8::1]'), true, 'a listed REMOTE IPv6 target is proxied')
  assert.equal(shouldProxy({ ...cfg, upstream: { ...cfg.upstream, host: '[::1]', port: 9999 } }, 'example.org', 9999), false, 'a bracketed loopback upstream is recognised as the self-loop')

  // End to end against the real listener: a bracketed loopback CONNECT must go
  // direct (and must not pollute the observed-host list with `[`), while a listed
  // remote IPv6 target goes upstream and keeps its bracketed wire form.
  {
    writeCfg({
      upstream: { enabled: true, protocol: 'http', host: '127.0.0.1', port: up.port(), username: '', password: '' },
      proxiedHosts: ['[::1]', '::1', '127.0.0.1', '[2001:db8::1]'],
      knownHosts: [],
    })
    const beforeUpstream = up.seen.length
    const loopbackAttempt = await rawConnect(proxyPort, '[::1]:9')
    loopbackAttempt.sock.destroy()
    assert.equal(up.seen.length, beforeUpstream, 'a bracketed loopback CONNECT never reaches the upstream')
    assert.ok(!proxy.hosts().includes('['), 'a bracketed CONNECT authority does not land in the observed hosts')

    const beforeRemote = up.seen.length
    const remoteAttempt = await rawConnect(proxyPort, '[2001:db8::1]:443')
    remoteAttempt.sock.destroy()
    const remoteHit = up.seen.slice(beforeRemote).find((entry) => entry.kind === 'connect')
    assert.ok(remoteHit !== undefined, 'a listed remote IPv6 target goes upstream')
    assert.equal(remoteHit.target, '[2001:db8::1]:443', 'the upstream CONNECT line keeps the IPv6 address bracketed')
  }
}

// ── scenario 15: fixed listen port (what the launch environment names) ──────
// Why: dsh installs its egress policy from the LAUNCH environment before any
// plugin mounts, so the only way the harness's OWN requests (model calls) ride
// this proxy is a port that is known before the proxy starts. A port that cannot
// be bound must not pass silently — a launcher naming it would send dsh's
// in-process egress into nothing.
{
  assert.equal(normalizeListenPort(45999), 45999, 'integer port survives')
  assert.equal(normalizeListenPort('8080'), 8080, 'numeric string coerces')
  assert.equal(normalizeListenPort(0), 0, 'zero means ephemeral')
  assert.equal(normalizeListenPort(70000), 0, 'out-of-range port becomes ephemeral')
  assert.equal(normalizeListenPort(-1), 0, 'negative port becomes ephemeral')
  assert.equal(normalizeListenPort('nonsense'), 0, 'garbage becomes ephemeral')
  assert.equal(defaultProxyConfig().listenPort, 0, 'default config listens on an ephemeral port (a fixed one is opt-in for launcher-declared deployments)')

  const cfgPath = join(work, 'listen.json')
  assert.equal(readProxyConfig(cfgPath).listenPort, 0, 'missing proxy.json -> ephemeral listen port')
  writeProxyConfig(cfgPath, { listenPort: 12345 })
  assert.equal(readProxyConfig(cfgPath).listenPort, 12345, 'written listen port is stored and read back')
  writeProxyConfig(cfgPath, {})
  assert.equal(readProxyConfig(cfgPath).listenPort, 12345, 'a save that omits the port keeps the stored one')
  writeProxyConfig(cfgPath, { listenPort: 'nonsense' })
  assert.equal(readProxyConfig(cfgPath).listenPort, 0, 'garbage port normalizes to ephemeral')
  writeFileSync(cfgPath, JSON.stringify({ listenPort: 99999 }))
  assert.equal(readProxyConfig(cfgPath).listenPort, 0, 'out-of-range STORED port normalizes to ephemeral')

  // A free fixed port is bound as requested, and reported as honored.
  const freeProbe = netCreateServer()
  await new Promise((r) => freeProbe.listen(0, '127.0.0.1', r))
  const fixed = freeProbe.address().port
  await new Promise((r) => freeProbe.close(r))
  const fixedProxy = createForwardProxy({ configFile: join(work, 'fixed.json'), listenPort: fixed })
  const boundPort = await fixedProxy.port
  assert.equal(boundPort, fixed, 'the requested fixed port is the one bound')
  assert.equal(fixedProxy.requestedPort, fixed, 'handle reports the requested port')
  assert.equal(fixedProxy.portHonored(), true, 'a free fixed port is honored')
  fixedProxy.close()

  // A taken port falls back to an ephemeral one AND says so.
  const blocker = netCreateServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const taken = blocker.address().port
  const fallbackLogs = []
  const fallbackProxy = createForwardProxy({
    configFile: join(work, 'taken.json'),
    listenPort: taken,
    log: (line) => fallbackLogs.push(line),
  })
  const fallbackPort = await fallbackProxy.port
  assert.ok(fallbackPort > 0 && fallbackPort !== taken, 'a taken fixed port still leaves a working listener')
  assert.equal(fallbackProxy.portHonored(), false, 'requested listen port taken -> falls back and reports it')
  assert.ok(
    fallbackLogs.some((line) => line.includes(String(taken))),
    'the fallback names the port it could not bind',
  )
  fallbackProxy.close()
  blocker.close()
}

proxy.close()
up.srv.close()
o1.srv.close()
rmSync(work, { recursive: true, force: true })
console.log('PASS — proxy-core (16 scenarios)')
process.exit(0)
