/**
 * Step handlers that resolve the canvas's `{{ }}` references.
 *
 * The mapping panel lets someone write `{{ steps.fetch.output.email }}` into a
 * field, and the preview shows what it will become. The engine's HTTP handler
 * takes `config.url` literally. Without something in between, a mapped URL is
 * requested verbatim, braces and all — the preview promises something the run
 * does not deliver, which is worse than not offering mapping at all.
 *
 * This is that in-between. It resolves the config against the upstream outputs
 * the engine already hands every step, then delegates to the engine's own
 * handler — so SSRF checking, timeouts, idempotency keys and error
 * classification are unchanged. Resolution is the only thing added.
 */

import { StepFailure, defaultHandlers, type HandlerRegistry, type StepContext, type StepHandler, type StepResult } from 'automa-durable-runner'

import { transformHandler } from './steps/transform.ts'
import { emailHandler, smtpFromEnv, type SmtpConfig } from './steps/email.ts'

/** `{{ steps.fetch.output.email }}` — whitespace-tolerant, nothing else. */
const REFERENCE = /\{\{\s*([^}]+?)\s*\}\}/g

/**
 * Follow a dotted path, including `orders[0].total`.
 *
 * Returns `undefined` for anything missing rather than throwing. A reference
 * to a field that is not there is a mapping mistake to be reported, not a
 * crash mid-run — and the engine would classify a thrown TypeError as
 * `internal`, which would blame the engine for the flow's error.
 */
