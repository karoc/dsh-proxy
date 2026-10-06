/**
 * In-process egress for dsh-proxy: put the harness's OWN requests (model calls,
 * web fetch/search) behind this plugin's loopback forward proxy.
 *
 * Why this is not just "set some env vars": dsh resolves its egress policy from
 * the environment it was LAUNCHED with, before any plugin mounts
 * (`apps/cli/src/profile-boot.ts` → `@deepseek-ai/dsh-http-proxy`
 * `installProxyFromEnvironment`), and that package owns undici's global
 * dispatcher. Child processes inherit variables this plugin publishes, but the
 * harness's own `fetch` does not read them afterwards — which is why model
 * traffic stayed direct on a systemd-run `dsh web` while npm/git/curl were
 * proxied.
 *
 * The same public installer is reachable from a plugin, and layering a policy is
 * a designed behavior (the package's own suite covers a second install layered
 * over the launcher's). So when — and only when — the launch environment named
 * no proxy at all, this plugin installs a policy that points http/https at its
 * own listener.
 *
 * The "only when" is a correctness rule, not politeness: this plugin's proxy
 * sends hosts that are not ticked DIRECT, so layering it over a launcher's proxy
 * would silently bypass that launcher's egress policy (a desktop shell or a
 * corporate launcher that set `HTTP_PROXY` on purpose). A launcher that already
 * decides egress keeps deciding it; the settings page says so and offers the
 * port/launch-environment route instead.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The harness package that owns undici's global dispatcher and the route matcher. */
export const POLICY_PACKAGE = '@deepseek-ai/dsh-http-proxy'

/** The slice of that package this plugin uses. */
export interface PolicyModule {
  installProxyFromEnvironment: (
    env: { get(name: string): { value: string } | undefined },
    report: (message: string) => void,
  ) => Promise<() => Promise<void>>
}

/** The proxy the LAUNCH environment named, captured before this plugin rewrites the variables. */
export interface LaunchProxy {
  name: string
  value: string
}

/** How dsh's own requests are (or are not) routed through this plugin. */
export type EgressStatus = 'self-installed' | 'launcher' | 'unavailable'

export interface EgressOutcome {
  status: EgressStatus
  /** Human-readable reason for the page; never contains credentials. */
  detail: string | null
  /** Restores the previous dispatcher; null unless this plugin installed one. */
  dispose: (() => Promise<void>) | null
}

/** Resolves the harness's policy module. Injectable so the decision logic is testable without a harness. */
export type PolicyImporter = () => Promise<PolicyModule>

/**
 * Resolve the policy package the way a plugin installed INTO A PROFILE would:
 * the bare specifier first (hoisted layouts), then anchored at each candidate
 * file — the profile's own `package.json` (that is where the harness resolved it
 * from, so the import lands on the same module instance and `proxyRouteFor`
 * callers see our policy too), the dsh entry point, and the working directory.
 *
 * Resolution is best-effort by design: a failure is REPORTED (the page then
 * tells the user to declare the proxy in the launch environment instead), never
 * silently ignored.
 */
export function createPolicyImporter(anchors: readonly string[]): PolicyImporter {
  return async () => {
    const failures: string[] = []
    try {
      return await import(POLICY_PACKAGE) as PolicyModule
    } catch (error) {
      failures.push(`bare specifier — ${(error as Error).message}`)
    }
    for (const anchor of anchors) {
      try {
        const require = createRequire(anchor)
        const resolved = require.resolve(POLICY_PACKAGE)
        const module = await import(pathToFileURL(resolved).href) as PolicyModule
        if (typeof module.installProxyFromEnvironment !== 'function') {
          failures.push(`${anchor} — resolved ${resolved} without installProxyFromEnvironment`)
          continue
        }
        return module
      } catch (error) {
        failures.push(`${anchor} — ${(error as Error).message}`)
      }
    }
    throw new Error(`${POLICY_PACKAGE} is not resolvable here (${failures.join(' | ')})`)
  }
}

/**
 * Install the harness policy that routes http/https at `proxyUrl`, unless a
 * launcher already declared egress.
 *
 * @param opts.proxyUrl - this plugin's loopback proxy, e.g. `http://127.0.0.1:41234`.
 * @param opts.launch - the launch-time proxy variable, or null when there was none.
 * @param opts.importer - resolves the harness policy module.
 * @param opts.log - receives the policy module's own diagnostics.
 * @returns the outcome, including the disposer that restores the previous policy.
 */
export async function installInProcessEgress(opts: {
  proxyUrl: string
  launch: LaunchProxy | null
  importer: PolicyImporter
  log: (line: string) => void
}): Promise<EgressOutcome> {
  if (opts.launch !== null) {
    // Never displace a launcher's decision: our proxy would send its non-ticked
    // hosts DIRECT, quietly bypassing the proxy that launcher configured.
    return {
      status: 'launcher',
      detail: `${opts.launch.name} was set before dsh started — the launcher owns egress`,
      dispose: null,
    }
  }
  let policy: PolicyModule
  try {
    policy = await opts.importer()
  } catch (error) {
    return { status: 'unavailable', detail: (error as Error).message, dispose: null }
  }
  const values: Record<string, string> = {
    HTTP_PROXY: opts.proxyUrl,
    HTTPS_PROXY: opts.proxyUrl,
    // The policy merges its own loopback bypass, so this only states the intent.
    NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
  }
  try {
    const dispose = await policy.installProxyFromEnvironment({
      get(name) {
        const hit = values[name] ?? values[name.toUpperCase()]
        return hit === undefined ? undefined : { value: hit }
      },
    }, opts.log)
    return { status: 'self-installed', detail: null, dispose }
  } catch (error) {
    return { status: 'unavailable', detail: (error as Error).message, dispose: null }
  }
}
