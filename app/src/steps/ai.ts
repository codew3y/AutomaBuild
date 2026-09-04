/**
 * The AI step.
 *
 * All of this could be done with the HTTP step — and was, until this existed.
 * Three things made it worth a step of its own, and each one is a mistake the
 * HTTP step lets you make:
 *
 * **The prompt has to be escaped, and nobody does it.** Writing an AI call by
 * hand means typing a JSON body with `{{ }}` references inside a string
 * literal. Resolution happens before that string is parsed as JSON, so a
 * mapped value containing a double quote breaks the document — and a webhook
 * payload is exactly the kind of untrusted text that contains one. Here the
 * body is built with `JSON.stringify` from a prompt that is already a plain
 * string, so there is nothing to escape and no way to get it wrong.
 *
 * **The API key ended up in the database.** The HTTP step's `auth` field is
 * part of the flow, and the flow is a published row in Postgres. This does not
 * ask for a key at all: it reads the provider's conventional environment
 * variable — `GROQ_API_KEY` for groq, and so on — so a key already in the
 * server's environment needs nothing configured here. The field exists for the
 * cases that need it and takes a secret *reference*, the same shape endpoint
 * secrets already use, so even then the flow records where the key lives
 * rather than what it is.
 *
 * **The answer was buried.** `steps.x.output.body.choices[0].message.content`
 * is the path through OpenAI's response envelope, and every consumer had to
 * know it. The output here is `{ text, model, finishReason, usage }`, so a
 * later step reads `{{ steps.ai.output.text }}`.
 *
 * ## Providers
 *
 * One request shape — OpenAI's `/chat/completions` — because Groq, OpenRouter,
 * Together, Cerebras, OpenAI itself, a local Ollama and even Gemini all speak
 * it. That is the whole reason this is a thin step rather than a provider
 * abstraction: there is one protocol here, not five, and pretending otherwise
 * would add a layer that translates nothing.
 *
 * `provider` is therefore just a base URL someone does not have to remember,
 * and `baseUrl` is there for anything not listed.
 */

import { createSafeFetch, SsrfBlockedError } from 'automa-safe-fetch'
import { StepFailure, type StepHandler } from 'automa-durable-runner'

import { parseSecretRef, resolveSecret, SecretResolutionError } from '../secret-source.ts'
import {
  CATEGORIES_FIELD,
  CATEGORY_FIELD,
  categoryField,
  coerceFields,
  fieldContract,
  NO_MATCH,
  parseCategories,
  parseOutputFields,
  resolveCategory,
  unfence,
  type NoMatch,
  type OutputField,
} from './ai-fields.ts'

/** Base URLs for the providers worth not having to look up. */
export const PROVIDERS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  // Google's OpenAI-compatible surface, rather than its own generateContent
  // shape — same protocol as the rest, so no special case here.
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
}

/**
 * Where each provider's key is read from when the step does not say.
 *
 * Asking for the key at all was a mistake: the server already has it in its
 * environment, and every provider has one obvious name for it. Typing
 * `env:GROQ_API_KEY` into a form to tell the server about a variable the
 * server set is work that produces nothing.
 *
 * These are the conventional names — the ones each provider's own quickstart
 * uses — so a key put in `.env` under the name the docs gave it is found with
 * no configuration. The field remains for the cases that need it: two keys for
 * one provider, or a name chosen before this existed.
 */
export const DEFAULT_KEY_ENV: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

/**
 * What the step is for, which decides how the model is told to behave.
 *
 * Zapier's AI action offers the same four as prompt templates — Summarize,
 * Write, Classify, Extract — and they are not decoration. A model asked to
 * classify something and given no further instruction writes a paragraph
 * explaining its reasoning, which is not a classification. Saying "answer with
 * the label and nothing else" is the difference, and it is the same sentence
 * every time, so the step says it rather than the author.
 *
 * `custom` states nothing, for a prompt that already says what it wants.
 * An explicit system message always wins over the preset, because someone who
 * wrote one meant it.
 */
