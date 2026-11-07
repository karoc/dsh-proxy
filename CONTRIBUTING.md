# Contributing to dsh-proxy

Thanks for helping with `dsh-proxy` — an external DeepSeek Harness plugin for
model-provider proxying.

## Development

```sh
pnpm install        # dev deps (tsdown, typescript, react types)
pnpm typecheck      # tsc --noEmit
pnpm test           # node --test: proxy-core + host-route / client-boot / cordis-mount
                    # (each spec prints its own scenario count)
                    # client-boot / cordis-mount specs (no external network)
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
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ..., "@karoc/dsh-proxy"] } }
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
git tag v<version>
pnpm release:check
```

**Keep the tag local until the upload lands.** An unpublished version is allowed
to move: if the release still needs commits (a gate fix, a re-run of
verification), re-point the tag with `git tag -f v<version>` at the new HEAD and
re-run `pnpm verify:all` — the report and the tag must name the same commit.
Push the tag only after the registry confirms the version
(`git push origin v<version>`). Pushing it earlier freezes it: a later fix then
needs a force-push, and the remote advertises a release that is not on npm.

### Publishing is a manual step (2FA)

The npm account has two-factor authentication enabled, so **the agent cannot
complete the publish** — OTP needs a human. Everything must be prepared to
"one command away" (clean tree, version + tag in place, `release:check`
passing, `npm pack --dry-run` content confirmed), then the human runs:

```sh
npm login     # 2FA
npm run publish:release   # gate → build → pack → verify the tarball → publish → advisory verify
```

`npm publish` is still gated (prepack/prepublishOnly), but it rebuilds after the
gate and forwards a failing `postpublish` exit code — `publish:release` is the
path that publishes the bytes it verified. `npm publish --ignore-scripts`
bypasses all gates and post-publish verification — treat it as a process
violation. After a successful publish, the post-publish check polls the registry
until the version is visible and verifies `dist-tags.latest` plus the tarball
contents; then push the tag (`git push origin v<version>`).

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

## Publish verification contract (2026-11-01)

`npm publish` forwards lifecycle-hook exit codes: a nonzero `postpublish` makes a
**landed** upload look failed. Therefore:

- `postpublish` runs `node scripts/post-publish-check.mjs --advisory`: it reports
  the verdict (`CONFIRMED` / `PENDING_PROPAGATION` / `UNVERIFIED` /
  `CONTENT_MISMATCH` / `NOT_PUBLISHED`) but always exits 0.
- `npm run verify:publish` is the strict gate (`--strict`; PENDING exits 3).
- Preferred release path: `npm run publish:release` — gates, builds once, packs,
  verifies the packed bytes (sha512 + `files` whitelist → `.verify/pack.json`),
  publishes the tarball (npm runs no lifecycle scripts for a tarball argument),
  then verifies advisory.
- If verification reports `PENDING_PROPAGATION` after a publish: do **not**
  re-publish. Wait 10–30 minutes and re-run `npm run verify:publish` (a retry
  that returns 409 means the earlier upload landed — that is success).
- Env seams: `DSH_POSTPUBLISH_{ATTEMPTS,INTERVAL_MS,TARBALL_ATTEMPTS,TARBALL_INTERVAL_MS,TARBALL_TIMEOUT_MS,BUDGET_MS}`,
  `DSH_POSTPUBLISH_ALLOW_CROSS_ORIGIN_TARBALL=1` for CDN-fronted mirrors.
