#!/usr/bin/env node
// Decision + resolution tests for src/egress.ts — the module that puts dsh's
// OWN requests (model calls, web fetch) behind this plugin's forward proxy.
//
// Why this file exists: the harness resolves its egress policy from the LAUNCH
// environment before any plugin mounts, so a plugin can only join in by
// installing that same policy itself. Two rules must hold, and both are
// behaviours a maintainer could otherwise "simplify" away:
//   * it must NOT install anything when a launcher already declared a proxy —
//     our proxy sends non-ticked hosts DIRECT, so layering would silently bypass
//     that launcher's egress policy;
//   * a failure to resolve/install must be REPORTED, never a silent "assume it
//     worked" (the settings page shows the fallback the user then needs).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createPolicyImporter, installInProcessEgress, POLICY_PACKAGE } from '../src/egress.ts'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-egress-'))

/** A stand-in for the harness policy package that records what it was asked to do. */
function fakePolicy() {
  const calls = []
  return {
    calls,
    module: {
      async installProxyFromEnvironment(env, report) {
        calls.push({
          http: env.get('HTTP_PROXY')?.value,
          https: env.get('https_proxy')?.value,
          all: env.get('ALL_PROXY')?.value,
          noProxy: env.get('NO_PROXY')?.value,
        })
        report('fake policy installed')
        return async () => { calls.push({ disposed: true }) }
      },
    },
  }
}

try {
  // ── no launcher proxy: install our own policy ──────────────────────────────
  {
    const fake = fakePolicy()
    const logs = []
    const outcome = await installInProcessEgress({
      proxyUrl: 'http://127.0.0.1:41234',
      launch: null,
      importer: async () => fake.module,
      log: (line) => logs.push(line),
    })
    assert.equal(outcome.status, 'self-installed', 'no launcher proxy -> the plugin installs the policy itself')
    assert.equal(fake.calls[0]?.http, 'http://127.0.0.1:41234', 'http scheme routes at this proxy')
    assert.equal(fake.calls[0]?.https, 'http://127.0.0.1:41234', 'the lowercase env name resolves too (undici reads it first)')
    assert.equal(fake.calls[0]?.all, undefined, 'ALL_PROXY is not claimed — only the two schemes this proxy serves')
    assert.ok(String(fake.calls[0]?.noProxy).includes('127.0.0.1'), 'loopback stays bypassed')
    assert.ok(logs.includes('fake policy installed'), 'the policy module diagnostics reach the plugin log')
    await outcome.dispose?.()
    assert.ok(fake.calls.some((call) => call.disposed === true), 'dispose restores the previous policy')
  }

  // ── a launcher-declared proxy is never displaced ───────────────────────────
  {
    const fake = fakePolicy()
    const outcome = await installInProcessEgress({
      proxyUrl: 'http://127.0.0.1:41234',
      launch: { name: 'HTTP_PROXY', value: 'http://corp.example:8080' },
      importer: async () => fake.module,
      log: () => {},
    })
    assert.equal(outcome.status, 'launcher', 'a launcher-declared proxy is never displaced by the plugin')
    assert.equal(fake.calls.length, 0, 'nothing is installed over the launcher policy')
    assert.equal(outcome.dispose, null, 'nothing to dispose when nothing was installed')
    assert.match(String(outcome.detail), /HTTP_PROXY/, 'the page can name the variable that owns egress')
  }

  // ── failures are reported, never silent ────────────────────────────────────
  {
    const unresolvable = await installInProcessEgress({
      proxyUrl: 'http://127.0.0.1:41234',
      launch: null,
      importer: async () => { throw new Error('not resolvable here') },
      log: () => {},
    })
    assert.equal(unresolvable.status, 'unavailable', 'an unresolvable policy package is reported as unavailable')
    assert.match(String(unresolvable.detail), /not resolvable here/, 'the resolution failure reaches the page')

    const throwing = await installInProcessEgress({
      proxyUrl: 'http://127.0.0.1:41234',
      launch: null,
      importer: async () => ({ installProxyFromEnvironment: async () => { throw new Error('install exploded') } }),
      log: () => {},
    })
    assert.equal(throwing.status, 'unavailable', 'a throwing installer is reported, never a silent success')
    assert.match(String(throwing.detail), /install exploded/, 'the install failure reaches the page')
    assert.equal(throwing.dispose, null, 'a failed install hands back no disposer')
  }

  // ── the resolver finds the package through an anchored node_modules ────────
  {
    const anchorDir = join(work, 'profile')
    const pkgDir = join(anchorDir, 'node_modules', ...POLICY_PACKAGE.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(anchorDir, 'package.json'), JSON.stringify({ name: 'fake-profile', private: true }))
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: POLICY_PACKAGE, version: '0.0.0', type: 'module', main: 'index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export async function installProxyFromEnvironment() { return async () => {} }\n')
    const module = await createPolicyImporter([join(anchorDir, 'package.json')])()
    assert.equal(
      typeof module.installProxyFromEnvironment,
      'function',
      'the importer resolves the policy package from a profile-anchored node_modules',
    )
    // And the resolved module is usable end to end.
    const outcome = await installInProcessEgress({
      proxyUrl: 'http://127.0.0.1:41234',
      launch: null,
      importer: async () => module,
      log: () => {},
    })
    assert.equal(outcome.status, 'self-installed', 'a resolved policy module installs cleanly')
    await outcome.dispose?.()
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log('PASS — egress (4 scenarios)')