export const TASKS: Record<string, string> = {
  summarize:
    'You summarise. Be faithful to the source and add nothing that is not in it. ' +
    'Prefer the shortest form that keeps the meaning.',
  classify:
    'You classify. Choose from the categories given and answer with the choice only. ' +
    'If none fits, say so plainly rather than inventing one.',
  extract:
    'You extract. Report only values present in the source, verbatim where possible. ' +
    'If a value is absent, say it is absent rather than guessing.',
  write:
    'You draft text for a person to send. Match the tone asked for, keep it concise, ' +
    'and never invent facts, names or figures that were not given to you.',
  custom: '',
}

export interface AiStepConfig {
  readonly task?: string
  /** Classification only: the categories to choose from. */
  readonly categories?: string
  /** Classification only: whether more than one category may be true. */
  readonly allowMultiple?: string | boolean
  /** Classification only: what to do when the answer matches none of them. */
  readonly noMatch?: string
  readonly provider?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly prompt?: string
  readonly outputFields?: string
  readonly system?: string
  readonly apiKey?: string
  readonly maxTokens?: string | number
  readonly temperature?: string | number
}

/**
 * What a later step reads. Flat on purpose.
 *
 * Declared output fields appear at the top level alongside these, so
 * `{{ steps.ai.output.sentiment }}` works. `text` is always present: it is the
 * whole answer when no fields were declared, and the raw reply when they were,
 * which is the only thing worth having when a field did not come back as
 * expected.
 */
export interface AiStepOutput {
  readonly text: string
  readonly model: string
  readonly finishReason: string | null
  readonly usage: {
    readonly promptTokens: number | null
    readonly completionTokens: number | null
  }
  readonly [field: string]: unknown
}

/** A number from a text field, or undefined when the field is empty. */
function optionalNumber(value: string | number | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new StepFailure(`${field} must be a number, but is ${JSON.stringify(String(value))}`, {
      deterministicallyBroken: true,
    })
  }
  return parsed
}

export function resolveBaseUrl(config: AiStepConfig): string {
  const explicit = (config.baseUrl ?? '').trim()
  if (explicit !== '') return explicit.replace(/\/+$/, '')

  const provider = (config.provider ?? 'groq').trim().toLowerCase()
  const known = PROVIDERS[provider]
  if (known === undefined) {
    throw new StepFailure(
      `unknown provider ${JSON.stringify(provider)}: expected one of ${Object.keys(PROVIDERS).join(', ')}, or set baseUrl`,
      { deterministicallyBroken: true },
    )
  }
  return known
}

export interface AiHandlerOptions {
  readonly safeFetch?: ReturnType<typeof createSafeFetch>
  readonly env?: NodeJS.ProcessEnv
}

