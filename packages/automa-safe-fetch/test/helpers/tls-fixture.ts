/**
 * Self-signed certificates, generated at test time.
 *
 * Deliberately not committed. A private key in a public repository is noise at
 * best — secret scanners flag it, and readers of a security library should not
 * have to work out whether the key in `test/fixtures` matters.
 *
 * Requires `openssl` on PATH. Present on GitHub's runners and in Git for
 * Windows; the TLS tests skip themselves if it is missing.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Certificate {
  readonly certPem: string
  readonly keyPem: string
  readonly certPath: string
  readonly dispose: () => void
}

export function opensslAvailable(): boolean {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' })
  return probe.status === 0
}

/**
 * A self-signed certificate naming `commonName` in its subjectAltName.
 *
 * EC rather than RSA purely for speed — key generation happens on every run.
 */
export function createSelfSignedCert(commonName: string): Certificate {
  const dir = mkdtempSync(join(tmpdir(), 'automa-safe-fetch-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-nodes',
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      `subjectAltName=DNS:${commonName}`,
    ],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`openssl failed: ${result.stderr}`)
  }

  return {
    certPem: readFileSync(certPath, 'utf8'),
    keyPem: readFileSync(keyPath, 'utf8'),
    certPath,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
