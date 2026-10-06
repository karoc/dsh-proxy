#!/usr/bin/env node
// Packed-artifact acceptance: what OTHER USERS get must be the thing that was
// tested. The specs otherwise exercise `src/*.ts` and the repo's own `lib/*.js`,
// so a `files` mistake (a missing bundle, a stale build, an accidental `src/`
// inclusion) would only surface after `npm publish` — in someone else's install.
//
// What this pins:
//   1. the tarball ships EXACTLY the documented member set (nothing missing,
//      nothing extra: no src/, no scripts/, no source maps, no verify report);
//   2. `lib/index.js` and `lib/client.js` inside the tarball are byte-identical
//      to the repository's build outputs (a stale bundle cannot be published);
//   3. the PACKED host bundle loads from a profile-shaped install path — the
//      layout npm creates for a real user — starts its proxy, registers the route
//      and serves it;
//   4. from that same installed path it resolves the harness egress package and
//      self-installs it with the right URLs, using a stub package (no network).
//
// `npm pack --ignore-scripts` keeps this hermetic: release-check already guards
// build freshness and the tag/tree state, and a spec must not depend on them.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-pack-'))
const cache = join(work, 'npm-cache')
const logs = join(work, 'npm-logs')
mkdirSync(cache)
mkdirSync(logs)

const EXPECTED_MEMBERS = [
  'package/CHANGELOG.md',
  'package/CONTRIBUTING.md',
  'package/LICENSE',
  'package/README.md',
  'package/README.zh.md',
  'package/cordis.patch.yml',
  'package/lib/client.js',
  'package/lib/index.js',
  'package/package.json',
].sort()

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packJson = JSON.parse(execFileSync('npm', [
  'pack', root, '--ignore-scripts', '--json',
  '--cache', cache, '--logs-dir', logs, '--pack-destination', work,
], { encoding: 'utf8' }))
const packed = packJson[0]
const tarball = join(work, packed.filename)

// ── 1. member set ───────────────────────────────────────────────────────────
const members = packed.files.map((entry) => `package/${entry.path}`).sort()
assert.deepEqual(
  members,
  EXPECTED_MEMBERS,
  `the published tarball ships exactly the documented members (got ${JSON.stringify(members)})`,
)

// ── 2. the bundles inside were built from THIS source ──────────────────────
// Comparing the tarball against lib/ in the same tree would be a vacuous check
// (a stale file appears on both sides); comparing against a FRESH BUILD of the
// current source is what actually pins "published bytes == current code". The
// build is deterministic (verified), so the comparison is exact.
const extractDir = join(work, 'extract')
mkdirSync(extractDir, { recursive: true })
execFileSync('tar', ['-xzf', tarball, '-C', extractDir])
const rebuild = join(work, 'rebuild')
const tsdown = join(root, 'node_modules', '.bin', 'tsdown')
assert.ok(existsSync(tsdown), 'tsdown is installed (run pnpm install before this gate)')
execFileSync(tsdown, ['--config', join(root, 'tsdown.config.ts'), '--out-dir', rebuild], { cwd: root, stdio: 'pipe' })
for (const bundle of ['index.js', 'client.js']) {
  assert.equal(
    readFileSync(join(extractDir, 'package', 'lib', bundle)).toString(),
    readFileSync(join(rebuild, bundle)).toString(),
    `the packed lib/${bundle} is byte-identical to a fresh build of this source (no stale bundle can be published)`,
  )
}
const packedManifest = JSON.parse(readFileSync(join(extractDir, 'package', 'package.json'), 'utf8'))
assert.equal(packedManifest.version, pkg.version, 'the packed manifest carries this version')