export function readPath(root: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment !== '')

  let value: unknown = root
  for (const segment of segments) {
    if (value === null || value === undefined) return undefined
    if (typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

export interface ResolveResult {
  readonly value: string
  /** References that resolved to nothing. */
  readonly missing: readonly string[]
}

/**
 * Substitute every reference in a string.
 *
 * A template that is exactly one reference and nothing else keeps the
 * referenced value's type when it is handed to `resolveConfig` below — a
 * `body` of `{{ steps.x.output.payload }}` should send the object, not
 * `[object Object]`. Inside a larger string it is stringified, because that is
 * the only thing concatenation can mean.
 */
export function resolveTemplate(template: string, scope: unknown): ResolveResult {
  const missing: string[] = []
  const value = template.replace(REFERENCE, (_match, path: string) => {
    const resolved = readPath(scope, path)
    if (resolved === undefined || resolved === null) {
      missing.push(path)
      // The reference is left in place rather than blanked. A URL that still
      // visibly says `{{ steps.x.output.id }}` is a legible failure; one that
      // silently became `https://api.example.com/customers/` is a request to
      // the wrong endpoint that looks fine in a log.
      return _match as string
    }
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
  return { value, missing }
}

const SOLE_REFERENCE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/

/** True when the whole string is a single reference, so its type survives. */
function isSoleReference(template: string): boolean {
  return SOLE_REFERENCE.test(template)
}

/**
 * Resolve one string, keeping its type when it is a single whole reference.
 *
 * `{{ steps.x.output.count }}` on its own gives back the number; the same
 * reference inside a longer string gives back text, because concatenation can
 * mean nothing else. Shared with the transform step, which resolves its values
 * itself after parsing so the same rule applies inside a JSON template.
 */
export function resolveValue(value: string, scope: unknown): { value: unknown; missing: string[] } {
  if (!value.includes('{{')) return { value, missing: [] }

  if (isSoleReference(value)) {
    const path = SOLE_REFERENCE.exec(value)![1]!
    const resolved = readPath(scope, path)
    if (resolved === undefined || resolved === null) return { value, missing: [path] }
    return { value: resolved, missing: [] }
  }

  const result = resolveTemplate(value, scope)
  return { value: result.value, missing: [...result.missing] }
}

export interface ResolvedConfig {
  readonly config: Record<string, unknown>
  readonly missing: readonly string[]
}

/**
 * Resolve every string in a step's config.
 *
 * Recurses into nested objects and arrays, because `headers` is an object and
 * a mapped `Authorization` is the most obvious thing someone will write.
 */
export function resolveConfig(config: Record<string, unknown>, scope: unknown): ResolvedConfig {
  const missing: string[] = []

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const resolved = resolveValue(value, scope)
      missing.push(...resolved.missing)
      return resolved.value
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }

  return { config: walk(config) as Record<string, unknown>, missing }
}

/**
 * The scope a reference is resolved against.
 *
 * `steps.<nodeId>.output.<path>` is the canvas's shape, and the engine hands
 * over `upstream` keyed by node id holding the output directly. The extra
 * `output` level is added here so the two agree — the alternative is teaching
 * the editor a different syntax from the one it shows in its own preview.
 */
export function scopeFor(context: StepContext): Record<string, unknown> {
  const steps: Record<string, unknown> = {}
  for (const [nodeId, output] of Object.entries(context.upstream)) {
    steps[nodeId] = { output }
  }
  // The trigger is reachable two ways on purpose. `trigger.body` is what the
  // editor's own tree calls it, and `steps.<triggerNode>.output` is what
  // referring to the trigger like any other step produces — both appear in
  // real flows, and a reference that resolves in the preview and not at run
  // time is the failure this whole module exists to prevent.
  return { steps, trigger: { body: context.run.input } }
}

/**
 * Wrap a handler so its config is resolved before it runs.
 *
 * An unresolved reference fails the step rather than proceeding with a literal
 * `{{ }}` in it. It is thrown as an ordinary error, which the engine
 * classifies as `internal` and retries — and that is right: the reference is
 * usually missing because the upstream step has not produced its output yet in
 * a partially-resumed run, and a retry is exactly what fixes that. A genuinely
 * wrong path exhausts its attempts and lands in the DLQ with the path in the
 * message, which is what someone debugging needs to see.
 */
export interface MappingOptions {
  /**
   * Config fields to leave unresolved, for a handler that must resolve them
   * itself.
   *
   * The transform step is the reason this exists. Its template is a JSON
   * document with references inside it; resolving here would substitute each
   * one into the *text* of that document, so `{"n": "{{ x }}"}` would parse to
   * the string \"4200\" rather than the number 4200. The transform parses
   * first and resolves each value afterwards, which is the only order that can
   * preserve a type.
   */
  readonly rawFields?: readonly string[]
}

export function withMapping(handler: StepHandler, options: MappingOptions = {}): StepHandler {
  const rawFields = options.rawFields ?? []

  return async (context: StepContext): Promise<StepResult> => {
    const original = context.node.config ?? {}

    const held: Record<string, unknown> = {}
    const raw: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(original)) {
      if (rawFields.includes(key)) held[key] = value
      else raw[key] = value
    }

    const { config: resolvedFields, missing } = resolveConfig(raw, scopeFor(context))
    const config = { ...resolvedFields, ...held }

    if (missing.length > 0) {
      throw new Error(`unresolved reference${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`)
    }

    // The node is replaced rather than mutated: the engine holds the flow
    // definition across every step, and mutating config here would leave the
    // resolved values in place for the next run through the same object.
    return handler({ ...context, node: { ...context.node, config } })
  }
}

/**
 * The trigger step: publish what started the run, and do nothing else.
 *
 * It is a real step rather than a synthetic row so that the ordinary machinery
 * applies to it — it appears in the run viewer, it has a duration, and it can
 * be referred to by later steps the same way any other step can. Its output is
 * the run input verbatim.
 */
export const triggerHandler: StepHandler = async (context) => ({ output: context.run.input })

/**
 * A step kind that is configured but unavailable.
 *
 * Registering nothing would make the engine report "no handler registered",
 * which reads like a missing feature. This says which piece of configuration
 * is absent, which is what someone can actually act on. It is deterministic,
 * so it fails once rather than retrying four more times to reach the same
 * conclusion.
 */
function unconfigured(kind: string, reason: string): StepHandler {
  return async () => {
    throw new StepFailure(`the ${kind} step is not configured: ${reason}`, {
      deterministicallyBroken: true,
    })
  }
}

export interface HandlerOptions {
  /** Omit to read SMTP settings from the environment. */
  readonly smtp?: SmtpConfig | null
}

/**
 * The engine's handlers plus this application's, each able to resolve the
 * editor's references.
 *
 * The step catalogue lives here rather than in the engine on purpose: the
 * engine ships `http` and `noop` and has no opinion about what a workflow
 * product offers. What a trigger, a transform and an email mean is this
 * application's business.
 */
export function mappingHandlers(options: HandlerOptions = {}): HandlerRegistry {
  const smtp = options.smtp === undefined ? smtpFromEnv() : options.smtp

  const base: Record<string, StepHandler> = {
    ...defaultHandlers(),
    trigger: triggerHandler,
    transform: transformHandler(),
    email:
      smtp === null
        ? unconfigured('email', 'SMTP_HOST is not set')
        : emailHandler({ config: smtp }),
  }

  // The transform resolves its own template, for the type-preservation reason
  // on MappingOptions.
  const rawFor: Record<string, readonly string[]> = { transform: ['template', 'expression'] }

  return Object.fromEntries(
    Object.entries(base).map(([kind, handler]) => [
      kind,
      withMapping(handler, { rawFields: rawFor[kind] ?? [] }),
    ]),
  )
}
