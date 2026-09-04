/**
 * Credentials, stored once per tenant and used by every flow.
 *
 * This is n8n's model rather than the one this started with. Reading a
 * provider's key from the *server's* environment works for one operator and
 * stops working the moment there are two: every tenant shares one key, so
 * every tenant's AI calls are billed to whoever owns it, and a tenant cannot
 * bring their own. n8n has a Credentials section, you save a key there once,
 * and every workflow picks it from a list.
 *
 * ## The key is encrypted at rest, and that is the whole point of this file
 *
 * A credential is a secret sitting in a table, so the table must not be able
 * to give it up. `pg_dump`, a read replica, a careless `SELECT *`, a stolen
 * backup — none of those may yield a usable key.
 *
 * AES-256-GCM, with a key derived from `ENCRYPTION_KEY` in the environment.
 * n8n does the same thing under the same name (`N8N_ENCRYPTION_KEY`), and for
 * the same reason: the ciphertext lives in the database and the key does not,
 * so the two have to be stolen separately.
 *
 * GCM rather than CBC because it authenticates as well as encrypts. Without
 * that, someone who can write to the table can flip bits in a stored key and
 * watch what breaks; with it, a tampered row fails to decrypt and says so.
 *
 * A fresh 12-byte nonce per encryption, stored alongside the ciphertext.
 * Reusing a nonce under one key is the way GCM fails catastrophically, so it
 * is generated per write and never derived from anything.
 *
 * ## What this deliberately does not do
 *
 * **No key rotation.** n8n has it; this does not. Rotating means re-encrypting
 * every row under a new key, which is a migration with a failure mode worth
 * designing properly rather than bolting on. The stored format carries a
 * version byte so that when it is built, old rows can still be read.
 *
 * **No decryption through the API.** A credential can be created, listed and
 * deleted over HTTP; the plaintext only ever leaves this module towards a step
 * that is about to use it. There is no endpoint that returns a key, because
 * there is no reason for one to exist and every reason for it not to.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import type { Pool } from 'pg'

/** Bumped if the stored format ever changes; see "no key rotation" above. */
const FORMAT = 'v1'

const NONCE_BYTES = 12
const KEY_BYTES = 32

/**
 * The shortest key worth accepting.
 *
 * Not a policy for its own sake: a key derived from four characters is
 * brute-forceable in the time it takes to notice, and a credential store whose
 * key is `test` provides the appearance of encryption rather than encryption.
 * Refusing at startup is the only place this can be said usefully.
 */
const MIN_KEY_LENGTH = 16

export class CredentialError extends Error {
  override readonly name = 'CredentialError'
}

/**
 * Derive the encryption key from the configured passphrase.
 *
 * scrypt rather than using the passphrase directly, because an operator will
 * type a memorable string and AES needs 32 uniform bytes. The salt is fixed
 * and public — it has to be, since the same passphrase must derive the same
 * key on every process and every restart, and there is nowhere to keep a
 * per-install salt that the key itself is not already keeping.
 *
 * That makes this weaker than a per-secret salt would be against a
 * pre-computed attack on the passphrase. The mitigation is length, which is
 * why short passphrases are refused.
 */
export function deriveKey(passphrase: string): Buffer {
  if (passphrase.length < MIN_KEY_LENGTH) {
    throw new CredentialError(
      `ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters; a short one is not encryption, it is the appearance of it`,
    )
  }
  return scryptSync(passphrase, 'automabuild/credentials/v1', KEY_BYTES)
}

/** `v1:<nonce>:<tag>:<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (plaintext === '') throw new CredentialError('refusing to store an empty credential')

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return [
    FORMAT,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join(':')
}

export function decryptSecret(stored: string, key: Buffer): string {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new CredentialError('the stored credential is not in a format this understands')
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'))
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // One message for both causes, deliberately. A wrong key and a tampered
    // row are indistinguishable to GCM, and guessing which it was in the error
    // would be inventing information.
    throw new CredentialError(
      'the stored credential could not be decrypted: either ENCRYPTION_KEY has changed or the row has been altered',
    )
  }
}

/** A credential, as anything outside this module is allowed to see it. */
export interface CredentialSummary {
  readonly credentialId: string
  readonly tenantId: string
  readonly name: string
  /** Which provider it is for, so a step can offer only the relevant ones. */
  readonly provider: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
}

export interface CreateCredential {
  readonly tenantId: string
  readonly name: string
  readonly provider: string
  readonly secret: string
}

const COLUMNS = `
  credential_id AS "credentialId",
  tenant_id     AS "tenantId",
  name,
  provider,
  created_at    AS "createdAt",
  last_used_at  AS "lastUsedAt"
`

/**
 * The store.
 *
 * Every method takes a tenant id and every query filters on it. Not because a
 * caller might forget — because the one that forgot would hand a tenant
 * another tenant's key, and that is the failure this table exists to make
 * impossible.
 */
export class CredentialStore {
  readonly #pool: Pool
  readonly #key: Buffer

  constructor(pool: Pool, passphrase: string) {
    this.#pool = pool
    this.#key = deriveKey(passphrase)
  }

  async list(tenantId: string): Promise<CredentialSummary[]> {
    const { rows } = await this.#pool.query(
      `SELECT ${COLUMNS} FROM credentials
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY provider, name`,
      [tenantId],
    )
    return rows as CredentialSummary[]
  }

  async create(input: CreateCredential): Promise<CredentialSummary> {
    const name = input.name.trim()
    if (name === '') throw new CredentialError('a credential needs a name')

    const { rows } = await this.#pool.query(
      `INSERT INTO credentials (credential_id, tenant_id, name, provider, secret)
            VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
      [randomUUID(), input.tenantId, name, input.provider, encryptSecret(input.secret, this.#key)],
    )
    return rows[0] as CredentialSummary
  }

  /**
   * Soft delete, so a flow that still references it fails with a message
   * naming the credential rather than with a row that silently vanished.
   */
  async remove(tenantId: string, credentialId: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `UPDATE credentials SET deleted_at = now()
        WHERE tenant_id = $1 AND credential_id = $2 AND deleted_at IS NULL`,
      [tenantId, credentialId],
    )
    return (rowCount ?? 0) > 0
  }

  /**
   * The plaintext, for a step that is about to use it.
   *
   * The only way out of this module, and it is not reachable over HTTP. Also
   * records the use, which is the cheapest way to answer "is this credential
   * still needed" without a separate audit table.
   */
  async secret(tenantId: string, credentialId: string): Promise<string> {
    const { rows } = await this.#pool.query(
      `UPDATE credentials SET last_used_at = now()
        WHERE tenant_id = $1 AND credential_id = $2 AND deleted_at IS NULL
     RETURNING secret, name`,
      [tenantId, credentialId],
    )

    const row = rows[0] as { secret: string; name: string } | undefined
    if (row === undefined) {
      throw new CredentialError(
        `no credential ${credentialId} for this tenant — it may have been deleted`,
      )
    }
    return decryptSecret(row.secret, this.#key)
  }
}
