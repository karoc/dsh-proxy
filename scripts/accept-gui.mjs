#!/usr/bin/env node
/**
 * GUI acceptance for dsh-proxy: verifies, against the LIVE dsh web GUI:
 *   1. the plugin client bundle is served (/plugins/dsh-proxy/client.js 200)
 *   2. the /proxy/api route is live (host half registered it)
 *   3. the Settings page shows a "思磨力代理 / Smoothly Proxy" section entry
 *
 * Run AFTER restarting dsh web (the plugin set is only scanned at startup).
 * Requires Playwright (chromium). `pnpm accept` / `node scripts/accept-gui.mjs`.
 */
import { chromium } from 'playwright'
import { mintBrowserCookie } from './lib/auth-cookie.mjs'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. bundle served (host endpoint). On dsh ≥ 0.1.3 external bundles are
//    served under the boot manifest's scoped id with a rev query
//    (/plugins/??@karoc/dsh-proxy/client.js&rev=<rev>); resolve the entry URL
//    from the boot HTML exactly as the GUI does, then fetch it.
const bundleUrl = await (async () => {
  try {
    const cookie = mintBrowserCookie()
    const html = await (await fetch(ORIGIN, { headers: { cookie: `${cookie.name}=${cookie.value}` } })).text()
    const idx = html.indexOf('__DSH_BOOT__')
    const chunk = idx >= 0 ? html.slice(idx, idx + 200000) : ''
    const match = chunk.match(/\{"id":"@karoc\/dsh-proxy","url":"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
})()
if (bundleUrl === null) {
  check('plugin client bundle served', false, 'could not resolve bundle URL from boot manifest')
} else {
  try {
    const cookie = mintBrowserCookie()
    const res = await fetch(`${ORIGIN}${bundleUrl}`, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
    const text = await res.text()
    check('plugin client bundle served', res.ok && text.length > 0, `HTTP ${res.status}, ${text.length} bytes`)
  } catch (e) {
    check('plugin client bundle served', false, e.message)
  }
}

// 2. /proxy/api route live (host half).
try {
  const res = await fetch(`${ORIGIN}/proxy/api`)
  const body = await res.json().catch(() => ({}))
  check('/proxy/api route live', res.ok && body.ok === true, `HTTP ${res.status}, upstream.enabled=${body?.upstream?.enabled}`)
} catch (e) {
  check('/proxy/api route live', false, e.message)
}

// 3. Settings page shows the Proxy section nav entry.
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text())
  })

  // dsh web (0.1.3+) gates the GUI behind a browser-session cookie; mint one
  // from the persisted signing secret so the nav checks see the live UI.
  await page.context().addCookies([{ ...mintBrowserCookie(), domain: '127.0.0.1', path: '/' }])
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  // Give the client bundles a moment to register slots.
  await page.waitForTimeout(2500)

  // Open Settings, then look for the Smoothly Proxy nav label inside the panel.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^Settings$/.test((b.textContent ?? '').trim()))
    btn?.click()
  })
  await page.waitForTimeout(1000)
  const found = await page.evaluate(() => {
    return [...document.querySelectorAll('span')]
      .filter((s) => (s.className ?? '').toString().includes('navLabel'))
      .map((s) => (s.textContent ?? '').trim())
  })
  check('settings nav shows Smoothly Proxy entry', found.includes('Smoothly Proxy'), found.join(' | ') || 'not found')

  // Also confirm no slot-entry crash on the page.
  const slotCrash = pageErrors.some((e) => /slot entry crashed/.test(e))
  check('no slot-entry crash on load', !slotCrash, slotCrash ? pageErrors[0] : 'clean')
} catch (e) {
  check('browser verification', false, e.message)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ ACCEPT — all GUI checks passed' : `❌ ACCEPT — ${failed.length} check(s) failed`}`)
process.exit(failed.length === 0 ? 0 : 1)
