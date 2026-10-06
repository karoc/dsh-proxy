#!/usr/bin/env node
/**
 * Negative controls for this repo's gates: a gate nobody has seen FAIL is not
 * evidence. Every scenario below clones the committed tree into a temp dir,
 * injects ONE defect, runs the gate that is supposed to catch it, and asserts
 * the gate FAILS with the expected message. A scenario that passes (or that
 * fails for the wrong reason) fails this script.
 *
 * Why: this repo shipped a routing guard that matched only the literal
 * `127.0.0.1` while the README promised "loopback always direct", and the
 * assertion meant to pin that promise could not fail. Manual one-off proofs
 * decay; this script re-proves the gates on every run.
 *
 * Offline-friendly: DSH_RELEASE_ALLOW_REGISTRY_UNREACHABLE=1 is set so the
 * release gate's registry probe cannot turn the positive control red.
 */
import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const TAG = `v${VERSION}`

/** Fresh clone of the committed tree, with the (gitignored) build output copied in. */
function freshClone() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-control-'))
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, dir], { stdio: 'ignore' })
  if (!existsSync(join(root, 'lib/index.js'))) {
    console.error('❌ negative controls need a built artifact — run `npm run bundle` first')
    process.exit(1)
  }
  cpSync(join(root, 'lib'), join(dir, 'lib'), { recursive: true })
  return dir
}

