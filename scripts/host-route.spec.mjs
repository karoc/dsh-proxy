#!/usr/bin/env node
// Host-half integration test for dsh-proxy: runs the real `apply(ctx)` with a
// fake webServer whose route registration is wired to a real node:http server,
// then exercises /proxy/api over real HTTP. No dsh runtime needed (cordis is
// imported type-only in src/index.ts, so it is erased at runtime).
//
// Covers:
//   - apply() starts the forward proxy and points process env at it
//   - GET /proxy/api returns the config view (upstream + proxiedHosts + hosts)
//   - POST op=save persists sanitized config
//   - POST op=test returns {ok, detail}
//   - the loopback proxy actually forwards a request (route through it)
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer as netCreateServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-host-'))
// Point the plugin at a scratch DSH_HOME so it never touches ~/.dsh.
const home = join(work, 'home')
const configFile = join(home, 'proxy.json')
process.env.DSH_HOME = home

// A FIXED listen port named by the LAUNCH environment is the one mechanism
// that puts dsh's own in-process requests (model calls) behind this proxy: the
// harness installs its egress policy from that environment before plugins mount,
// so no plugin can do it afterwards. Pin the whole path end to end below.
const launchProbe = netCreateServer()
await new Promise((r) => launchProbe.listen(0, '127.0.0.1', r))
const launchPort = launchProbe.address().port
await new Promise((r) => launchProbe.close(r))
mkdirSync(home, { recursive: true })
// No listenPort configured: the plugin must ADOPT the port the launch
// environment names — that address is what dsh's already-installed policy (and
// the launcher's contract) expects this proxy to be at.
writeFileSync(configFile, JSON.stringify({}) + '\n')
process.env.HTTP_PROXY = `http://user:secret@127.0.0.1:${launchPort}`

const { apply, proxyConfigPath, settingsPath, launchProxyTargetsPort, launchProxyLoopbackPort, maskProxyUrl } = await import('../src/index.ts')

// A fake webServer: capture the registered handler and serve it on a real
// node:http server so the test can hit it over HTTP.
let routeHandler = null
const webServer = {
  register(route) {
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/proxy/api')
    routeHandler = route.handler
    return () => {}
  },
}

