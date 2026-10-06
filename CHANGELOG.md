# Changelog

## [0.1.15] - 2026-10-06

### Fixed

- **A SOCKS5 upstream was sent IPv6 targets as DOMAIN names.** The handshake chose
  between `ATYP=1` (IPv4) and `ATYP=3` (domain) only, so `2001:db8::1` went out as a
  hostname no resolver can answer. It now sends `ATYP=4` with the 16 address bytes:
  `ipv6ToBytes()` expands the compressed form, the full eight-group form, an
  embedded IPv4 tail (`::ffff:1.2.3.4`) and drops a zone id (which has no wire
  representation). An address that cannot be encoded fails loudly instead of being
  sent as a name. G25 pins it, with a negative control that re-injects the domain
  branch.

### Notes

- The dsh-desktop shell carries a copy of this engine and had the same
  empty-provider defect plus the older loopback rule (literal `127.0.0.1` only,
  bare `::1` only). Both are fixed in that repository — its provider list now
  reads the active profile's document, and its routing/observation/provider code
  uses the same shared classifier and CONNECT-authority parsing as here. Changes
  are committed there on a branch (commit `6bb8316`), per that repo's PR-only rule.

## [0.1.14] - 2026-10-06

### Fixed

- **IPv6 loopback is loopback in every spelling it arrives in.** The guard only
  matched the bare `::1`, while a URL parser hands over `[::1]`, Node rewrites an
  IPv4-mapped literal to `::ffff:7f00:1`, and a CONNECT authority is
  `[::1]:443` — so a bracketed loopback target could be sent to the upstream
  proxy, against the guarantee that loopback is always direct. One shared
  classifier now normalizes all of them (brackets, dotted and hex IPv4-mapped
  forms) and is used by routing, the self-loop guard, the observed-host list and
  the provider list.

- **CONNECT authorities are parsed, not split on `:`.** `[::1]:443` used to
  become host `[`, which both defeated the loopback test and wrote a junk `[`
  entry into the observed-host list a user could then tick. The upstream CONNECT
  line keeps IPv6 addresses bracketed, and `proxiedHosts` matching is normalized
  so a listed `[2001:db8::1]` also matches the `2001:db8::1` form a CONNECT
  produces.

- **`llm-deepseek` no longer vanishes from the provider list.** Without a
  configured `baseURL` the document carries no host — the harness resolves that
  endpoint from a runtime constant — so the provider carrying real traffic was
  absent. It now falls back to the public endpoint (`api.deepseek.com`); a
  configured `baseURL` still wins.

### Added

- README: a deployment matrix (terminal/unit, dsh-desktop, launcher-declared
  proxy, headless, unusual builds) stating what routes dsh's own requests and
  what the page shows for each.

### Verified

- **npm-installed layout, for real**: `npm install @deepseek-ai/dsh@0.2.1-alpha.1`
  in a scratch tree, then the plugin's own resolver anchored at the installed
  entry (`node_modules/@deepseek-ai/dsh/lib/bin.js`) — it resolves
  `installProxyFromEnvironment` from the installed `dsh-http-proxy`, and a real
  in-process `fetch` issued a `CONNECT example.org:443` through the installed
  policy. The earlier "[assumed]" note about this layout is settled.
- **dsh-desktop carries the same empty-provider defect** (its `proxy.mjs` reads
  the removed `settings.yaml`). Fixed in that repository: a profile-document
  reader (`profiles/<name>/cordis.patch.yml`), loopback filtering, and the same
  DeepSeek public-endpoint rule; its `test-proxy` (12 scenarios, incl. a new
  profile-document case) and `test-copy-consistency` gates pass.

## [0.1.13] - 2026-10-06

### Added

- **Routing rule: "only checked hosts" (default) or "everything except
  checked".** The second reading exists for setups whose local proxy already
  does its own filtering — there, ticking every host is busywork. The rule lives
  in `proxy.json` as `routeMode` (`only-listed` | `except-listed`), flips the
  meaning of the SAME checkbox list, and changes the list title ("hosts going
  through the proxy" ↔ "hosts staying direct") so the screen never contradicts
  the rule. An unreadable stored value falls back to the default — the safe
  direction, never "send everything upstream" (G22).

### Changed

- The page copy was rewritten for plainness and length: the egress block is now
  one short sentence per state instead of a paragraph of mechanism, protocol
  hints and empty-state texts were trimmed, and four strings nothing rendered
  were deleted. Two real i18n defects fell out of that pass: the per-host route
  labels ("via upstream" / "direct") and the protocol labels were hard-coded
  English, so Chinese users saw English in the middle of a Chinese page; both now
  come from the dictionary.
- Pointing the upstream at this plugin's own port now says so on the page
  (previously only the routing guard silently ignored it).

## [0.1.12] - 2026-10-06

### Changed

- **The listen-port field now says what it is not.** A user reading the panel
  reasonably asked whether the upstream's port belongs there (their upstream is
  on loopback, so the two ports look interchangeable). It is the address this
  plugin LISTENS on, not a destination: the label now reads "plugin listen port
  (optional — NOT the upstream address)", the hint points at the upstream card,
  and typing the configured upstream's own loopback port produces a specific
  warning instead of leaving the bind failure as the only feedback. The same
  clarification is in the README's `proxy.json` section.

  What actually happens if you do it anyway: the bind fails (the upstream owns
  that port), the plugin falls back to an ephemeral port and reports it, and —
  because the upstream card is off in that scenario — every host goes DIRECT, so
  the local upstream is bypassed entirely.

