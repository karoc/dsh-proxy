# Changelog

## [0.1.4] - 2026-09-25

### Fixed

- **DSH 0.1.7 icon rename (upstream commit `4937343a5e`, released from
  `0.1.7-alpha.1`).** `IconChevronDownOutline14`, `IconGlobeOutline14` and
  `IconLinkOutline14` no longer exist in `dsh-client-ui-primitives` — the size
  suffix moved into each artwork's default and the name now carries the stroke
  weight — so all three resolved to `undefined` and the Settings → Smoothly
  Proxy section crashed on render (`React error #130`,
  `slot entry crashed in 'settings.section'`). `src/client/ProxySection.tsx`
  now imports the `*Regular` variants the built-in pages use. Rendered sizes: the chevron and the globe
  stay 14 px (their artwork defaults); only the link moves from 14 px to its
  16 px artwork default. **Support floor:** the client half requires dsh ≥ 0.1.7
  **since v0.1.4** — **v0.1.3 remains the release for 0.1.2–0.1.6**.

### Changed

- **The dsh floor is now declared, not just documented.** `package.json`
  declares an optional peer dependency
  `@deepseek-ai/dsh-client-ui-settings: ">=0.1.7-rc.1"`. The gate that reads it ships from **DSH 0.1.7-rc.1** on — it
  compares every `@deepseek-ai/dsh*` peer against the running runtime and refuses
  a plugin the runtime fails, printing the `dsh plugin allow-version` remedy.
  Runtimes older than that gate evaluate **no** peers
  and refuse nothing: on 0.1.2–0.1.6 the client half cannot render (the
  `*Regular` icon names arrived in 0.1.7-alpha.1), so **v0.1.3 remains the
  release for 0.1.2–0.1.6** — the 0.1.7 alphas have those icons and work. It is
  marked `peerDependenciesMeta.optional` because the host supplies that package
  at runtime, so npm installs nothing extra. Note the prerelease rule the range encodes (measured with the semver DSH
  actually resolves — 7.8.5): `>=0.1.7` and `^0.1.7` do **not** match a
  `0.1.7-rc.N` runtime, hence the explicit `-rc.1` floor. semver 7.7.4 answers
  `true` for the caret form.
- Removed the stale `@deepseek-ai/dsh-client-runtime` entry from
  `dsh.client.inject`: that package no longer ships with DSH (11 versions exist on npm, but `latest`
  is still the historical `0.0.1-rc.1` and nothing in the harness tree provides
  it), and the loader silently ignored the unresolvable row.

## [0.1.3]

- **Brand name**: Smoothly Proxy / 思磨力代理插件 — the plugin's user-visible
  identity is now standardized: 品牌英文 **Smoothly**，品牌中文 **思磨力**，英文名
  **Smoothly Proxy**（简称同），中文名 **思磨力代理插件**（简称 **思磨力代理**）。
  Applied to the READMEs, settings page title, settings nav label
  (思磨力代理 / Smoothly Proxy), package description, and source header
  comments. The technical identity is untouched: npm package
  `@karoc/dsh-proxy`, runtime id `dsh-proxy`, CSS prefix, and `/proxy/api`
  route all stay as-is so installed profiles need no re-install.

## [0.1.2]

- **Brand name**: DSH Smoothly Proxy (DSH SP) — used in the README, settings page title, and changelog.

## [0.1.1]

- **dsh 0.1.2 compatibility:** the loader identity now matches the npm package
  name everywhere. `client-modules` serves graph rows under the package name
  (`@karoc/dsh-proxy`) and the browser module system awaits factories
  registered under that exact id — the bundle previously registered as
  `dsh-proxy` (the pre-rename tsdown ID), so on dsh ≥ 0.1.2 the entry import
  failed and cascaded into duplicate-factory errors that dropped every
  external plugin's client half. Aligned: module-table ID (`tsdown.config.ts`),
  loader entry `name` (`cordis.patch.yml`, the runtime id stays `dsh-proxy`),
  and the host `export const name`. Runtime business ids (settings.section id,
  locale namespace, CSS prefix, style-tag marker) are unchanged.
- **First tarball with the correct scoped identity:** the 0.1.0 tarball shipped
  the old unscoped patch/ID, which worked on dsh < 0.1.2 but failed the graph
  row match on newer dsh. 0.1.1 is the first release where the package name,
  loader entry name, bundle registration id, and host name are all
  `@karoc/dsh-proxy`.
- **Release-flow hardening:** `release:check` now fails fast when `tsdown` is
  not resolvable from PATH (a never-installed project would otherwise fail
  mid-publish with `tsdown: not found`); fixes a template-literal syntax error
  in `post-publish-check.mjs` that crashed the postpublish lifecycle (and hid
  the fact that the upload had actually succeeded).
- Tests: `client-boot.spec.mjs` asserts the scoped registration id; engine /
  host-route / mount / tooltip acceptance suites unchanged and passing.

## [0.1.0]

- Initial release: external DeepSeek Harness plugin providing a model-provider
  forward proxy with per-host routing and a dedicated Settings page.
- Host half (`src/index.ts` + `src/proxy-core.ts`): starts a loopback forward
  proxy (HTTP + CONNECT, HTTP/HTTPS/SOCKS5 upstreams, Basic auth, per-host
  routing, live config re-read, self-loop guard), points the process's
  `HTTP(S)_PROXY` / `NODE_USE_ENV_PROXY` / `NO_PROXY` at it, and serves
  `/proxy/api` (GET view, POST save / test / persist). Engine is a faithful TS
  port of dsh-desktop's `scripts/proxy.mjs`; `test` probe and `sanitizeUpstream`
  mirror the desktop shell's Rust implementations.
- Client half (`src/client/*`): registers a `settings.section` (id `dsh-proxy`,
  order 25) after the built-in Models and Model-reasoning pages. UI mirrors the
  desktop settings window: upstream card (enable / protocol / host / port /
  user / pass / test connection), model-provider hosts derived from
  `settings.yaml`, other observed hosts, per-host checkboxes, and a search box.
- Config persisted at `<DSH_HOME>/proxy.json`; changes take effect immediately
  (the proxy re-reads the file on every request).
- Settings page: a provider/observed-host row whose label truncates shows the
  full label (all display names + host) in a custom hover bubble (DSH
  `Tooltip`) — no native `title` tooltip. Overflow is measured on every commit
  plus `ResizeObserver` / `document.fonts.ready` / window resize, so a late
  webfont that widens the text retroactively arms the bubble; short labels stay
  quiet.
- Tests: `scripts/proxy-core.spec.mjs` — 13 scenarios (ported from
  dsh-desktop's `test-proxy.mjs` plus settings-helper coverage), no external
  network.
- Full release tooling: bilingual README, CHANGELOG, CONTRIBUTING, release
  gate + post-publish verification.
