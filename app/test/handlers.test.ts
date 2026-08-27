import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { readPath, resolveConfig, resolveTemplate, scopeFor, withMapping } from '../src/handlers.ts'
import type { StepContext } from 'automa-durable-runner'

const scope = {
  steps: {
    fetch: { output: { email: 'sam@example.com', tier: 'premium', id: 42, orders: [{ total: 19.5 }] } },
    empty: { output: null },
  },
  trigger: { body: { event: 'invoice.paid', amount: 4200 } },
}

describe('reading a path', () => {
  test('follows dots and array indices', () => {
    assert.equal(readPath(scope, 'steps.fetch.output.email'), 'sam@example.com')
    assert.equal(readPath(scope, 'steps.fetch.output.orders[0].total'), 19.5)
    assert.equal(readPath(scope, 'trigger.body.amount'), 4200)
  })

  test('returns undefined rather than throwing on a missing path', () => {
    assert.equal(readPath(scope, 'steps.nope.output.x'), undefined)
    assert.equal(readPath(scope, 'steps.empty.output.x'), undefined)
    // Walking into a primitive is the case that throws if you are careless.
    assert.equal(readPath(scope, 'steps.fetch.output.email.length.nope'), undefined)
  })
})

describe('resolving a template', () => {
  test('substitutes a reference inside a larger string', () => {
    const result = resolveTemplate('mailto:{{ steps.fetch.output.email }}?tier={{ steps.fetch.output.tier }}', scope)
    assert.equal(result.value, 'mailto:sam@example.com?tier=premium')
    assert.deepEqual(result.missing, [])
  })

  test('tolerates whitespace inside the braces', () => {
    assert.equal(resolveTemplate('{{steps.fetch.output.tier}}', scope).value, 'premium')
    assert.equal(resolveTemplate('{{   steps.fetch.output.tier   }}', scope).value, 'premium')
  })

  test('leaves an unresolved reference visible instead of blanking it', () => {
    const result = resolveTemplate('https://api.example.com/c/{{ steps.fetch.output.missing }}', scope)
    assert.match(result.value, /\{\{ steps\.fetch\.output\.missing \}\}/)
    assert.deepEqual(result.missing, ['steps.fetch.output.missing'])
  })

  test('a string with no reference is returned unchanged', () => {
    assert.equal(resolveTemplate('https://example.com/plain', scope).value, 'https://example.com/plain')
  })
})

describe('resolving a config', () => {
  test('a field that is one whole reference keeps the referenced type', () => {
    const { config, missing } = resolveConfig({ body: '{{ steps.fetch.output.orders }}' }, scope)
    assert.deepEqual(missing, [])
    assert.deepEqual(config['body'], [{ total: 19.5 }], 'an object body must not become "[object Object]"')
  })

  test('a reference inside a longer string is stringified', () => {
    const { config } = resolveConfig({ url: 'https://x.test/{{ steps.fetch.output.id }}' }, scope)
    assert.equal(config['url'], 'https://x.test/42')
  })

  test('recurses into headers and arrays', () => {
    const { config } = resolveConfig(
      {
        headers: { 'X-Tier': '{{ steps.fetch.output.tier }}' },
        tags: ['{{ steps.fetch.output.id }}', 'static'],
      },
      scope,
    )
    assert.deepEqual(config['headers'], { 'X-Tier': 'premium' })
    assert.deepEqual(config['tags'], [42, 'static'])
  })

  test('collects every missing reference, not just the first', () => {
    const { missing } = resolveConfig(
      { url: '{{ a.b }}', headers: { x: '{{ c.d }}' } },
      scope,
    )
    assert.deepEqual(missing.sort(), ['a.b', 'c.d'])
  })

  test('leaves non-strings alone', () => {
    const { config } = resolveConfig({ retries: 3, enabled: true, nothing: null }, scope)
    assert.deepEqual(config, { retries: 3, enabled: true, nothing: null })
  })
})

describe('the scope a step resolves against', () => {
  const context = {
    run: { input: { event: 'invoice.paid' } },
    upstream: { fetch: { email: 'sam@example.com' } },
  } as unknown as StepContext

  test('nests upstream outputs under .output, matching the editor', () => {
    const built = scopeFor(context)
    assert.equal(readPath(built, 'steps.fetch.output.email'), 'sam@example.com')
  })

  test('exposes the payload the run started with', () => {
    assert.equal(readPath(scopeFor(context), 'trigger.body.event'), 'invoice.paid')
  })
})

describe('a handler wrapped for mapping', () => {
  const context = (config: Record<string, unknown>) =>
    ({
      run: { input: { amount: 4200 } },
      upstream: { fetch: { id: 7 } },
      node: { id: 'call', kind: 'http', idempotent: true, config },
    }) as unknown as StepContext

  test('the handler sees resolved config', async () => {
    let seen: unknown
    const wrapped = withMapping(async (ctx) => {
      seen = ctx.node.config
      return {}
    })
    await wrapped(context({ url: 'https://x.test/{{ steps.fetch.output.id }}' }))
    assert.deepEqual(seen, { url: 'https://x.test/7' })
  })

  test('does not mutate the flow definition it was given', async () => {
    // The engine holds one flow definition for the life of the worker. Writing
    // resolved values back into it would leave the first run's data in place
    // for every run after it.
    const config = { url: 'https://x.test/{{ steps.fetch.output.id }}' }
    const wrapped = withMapping(async () => ({}))
    await wrapped(context(config))
    assert.equal(config.url, 'https://x.test/{{ steps.fetch.output.id }}')
  })

  test('fails the step rather than requesting a URL with braces in it', async () => {
    const wrapped = withMapping(async () => {
      throw new Error('the handler must not be reached')
    })
    await assert.rejects(
      () => wrapped(context({ url: 'https://x.test/{{ steps.gone.output.id }}' })),
      /unresolved reference: steps\.gone\.output\.id/,
    )
  })

  test('a step with no config at all still runs', async () => {
    const wrapped = withMapping(async () => ({ output: 'ok' }))
    const result = await wrapped({
      run: { input: null },
      upstream: {},
      node: { id: 'n', kind: 'noop', idempotent: true },
    } as unknown as StepContext)
    assert.deepEqual(result, { output: 'ok' })
  })
})