## [0.1.11] - 2026-10-06

### Changed

- **The listen port is no longer presented as a setting.** It never was one:
  `listenPort` defaults to `0`, which means the plugin asks the OS for a free
  port, and a port that cannot be bound already falls back to an ephemeral one
  and reports it. Only a deployment whose LAUNCHER must name the address in
  advance needs a fixed value — and even then an unconfigured plugin adopts the
  loopback port that launcher declares. The settings page now reflects that:
  the primary line states the state ("in-process traffic rides this proxy"), the
  port and the `Environment=` line live in a **collapsed diagnostics panel** that
  opens by itself only when something needs attention (a launcher proxy owning
  egress, a failed self-install, an unbindable port, a port awaiting a
  restart), and the port field is labelled optional with the reason spelled out.

- A page served by a newer client bundle against an older host half (the window
  before a restart) now says so instead of rendering `undefined` into the status
  text.

## [0.1.10] - 2026-10-06

### Fixed

- **A launcher-declared port is adopted instead of fought.** If your service
  environment says `HTTP_PROXY=http://127.0.0.1:45999` (the 0.1.7 contract) while
  `listenPort` is unset, the plugin now LISTENS on 45999 instead of binding an
  ephemeral port and leaving dsh's already-installed policy pointed at a dead
  address. A port that something else already serves is the exception: binding
  fails, the plugin falls back to an ephemeral port and reports it — which is
  also the right outcome when the launch proxy is a *different* local proxy,
  because that one keeps owning egress.

  Non-loopback and malformed launch proxies are never adopted (G20).

## [0.1.9] - 2026-10-06

### Fixed

- **The plugin no longer needs the user to touch their service definition.**
  0.1.7 shipped the honest but demanding answer: dsh resolves its egress policy
  from the LAUNCH environment before plugins mount, so model traffic could only
  be routed by editing the service unit. That is not the whole truth — the
  harness's own policy installer is reachable from a plugin, and layering a
  policy is a behaviour its suite covers. `src/egress.ts` now resolves
  `@deepseek-ai/dsh-http-proxy` (anchored at the active profile, so the import
  lands on the same module instance the harness uses) and installs a policy
  pointing http/https at this plugin's listener **when, and only when, the launch
  environment declared no proxy at all**. Model calls, web fetch and web search
  then ride this proxy with per-host routing intact — zero configuration.

  The condition is a correctness rule, not politeness: this plugin's proxy sends
  un-ticked hosts DIRECT, so layering it over a launcher's proxy would silently
  bypass that launcher's egress policy. A launcher that already decides egress
  keeps deciding it, and the page says so. An unresolvable policy package is
  reported as `unavailable` (the page then prints the environment-variable
  fallback) rather than being papered over.

- **`listenPort` defaults to `0` (ephemeral) again.** With self-installed egress
  a fixed port is no longer needed; it remains the opt-in for deployments where
  the launcher declares the proxy itself (`HTTP_PROXY=http://127.0.0.1:<listenPort>`).
  0.1.7's fixed default (45999) is withdrawn before publication — it would have
  made two dsh instances on one machine warn about a port nobody needs.

- The settings page now distinguishes four egress states (self-installed /
  launch environment / another launcher proxy owns egress / unavailable) instead
  of assuming the launch environment is the only way.

### Added

- `scripts/egress.spec.mjs` (decision + resolution + failure reporting) wired
  into `npm test` and `verify:all`; guarantees G18–G19 pin "never displace a
  launcher proxy" and "a failed self-install is reported"; negative controls
  re-inject both defects and must redden the suite.

## [0.1.8] - 2026-10-06

### Fixed

