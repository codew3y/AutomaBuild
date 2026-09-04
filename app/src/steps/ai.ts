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
 * part of the flow, and the flow is a published row in Postgres. This takes a
 * secret *reference* — `env:GROQ_API_KEY` — the same shape endpoint secrets
 * already use, so the flow records where the key lives rather than what it is.
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

export interface AiStepConfig {
  readonly provider?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly prompt?: string
  readonly system?: string
  readonly apiKey?: string
  readonly maxTokens?: string | number
  readonly temperature?: string | number
}

/** What a later step reads. Flat on purpose. */
export interface AiStepOutput {
  readonly text: string
  readonly model: string
  readonly finishReason: string | null
  readonly usage: {
    readonly promptTokens: number | null
    readonly completionTokens: number | null
  }
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

    // A reference, not a key. `env:GROQ_API_KEY` is resolved here, at run
    // time, so the flow row never holds the credential.
    const keyRef = (config.apiKey ?? '').trim()
    if (keyRef === '') {
      throw new StepFailure(
        'the AI step has no apiKey; set it to a reference such as env:GROQ_API_KEY',
        { deterministicallyBroken: true },
      )
    }

    let apiKey: string
    try {
      apiKey = resolveSecret(parseSecretRef(keyRef), options.env ?? process.env)
    } catch (error) {
      // Deterministic: an unset variable will be unset on every retry, and the
      // message names which one rather than leaving a 401 to be interpreted.
      throw new StepFailure(
        error instanceof SecretResolutionError
          ? `the AI step's apiKey could not be resolved: ${error.message}`
          : `the AI step's apiKey is not a usable reference: ${String(error)}`,
        { deterministicallyBroken: true },
      )
    }

    const messages: { role: string; content: string }[] = []
    const system = (config.system ?? '').trim()
    if (system !== '') messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })

    // Built here rather than typed by hand, which is the point: the prompt is
    // a plain string and `JSON.stringify` escapes whatever is in it.
    const body = JSON.stringify({
      model,
      messages,
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

      return { output: toOutput(parsed, model) }
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