export function aiHandler(options: AiHandlerOptions = {}): StepHandler {
  // The same client the HTTP step uses, for the same reason: a base URL can
  // come from a flow, and a flow comes from a user.
  const safeFetch = options.safeFetch ?? createSafeFetch({ maxRedirects: 0 })

  return async (context) => {
    const config = (context.node.config ?? {}) as AiStepConfig

    const prompt = (config.prompt ?? '').trim()
    if (prompt === '') {
      throw new StepFailure('the AI step has no prompt', { deterministicallyBroken: true })
    }

    const model = (config.model ?? '').trim()
    if (model === '') {
      throw new StepFailure('the AI step has no model', { deterministicallyBroken: true })
    }

    // A reference, not a key, and usually not stated at all: the provider's
    // conventional variable name is the default, so a key in the server's
    // environment is found with nothing configured here.
    const provider = (config.provider ?? 'groq').trim().toLowerCase()
    const keyRef =
      (config.apiKey ?? '').trim() !== ''
        ? config.apiKey!.trim()
        : `env:${DEFAULT_KEY_ENV[provider] ?? 'GROQ_API_KEY'}`

    let apiKey: string
    try {
      apiKey = resolveSecret(parseSecretRef(keyRef), options.env ?? process.env)
    } catch (error) {
      // Deterministic: an unset variable will be unset on every retry, and the
      // message names which one rather than leaving a 401 to be interpreted.
      const asked =
        (config.apiKey ?? '').trim() === ''
          ? `no api key was set on the step, so ${keyRef} was tried`
          : `the step's api key is ${keyRef}`
      throw new StepFailure(
        error instanceof SecretResolutionError
          ? `the AI step could not resolve its api key — ${asked}: ${error.message}`
          : `the AI step's api key is not a usable reference — ${asked}: ${String(error)}`,
        { deterministicallyBroken: true },
      )
    }

    // Declared before the request is built, because a bad declaration should
    // fail without spending a call.
    const fields: OutputField[] = parseOutputFields(config.outputFields ?? '')

    /*
      The system message, assembled from up to three parts.

      The author's own words if they wrote any, otherwise the preset for the
      task. Then the field contract, when fields were declared — appended
      rather than merged, so it cannot be lost inside a long instruction and
      so a prompt written as a plain question still gets structured back.
    */
    const task = (config.task ?? 'custom').trim().toLowerCase()
    if (!(task in TASKS)) {
      throw new StepFailure(
        `unknown task ${JSON.stringify(task)}: expected one of ${Object.keys(TASKS).join(', ')}`,
        { deterministicallyBroken: true },
      )
    }

    /*
      A classification adds one field of its own.

      Expressed as an ordinary output field so the contract, the coercion and
      the missing-answer check all apply to it unchanged — and so an author who
      declares fields of their own gets one answer containing both rather than
      two schemes competing for the reply.
    */
    const categories = task === 'classify' ? parseCategories(config.categories ?? '') : []
    const multiple = config.allowMultiple === true || config.allowMultiple === 'multiple'
    const noMatch: NoMatch = config.noMatch === 'fail' ? 'fail' : 'other'
    if (config.noMatch !== undefined && config.noMatch !== '' && !NO_MATCH.includes(noMatch)) {
      throw new StepFailure(
        `unknown noMatch ${JSON.stringify(config.noMatch)}: expected ${NO_MATCH.join(' or ')}`,
        { deterministicallyBroken: true },
      )
    }

    if (task === 'classify' && categories.length === 0) {
      // Classifying into nothing is not a task. Said here rather than letting
      // the model invent its own set, which it will, differently each time.
      throw new StepFailure(
        'a Text Classifier needs categories: list them one per line, as name — description',
        { deterministicallyBroken: true },
      )
    }

    const asked: OutputField[] =
      categories.length > 0 ? [categoryField(categories, multiple), ...fields] : fields

    const authored = (config.system ?? '').trim()
    const preamble = authored !== '' ? authored : TASKS[task]!
    const system = [preamble, asked.length > 0 ? fieldContract(asked) : '']
      .filter((part) => part !== '')
      .join('\n\n')

    const messages: { role: string; content: string }[] = []
    if (system !== '') messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })

    // Built here rather than typed by hand, which is the point: the prompt is
    // a plain string and `JSON.stringify` escapes whatever is in it.
    const body = JSON.stringify({
      model,
      messages,
      // `json_object` rather than a strict `json_schema`: the schema form is
      // guaranteed by constrained decoding but only on a handful of models —
      // on Groq, not on the small fast one most flows will use. This is
      // supported everywhere the chat API is, and the contract in the system
      // message does the describing. The reply is validated either way, so a
      // model that ignores it fails the step rather than the flow.
      ...(asked.length > 0 ? { response_format: { type: 'json_object' } } : {}),
      ...(optionalNumber(config.maxTokens, 'maxTokens') === undefined
        ? {}
        : { max_tokens: optionalNumber(config.maxTokens, 'maxTokens') }),
      ...(optionalNumber(config.temperature, 'temperature') === undefined
        ? {}
        : { temperature: optionalNumber(config.temperature, 'temperature') }),
    })

    const url = `${resolveBaseUrl(config)}/chat/completions`

    let requestSent = false
    try {
      const response = await safeFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          // Honoured by providers that implement it, harmless elsewhere.
          'idempotency-key': context.idempotencyKey,
        },
        body,
        signal: context.signal,
        timeoutMs: context.deadlineMs,
      })
      requestSent = true

      const text = await response.text()
      if (!response.ok) {
        // The provider's own message is the useful part — a wrong model name
        // or an exhausted quota both arrive this way and read very
        // differently. Truncated, because some providers echo the request.
        throw new StepFailure(`HTTP ${response.status}: ${text.slice(0, 300)}`, {
          httpStatus: response.status,
          requestSent: true,
          responseReceived: true,
        })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new StepFailure(
          `the provider returned a ${response.status} that is not JSON: ${text.slice(0, 200)}`,
          { requestSent: true, responseReceived: true },
        )
      }

      const base = toOutput(parsed, model)
      if (asked.length === 0) return { output: base }

      // Zapier's rule, and the right one: no declared fields means one
      // combined answer. With fields, each becomes its own output.
      let structured: unknown
      try {
        structured = JSON.parse(unfence(base.text))
      } catch {
        throw new StepFailure(
          `the model was asked for JSON and returned: ${base.text.slice(0, 300)}`,
          { requestSent: true, responseReceived: true },
        )
      }

      const values = coerceFields(structured, asked)

      // Hold the model to the categories it was given. A model handed five
      // will occasionally answer with a sixth it preferred.
      if (categories.length > 0) {
        const key = multiple ? CATEGORIES_FIELD : CATEGORY_FIELD
        values[key] = resolveCategory(values[key], categories, noMatch)
      }

      return { output: { ...base, ...values } }
    } catch (error) {
      if (error instanceof StepFailure) throw error

      if (error instanceof SsrfBlockedError) {
        throw new StepFailure(`blocked: ${error.reason}`, {
          deterministicallyBroken: false,
          httpStatus: 400,
          requestSent: false,
        })
      }

      const code = (error as NodeJS.ErrnoException).code
      throw new StepFailure((error as Error).message, {
        ...(code === undefined ? {} : { code }),
        requestSent,
        responseReceived: false,
      })
    }
  }
}

