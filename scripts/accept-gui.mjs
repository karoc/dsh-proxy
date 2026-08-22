#!/usr/bin/env node
/**
 * GUI acceptance for dsh-proxy: verifies, against the LIVE dsh web GUI:
 *   1. the plugin client bundle is served (/plugins/dsh-proxy/client.js 200)
 *   2. the /proxy/api route is live (host half registered it)
 *   3. the Settings page shows a "代理 / Proxy" section entry
 *
 * Run AFTER restarting dsh web (the plugin set is only scanned at startup).
 * Requires Playwright (chromium). `pnpm accept` / `node scripts/accept-gui.mjs`.
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. bundle served (host endpoint).
try {
  const res = await fetch(`${ORIGIN}/plugins/dsh-proxy/client.js`)
  check('plugin client bundle served', res.ok, `HTTP ${res.status}`)
} catch (e) {
  check('plugin client bundle served', false, e.message)
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

  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  // Give the client bundles a moment to register slots.
  await page.waitForTimeout(2500)

  // Open Settings, then look for the Proxy nav label inside the panel.
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
  check('settings nav shows Proxy entry', found.includes('Proxy'), found.join(' | ') || 'not found')

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
