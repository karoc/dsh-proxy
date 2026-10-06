# Smoothly Proxy (思磨力代理插件)

English | [简体中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![npm downloads](https://img.shields.io/npm/dm/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![license MIT](https://img.shields.io/npm/l/@karoc/dsh-proxy.svg)](LICENSE)

**Smoothly Proxy** (**思磨力代理** / Smoothly) is an **external** DeepSeek
Harness plugin: a model-provider **forward proxy** with **per-host routing**,
plus a **Settings page** dedicated to model-provider proxying.

It runs a loopback forward proxy inside the dsh host process, points the
process's egress traffic at it (`HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY`), and
routes the hosts you select through an optional upstream proxy (or, with one
click, every host **except** the ones you select)
(HTTP / HTTPS / SOCKS5, with optional Basic auth). Everything else stays
direct. Model-provider hosts are read LIVE from your running dsh
configuration, and hosts observed in traffic are collected for you — both
appear as checkboxes.

Why an external plugin: the built-in settings pages don't cover outbound
proxying, and adding one to a built-in package would be overwritten by the next
official release. This package ships as an installable **bundle** that never
touches repository source, so official updates cannot clobber it.

The proxy engine and settings UI are extracted from
[karoc/dsh-desktop](https://github.com/karoc/dsh-desktop) (behavior preserved)
so a browser-only `dsh web` gets the same model-provider proxy controls the
desktop shell had.

## What it adds

A new Settings section, **「思磨力代理 / Smoothly Proxy」** (nav order 25), placed
after the built-in **Models** page and, when that plugin is installed, the
external **Model reasoning** page. It shows:

- an **upstream proxy card**: enable toggle, protocol selector (HTTP / HTTPS /
  SOCKS5), host, port, optional username/password, and a **Test connection**
  button (a SOCKS5 handshake for SOCKS5, a `CONNECT` probe for HTTP; an HTTPS
  upstream is only checked for TCP reachability — its TLS handshake is not
  verified);
- a **routing rule** with two readings of the same checkbox list — *only checked
  hosts* (default) or *everything except checked*, for setups whose local proxy
  already does its own routing;
- a **model providers** list — hosts read LIVE from your running dsh
  configuration (`llm-deepseek.baseURL`, `llm-pi-ai.providers.<n>.baseURL`, any
  `llm-*` namespace), labeled with the friendly display name where available.
  The values come from the harness's own settings document, so the list follows
  the running configuration wherever dsh keeps it; a harness that still has the
  pre-0.2 `<DSH_HOME>/settings.yaml` is read as the fallback. Loopback
  endpoints are omitted — they can never be proxied;
- an **other observed hosts** list — hosts the proxy has seen in traffic
  (including `registry.npmjs.org` install/update traffic), persisted into
  `proxy.json` so they survive restarts;
- a **search box** that filters both lists by host / name as you type.

Check a host to route it through the upstream proxy. Saving writes
`<DSH_HOME>/proxy.json`; the running proxy **re-reads the file on every
request**, so changes take effect immediately — no dsh restart needed.

### How the proxy routes traffic

```
dsh host process
  ├─ undici fetch (model requests, web search) ──┐
  ├─ npm / pnpm / git / child CLIs ──────────────┤  HTTP(S)_PROXY → loopback proxy
  └─ subagents ──────────────────────────────────┘        │
                                                          ▼
                              127.0.0.1:<random>  forward proxy (raw net/http)
                                                          │
                              ┌───────────────────────────┴────────────┐
                              ▼                                        ▼
                     hosts in proxiedHosts                      everything else
                     + upstream enabled                      DIRECT (loopback ALWAYS direct)
                              │
                              ▼
                     upstream proxy (HTTP/HTTPS/SOCKS5, optional Basic auth)
```

Safety rules (hard-coded, not configurable):

- **loopback targets are always direct** — never sent to an upstream proxy;
- an upstream pointing back at this very proxy is treated as **disabled**
  (self-loop guard);
- the proxy itself uses raw `net`/`http`, so it can never route its own
  outbound connections back through itself.

### Config file

```
<DSH_HOME>/proxy.json     # $DSH_HOME, or ~/.dsh by default
```

```json
{
  "upstream": { "enabled": false, "protocol": "http", "host": "", "port": 0, "username": "", "password": "" },
  "proxiedHosts": ["api.deepseek.com"],
  "knownHosts": ["api.deepseek.com", "registry.npmjs.org"],
  "listenPort": 45999
}
```

`knownHosts` is written by the plugin (observed traffic); `upstream`,
`proxiedHosts` and `listenPort` are written from the settings page
(`listenPort` takes effect after a restart; `0` means an ephemeral port).
`listenPort` is the address this plugin LISTENS on — it is not the upstream
address, which belongs in `upstream`; setting it to the upstream's own port
fails to bind and falls back to an ephemeral port. You can also hand-edit the
file while dsh runs — it is re-read live.

## Install

**Prerequisites:** a DeepSeek Harness install with the `dsh` CLI, plus [pnpm](https://pnpm.io) (the `dsh plugin` command runs pnpm under the hood). This is an installable **bundle** — it is loaded by `dsh`, not imported as a library.

### From npm (recommended)

The package is published to npm as `@karoc/dsh-proxy`:

```sh
dsh plugin --profile web add @karoc/dsh-proxy
```

This installs the prebuilt bundle and appends it to the `web` profile. Then **restart `dsh web`** and open **Settings → 思磨力代理 / Smoothly Proxy**.

### From git

```sh
dsh plugin --profile web add github:karoc/dsh-proxy#<sha>
```

A git install runs the package's `prepare` script to build the bundle. pnpm ≥ 10 requires allowlisting that build once — copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml` under `allowBuilds`, then re-run `add` (see `docs/user/develop/basic/publish.md` in the DSH repo).

### Updating

Bump to the newest release with pnpm update (or re-add to pick up a newer git ref):

```sh
dsh plugin --profile web update @karoc/dsh-proxy
# or, if the dependency spec is pinned: dsh plugin --profile web add @karoc/dsh-proxy
```

Then **restart `dsh web`** so the new client bundle loads.

### dsh's own requests (model calls) ride this proxy automatically

The proxy has two kinds of clients, and they are wired differently:

- **Child processes** (bash, npm, pnpm, git, curl…) inherit the `*PROXY`
  variables this plugin publishes — no setup.
- **dsh's own requests** (model calls, web fetch/search) are routed by the
  harness's egress policy, which dsh resolves from the environment it was
  LAUNCHED with, before any plugin loads. When that environment declared no
  proxy, this plugin installs the same policy itself, pointing at its own
  listener, once the listener is up (`src/egress.ts`). Nothing to configure.

Settings → Smoothly Proxy states which of the following is true:

- **routed, self-installed** — the normal case: model traffic follows the host
  checkboxes above, per host. The listen port is an ephemeral one the plugin
  picks itself: there is nothing to configure, and the diagnostics panel (collapsed
  unless something needs attention) only reports it for debugging.
- **routed, launch environment** — your launcher declared
  `HTTP_PROXY=http://127.0.0.1:<listenPort>`, so dsh installed the policy before
  the plugin did; set `listenPort` (`proxy.json`) to a fixed port to keep that
  address stable across restarts.
- **a launcher proxy owns egress** — the launch environment declared a
  *different* proxy. This plugin deliberately does **not** layer over it (its own
  proxy sends un-ticked hosts direct, which would silently bypass the launcher's
  policy). Point the launcher at this proxy, or drop the variable, to use
  per-host routing for dsh's own requests.
- **unavailable** — the harness policy package could not be resolved in this
  composition (unusual layouts). The page then prints the exact `Environment=`
  line to declare instead, and everything else keeps working.

### Which deployment does what

| How dsh was started | What routes dsh's own requests | Page shows |
|---|---|---|
| `dsh web` from a terminal or a unit you own | this plugin (it installs the policy itself) | *routing through this plugin* |
| dsh-desktop shell | the shell's proxy — it sets `*PROXY` before spawning dsh | *the launch environment declares a different proxy* (by design: layering ours over it would bypass the shell's policy) |
| a launcher that sets `HTTP_PROXY=http://127.0.0.1:<port>` itself | dsh, before any plugin loads | *routing through this plugin (named by the launch environment)* |
| a headless profile | nothing — this plugin is not loaded without the web server | — |
| a build that does not expose `@deepseek-ai/dsh-http-proxy` | nothing; the plugin cannot join | *could not take over automatically* + the line to paste |

### Removing

```sh
dsh plugin --profile web remove @karoc/dsh-proxy
```

This removes both the dependency and its bundle layer from the `web` profile. Restart `dsh web` for the section to disappear.

## Layout

```
cordis.patch.yml      # bundle layer: mounts the row that the client-modules
                      # service discovers (dsh.client manifest)
package.json          # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts      # self-contained build: node half + module-table client bundle
src/proxy-core.ts     # forward proxy engine (HTTP+CONNECT, SOCKS5/HTTPS upstream,
                      # per-host routing, live config, test probe) — TS port of
                      # dsh-desktop's scripts/proxy.mjs
src/index.ts          # host apply: starts the proxy, sets *PROXY env vars,
                      # registers /proxy/api (GET view / POST save·test·persist)
src/client/index.ts   # client apply: register settings.section (id dsh-proxy)
src/client/ProxySection.tsx  # the settings page (upstream card + host lists)
src/client/styles.ts  # design-token styles (--dsw-alias-*) + injection
src/client/locales.ts # en/zh copy
scripts/*.spec.mjs    # behavioral tests: proxy-core.ts (13 scenarios) plus
                      # host route / client boot / cordis mount — no network
```

### The /proxy/api route

The host half serves the settings page over a same-origin HTTP route (the
built-in `/api` prefix is reserved for the gateway, so this uses `/proxy/api`):

- `GET  /proxy/api` → `{ ok, upstream, proxiedHosts, knownHosts, hosts, providers, port }`
- `POST /proxy/api` `{ op: 'save', upstream, proxiedHosts }` → sanitized + persisted config
- `POST /proxy/api` `{ op: 'test', upstream }` → `{ ok, detail }`
- `POST /proxy/api` `{ op: 'persist' }` → merge observed hosts into `knownHosts`

## Build

```sh
pnpm install
pnpm bundle          # emits lib/index.js + lib/client.js
pnpm typecheck        # tsc --noEmit
pnpm test             # node --test: proxy-core (13 scenarios) + host-route /
                      # client-boot / cordis-mount specs (no network)
pnpm release:check   # release gate: docs/changelog/tag/tree/build/registry must all pass
pnpm publish         # runs the gate (prepack/prepublishOnly), then postpublish verifies the live release
```

The bundle leaves the platform packages (`react`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-*`) external — they resolve at runtime from the loader's
module table; everything else is inlined.

## Notes / limitations

- **The proxy is an egress point for the process, not a per-request switch the
  model reads.** It works by pointing the process's `HTTP(S)_PROXY` at itself.
  Requests that dsh starts *after* this plugin's host `apply()` runs (any
  subprocess, and undici fetches whose global dispatcher is still lazy) ride
  the proxy. A dsh-internal fetch that already materialized its dispatcher
  before plugin load may not route through it — a dsh restart is the documented
  remedy (the desktop shell enforces the same boundary by setting env before
  spawning dsh).
- `npm`/`pnpm` install/update traffic goes through the proxy like everything
  else; toggling a host **related to install/update** takes effect on the next
  install/update (already-in-flight operations keep their environment).
- **A SOCKS5 upstream only carries HTTPS targets.** SOCKS5 has no absolute-URI
  HTTP mode, so a selected plain `http://` host falls back to direct through a
  SOCKS5 upstream (the settings page states the same thing).
- **Section nav icon is shell-assigned, not plugin-assigned.** The built-in
  `ui-settings-general` `SettingsRoot.tsx` `navIcon(id)` maps known ids and
  falls back to a gear for every other id — including this section's
  `dsh-proxy`. The `settings.section` registration has no icon field, so an
  external plugin cannot set it without patching the shell. When DSH exposes a
  per-section icon, use `IconGlobeOutlineRegular` from `dsh-client-ui-primitives`
  for this section.
- **Requires dsh ≥ 0.1.7 since v0.1.4 — v0.1.3 remains the release for
  0.1.2–0.1.6.** DSH 0.1.7 renamed the icon exports (`IconX14` → `IconXRegular`,
  the stroke-weight naming; upstream commit `4937343a5e`), so this section
  imports the `*Regular` variants. The floor is declared as an **optional peer
  dependency** on `@deepseek-ai/dsh-client-ui-settings`, which the dsh ≥ 0.1.7
  compatibility gate compares against the running dsh version — a mismatch
  refuses the bundle and names the exact `dsh plugin allow-version` remedy.
  dsh < 0.1.7 predates that gate, so those runtimes still load this plugin and
  render a broken section — install v0.1.3 there.
- **Install it the official way.** The loader
  entry name, bundle registration id, and host plugin name are all
  `@karoc/dsh-proxy` (matching the npm package name). A hand-written `link:`
  dependency only counts once the package manager has materialized it under the
  profile's `node_modules` and the profile lists it in `dsh.profile.bundles` —
  install via `dsh plugin --profile web add @karoc/dsh-proxy` (npm) or
  `dsh plugin --profile web add link:/path/to/dsh-proxy` (source), then restart
  `dsh web`.
- The desktop shell (`dsh-desktop`) keeps its own proxy and tray settings
  window — this plugin is a standalone extraction, not a replacement. Both can
  coexist (e.g. install `dsh-proxy` into the shell's profile to get the
  in-dsh settings page too).

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (development + release checklist) and
[CHANGELOG.md](CHANGELOG.md) for version history.
