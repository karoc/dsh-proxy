# Contributing to dsh-proxy

Thanks for helping with `dsh-proxy` — an external DeepSeek Harness plugin for
model-provider proxying.

## Development

```sh
pnpm install        # dev deps (tsdown, typescript, react types)
pnpm typecheck      # tsc --noEmit
pnpm test           # typecheck + scripts/proxy-core.spec.mjs (13 scenarios)
pnpm bundle         # emit lib/index.js + lib/client.js
```

The host half (`src/index.ts` + `src/proxy-core.ts`) is pure Node — no dsh
runtime needed to test it: `pnpm test` runs the proxy against fake origins and
fake upstreams on `127.0.0.1` (no external network). The client half
(`src/client/*`) is only exercised inside a running `dsh web`.

### Local install without publishing

To see the plugin live in the GUI, link it into a profile:

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "@karoc/dsh-proxy": "link:/path/to/dsh-proxy", ... },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ..., "dsh-proxy"] } }
```

Then `cd ~/.dsh/profiles/web && pnpm install` and **restart `dsh web`**
(changing the plugin set requires a restart; only bundle content changes hot
reload via the dev-server watcher).

## Layout

- `src/proxy-core.ts` — the forward proxy engine (ported from dsh-desktop;
  keep behavior compatible). Pure Node, no dsh imports.
- `src/index.ts` — host `apply`: starts the proxy, sets `*PROXY` env vars,
  registers `/proxy/api`.
- `src/client/` — settings page + slot registration + i18n + styles.

## Release checklist

Every release must be done in one pass (code + docs + changelog + version +
tag). The gate script (`pnpm release:check`, also run by `prepack` and
`prepublishOnly`) enforces:

1. `README.md` and `README.zh.md` exist and have the **same number of `##` and
   `###` sections** (bilingual structural sync — add/remove sections in both).
2. `CHANGELOG.md` has a non-empty entry for the current version, as the latest
   released entry.
3. `package.json` version matches the latest CHANGELOG entry.
4. Git tag `v<version>` exists and points at HEAD.
5. Working tree is clean (everything committed).
6. `lib/` is present and fresh (run `pnpm bundle` after touching `src/`).
7. The version is not already published on npm.
8. **Identity parity:** `tsdown.config.ts` module-table ID, the loader entry
   `name` in `cordis.patch.yml`, and the host `export const name` in
   `src/index.ts` must all equal the npm package name (`@karoc/dsh-proxy`).
   `client-modules` serves graph rows under the package name and the browser
   awaits factories under that exact id; a mismatch drops the client half on
   dsh ≥ 0.1.2. Runtime business ids (settings.section id, locale NS, CSS
   prefix, style-tag marker) intentionally stay `dsh-proxy`. The `release-check`
   gate does not verify this — check it before tagging.

Release steps:

```sh
# 1. write code + update README.md/README.zh.md + CHANGELOG.md together
# 2. bump version in package.json
git add -A && git commit -m "dsh-proxy v<version>"
git tag v<version> && git push origin v<version>
pnpm release:check
```

### Publishing is a manual step (2FA)

The npm account has two-factor authentication enabled, so **the agent cannot
complete the publish** — OTP needs a human. Everything must be prepared to
"one command away" (clean tree, version + tag in place, `release:check`
passing, `npm pack --dry-run` content confirmed), then the human runs:

```sh
npm login     # 2FA
npm publish   # runs the gate (prepack/prepublishOnly), then postpublish verifies
```

`npm publish --ignore-scripts` bypasses all gates and post-publish verification
— treat it as a process violation. After a successful publish, `postpublish`
polls the registry until the version is visible and verifies `dist-tags.latest`
plus the tarball contents.

### Known release-check "failures" that are actually fine

- After a release, the next `release:check` fails with "version already
  published" / "tag not at HEAD" — that's the gate protecting an already-live
  version. Bump to the next version and tag it instead of overwriting.
- The first publish of a brand-new package: the post-publish registry poll
  covers the whole-package-not-yet-visible case; if it still times out, verify
  manually with `npm view @karoc/dsh-proxy versions` — do not re-publish the
  same version without checking.

## License

MIT
