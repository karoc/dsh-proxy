# Changelog

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