/** Run a command inside the clone; never throws. */
function run(dir, command) {
  try {
    return { code: 0, output: execSync(command, { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, DSH_RELEASE_ALLOW_REGISTRY_UNREACHABLE: '1' } }) }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const scenarios = [
  {
    name: 'dirty working tree',
    command: 'node scripts/release-check.mjs',
    expect: /working tree is not clean/,
    mutate: (dir) => appendFileSync(join(dir, 'README.md'), '\n<!-- uncommitted -->\n'),
  },
  {
    name: 'CHANGELOG entry for the current version removed',
    command: 'node scripts/release-check.mjs',
    expect: new RegExp(`CHANGELOG\\.md has no entry for \\[${VERSION.replace(/\./g, '\\.')}\\]`),
    mutate: (dir) => {
      const p = join(dir, 'CHANGELOG.md')
      writeFileSync(p, readFileSync(p, 'utf8').replace(new RegExp(`^## \\[${VERSION.replace(/\./g, '\\.')}\\].*$`, 'm'), ''))
    },
  },
  {
    name: 'release tag deleted',
    command: 'node scripts/release-check.mjs',
    expect: new RegExp(`git tag ${TAG} does not exist`),
    mutate: (dir) => execFileSync('git', ['tag', '-d', TAG], { cwd: dir, stdio: 'ignore' }),
  },
  {
    name: 'build artifact removed',
    command: 'node scripts/release-check.mjs',
    expect: /is missing — run `npm run bundle` first/,
    mutate: (dir) => rmSync(join(dir, 'lib/index.js')),
  },
  {
    name: 'guarantee row loses its pinning assertion',
    command: 'node scripts/check-guarantees.mjs',
    expect: /no assertion matches/,
    mutate: (dir) => {
      const p = join(dir, 'docs/guarantees.md')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(/`unlisted host is direct`/, '`an assertion that does not exist`')
      // A no-op mutation would make this scenario pass for the wrong reason.
      if (after === before) throw new Error('mutation did not apply — the anchor is not in docs/guarantees.md')
      writeFileSync(p, after)
    },
  },
  {
    // The reported defect, re-injected at the seam that caused it: the host half
    // stops reading the live settings document and falls back to the legacy
    // file, which dsh ≥ 0.2 has already renamed away — the provider list goes
    // empty again (0 providers in the settings page).
    name: 'provider list stops reading the live settings document',
    command: 'node --test scripts/host-route.spec.mjs',
    expect: /providers come from the live settings document/,
    mutate: (dir) => {
      const p = join(dir, 'src/index.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('live: liveSettingsDocument(ctx),', 'live: undefined,')
      if (after === before) throw new Error('mutation did not apply — src/index.ts no longer reads the live settings document')
      writeFileSync(p, after)
    },
  },
  {
    // The layering itself: a readable live document must win. Without this the
    // gate could pass while the resolver silently prefers the legacy file.
    name: 'layered resolver prefers the legacy document over a live one',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /live settings document wins over a stale legacy settings\.yaml/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        'return opts.live !== undefined ? providerHostsFromEntries(opts.live) : providerHostsFromSettings(opts.legacyPath)',
        'return providerHostsFromSettings(opts.legacyPath)',
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer layers the live document')
      writeFileSync(p, after)
    },
  },
  {
    // A loopback provider offered as a proxy target is a checkbox that can
    // never take effect (routing sends loopback direct by guarantee).
    name: 'loopback provider hosts offered as proxy targets again',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /loopback provider hosts are never offered as proxy targets/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        'if (host && !isLoopbackHost(host)) out.push(',
        'if (host) out.push(',
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer filters loopback provider hosts')
      writeFileSync(p, after)
    },
  },
  {
    // A launcher names the fixed port; if it is taken, saying nothing sends dsh's
    // in-process egress into a port nobody listens on.
    name: 'a taken fixed listen port is reported as honored',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /requested listen port taken -> falls back and reports it/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('portHonored: () => requestedPort > 0 && boundPort === requestedPort,', 'portHonored: () => true,')
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer computes portHonored')
      writeFileSync(p, after)
    },
  },
  {
    // "In-process traffic is routed here" must not be optimistic: any other
    // launch proxy means dsh's own requests do NOT ride this proxy.
    name: 'any launch proxy counts as in-process routing',
    command: 'node --test scripts/host-route.spec.mjs',
    expect: /launch proxy pointing elsewhere is not in-process routing/,
    mutate: (dir) => {
      const p = join(dir, 'src/index.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && url.port === String(port)",
        'return true',
      )
      if (after === before) throw new Error('mutation did not apply — src/index.ts no longer matches the launch proxy against the bound port')
      writeFileSync(p, after)
    },
  },
  {
    // A launcher that already decides egress must keep deciding it: this
    // plugin's proxy sends non-ticked hosts DIRECT, so layering over the
    // launcher's policy would silently bypass it.
    name: 'self-installed egress displaces a launcher proxy',
    command: 'node --test scripts/egress.spec.mjs',
    expect: /a launcher-declared proxy is never displaced by the plugin/,
    mutate: (dir) => {
      const p = join(dir, 'src/egress.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('if (opts.launch !== null) {', 'if (false) {')
      if (after === before) throw new Error('mutation did not apply — src/egress.ts no longer guards against the launcher proxy')
      writeFileSync(p, after)
    },
  },
  {
    // "Installed" must never be assumed: an unresolvable policy package has to
    // surface as unavailable so the page can offer the environment fallback.
    name: 'a failed egress self-install claims success',
    command: 'node --test scripts/egress.spec.mjs',
    expect: /an unresolvable policy package is reported as unavailable/,
    mutate: (dir) => {
      const p = join(dir, 'src/egress.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "    return { status: 'unavailable', detail: (error as Error).message, dispose: null }\n  }\n  const values",
        "    return { status: 'self-installed', detail: null, dispose: null }\n  }\n  const values",
      )
      if (after === before) throw new Error('mutation did not apply — src/egress.ts no longer reports an unresolvable policy package')
      writeFileSync(p, after)
    },
  },
  {
    // Adopting a NON-loopback launch proxy would bind this plugin at an address
    // that is not ours to serve (a corporate proxy, or a name that resolves
    // elsewhere) — the launcher's own policy must keep owning egress.
    name: 'a non-loopback launch proxy gets adopted as our listen port',
    command: 'node --test scripts/host-route.spec.mjs',
    expect: /a non-loopback launch proxy is never adopted/,
    mutate: (dir) => {
      const p = join(dir, 'src/index.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return 0",
        '    if (false) return 0',
      )
      if (after === before) throw new Error('mutation did not apply — src/index.ts no longer restricts port adoption to loopback')
      writeFileSync(p, after)
    },
  },
  {
    // Routing that ignores the rule would silently invert what the page promises
    // ("checked hosts go upstream") for everyone using the except-listed mode.
    name: 'routing ignores the except-listed rule',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /except-listed: an unchecked host goes upstream/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "  return normalizeRouteMode(cfg?.routeMode) === 'except-listed' ? !listed : listed",
        '  return listed',
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer applies the routing rule')
      writeFileSync(p, after)
    },
  },
  {
    // A stored value nobody understands must not be read as "proxy everything".
    name: 'an unknown routing rule becomes all-upstream',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /an unknown route mode falls back to only-listed, never to all-upstream/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      // "just trust whatever was stored": the realistic version of this defect,
      // and narrow enough that the first failing assertion is the intended one.
      const after = before.replace(
        "  return value === 'except-listed' ? 'except-listed' : 'only-listed'",
        "  return (value ?? 'only-listed') as RouteMode",
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer fails safe on an unknown rule')
      writeFileSync(p, after)
    },
  },
  {
    // The bracketed spelling a URL parser hands us must count as loopback, or a
    // `[::1]` target can be sent to the upstream proxy.
    name: 'a bracketed IPv6 loopback stops being loopback',
    command: 'node --test scripts/proxy-core.spec.mjs',
    // The mutation is caught by the first assertion it reaches: the provider list
    // must not offer a bracketed loopback endpoint. The matcher lives in
    // src/host-match.ts (shared with the client half).
    expect: /IPv6 loopback endpoints are never offered/,
    mutate: (dir) => {
      const p = join(dir, 'src/host-match.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "  const bare = String(host ?? '').trim().toLowerCase().replace(/^\\[|\\]$/g, '')",
        "  const bare = String(host ?? '').trim().toLowerCase()",
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer unwraps bracketed literals')
      writeFileSync(p, after)
    },
  },
  {
    // The same target arrives as `[v6]` from a provider baseURL and as `v6` from
    // a CONNECT authority: exact-string matching silently drops one of them.
    name: 'listed hosts are matched by exact string again',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /a listed remote IPv6 target goes upstream/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        '  const listed = (cfg?.proxiedHosts ?? []).some((entry) => normalizeHostForMatch(entry) === wanted)',
        '  const listed = (cfg?.proxiedHosts ?? []).includes(h)',
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer normalizes host matching')
      writeFileSync(p, after)
    },
  },
  {
    // Parsing a CONNECT authority by splitting on ':' turns `[::1]:443` into
    // host `[`, which both defeats the loopback guard and pollutes the list.
    name: 'CONNECT authority is split on colons again',
    command: 'node --test scripts/proxy-core.spec.mjs',
    // The split is caught first by the SOCKS5 IPv6-target case (the address is
    // mangled into `[2001` long before the observed-host assertion runs); that it
    // also pollutes the host list is asserted later in the same spec.
    expect: /socks5: IPv6 target is sent as ATYP=4 with 16 address bytes/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        "    const target = parseConnectAuthority(String(req.url ?? ''))",
        "    const [h0, p0] = String(req.url ?? '').split(':'); const target = { host: (h0 ?? '').toLowerCase(), port: Number(p0) || 443 }",
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer parses the CONNECT authority')
      writeFileSync(p, after)
    },
  },
  {
    // An IPv6 target sent to a SOCKS5 upstream as a DOMAIN is a name no resolver
    // can answer; the wire form has to be ATYP=4 with the address bytes.
    name: 'an IPv6 SOCKS5 target is sent as a domain again',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /socks5: IPv6 target is sent as ATYP=4 with 16 address bytes/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('  } else if (isIPv6(targetHost)) {', '  } else if (false) {')
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer encodes IPv6 targets')
      writeFileSync(p, after)
    },
  },
  {
    // Clearing only the file leaves the session set to re-add everything on the
    // next persist, so the control silently undoes itself.
    name: 'clearing observed hosts leaves the live set behind',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /forgetHosts clears the live set so the next persist cannot write the cleared hosts back/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('      seenHosts.clear()\n      if (notifyTimer) clearTimeout(notifyTimer)', '      if (notifyTimer) clearTimeout(notifyTimer)')
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer clears the live observed set')
      writeFileSync(p, after)
    },
  },
  {
    // Dropping the gate exposes the upstream credentials and the routing to any
    // local process, which is exactly what the harness /api door prevents.
    name: 'the proxy route skips the operator-session gate',
    command: 'node scripts/host-route.spec.mjs',
    expect: /\/proxy\/api requires the operator session when the connection service exists/,
    mutate: (dir) => {
      const p = join(dir, 'src/index.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace('      if (rejection !== undefined) {', '      if (false) {')
      if (after === before) throw new Error('mutation did not apply — src/index.ts no longer gates the settings route')
      writeFileSync(p, after)
    },
  },
  {
    // Falling back to defaults on a broken read silently disables the upstream —
    // the traffic that was meant to be proxied goes direct instead.
    name: 'a broken config falls back to defaults instead of the last good one',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /a broken config file keeps the last good config instead of disabling the upstream/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace(
        '    return lastGoodConfig.get(configFile) ?? defaultProxyConfig()',
        '    return defaultProxyConfig()',
      )
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer caches the last good config')
      writeFileSync(p, after)
    },
  },
  {
    // Binding without a host exposes the forward proxy (and the upstream
    // credentials it injects) to the whole network.
    name: 'the forward proxy binds every interface',
    command: 'node --test scripts/proxy-core.spec.mjs',
    expect: /the forward proxy binds loopback only/,
    mutate: (dir) => {
      const p = join(dir, 'src/proxy-core.ts')
      const before = readFileSync(p, 'utf8')
      const after = before.replace("server.listen(candidate, '127.0.0.1')", 'server.listen(candidate)')
      if (after === before) throw new Error('mutation did not apply — src/proxy-core.ts no longer pins the listen host')
      writeFileSync(p, after)
    },
  },
]

let failed = 0
console.log('▶ positive control — an unmutated clone must PASS both gates')
{
  const dir = freshClone()
  const release = run(dir, 'node scripts/release-check.mjs')
  const guarantees = run(dir, 'node scripts/check-guarantees.mjs')
  rmSync(dir, { recursive: true, force: true })
  const ok = release.code === 0 && guarantees.code === 0
  console.log(`${ok ? '  ✅' : '  ❌'} release-check exit=${release.code}, guarantee gate exit=${guarantees.code}`)
  if (!ok) {
    failed += 1
    console.log(`     release tail: ${release.output.trim().split('\n').slice(-3).join(' | ')}`)
    console.log(`     guarantees tail: ${guarantees.output.trim().split('\n').slice(-2).join(' | ')}`)
  }
  if (ok) console.log(`     (release-check: ${release.output.trim().split('\n').pop()})`)
}

for (const scenario of scenarios) {
  const dir = freshClone()
  let result
  try {
    scenario.mutate(dir)
    result = run(dir, scenario.command)
  } catch (error) {
    result = { code: 0, output: `mutation threw: ${error.message}` }
  }
  rmSync(dir, { recursive: true, force: true })
  const caught = result.code !== 0 && scenario.expect.test(result.output)
  console.log(`${caught ? '✅' : '❌'} ${scenario.name}`)
  if (!caught) {
    failed += 1
    console.log(`     exit=${result.code} expected ${scenario.expect}`)
    console.log(`     output: ${result.output.trim().split('\n').slice(0, 3).join(' | ')}`)
  }
}

if (failed > 0) {
  console.error(`\n❌ ${failed} negative control(s) failed — a gate is not load-bearing as documented`)
  process.exit(1)
}
console.log(`\n✅ all ${scenarios.length} negative controls + the positive control behaved as documented`)
