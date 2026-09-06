// Mint a browser-session cookie equivalent to the one `dsh web` issues after
// the launch-token exchange, using the persisted signing secret read at RUN
// TIME from ~/.dsh/.credentials.yaml (record `client-connection/browser-session`).
// Lets headless verify scripts open the GUI without DSH_TOKEN in the env.
// Read-only: the credential file is never written; the secret never enters
// this repository.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

function b64url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** @returns {{ name: string, value: string }} cookie for the given authority. */
export function mintBrowserCookie(authority = '127.0.0.1:3080') {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u.exec(text)
  if (match === null) throw new Error(`no client-connection/browser-session secret in ${file}`)
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + DAY_MS }
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
  return { name, value: `v1.${body}.${signature}` }
}
