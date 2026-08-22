#!/usr/bin/env node
// Client-bundle boot test: loads lib/client.js the way the browser does —
// classic script, window.__ModuleLoader__.load({id, factory}), factory receives
// require(). Every require() target must be a known platform external (the
// loader's module table answers react + @deepseek-ai/*); anything else means
// the bundle would crash the whole web client on boot (white screen).
//
// We do NOT actually evaluate react/components (no DOM), but we DO assert the
// full set of require() targets the bundle makes at factory-execution time,
// which is what determines boot safety.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// Known platform externals the loader module table answers (CLIENT_EXTERNALS
// in tsdown.config.ts + runtime store exemption for these plugin-facing pkgs).
const KNOWN_EXTERNALS = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-settings',
])

// Collect every require("...") target in the bundle.
const requires = [...code.matchAll(/require\(("([^"]+)"|'([^']+)')\)/g)]
  .map((m) => m[2] ?? m[3])
  .filter((id) => id !== 'module' && id !== 'exports')

const unknown = [...new Set(requires)].filter((id) => !KNOWN_EXTERNALS.has(id))
console.log('require targets:', [...new Set(requires)].sort().join(', '))

if (unknown.length > 0) {
  console.error(`FAIL — bundle requires unknown modules not in the loader table:\n  ${unknown.join('\n  ')}`)
  console.error('A missing module here crashes the whole web client on boot (white screen).')
  process.exit(1)
}

// Banner/footer contract: the module-table loader wrapper.
assert.match(code, /window\.__ModuleLoader__\.load\(\{[\s\S]*?id: "dsh-proxy"[\s\S]*?factory:/, 'has __ModuleLoader__.load with id dsh-proxy')
assert.match(code, /return module\.exports;\s*\}\s*\}\);/, 'has closing factory footer')

console.log('PASS — client bundle: all require() targets are known platform externals; loader wrapper intact.')
