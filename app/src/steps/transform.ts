/**
 * The transform step.
 *
 * It makes no external call. It takes what earlier steps produced and reshapes
 * it into whatever the next step wants — renaming fields, picking a subset,
 * combining values, supplying a default. It exists because the API that gives
 * you data and the API that wants it almost never agree on a shape, and
 * without a step in between that mismatch has to live inside one of them.
 *
 * The template is a JSON document whose string values may contain `{{ }}`
 * references. Those are already resolved by `withMapping` before this runs, so
 * by the time the handler sees its config the references are gone and what is
 * left is data. This is deliberately not an expression language: user-supplied
 * code in a workflow engine is a sandbox problem, and a sandbox is a much
 * larger thing to get right than a template.
 *
 * The output is the parsed document, so the next step refers to it as
 * `{{ steps.<id>.output.<field> }}` exactly like any other step's output.
 */

import type { StepHandler } from 'automa-durable-runner'

import { resolveValue, scopeFor } from '../handlers.ts'

export class TransformError extends Error {
  readonly name = 'TransformError'
  constructor(message: string) {
    super(message)
  }
}

/**
 * Parse the template into the value this step outputs.
 *
 * Separate from the handler so it can be tested without an engine, and so the
 * editor could run the same function to preview a transform before it is ever
 * published.
 */
export function evaluateTransform(template: unknown): unknown {
  // Already an object: the config came through as structured data, which
  // happens when the whole field was a single `{{ }}` reference and kept the
  // referenced value's type.
  if (typeof template !== 'string') return template ?? null

  const trimmed = template.trim()
  if (trimmed === '') return null

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    // Not JSON. A bare string is a legitimate transform — mapping one field
    // through to a name of your choosing — so it is only an error when the
    // author clearly meant JSON and got it wrong. Anything that opens with a
    // brace or a bracket meant JSON.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new TransformError(
        `the template is not valid JSON: ${(error as Error).message}`,
      )
    }
    return trimmed
  }
}

/**
 * Resolve every string inside an already-parsed structure.
 *
 * Parse first, resolve second. The other order substitutes each reference into
 * the *text* of the document, so `{"n": "{{ x }}"}` parses to the string
 * "4200" instead of the number 4200 — every value a transform produces would
 * be a string, and a later step comparing numbers would be comparing text.
 */
function resolveDeep(value: unknown, scope: unknown, missing: string[]): unknown {
  if (typeof value === 'string') {
    const { value: resolved, missing: absent } = resolveValue(value, scope)
    missing.push(...absent)
    return resolved
  }
  if (Array.isArray(value)) return value.map((entry) => resolveDeep(entry, scope, missing))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveDeep(entry, scope, missing),
      ]),
    )
  }
  return value
}

export function transformHandler(): StepHandler {
  return async (context) => {
    const config = (context.node.config ?? {}) as Record<string, unknown>
    // `template` is the field; `expression` is accepted because that is what
    // the editor's schema called it first, and a flow published under the old
    // name must not stop working when the name changes.
    const source = config['template'] ?? config['expression']

    if (source === undefined) {
      throw new TransformError('a transform step needs a template')
    }

    // The template arrives unresolved: withMapping is told to leave it alone
    // so that this can parse before resolving.
    const parsed = evaluateTransform(source)

    const missing: string[] = []
    const output = resolveDeep(parsed, scopeFor(context), missing)

    if (missing.length > 0) {
      throw new TransformError(
        `unresolved reference${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      )
    }

    return { output }
  }
}
