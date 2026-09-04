/**
 * Credential encryption.
 *
 * No database. What has to be right here is the crypto and the refusals, and
 * both are testable without one — the store's queries are exercised by the
 * integration tests that have Postgres.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CredentialError,
  decryptSecret,
  deriveKey,
  encryptSecret,
} from '../src/credentials.ts'

const PASSPHRASE = 'a-long-enough-passphrase'
const KEY = deriveKey(PASSPHRASE)
const SECRET = 'gsk_a_real_looking_api_key_value'

describe('the key', () => {
  it('is the same every time for the same passphrase', () => {
    // It has to be: the ciphertext is in the database and the key is derived
    // on every start, in every worker process.
    assert.deepEqual(deriveKey(PASSPHRASE), deriveKey(PASSPHRASE))
  })

  it('is different for a different passphrase', () => {
    assert.notDeepEqual(deriveKey(PASSPHRASE), deriveKey(PASSPHRASE + '!'))
  })

  it('is 32 bytes, which is what AES-256 takes', () => {
    assert.equal(KEY.length, 32)
  })

  it('refuses a passphrase short enough to guess', () => {
    // A store whose key is "test" offers the appearance of encryption. Startup
    // is the only place saying so is any use.
    assert.throws(() => deriveKey('short'), CredentialError)
    assert.throws(() => deriveKey(''), /at least 16 characters/)
  })
})

describe('round tripping a secret', () => {
  it('comes back exactly', () => {
    assert.equal(decryptSecret(encryptSecret(SECRET, KEY), KEY), SECRET)
  })

  it('survives the characters a real key contains', () => {
    for (const value of ['sk-proj-a/b+c=', 'ключ', 'a key with spaces', '{"json":"key"}']) {
      assert.equal(decryptSecret(encryptSecret(value, KEY), KEY), value)
    }
  })

  it('produces different ciphertext every time', () => {
    // A fresh nonce per write. Two identical keys stored twice must not look
    // identical in the table, or the table leaks which tenants share a key.
    const a = encryptSecret(SECRET, KEY)
    const b = encryptSecret(SECRET, KEY)
    assert.notEqual(a, b)
    assert.equal(decryptSecret(a, KEY), decryptSecret(b, KEY))
  })

  it('never contains the plaintext', () => {
    const stored = encryptSecret(SECRET, KEY)
    assert.equal(stored.includes(SECRET), false)
    assert.equal(stored.includes('gsk_'), false)
  })

  it('refuses to store nothing', () => {
    // An empty credential would resolve to an empty Bearer and leave a 401 to
    // be interpreted as a wrong key.
    assert.throws(() => encryptSecret('', KEY), /empty credential/)
  })
})

describe('what decryption refuses', () => {
  it('refuses the wrong key', () => {
    const stored = encryptSecret(SECRET, KEY)
    assert.throws(() => decryptSecret(stored, deriveKey('a-different-passphrase')), CredentialError)
  })

  it('refuses a tampered ciphertext, which is why GCM and not CBC', () => {
    // Someone who can write to the table must not be able to flip bits in a
    // stored key and watch what changes.
    const [version, nonce, tag, body] = encryptSecret(SECRET, KEY).split(':')
    const flipped = Buffer.from(body!, 'base64url')
    flipped[0] = flipped[0]! ^ 0x01
    assert.throws(
      () => decryptSecret([version, nonce, tag, flipped.toString('base64url')].join(':'), KEY),
      /could not be decrypted/,
    )
  })

  it('refuses a tampered tag and a tampered nonce', () => {
    const [version, nonce, tag, body] = encryptSecret(SECRET, KEY).split(':')
    const other = Buffer.alloc(12).toString('base64url')
    assert.throws(() => decryptSecret([version, other, tag, body].join(':'), KEY), CredentialError)
    assert.throws(
      () => decryptSecret([version, nonce, Buffer.alloc(16).toString('base64url'), body].join(':'), KEY),
      CredentialError,
    )
  })

  it('says the same thing for a wrong key as for a tampered row', () => {
    // GCM cannot tell them apart, and guessing in the message would be
    // inventing information.
    const stored = encryptSecret(SECRET, KEY)
    const wrongKey = (() => {
      try {
        decryptSecret(stored, deriveKey('another-long-passphrase'))
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    assert.match(wrongKey, /ENCRYPTION_KEY has changed or the row has been altered/)
  })

  it('refuses a format it does not recognise', () => {
    assert.throws(() => decryptSecret('just-a-string', KEY), /not in a format/)
    assert.throws(() => decryptSecret('v2:a:b:c', KEY), /not in a format/)
    assert.throws(() => decryptSecret('', KEY), /not in a format/)
  })

  it('carries a version, so a later format can still read this one', () => {
    assert.equal(encryptSecret(SECRET, KEY).startsWith('v1:'), true)
  })
})
