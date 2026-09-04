/**
 * Declared output fields, which is what turns an AI call into a step.
 *
 * The idea is Zapier's and n8n's, and they arrived at it from opposite
 * directions. Zapier's AI action has a **Settings → Output Fields** panel
 * where you add a field name, a type and a description; n8n's agent has
 * **Require Specific Output Format** and a Structured Output Parser sub-node.
 * Both exist because one blob of prose is nearly useless to the next step: you
 * cannot branch on it, you cannot put one part of it in a subject line and
 * another in a body, and you cannot tell whether the model answered the
 * question or apologised for being unable to.
 *
 * So the author says what they want back:
 *
 *     sentiment: text — positive, negative or neutral
 *     urgent: boolean
 *     summary: text
 *     amount: number
 *
 * and a later step reads `{{ steps.ai.output.sentiment }}` — a real value, of
 * a real type, that a branch can compare and an email can quote.
 *
 * Declaring nothing is also allowed, and does what Zapier documents for the
 * same case: one combined answer, in `text`. That is the right default,
 * because the first thing anyone does is ask a question and look at the reply.
 *
 * Written as lines rather than a repeating form because a step's config is a
 * flat map of strings — and because `name: type — description` is legible at a
 * glance, which a nested editor for four attributes is not.
 */

import { StepFailure } from 'automa-durable-runner'

export const FIELD_TYPES = ['text', 'number', 'boolean', 'list'] as const

export type FieldType = (typeof FIELD_TYPES)[number]

export interface OutputField {
  readonly name: string
  readonly type: FieldType
  readonly description: string
  /**
   * Whether the model must answer this one.
   *
   * Marked with a trailing `?` for optional, so required is the default. It is
   * the safer default: a field the author bothered to declare and the model
   * declined to fill is usually a broken prompt, and finding out at the step
   * rather than in a blank email is the point.
   */
  readonly required: boolean
}

/** `name` — a JSON key, and an identifier a `{{ }}` path can address. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read the declared fields.
 *
 * One per line. The type may be omitted and defaults to text, because most
 * fields are text and saying so is noise. Both an em dash and a plain hyphen
 * introduce the description, since one of them is what a person actually
 * types.
 */
export function parseOutputFields(raw: string): OutputField[] {
  const fields: OutputField[] = []
  const seen = new Set<string>()

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // `name: type — description`, where everything after the name is optional.
    const colon = trimmed.indexOf(':')
    const head = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim()
    const tail = colon === -1 ? '' : trimmed.slice(colon + 1).trim()

    const optional = head.endsWith('?')
    const name = optional ? head.slice(0, -1).trim() : head

    if (!NAME.test(name)) {
      throw new StepFailure(
        `${JSON.stringify(name)} is not a usable output field name: use letters, digits and underscores, starting with a letter`,
        { deterministicallyBroken: true },
      )
    }
    if (seen.has(name)) {
      throw new StepFailure(`the output field ${JSON.stringify(name)} is declared twice`, {
        deterministicallyBroken: true,
      })
    }
    seen.add(name)

    // The description is whatever follows the first dash, em or plain. The
    // dash may also open the tail — `name: — a description` is how someone
    // writes a description without stating a type, and reading the dash as
    // the type made that a confusing error about an unknown type.
    const leading = /^[—-]\s+/.exec(tail)
    const dash = leading === null ? tail.search(/\s[—-]\s+/) : 0
    const typeText = (dash === 0 ? '' : dash === -1 ? tail : tail.slice(0, dash))
      .trim()
      .toLowerCase()
    const description =
      dash === -1 ? '' : tail.slice(dash === 0 ? leading![0].length : dash + 2).trim()

    const type = typeText === '' ? 'text' : typeText
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new StepFailure(
        `${JSON.stringify(type)} is not a field type: expected ${FIELD_TYPES.join(', ')}`,
        { deterministicallyBroken: true },
      )
    }

    fields.push({ name, type: type as FieldType, description, required: !optional })
  }

  return fields
}