- **`scripts/verify-tooltip.mjs` could report "no tooltip bubble" for reasons
  that have nothing to do with the tooltip.** Two of them: (1) the target row can
  sit below the fold — the host list is a scrollable box inside a panel that grew
  (the new egress block sits above it), so the synthetic mouse moved to a
  coordinate nothing occupied; (2) the bubble wrapper only exists after React has
  seen the injected narrowing (ResizeObserver → setState → re-render), so a hover
  that lands too early finds nothing. The script now scrolls the target into
  view and fails loudly when it is not on screen (with the measured `y`), and it
  retries the hover a bounded three times; the assertion itself is unchanged, so
  it can still only pass when the bubble really appears.

## [0.1.7] - 2026-10-06

### Fixed

- **Model requests did not go through the proxy at all — only child processes
  did.** dsh installs its egress policy from the environment it was **launched**
  with, before any plugin mounts (`apps/cli/src/profile-boot.ts` →
  `@deepseek-ai/dsh-http-proxy`'s `installProxyFromEnvironment`, which owns
  undici's global dispatcher and answers its own callers through
  `proxyRouteFor()`). Setting `HTTP_PROXY`/`NODE_USE_ENV_PROXY` later, from a
  plugin's `apply()`, reaches spawned children only: on a systemd-run `dsh web`
  the harness's own `fetch` — model calls, web fetch, web search — stayed direct.
  Measured on the affected machine in one process: a child `curl https://example.org`
  and `npm` (registry.npmjs.org) appeared in the proxy's observed hosts, while an
  in-process `web_fetch` (successful, HTTP 200) and dozens of model calls never
  did. The dsh-desktop shell avoids this by setting the variables before spawning
  `dsh` as a child; a directly-started `dsh web` has nobody to do that.

  The proxy now listens on a **fixed port** (`listenPort` in `proxy.json`,
  default `45999`) instead of an ephemeral one, so a launch environment can name
  it: `Environment="HTTP_PROXY=http://127.0.0.1:45999" …` in the service unit,
  then one restart, and dsh's own requests ride this proxy with per-host routing
  intact (README → "Putting dsh's own requests behind the proxy"). An existing
  `proxy.json` without the field adopts the default; an explicit `0` still means
  "ephemeral".

- **The page never said which traffic it was actually handling.** Settings →
  Smoothly Proxy now reports the bound port, the configured port, whether the
  requested port was honored, and whether dsh's own requests are routed here —
  with the exact `Environment=` line for the current port when they are not. The
  old header comment's "a dsh restart is the documented remedy" was **wrong**: a
  restart alone never fixed in-process routing, because the ordering is the same
  on every boot.

- A requested fixed port that is taken now falls back to an ephemeral one **and
  says so** (log + `portHonored: false`) instead of leaving a launcher pointed at
  a port nothing listens on.

### Added

- Negative controls for both new rules: `portHonored` forced true, and the
  launch-proxy matcher forced true, each redden `proxy-core.spec.mjs` /
  `host-route.spec.mjs`. Guarantees G16–G17 pin them.

## [0.1.6] - 2026-10-06

### Fixed

- **`npm run accept` reported a false red on a healthy GUI.** The boot manifest
  can hand out a ROOT-RELATIVE bundle URL with no leading slash
  (`plugins/??@karoc/dsh-proxy/client.js&rev=…`); `scripts/accept-gui.mjs`
  concatenated it onto the origin and asked for
  `http://127.0.0.1:3080plugins/…`, so "plugin client bundle served" failed while
  the GUI was rendering the plugin correctly. The URL is now resolved the way the
  browser resolves it (`new URL(bundleUrl, ORIGIN)`), and the check prints the
  path it actually fetched.

- **`scripts/verify-tooltip.mjs` skipped its own assertions.** Whether any host
  label truncates depends on the content (longest provider/host label vs the
  panel width), so on a page whose labels all fit the script failed its
  precondition and silently skipped the hover checks — a red that explained
  nothing and verified nothing. It now measures the natural layout first and, when
  nothing truncates, forces a narrow label box so the behavior under test
  (truncated label → bubble carrying the FULL text) runs on every invocation; the
  detail line names which mode produced the evidence.

### Note

- Acceptance tooling only: `scripts/` is outside the published `files` list, so
  no runtime behavior changed. Both fixes make the acceptance entry points
  truthful on dsh 0.2.

## [0.1.5] - 2026-10-06

### Fixed