// Fake cordis ctx: `get('webServer')` + `get('settings')` are the only reads
// apply() makes. The settings service answers the shape the running harness
// answers with (`{namespaces: [{ns, value}]}`) — and is swappable, so the specs
// below can prove the live source is read (per request, not cached) and that a
// missing/throwing service falls back to the legacy document.
const liveDocument = () => ({ namespaces: [
  { ns: 'llm-pi-ai', value: { providers: {
    ark: { displayName: 'Ark', baseURL: 'https://ark.example/v1' },
    local: { displayName: 'Local', baseURL: 'http://127.0.0.1:11434/v1' },
  } } },
  { ns: 'llm-deepseek', value: { baseURL: 'https://api.deepseek.com/anthropic' } },
] })
let settingsService = { describe: () => liveDocument() }
const disposers = []
const ctx = {
  get(key) {
    if (key === 'webServer') return webServer
    if (key === 'settings') return settingsService
    return undefined
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}

apply(ctx)

// Wire the captured handler to a real server.
const server = createServer((req, res) => {
  routeHandler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const api = async (method, body) => {
  const res = await fetch(`${origin}/proxy/api`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

try {
  await run()
  console.log('PASS — host apply + /proxy/api (7 scenarios)')
  process.exit(0)
} finally {
  server.close()
  for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* noop */ } }
  rmSync(work, { recursive: true, force: true })
  delete process.env.DSH_HOME
}

async function run() {
  // ── host wiring: env vars point at the loopback proxy ────────────────────
  assert.equal(process.env.NODE_USE_ENV_PROXY, '1', 'NODE_USE_ENV_PROXY set')
  assert.match(process.env.HTTP_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'HTTP_PROXY set to loopback')
  assert.match(process.env.HTTPS_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'HTTPS_PROXY set')
  assert.match(process.env.NO_PROXY ?? '', /127\.0\.0\.1/, 'NO_PROXY includes loopback')
  const proxyPort = Number(new URL(process.env.HTTP_PROXY).port)
  assert.ok(proxyPort > 0, 'proxy port parsed')

  // ── GET: default view ────────────────────────────────────────────────────
  {
    const { status, body } = await api('GET')
    assert.equal(status, 200, 'GET /proxy/api 200')
    assert.equal(body.ok, true, 'view ok')
    assert.equal(body.upstream.enabled, false, 'default upstream disabled')
    assert.deepEqual(body.proxiedHosts, [], 'default no proxied hosts')
    assert.ok(Array.isArray(body.providers), 'providers is a list')
    // The launch environment named this port, so dsh's own requests ride here.
    assert.equal(body.listenPort, 0, 'nothing is configured: the port comes from the launch environment')
    assert.equal(body.port, launchPort, 'the proxy bound the port the launch environment names')
    assert.equal(body.portRequested, launchPort, 'the adopted port is reported as the requested one')
    assert.equal(body.portHonored, true, 'a free fixed port is honored at runtime')
    assert.equal(body.inProcessRouted, true, 'launch environment naming this port -> in-process traffic is routed here')
    assert.equal(launchProxyLoopbackPort({ name: 'HTTP_PROXY', value: `http://localhost:${launchPort}` }), launchPort, 'adoption recognises the loopback spellings')
    assert.equal(launchProxyLoopbackPort({ name: 'HTTP_PROXY', value: 'http://corp.example:8080' }), 0, 'a non-loopback launch proxy is never adopted')
    assert.equal(launchProxyLoopbackPort({ name: 'HTTP_PROXY', value: 'not a url' }), 0, 'a malformed launch proxy is never adopted')
    assert.equal(launchProxyLoopbackPort(null), 0, 'no launch proxy -> nothing to adopt')
    assert.ok(String(body.launchProxy).includes('127.0.0.1'), 'the launch proxy is reported')
    assert.ok(!String(body.launchProxy).includes('secret'), 'launch proxy credentials never leave the process')
    // A launcher that already decides egress keeps deciding it: this plugin's
    // proxy sends non-ticked hosts DIRECT, so layering a policy over the
    // launcher's would silently bypass it.
    assert.equal(body.egressStatus, 'launcher', 'a launch-environment proxy owns egress; the plugin does not install over it')
    assert.ok(String(body.egressDetail).includes('HTTP_PROXY'), 'the page can name the variable that owns egress')

    // The flag must not be optimistic: anything else means dsh's own requests
    // do NOT ride this proxy.
    assert.equal(
      launchProxyTargetsPort({ name: 'HTTP_PROXY', value: `http://127.0.0.1:${launchPort + 1}` }, launchPort),
      false,
      'launch proxy pointing elsewhere is not in-process routing',
    )
    assert.equal(
      launchProxyTargetsPort({ name: 'HTTP_PROXY', value: `http://proxy.example:${launchPort}` }, launchPort),
      false,
      'a non-loopback launch proxy is not in-process routing',
    )
    assert.equal(launchProxyTargetsPort(null, launchPort), false, 'no launch proxy -> not in-process routing')
    assert.ok(!maskProxyUrl('http://u:p@127.0.0.1:1').includes('u:p'), 'maskProxyUrl strips credentials')
    assert.ok(Array.isArray(body.hosts), 'hosts is a list')
    assert.ok(Array.isArray(body.knownHosts), 'knownHosts is a list')
  }

  // ── GET: model providers come from the LIVE settings service ─────────────
  {
    const { body } = await api('GET')
    assert.deepEqual(body.providers, [
      { name: 'llm-pi-ai/ark', displayName: 'Ark', host: 'ark.example' },
      { name: 'llm-deepseek', displayName: 'DeepSeek', host: 'api.deepseek.com' },
    ], 'providers come from the live settings document (loopback entry dropped)')

    // A provider added to the live config shows up on the NEXT read — no
    // restart, no snapshot cached at apply() time.
    settingsService = { describe: () => ({ namespaces: [
      { ns: 'llm-pi-ai', value: { providers: { fresh: { baseURL: 'https://fresh.example/v1' } } } },
    ] }) }
    const after = await api('GET')
    assert.deepEqual(after.body.providers, [{ name: 'llm-pi-ai/fresh', host: 'fresh.example' }], 'provider list follows the live document on every read')

    // No settings service (older composition): the legacy document is read.
    settingsService = undefined
    mkdirSync(home, { recursive: true })
    writeFileSync(settingsPath(), ['llm-pi-ai:', '  providers:', '    legacy:', '      baseURL: https://legacy.example/v1', ''].join('\n'))
    const legacy = await api('GET')
    assert.deepEqual(legacy.body.providers, [{ name: 'llm-pi-ai/legacy', host: 'legacy.example' }], 'no settings service -> legacy settings.yaml is read')

    // A settings read that throws must not take the route down.
    settingsService = { describe: () => { throw new Error('settings unavailable') } }
    const thrown = await api('GET')
    assert.equal(thrown.status, 200, 'a throwing settings read keeps GET /proxy/api at 200')
    assert.deepEqual(thrown.body.providers, [{ name: 'llm-pi-ai/legacy', host: 'legacy.example' }], 'a throwing settings read falls back to the legacy document')

    // Restore the live service + drop the scratch legacy file.
    settingsService = { describe: () => liveDocument() }
    rmSync(settingsPath(), { force: true })
  }

  // ── POST save: persists sanitized config ─────────────────────────────────
  {
    const { status, body } = await api('POST', {
      op: 'save',
      upstream: { enabled: true, protocol: 'socks5', host: 'proxy.example', port: 1080, username: 'a', password: 'b', extra: 'x' },
      proxiedHosts: ['API.DeepSeek.com,', '  example.org  ', ''],
    })
    assert.equal(status, 200, 'save 200')
    assert.equal(body.upstream.enabled, true, 'saved upstream enabled')
    assert.equal(body.upstream.protocol, 'socks5', 'saved protocol')
    assert.equal(body.upstream.host, 'proxy.example', 'saved host')
    assert.equal(body.upstream.extra, undefined, 'extra key dropped (sanitized)')
    assert.deepEqual(body.proxiedHosts, ['api.deepseek.com', 'example.org'], 'proxied hosts normalized')
    // Persisted on disk at <DSH_HOME>/proxy.json.
    const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(configFile, 'utf8'))
    assert.deepEqual(onDisk.proxiedHosts, ['api.deepseek.com', 'example.org'], 'proxy.json holds normalized hosts')
  }

  // ── GET after save: view reflects persisted config ───────────────────────
  {
    const { body } = await api('GET')
    assert.equal(body.upstream.enabled, true, 'view reflects saved upstream')
    assert.deepEqual(body.proxiedHosts, ['api.deepseek.com', 'example.org'], 'view reflects saved hosts')
  }

  // ── POST test: unreachable upstream → {ok:false, detail} (no hang) ───────
  {
    const start = Date.now()
    const { status, body } = await api('POST', {
      op: 'test',
      upstream: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 1, username: '', password: '' },
    })
    assert.equal(status, 200, 'test 200')
    assert.equal(body.ok, false, 'dead upstream reports ok:false')
    assert.ok(body.detail.length > 0, 'test has a detail message')
    assert.ok(Date.now() - start < 8000, 'test fails fast (no hang)')
  }

  // ── POST unknown op → 400 ────────────────────────────────────────────────
  {
    const { status } = await api('POST', { op: 'nope' })
    assert.equal(status, 400, 'unknown op 400')
  }

  // ── the loopback proxy itself forwards an HTTP request ───────────────────
  {
    // A tiny origin.
    const o = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`origin:${req.method}:${req.url}`)
    })
    await new Promise((r) => o.listen(0, '127.0.0.1', r))
    const O1 = `127.0.0.1:${o.address().port}`
    const res = await new Promise((resolvePromise, rejectPromise) => {
      const req = httpRequest({
        host: '127.0.0.1', port: proxyPort,
        method: 'GET', path: `http://${O1}/proxied`,
      }, (r) => {
        let b = ''
        r.on('data', (d) => { b += d })
        r.on('end', () => resolvePromise({ status: r.statusCode, body: b }))
      })
      req.on('error', rejectPromise)
      req.end()
    })
    assert.equal(res.status, 200, 'proxy forwards HTTP')
    assert.equal(res.body, 'origin:GET:/proxied', 'origin got the request (direct route)')
    o.close()
  }
}
