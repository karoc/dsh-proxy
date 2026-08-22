#!/usr/bin/env node
// Real-cordis mount test: loads the built host bundle and mounts it through an
// actual @deepseek-ai/cordis Context (like the host loader does), with a fake
// webServer service. Catches loader-contract failures that a fake-ctx test
// would miss: inject resolution, ctx.effect availability, apply() throwing.
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-cordis-'))
process.env.DSH_HOME = join(work, 'home')

// Fake webServer service that records registered routes.
const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

const ctx = new Context()
ctx.provide('webServer', webServer)
console.log('cordis ctx.effect type:', typeof ctx.effect)

try {
  const mod = await import('../lib/index.js')
  console.log('module exports:', Object.keys(mod).join(','))
  console.log('name:', mod.name, '| inject:', JSON.stringify(mod.inject))

  // Mount via cordis plugin() like the loader does.
  ctx.plugin({ name: mod.name, inject: mod.inject, apply: mod.apply })
  await new Promise((r) => setTimeout(r, 300)) // let async proxy start

  console.log('routes registered:', routes.length, routes.map((r) => r.path).join(','))
  console.log('HTTP_PROXY:', process.env.HTTP_PROXY)
  console.log('NODE_USE_ENV_PROXY:', process.env.NODE_USE_ENV_PROXY)

  const ok = routes.length === 1 && routes[0].path === '/proxy/api' && !!process.env.HTTP_PROXY
  console.log(ok ? 'PASS — real cordis mount: apply ran, route registered, env set' : 'FAIL — mount incomplete')
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('MOUNT FAIL:', e)
  process.exit(1)
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* noop */ }
}