/**
 * The instruction that makes the model answer in the declared shape.
 *
 * Appended to the system message rather than the prompt, so it survives a
 * prompt written as a plain question — and so it reads to the model as part of
 * how to behave rather than part of what was asked.
 *
 * A worked example of the exact keys is included. Describing a schema in prose
 * gets a schema-shaped answer; showing the object gets the object.
 */
export function fieldContract(fields: readonly OutputField[]): string {
  const lines = fields.map((field) => {
    const parts = [`  ${JSON.stringify(field.name)}: ${describeType(field.type)}`]
    if (field.description !== '') parts.push(`// ${field.description}`)
    if (!field.required) parts.push('// optional, use null if not applicable')
    return parts.join(' ')
  })

  return [
    'Reply with JSON only. No prose, no code fence. Use exactly these keys:',
    '{',
    lines.join(',\n'),
    '}',
  ].join('\n')
}

function describeType(type: FieldType): string {
  if (type === 'number') return 'a number'
  if (type === 'boolean') return 'true or false'
  if (type === 'list') return 'an array of strings'
  return 'a string'
}

/**
 * Turn the model's JSON into the step's output.
 *
 * Coerced rather than trusted. A model asked for a boolean answers `true`
 * about half the time and `"yes"` the rest, and a step whose output type
 * depends on the model's mood is not a step anyone can branch on.
 *
 * A missing required field fails, for the reason on `OutputField.required`.
 */
export function coerceFields(
  parsed: unknown,
  fields: readonly OutputField[],
): Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StepFailure(
      `the model was asked for a JSON object with ${fields.length} field${fields.length === 1 ? '' : 's'} and returned ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
      { requestSent: true, responseReceived: true },
    )
  }

  const source = parsed as Record<string, unknown>
  const output: Record<string, unknown> = {}
  const missing: string[] = []

  for (const field of fields) {
    const value = source[field.name]
    if (value === undefined || value === null) {
      if (field.required) missing.push(field.name)
      output[field.name] = null
      continue
    }
    output[field.name] = coerce(value, field)
  }

  if (missing.length > 0) {
    throw new StepFailure(
      `the model did not answer ${missing.join(', ')} — mark the field optional with a trailing ? if that is expected`,
      { requestSent: true, responseReceived: true },
    )
  }

  return output
}

function coerce(value: unknown, field: OutputField): unknown {
  if (field.type === 'text') return typeof value === 'string' ? value : JSON.stringify(value)

  if (field.type === 'number') {
    // Stripping the units a model adds — "$42.50", "42 items" — but not so
    // freely that nothing is left: `Number('')` is 0, not NaN, so "lots"
    // stripped to nothing would have come back as a confident zero. The
    // stripped text has to still look like a number.
    const stripped = typeof value === 'number' ? String(value) : String(value).replace(/[^0-9.eE+-]/g, '')
    const n = /[0-9]/.test(stripped) ? Number(stripped) : Number.NaN
    if (!Number.isFinite(n)) {
      throw new StepFailure(
        `${field.name} was asked for as a number and came back as ${JSON.stringify(value)}`,
        { requestSent: true, responseReceived: true },
      )
    }
    return n
  }

  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value
    const text = String(value).trim().toLowerCase()
    // The words a model actually uses when it means yes or no.
    if (['true', 'yes', 'y', '1'].includes(text)) return true
    if (['false', 'no', 'n', '0'].includes(text)) return false
    throw new StepFailure(
      `${field.name} was asked for as true or false and came back as ${JSON.stringify(value)}`,
      { requestSent: true, responseReceived: true },
    )
  }

  // list
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  // A model given "an array of strings" sometimes sends one comma-separated
  // string instead. Splitting is kinder than failing, and unambiguous.
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Strip a code fence, which models add however firmly asked not to.
 *
 * Only the fence: anything else that is not JSON is a real failure and is
 * reported as one, with the text, because the text is the evidence.
 */
export function unfence(reply: string): string {
  const trimmed = reply.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}
