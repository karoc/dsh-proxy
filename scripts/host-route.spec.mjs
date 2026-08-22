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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-host-'))
// Point the plugin at a scratch DSH_HOME so it never touches ~/.dsh.
const home = join(work, 'home')
const configFile = join(home, 'proxy.json')
process.env.DSH_HOME = home

const { apply, proxyConfigPath, settingsPath } = await import('../src/index.ts')

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

// Fake cordis ctx: only `get('webServer')` and `effect` are used by apply().
const disposers = []
const ctx = {
  get(key) {
    assert.equal(key, 'webServer')
    return webServer
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
  console.log('PASS — host apply + /proxy/api (6 scenarios)')
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
    assert.ok(Array.isArray(body.hosts), 'hosts is a list')
    assert.ok(Array.isArray(body.knownHosts), 'knownHosts is a list')
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
