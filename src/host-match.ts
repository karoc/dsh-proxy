/**
 * Host matching shared by the HOST half (routing, observation, provider list) and
 * the CLIENT half (which row reads *via upstream*). Kept in one module because a
 * second copy is how the IPv6 spellings drifted apart in the first place: a URL
 * parser hands over `[::1]`, Node normalizes an IPv4-mapped literal to
 * `::ffff:7f00:1`, and a CONNECT authority is `[::1]:443` — all the same host.
 *
 * No node builtins here: this module is bundled into the browser bundle too.
 */

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|0\.0\.0\.0)$/i

/**
 * Normalize a host so ONE comparison covers every spelling it arrives in.
 * @param host - hostname, possibly bracketed (`[::1]`) or IPv4-mapped.
 * @returns the comparable form (brackets stripped, IPv4-mapped collapsed).
 */
export function normalizeHostForMatch(host: string): string {
  const bare = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  // Dotted spelling, as written by hand or by an IPv4-mapped literal.
  const dotted = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted !== null) return dotted[1]
  // Hex spelling, which is what Node's URL parser produces.
  const mapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped === null) return bare
  const hi = Number.parseInt(mapped[1], 16)
  const lo = Number.parseInt(mapped[2], 16)
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
}

/** Whether `host` is a loopback/unspecified target in any of its spellings. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(normalizeHostForMatch(host))
}

/**
 * Split a CONNECT authority into the routing host and port. `[v6]:port` keeps its
 * brackets around the ADDRESS only — splitting on ':' turns the whole thing into
 * host `[`, which both defeats the loopback test and pollutes the host list.
 * @param authority - the CONNECT request target.
 * @returns the host and port, or null when the authority is unusable.
 */
export function parseConnectAuthority(authority: string): { host: string; port: number } | null {
  const value = String(authority ?? '')
  const match = value.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? value.match(/^([^:]+):(\d+)$/)
  if (match === null) return null
  const host = match[1].trim().toLowerCase()
  if (host === '') return null
  const port = Number(match[2])
  return { host, port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 443 }
}

/**
 * Format host:port for a request line / Host header (brackets for IPv6).
 * @param host - bare or bracketed host.
 * @param port - target port.
 */
export function formatAuthority(host: string, port: number): string {
  const bare = String(host ?? '').trim()
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`
}
