/**
 * Declared output fields.
 *
 * The part that turns an AI call into a step: the author says what they want
 * back, and each answer becomes a value a branch can compare and an email can
 * quote. Zapier calls it Output Fields, n8n a Structured Output Parser.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  coerceFields,
  fieldContract,
  parseOutputFields,
  unfence,
} from '../src/steps/ai-fields.ts'

const LF = String.fromCharCode(10)

describe('declaring the fields', () => {
  it('reads name, type and description', () => {
    const fields = parseOutputFields(
      ['sentiment: text — positive, negative or neutral', 'urgent: boolean'].join(LF),
    )
    assert.deepEqual(fields, [
      {
        name: 'sentiment',
        type: 'text',
        description: 'positive, negative or neutral',
        required: true,
      },
      { name: 'urgent', type: 'boolean', description: '', required: true },
    ])
  })

  it('defaults the type to text, because most fields are text', () => {
    assert.equal(parseOutputFields('summary')[0]!.type, 'text')
    assert.equal(parseOutputFields('summary: — one line')[0]!.description, 'one line')
  })

  it('accepts a plain hyphen as well as an em dash', () => {
    // One of them is what a person actually types.
    assert.equal(parseOutputFields('amount: number - in cents')[0]!.description, 'in cents')
  })

  it('treats a trailing ? as optional, so required is the default', () => {
    const fields = parseOutputFields(['a: text', 'b?: text'].join(LF))
    assert.equal(fields[0]!.required, true)
    assert.equal(fields[1]!.required, false)
    assert.equal(fields[1]!.name, 'b', 'the marker is not part of the name')
  })

  it('skips blank lines and comments', () => {
    assert.equal(parseOutputFields(['# what we want', '', 'a: text'].join(LF)).length, 1)
  })

  it('refuses a name a reference could not address', () => {
    // `{{ steps.ai.output.my field }}` is not a path, so the field is useless.
    assert.throws(() => parseOutputFields('my field: text'), /not a usable output field name/)
    assert.throws(() => parseOutputFields('2nd: text'), /not a usable output field name/)
  })

  it('refuses a duplicate, which would silently lose one', () => {
    assert.throws(() => parseOutputFields(['a: text', 'a: number'].join(LF)), /declared twice/)
  })

  it('refuses a type it cannot coerce', () => {
    assert.throws(() => parseOutputFields('a: datetime'), /is not a field type/)
  })
})

describe('the contract sent to the model', () => {
  it('shows the object rather than describing it', () => {
    // Describing a schema in prose gets a schema-shaped answer back.
    const contract = fieldContract(parseOutputFields('sentiment: text — the mood'))
    assert.match(contract, /JSON only/)
    assert.match(contract, /"sentiment": a string \/\/ the mood/)
  })

  it('tells the model an optional field may be null', () => {
    assert.match(fieldContract(parseOutputFields('note?: text')), /optional, use null/)
  })
})

describe('reading the answer back', () => {
  const fields = parseOutputFields(
    ['summary: text', 'score: number', 'urgent: boolean', 'tags: list'].join(LF),
  )

  it('takes the values through unchanged when the model behaves', () => {
    const out = coerceFields(
      { summary: 'a line', score: 7, urgent: true, tags: ['a', 'b'] },
      fields,
    )
    assert.deepEqual(out, { summary: 'a line', score: 7, urgent: true, tags: ['a', 'b'] })
  })

  it('coerces the answers a model actually gives', () => {
    // Asked for a boolean, a model says true about half the time and "yes" the
    // rest. A step whose output type depends on the model's mood is not
    // something a branch can be built on.
    const out = coerceFields(
      { summary: 'x', score: '7', urgent: 'yes', tags: 'a, b' },
      fields,
    )
    assert.equal(out['score'], 7)
    assert.equal(out['urgent'], true)
    assert.deepEqual(out['tags'], ['a', 'b'])
  })

  it('reads no as false, and refuses a word that means neither', () => {
    assert.equal(coerceFields({ urgent: 'no' }, parseOutputFields('urgent: boolean'))['urgent'], false)
    assert.throws(
      () => coerceFields({ urgent: 'perhaps' }, parseOutputFields('urgent: boolean')),
      /true or false/,
    )
  })

  it('pulls a number out of the units a model adds', () => {
    assert.equal(coerceFields({ n: '$42.50' }, parseOutputFields('n: number'))['n'], 42.5)
    assert.throws(() => coerceFields({ n: 'lots' }, parseOutputFields('n: number')), /as a number/)
  })

  it('fails when a required field was not answered', () => {
    // Otherwise the value is null, a later step maps it into an email, and the
    // run reports success having sent a blank one.
    assert.throws(
      () => coerceFields({ summary: 'x' }, parseOutputFields(['summary: text', 'score: number'].join(LF))),
      /did not answer score/,
    )
  })

  it('allows an optional field to be absent, as null', () => {
    const out = coerceFields({ a: 'x' }, parseOutputFields(['a: text', 'b?: text'].join(LF)))
    assert.equal(out['b'], null)
  })

  it('says what it got when the model returns the wrong shape', () => {
    assert.throws(() => coerceFields(['a'], fields), /returned an array/)
    assert.throws(() => coerceFields('a string', fields), /returned string/)
  })
})

describe('the code fence models add anyway', () => {
  it('comes off, however it was written', () => {
    assert.equal(unfence('```json' + LF + '{"a":1}' + LF + '```'), '{"a":1}')
    assert.equal(unfence('```' + LF + '{"a":1}' + LF + '```'), '{"a":1}')
    assert.equal(unfence('  {"a":1}  '), '{"a":1}')
  })

  it('leaves anything else alone, so a real failure keeps its evidence', () => {
    assert.equal(unfence('I cannot do that'), 'I cannot do that')
  })
})
