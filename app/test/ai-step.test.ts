/**
 * The AI step.
 *
 * No provider is called. What is worth testing is the shape of the request it
 * builds and the shape of the answer it hands on — those are the step's two
 * contracts, and both were the reason it exists rather than an HTTP step.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { aiHandler, resolveBaseUrl, toOutput, PROVIDERS } from '../src/steps/ai.ts'
import type { StepContext } from 'automa-durable-runner'

const context = (config: Record<string, unknown>): StepContext =>
  ({
    run: { input: {} },
    step: {},
    node: { id: 'ai', kind: 'ai', config },
    idempotencyKey: 'idem-1',
    upstream: {},
    signal: new AbortController().signal,
    deadlineMs: 5000,
  }) as unknown as StepContext

/** A stand-in provider that records what it was sent and answers plausibly. */
function recorder(reply: unknown = { choices: [{ message: { content: 'a summary' } }] }) {
  const calls: { url: string; init: Record<string, unknown> }[] = []
  const safeFetch = (async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(reply),
      headers: new Map(),
    }
  }) as never
  return { calls, safeFetch }
}

describe('the request it builds', () => {
  it('escapes the prompt, which is the whole point of not using an HTTP step', async () => {
    // Written by hand, this prompt would break the JSON document it sits in —
    // and a webhook payload is exactly the kind of text that contains a quote.
    const nasty = 'He said "hello" and then\na newline, plus a backslash \\'
    const { calls, safeFetch } = recorder()

    await aiHandler({ safeFetch, env: { KEY: 'k' } })(
      context({ prompt: nasty, model: 'm', apiKey: 'env:KEY' }),
    )

    const sent = JSON.parse(String(calls[0]!.init['body'])) as {
      messages: { role: string; content: string }[]
    }
    assert.equal(sent.messages[0]!.content, nasty, 'the prompt survives verbatim')
  })

  it('sends the key from the reference, and not the reference', async () => {
    const { calls, safeFetch } = recorder()
    await aiHandler({ safeFetch, env: { GROQ_API_KEY: 'gsk_secret' } })(
      context({ prompt: 'p', model: 'm', apiKey: 'env:GROQ_API_KEY' }),
    )
    const headers = calls[0]!.init['headers'] as Record<string, string>
    assert.equal(headers['authorization'], 'Bearer gsk_secret')
  })

  it('puts a system message before the prompt, and omits it when empty', async () => {
    const { calls, safeFetch } = recorder()
    const handler = aiHandler({ safeFetch, env: { KEY: 'k' } })

    await handler(context({ prompt: 'p', model: 'm', apiKey: 'env:KEY', system: 'be terse' }))
    let sent = JSON.parse(String(calls[0]!.init['body'])) as { messages: { role: string }[] }
    assert.deepEqual(
      sent.messages.map((m) => m.role),
      ['system', 'user'],
    )

    await handler(context({ prompt: 'p', model: 'm', apiKey: 'env:KEY', system: '   ' }))
    sent = JSON.parse(String(calls[1]!.init['body'])) as { messages: { role: string }[] }
    assert.deepEqual(
      sent.messages.map((m) => m.role),
      ['user'],
    )
  })

  it('omits the optional numbers rather than sending defaults of its own', async () => {
    const { calls, safeFetch } = recorder()
    await aiHandler({ safeFetch, env: { KEY: 'k' } })(
      context({ prompt: 'p', model: 'm', apiKey: 'env:KEY' }),
    )
    const sent = JSON.parse(String(calls[0]!.init['body'])) as Record<string, unknown>
    assert.equal('max_tokens' in sent, false)
    assert.equal('temperature' in sent, false)
  })

  it('accepts numbers typed as text, because a form field is text', async () => {
    const { calls, safeFetch } = recorder()
    await aiHandler({ safeFetch, env: { KEY: 'k' } })(
      context({ prompt: 'p', model: 'm', apiKey: 'env:KEY', maxTokens: '256', temperature: '0' }),
    )
    const sent = JSON.parse(String(calls[0]!.init['body'])) as Record<string, unknown>
    assert.equal(sent['max_tokens'], 256)
    assert.equal(sent['temperature'], 0)
  })
})