// ── 3./4. load it from the layout npm creates, not from the repo ────────────
// <work>/profiles/web/node_modules/@karoc/dsh-proxy/…  (host bundle here)
// <work>/profiles/web/node_modules/@deepseek-ai/dsh-http-proxy/  (stub policy)
const installed = join(work, 'profiles', 'web', 'node_modules', '@karoc', 'dsh-proxy')
mkdirSync(installed, { recursive: true })
cpSync(join(extractDir, 'package'), installed, { recursive: true })
const policyStub = join(work, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-http-proxy')
mkdirSync(join(policyStub, 'lib'), { recursive: true })
writeFileSync(join(policyStub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-http-proxy', version: '0.0.0-stub', type: 'module', main: 'lib/index.js' }))
// The harness contract: installProxyFromEnvironment(lookup, log) where `lookup`
// is an OBJECT with get(name) (not a function) and the return value is a disposer.
writeFileSync(join(policyStub, 'lib', 'index.js'), `
export const calls = globalThis.__proxyPolicyStubCalls ??= []
export function installProxyFromEnvironment(lookup, log) {
  // The harness's own contract (packages/http-proxy): get() answers an ENVELOPE
  // { value } or undefined — verified against its source, not assumed.
  const read = (name) => {
    const hit = lookup?.get?.(name)
    if (hit === undefined) return undefined
    if (typeof hit === 'object' && typeof hit.value === 'string') return hit.value
    return { malformed: hit }
  }
  calls.push({
    lookupShape: typeof lookup,
    hasGet: typeof lookup?.get === 'function',
    http: read('HTTP_PROXY'),
    https: read('HTTPS_PROXY'),
    noProxy: read('NO_PROXY'),
  })
  if (typeof log === 'function') log('stub policy installed')
  return () => { calls.push({ disposed: true }) }
}
`)

process.env.DSH_HOME = join(work, 'home')
// This spec may inherit HTTP(S)_PROXY from the shell that launched it — a dsh host
// exports them to its children, which is exactly how the plugin routes that
// host's traffic. Inherited variables would make the plugin yield to a "launcher"
// (correctly!) instead of self-installing, so the precondition is stated here.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[name]
}
const mod = await import(join(installed, 'lib', 'index.js'))
assert.equal(typeof mod.apply, 'function', 'the packed host bundle exports apply()')

let routeHandler = null
const webServer = {
  register(route) {
    assert.equal(route.path, '/proxy/api')
    routeHandler = route.handler
    return () => {}
  },
}
const disposers = []
const ctx = {
  get(key) {
    if (key === 'webServer') return webServer
    // `documentPath` is the profile document the harness reports at runtime: the
    // resolver anchors on the profile's package.json next to it.
    if (key === 'settings') return { describe: () => ({ namespaces: [], documentPath: join(work, 'profiles', 'web', 'cordis.patch.yml') }) }
    return undefined
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}
writeFileSync(join(work, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'profile-web', private: true }))

const server = createServer((req, res) => routeHandler(req, res))
try {
  mod.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const view = await (await fetch(`${origin}/proxy/api`)).json()
  assert.equal(view.ok, true, 'the packed host bundle serves /proxy/api from an installed path')
  assert.ok(Number.isInteger(view.port) && view.port > 0, 'the packed bundle bound a listening port')

  // The self-install path: the stub policy package must have been found through
  // the profile anchor and called with this proxy's URL.
  assert.equal(view.egressStatus, 'self-installed', `the packed bundle resolved the harness policy package from its installed location (status ${view.egressStatus}: ${view.egressDetail ?? '-'})`)
  const calls = globalThis.__proxyPolicyStubCalls ?? []
  assert.equal(calls.length, 1, 'the policy install was called exactly once')
  assert.equal(calls[0].lookupShape, 'object', 'the policy package got the harness lookup contract (an object with get)')
  assert.equal(calls[0].hasGet, true, 'the lookup exposes get()')
  assert.equal(calls[0].http, `http://127.0.0.1:${view.port}`, 'the policy got this proxy as HTTP_PROXY')
  assert.equal(calls[0].https, `http://127.0.0.1:${view.port}`, 'the policy got this proxy as HTTPS_PROXY')
} finally {
  server.close()
  for (const dispose of disposers.splice(0)) { try { dispose() } catch { /* noop */ } }
  rmSync(work, { recursive: true, force: true })
  delete process.env.DSH_HOME
}

console.log('PASS — packed artifact: member set, in-tarball bundles, installed-layout load + self-install')
