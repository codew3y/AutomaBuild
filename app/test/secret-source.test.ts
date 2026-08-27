/**
 * Where a secret lives.
 *
 * The endpoints table held signing secrets as plaintext, so a backup, a
 * replica, a support dump or a careless `SELECT *` all carried live
 * credentials. A stored value is a reference now, and this is the code that
 * makes that true.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describeSecretRef,
  parseSecretRef,
  resolveSecret,
  resolveSecrets,
  SecretResolutionError,
} from '../src/secret-source.ts'

let dir: string
let secretFile: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'automabuild-secret-'))
  secretFile = join(dir, 'hook')
  // Deliberately with a trailing newline, which is what every editor and every
  // `echo` produces.
  writeFileSync(secretFile, 'whsec_from_a_file\n')
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parsing a reference', () => {
  test('recognises the three kinds', () => {
    assert.deepEqual(parseSecretRef('env:NAME'), { kind: 'env', locator: 'NAME' })
    assert.deepEqual(parseSecretRef('file:/run/secrets/x'), { kind: 'file', locator: '/run/secrets/x' })
    assert.deepEqual(parseSecretRef('literal:abc'), { kind: 'literal', locator: 'abc' })
  })

  test('treats an unprefixed value as a literal, so old rows keep working', () => {
    assert.deepEqual(parseSecretRef('whsec_abc'), { kind: 'literal', locator: 'whsec_abc' })
  })

  test('does not mistake a value containing a colon for a reference', () => {
    // A secret with a colon in it must not become a reference to a scheme
    // nobody has ever heard of, which would then fail to resolve.
    assert.deepEqual(parseSecretRef('weird:secret'), { kind: 'literal', locator: 'weird:secret' })
  })

  test('a windows path after file: survives intact', () => {
    assert.deepEqual(parseSecretRef('file:C:/secrets/hook'), {
      kind: 'file',
      locator: 'C:/secrets/hook',
    })
  })
})

describe('resolving one', () => {
  test('reads the environment', () => {
    assert.equal(resolveSecret({ kind: 'env', locator: 'X' }, { X: 'value' }), 'value')
  })

  test('reads a file, trimming the newline an editor added', () => {
    // A signature computed over the secret-plus-newline matches nothing, and
    // the failure looks exactly like the sender having the wrong key.
    assert.equal(resolveSecret({ kind: 'file', locator: secretFile }), 'whsec_from_a_file')
  })

  test('throws rather than yielding an empty secret', () => {
    // An empty secret verifies nothing and rejects every delivery, which looks
    // like every sender getting their key wrong at once — the hardest failure
    // to diagnose, because the error points at the wrong party.
    assert.throws(() => resolveSecret({ kind: 'env', locator: 'MISSING' }, {}), SecretResolutionError)
    assert.throws(() => resolveSecret({ kind: 'env', locator: 'EMPTY' }, { EMPTY: '' }), SecretResolutionError)
    assert.throws(() => resolveSecret({ kind: 'literal', locator: '' }), SecretResolutionError)
  })

  test('reports a missing file usefully', () => {
    assert.throws(
      () => resolveSecret({ kind: 'file', locator: join(dir, 'nope') }),
      /cannot read/,
    )
  })
})

describe('resolving a set', () => {
  test('keeps the working ones when a reference is broken', () => {
    // Rotation. An endpoint holds every currently-valid secret, and one of them
    // pointing at a variable that is not set yet must not take the other down.
    const { secrets, problems } = resolveSecrets(['env:GOOD', 'env:NOT_SET'], { GOOD: 'a' })
    assert.deepEqual(secrets, ['a'])
    assert.equal(problems.length, 1)
  })

  test('throws when none of them resolve', () => {
    // Different from one being broken: an endpoint with no usable secret
    // rejects every delivery, and doing that silently would look like every
    // sender suddenly got their key wrong.
    assert.throws(() => resolveSecrets(['env:A', 'env:B'], {}), SecretResolutionError)
    assert.throws(() => resolveSecrets([], {}), SecretResolutionError)
  })

  test('preserves order, because rotation tries them in turn', () => {
    const { secrets } = resolveSecrets(['env:NEW', 'env:OLD'], { NEW: 'n', OLD: 'o' })
    assert.deepEqual(secrets, ['n', 'o'])
  })
})

describe('describing one', () => {
  test('never includes the value', () => {
    const described = describeSecretRef('literal:whsec_super_secret')
    assert.equal(described.includes('whsec_super_secret'), false)
  })

  test('says plainly when a secret is sitting in the database', () => {
    // The point of keeping literals working is not to bless them. It is to
    // make them visible, so somebody moves them.
    assert.match(describeSecretRef('literal:x'), /plaintext/)
    assert.match(describeSecretRef('whsec_unprefixed'), /plaintext/)
  })

  test('names the source for a reference', () => {
    assert.equal(describeSecretRef('env:WEBHOOK_SECRETS'), 'env:WEBHOOK_SECRETS')
    assert.equal(describeSecretRef('file:/run/secrets/x'), 'file:/run/secrets/x')
  })
})
