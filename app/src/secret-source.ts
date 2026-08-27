/**
 * Where a secret actually lives.
 *
 * The `endpoints.secrets` column used to hold signing secrets as plaintext. It
 * worked, and it meant that a database backup, a replica, a support dump or a
 * careless `SELECT *` all carried live credentials — none of which are places
 * anyone decided to put them.
 *
 * A stored value is now a *reference* rather than a secret:
 *
 *   env:WEBHOOK_SECRETS      read from the process environment
 *   file:/run/secrets/hook   read from disk, which is how Docker and Kubernetes
 *                            present a mounted secret
 *   literal:whsec_...        the value itself, for tests and local development
 *
 * A bare string with no prefix is treated as `literal:` so existing rows keep
 * working, and `describe()` reports it as such — the point is not to forbid it
 * but to make it visible, because plaintext that nobody can see is plaintext
 * nobody will fix.
 *
 * This is deliberately not encryption-at-rest with a key in an environment
 * variable. That moves the secret one step and calls it solved; the key sits
 * next to the thing it protects and any dump that has the row usually has the
 * environment too. A reference means the database genuinely does not hold the
 * credential.
 */

import { readFileSync } from 'node:fs'

export type SecretKind = 'env' | 'file' | 'literal'

export interface SecretRef {
  readonly kind: SecretKind
  readonly locator: string
}

export class SecretResolutionError extends Error {
  readonly name = 'SecretResolutionError'
  constructor(message: string) {
    super(message)
  }
}

export function parseSecretRef(stored: string): SecretRef {
  const at = stored.indexOf(':')
  if (at > 0) {
    const prefix = stored.slice(0, at)
    if (prefix === 'env' || prefix === 'file' || prefix === 'literal') {
      return { kind: prefix, locator: stored.slice(at + 1) }
    }
  }
  // No recognised prefix. A Stripe secret is `whsec_...`, which contains no
  // colon, and a value that happens to contain one must not be mistaken for a
  // reference to something that does not exist.
  return { kind: 'literal', locator: stored }
}

/**
 * Turn a reference into the secret.
 *
 * A reference that cannot be resolved throws rather than yielding an empty
 * string. An empty secret would verify nothing and reject every delivery,
 * which looks exactly like a sender with the wrong key — the hardest kind of
 * failure to diagnose, because the error points at the wrong party.
 */
export function resolveSecret(
  ref: SecretRef,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (ref.kind === 'literal') {
    if (ref.locator === '') throw new SecretResolutionError('the stored secret is empty')
    return ref.locator
  }

  if (ref.kind === 'env') {
    const value = env[ref.locator]
    if (value === undefined || value === '') {
      throw new SecretResolutionError(
        `${ref.locator} is not set, so the endpoint that references it cannot verify anything`,
      )
    }
    return value
  }

  try {
    // Trimmed: a secret written into a file by an editor or a shell almost
    // always gains a trailing newline, and a signature computed over the
    // secret-plus-newline matches nothing.
    const contents = readFileSync(ref.locator, 'utf8').trim()
    if (contents === '') throw new SecretResolutionError(`${ref.locator} is empty`)
    return contents
  } catch (error) {
    if (error instanceof SecretResolutionError) throw error
    throw new SecretResolutionError(
      `cannot read ${ref.locator}: ${(error as Error).message}`,
    )
  }
}

/**
 * Resolve a whole set, skipping the ones that cannot be resolved.
 *
 * Rotation is the reason. An endpoint holds every currently-valid secret, and
 * one of them pointing at a variable that has not been set yet must not take
 * the other down with it — the working secret should keep working while
 * somebody fixes the broken reference.
 *
 * All of them failing is different, and that throws: an endpoint with no
 * usable secret rejects every delivery, and doing so silently would look like
 * every sender suddenly got their key wrong.
 */
export function resolveSecrets(
  stored: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { secrets: string[]; problems: string[] } {
  const secrets: string[] = []
  const problems: string[] = []

  for (const entry of stored) {
    try {
      secrets.push(resolveSecret(parseSecretRef(entry), env))
    } catch (error) {
      problems.push((error as Error).message)
    }
  }

  if (secrets.length === 0) {
    throw new SecretResolutionError(
      `no secret could be resolved: ${problems.join('; ') || 'the list is empty'}`,
    )
  }

  return { secrets, problems }
}

/** A description safe to log or show, which never includes the value. */
export function describeSecretRef(stored: string): string {
  const ref = parseSecretRef(stored)
  if (ref.kind === 'literal') return 'literal (stored in the database in plaintext)'
  return `${ref.kind}:${ref.locator}`
}
