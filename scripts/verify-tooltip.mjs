#!/usr/bin/env node
// GUI hover-tooltip acceptance for dsh-proxy: at a viewport width where the
// longest real provider label truncates, hovering it with the real mouse shows
// the plugin's custom Tooltip bubble (role="tooltip", no native title), and
// short labels stay quiet. Run: node scripts/verify-tooltip.mjs
import { chromium } from 'playwright'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
const browser = await chromium.launch()
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^Settings$/.test((b.textContent ?? '').trim()))
    btn?.click()
  })
  await page.waitForTimeout(900)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((s) => (s.textContent ?? '').trim() === 'Proxy' && (s.className ?? '').toString().includes('navLabel'))
    el?.click()
  })
  await page.waitForTimeout(1500)

  const state = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.dsh-proxy-host-label')]
    return labels.map((el) => ({
      text: (el.textContent ?? '').trim(),
      overflowing: el.scrollWidth > el.clientWidth + 1,
      hasTitle: el.hasAttribute('title'),
    }))
  })
  check('provider rows rendered', state.length > 0, `${state.length} rows`)
  const overflowed = state.filter((s) => s.overflowing)
  const short = state.find((s) => !s.overflowing)
  check('at least one real label truncates at this width', overflowed.length > 0, `${overflowed.length} overflowing`)
  check('no native title attribute used', state.every((s) => !s.hasTitle), 'title-free')

  if (overflowed.length > 0) {
    const pos = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.dsh-proxy-host-label')].find((e) => e.scrollWidth > e.clientWidth + 1)
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.mouse.move(pos.x, pos.y, { steps: 4 })
    await page.waitForTimeout(900) // delayMs 300 + render

    const bubble = await page.evaluate(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')]
      return tips.length > 0 ? { text: (tips[0].textContent ?? '').trim(), side: tips[0].getAttribute('data-side') } : null
    })
    check('custom tooltip bubble appears on hover', bubble !== null, bubble?.side ?? 'no bubble')
    if (bubble !== null) {
      // element.textContent is the FULL label (CSS ellipsis hides the tail,
      // it does not remove it), so the bubble must carry every character of it.
      check('bubble carries the FULL label text', bubble.text.length >= overflowed[0].text.length, `bubble ${bubble.text.length} ≥ label ${overflowed[0].text.length}`)
      check('bubble text is the complete provider name', bubble.text.startsWith(overflowed[0].text.trim().slice(0, 10)), visibleCheck(overflowed[0].text, bubble.text))
    }

    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    const gone = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].length)
    check('bubble hides after mouse leaves', gone === 0, `${gone} bubble(s)`)
  }

  if (short) {
    const pos = await page.evaluate((needle) => {
      const el = [...document.querySelectorAll('.dsh-proxy-host-label')].find((e) => (e.textContent ?? '').trim() === needle)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, short.text.trim())
    if (pos) {
      await page.mouse.move(pos.x, pos.y, { steps: 3 })
      await page.waitForTimeout(500)
      const n = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].length)
      check('short label does NOT pop a tooltip', n === 0, `${n} bubble(s)`)
    }
  }

  check('no page errors during hover test', errors.length === 0, errors[0] ?? 'clean')
} catch (e) {
  check('hover tooltip verification', false, e.message)
} finally {
  await browser.close()
}

function visibleCheck(visible, bubble) {
  return `visible "${visible.slice(0, 20)}…" → bubble "${bubble.slice(0, 20)}…"`
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ ACCEPT — tooltip behavior verified' : `❌ ${failed.length} check(s) failed`}`)
process.exit(failed.length === 0 ? 0 : 1)