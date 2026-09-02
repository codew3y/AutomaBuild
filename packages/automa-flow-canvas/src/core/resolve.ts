/**
 * Resolving `{{ steps.x.output.y }}` against sample data, for the live preview.
 *
 * The preview is the point of the mapping panel. Showing someone
 * `{{ steps.fetch.output.email }}` tells them what they typed; showing them
 * `sam@example.com` tells them whether it is right. A mapping that silently
 * resolves to nothing is the single most common way these flows break, and it
 * is invisible until the run.
 *
 * So an unresolvable path is reported as *missing*, explicitly, rather than
 * rendered as an empty string. Empty string is a legitimate value; "there is
 * nothing at that path" is not the same thing, and collapsing them is how the
 * preview would end up lying.
 */

export interface ResolveResult {
  /** The rendered text, with every reference substituted. */
  readonly text: string
  /** Paths that resolved to nothing. Non-empty means the preview is a warning. */
  readonly missing: readonly string[]
  /** True when the whole value was one reference — the preview can show the raw type. */
  readonly single: boolean
  /** The resolved value when `single`, so the panel can show a number as a number. */
  readonly value?: unknown
}

/** `{{ steps.<id>.<path...> }}` with any surrounding whitespace. */
const REFERENCE = /\{\{\s*([^}]+?)\s*\}\}/g

export type StepOutputs = Readonly<Record<string, unknown>>

/** Walk a dotted path, treating `a.b[0].c` and `a.b.0.c` alike. */
export function readPath(source: unknown, path: string): { found: boolean; value: unknown } {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part.length > 0)

  let current: unknown = source
  for (const part of parts) {
    if (current === null || current === undefined) return { found: false, value: undefined }
    if (typeof current !== 'object') return { found: false, value: undefined }
    if (!(part in (current as Record<string, unknown>))) {
      return { found: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[part]
  }
  return { found: true, value: current }
}

/**
 * Substitute every reference in `template` using the given step outputs.
 *
 * `outputs` is keyed by step id; a reference of `steps.fetch.output.email`
 * reads `email` from `outputs.fetch.output`.
 */
export function resolveTemplate(template: string, outputs: StepOutputs): ResolveResult {
  const missing: string[] = []
  const matches = [...template.matchAll(REFERENCE)]

  // A field that is exactly one reference keeps its type in the preview: a
  // number shows as a number, an object as an object. Otherwise everything
  // would be stringified and `false` would look like the word "false".
  const single =
    matches.length === 1 &&
    matches[0]![0].length === template.trim().length &&
    template.trim() === matches[0]![0]

  let resolvedValue: unknown
  const text = template.replace(REFERENCE, (_whole, expression: string) => {
    const path = expression.trim()
    const withoutPrefix = path.startsWith('steps.') ? path.slice('steps.'.length) : path
    const { found, value } = readPath(outputs, withoutPrefix)

    if (!found) {
      missing.push(path)
      return `⟨${path}⟩`
    }
    resolvedValue = value
    if (value === null) return 'null'
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  })

  return {
    text,
    missing,
    single,
    ...(single && missing.length === 0 ? { value: resolvedValue } : {}),
  }
}

export interface OutputLeaf {
  /** `fetch.output.email` — what a reference would contain. */
  readonly path: string
  /** Just the last segment, for display. */
  readonly key: string
  readonly depth: number
  readonly value: unknown
  readonly kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
}

/**
 * Flatten sample outputs into a list the mapping panel can render as a tree.
 *
 * Only the steps passed in are included, and the caller passes ancestors only —
 * offering a step that does not run first would invite exactly the mapping the
 * validation then rejects, which is a frustrating way to learn a rule.
 *
 * The depth limit exists to stop a pathological payload producing a thousand
 * rows, not to hide structure. It has to be generous, because the path is
 * already three levels deep before any real field appears —
 * `fetch` → `output` → `orders` → `[0]` → `total` is five — and an array index
 * costs a level of its own. Set too low it silently truncates the tree, which
 * looks like the provider not returning the field.
 */
export function outputTree(outputs: StepOutputs, maxDepth = 7): OutputLeaf[] {
  const leaves: OutputLeaf[] = []

  const walk = (value: unknown, path: string, key: string, depth: number): void => {
    if (depth > maxDepth) return

    const kind: OutputLeaf['kind'] =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'object'
            ? 'object'
            : (typeof value as OutputLeaf['kind'])

    if (path !== '') leaves.push({ path, key, depth, value, kind })

    if (kind === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        walk(childValue, path === '' ? childKey : `${path}.${childKey}`, childKey, depth + 1)
      }
    } else if (kind === 'array') {
      // One sample element is enough to show the shape. Listing fifty would
      // bury the fields worth mapping.
      const first = (value as unknown[])[0]
      if (first !== undefined) {
        walk(first, `${path}[0]`, '[0]', depth + 1)
      }
    }
  }

  walk(outputs, '', '', 0)
  return leaves
}

/** The text to insert when a leaf is picked. */
export function referenceFor(path: string): string {
  return `{{ steps.${path} }}`
}