describe('what it refuses, once, rather than retrying', () => {
  const handler = () => aiHandler({ safeFetch: recorder().safeFetch, env: { KEY: 'k' } })

  it('needs a prompt, a model and a key', async () => {
    await assert.rejects(() => handler()(context({ model: 'm', apiKey: 'env:KEY' })), /no prompt/)
    await assert.rejects(() => handler()(context({ prompt: 'p', apiKey: 'env:KEY' })), /no model/)
    await assert.rejects(() => handler()(context({ prompt: 'p', model: 'm' })), /no apiKey/)
  })

  it('names the variable when the key reference cannot be resolved', async () => {
    // Rather than sending an empty Bearer and leaving a 401 to be interpreted.
    await assert.rejects(
      () =>
        aiHandler({ safeFetch: recorder().safeFetch, env: {} })(
          context({ prompt: 'p', model: 'm', apiKey: 'env:MISSING_KEY' }),
        ),
      /MISSING_KEY/,
    )
  })

  it('refuses a non-numeric limit instead of coercing it', async () => {
    await assert.rejects(
      () => handler()(context({ prompt: 'p', model: 'm', apiKey: 'env:KEY', maxTokens: 'lots' })),
      /maxTokens must be a number/,
    )
  })
})

describe('the base URL', () => {
  it('knows the providers worth not looking up', () => {
    assert.equal(resolveBaseUrl({ provider: 'groq' }), PROVIDERS['groq'])
    assert.equal(resolveBaseUrl({}), PROVIDERS['groq'], 'groq is the default')
    assert.equal(resolveBaseUrl({ provider: 'GEMINI' }), PROVIDERS['gemini'], 'case-insensitive')
  })

  it('lets an explicit baseUrl win, for anything not listed', () => {
    assert.equal(
      resolveBaseUrl({ provider: 'groq', baseUrl: 'http://127.0.0.1:11434/v1/' }),
      'http://127.0.0.1:11434/v1',
      'and the trailing slash goes, so the path join cannot double up',
    )
  })

  it('refuses a provider it does not know', () => {
    assert.throws(() => resolveBaseUrl({ provider: 'nope' }), /unknown provider/)
  })
})

describe('the answer it hands on', () => {
  it('flattens the envelope so a later step reads output.text', () => {
    const out = toOutput(
      {
        model: 'llama-3.1-8b-instant',
        choices: [{ message: { content: 'one sentence' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      },
      'asked-for',
    )
    assert.equal(out.text, 'one sentence')
    assert.equal(out.model, 'llama-3.1-8b-instant', 'the model that answered, not the one asked for')
    assert.equal(out.finishReason, 'stop')
    assert.deepEqual(out.usage, { promptTokens: 12, completionTokens: 5 })
  })

  it('falls back to the requested model when the reply omits it', () => {
    assert.equal(toOutput({ choices: [{ message: { content: 'x' } }] }, 'asked-for').model, 'asked-for')
  })

  it('reports missing usage as null rather than zero', () => {
    // Zero tokens is a fact; not knowing is not. Reporting the second as the
    // first would make a cost report quietly wrong.
    const out = toOutput({ choices: [{ message: { content: 'x' } }] }, 'm')
    assert.deepEqual(out.usage, { promptTokens: null, completionTokens: null })
  })

  it('fails on a well-formed reply with no content', () => {
    // Otherwise a later step maps an empty string into an email and the run
    // reports success having sent a blank message.
    assert.throws(() => toOutput({ choices: [] }, 'm'), /no message content/)
    assert.throws(() => toOutput({ choices: [{ message: {} }] }, 'm'), /no message content/)
    assert.throws(() => toOutput({}, 'm'), /no message content/)
  })
})