/**
 * Flatten the response envelope.
 *
 * Exported to be tested without a socket, and because the shape is the step's
 * contract with every flow that consumes it — worth pinning somewhere visible.
 *
 * A well-formed reply with no choices is a failure rather than an empty
 * string: a later step mapping `output.text` into an email would otherwise
 * send a blank one and report success.
 */
export function toOutput(parsed: unknown, requestedModel: string): AiStepOutput {
  const root = (parsed ?? {}) as Record<string, unknown>
  const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : []
  const first = (choices[0] ?? null) as Record<string, unknown> | null
  const message = (first?.['message'] ?? null) as Record<string, unknown> | null
  const content = typeof message?.['content'] === 'string' ? (message['content'] as string) : null

  if (content === null) {
    throw new StepFailure('the provider returned no message content', {
      requestSent: true,
      responseReceived: true,
    })
  }

  const usage = (root['usage'] ?? {}) as Record<string, unknown>
  const count = (key: string): number | null =>
    typeof usage[key] === 'number' ? (usage[key] as number) : null

  return {
    text: content,
    // The model the provider says it used, which is not always the one asked
    // for — a router may substitute, and knowing which answered matters when
    // the answer is surprising.
    model: typeof root['model'] === 'string' ? (root['model'] as string) : requestedModel,
    finishReason:
      typeof first?.['finish_reason'] === 'string' ? (first['finish_reason'] as string) : null,
    usage: { promptTokens: count('prompt_tokens'), completionTokens: count('completion_tokens') },
  }
}