- **The model-provider list went empty (`0`) on dsh ≥ 0.2.** The host half
  derived provider hosts by parsing `<DSH_HOME>/settings.yaml`. dsh 0.2 removed
  that document: at boot `SettingsForms.importLegacyDocument()` renames it to
  `settings.yaml.imported` and imports every section into the **active profile's**
  config document (`~/.dsh/profiles/<name>/cordis.patch.yml`, a top-level YAML
  array of `{id, name, config}` entries; upstream commit `601d6761e4`,
  `feat(settings): project volatile Config through profile-backed forms`). The
  reader therefore found no file, returned `[]`, and Settings → Smoothly Proxy
  rendered an empty list — while the built-in model pages kept showing the same
  providers normally.

  Evidence on the affected machine: `GET /proxy/api` answered `providers: []`,
  `~/.dsh/settings.yaml` was gone (only `settings.yaml.imported` remained), and
  the GUI's own settings read (`POST /api/settings/describe`) answered
  `llm-pi-ai.value.providers.<key>.{displayName, baseURL}` for all seven
  configured routes.

  The host half now reads the **live settings document**
  (`ctx.get('settings').describe()` — the same call dsh's own settings pages
  read) and keeps the legacy `<DSH_HOME>/settings.yaml` only as the fallback for
  a composition without a settings service (dsh < 0.2, or a read that throws). A
  readable live document always wins, so a leftover legacy file can never
  resurrect stale hosts. The provider list is read per request, so adding or
  renaming a provider route reaches the page on the next load — no dsh restart.

- **Loopback provider hosts were offered as proxy targets.** A provider whose
  `baseURL` is loopback (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0`) appeared in
  the model-provider list with a checkbox that could never take effect — routing
  sends loopback direct no matter what. Such hosts are now dropped from the list
  on both the live and the legacy path, matching the observed-host list, and the
  page copy now says the list is read live from your dsh settings (the old text
  named `settings.yaml`, a file dsh 0.2 no longer has).

### Added

- Negative controls for the new behavior, re-proved on every `npm test`: the
  reported defect re-injected (host half stops reading the live document) must
  redden `host-route.spec.mjs`; a resolver that prefers the legacy file, and a
  provider list that offers loopback hosts again, must redden
  `proxy-core.spec.mjs`. Guarantees G13–G15 (`docs/guarantees.md`) pin the
  loopback rule, the live-over-legacy order, and the "a settings read that
  throws still answers 200" fallback.

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

- **Loopback was only recognised as the literal `127.0.0.1`.** The routing guard
  was `/^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/`, so every other address in the
  `127.0.0.0/8` block (e.g. `127.0.0.2`, used by interface aliases and some
  container setups) was sent to the **upstream proxy** when it was listed in
  `proxiedHosts` — contradicting the documented "loopback targets are always
  direct" guarantee. The guard now matches the whole `127/8` block. The spec
  assertion that was supposed to pin this was **vacuous** (it asserted the
  loopback hosts against a `proxiedHosts` list that did not contain them, so it
  returned "direct" for the unlisted-host reason and would have stayed green with
  the guard deleted) — it now lists them, adds a positive control, and covers
  `127.0.0.2`; verified red against the old guard before the fix.
- Dropped the dead `@deepseek-ai/dsh-client-runtime/client` entry from the
  bundler externals and the client-boot spec: that package no longer ships with
  DSH and nothing imports it (same stale reference as the `dsh.client.inject`
  row removed above).

### Tests

- **`npm run verify:all` — every gate, one command, bound to the commit.**
  It runs script syntax, the spec suite, the guarantee gate, the negative
  controls and the release gate, and writes `{ts, commit, node, steps[]}` to the
  gitignored `lib/verify-report.json`. `npm run verify:fresh` FAILS when HEAD no
  longer matches the recorded commit — because a green claim is only as good as
  the commit it was measured on, and this repo deliberately re-points tags for
  unpublished versions. A failed step is a failed verification, never an
  "unknown".
- **Negative controls, now part of `npm test`** (`npm run test:controls`).
  A gate nobody has seen fail is not evidence, so `scripts/test-negative-controls.mjs`
  clones the committed tree per scenario, injects ONE defect, and asserts the
  gate fails with the documented message: a dirty tree, a removed CHANGELOG
  entry, a deleted release tag, a removed build artifact, and a guarantee row
  whose pinning assertion no longer exists — plus a positive control (an
  unmutated clone must pass both gates). 5/5 mutations caught.
- **Guarantee gate, now part of `npm test`.** `docs/guarantees.md` lists this
  plugin's negative guarantees and names the assertion label that pins each one;
  `scripts/check-guarantees.mjs` fails the suite when a label disappears (12 rows
  today, and the selector must exist in `scripts/*.spec.mjs`). Verified by
  negative control: pointing a row at a non-existent label makes the gate FAIL.
  The routing guard that shipped matching only the literal `127.0.0.1` stayed
  invisible for months precisely because the assertion meant to pin it could not
  fail — the gate plus the `127/8` assertion close that class of defect.

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
