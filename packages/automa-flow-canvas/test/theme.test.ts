/**
 * Light or dark, and nothing in between.
 *
 * The state that used to exist here — "follow the system" — is gone, so the
 * thing worth testing changed with it. It is no longer that an explicit choice
 * beats the opposite system setting; it is that the choice is always explicit,
 * always written down, and never quietly handed back to the system.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { applyTheme, nextTheme, readTheme, systemTheme, themeLabel } from '../src/core/theme.ts'

function stubDom(prefersDark: boolean, stored?: string) {
  const attributes = new Map<string, string>()
  const store = new Map<string, string>()
  if (stored !== undefined) store.set('automa-flow-canvas:theme', stored)

  globalThis.document = {
    documentElement: {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    },
  } as unknown as Document

  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as unknown as Storage

  globalThis.matchMedia = ((query: string) => ({
    matches: prefersDark && query.includes('dark'),
  })) as unknown as typeof matchMedia

  return { attributes, store }
}

beforeEach(() => stubDom(false))

describe('choosing a theme', () => {
  test('the attribute is always set, never removed', () => {
    // With no system state there is nothing an absent attribute could mean, and
    // leaving it off would hand control back to prefers-color-scheme — the
    // behaviour this deliberately drops.
    const { attributes } = stubDom(true)
    applyTheme('light')
    assert.equal(attributes.get('data-theme'), 'light')
    applyTheme('dark')
    assert.equal(attributes.get('data-theme'), 'dark')
  })

  test('the choice survives a reload', () => {
    const { store } = stubDom(true)
    applyTheme('light')
    assert.equal(store.get('automa-flow-canvas:theme'), 'light')
    assert.equal(readTheme(), 'light')
  })

  test('a stored choice wins over the system', () => {
    // The whole point of dropping the system state: a dark machine must not
    // override someone who asked for light.
    stubDom(true, 'light')
    assert.equal(readTheme(), 'light')
    stubDom(false, 'dark')
    assert.equal(readTheme(), 'dark')
  })

  test('the system decides only the very first visit', () => {
    stubDom(true)
    assert.equal(readTheme(), 'dark')
    stubDom(false)
    assert.equal(readTheme(), 'light')
  })

  test('a corrupt stored value falls back to the system rather than to nothing', () => {
    stubDom(true, 'chartreuse')
    assert.equal(readTheme(), 'dark')
  })
})

describe('the toggle', () => {
  test('flips, and only flips', () => {
    assert.equal(nextTheme('light'), 'dark')
    assert.equal(nextTheme('dark'), 'light')
    assert.equal(nextTheme(nextTheme('light')), 'light')
  })

  test('is labelled with what it will do, not what is on', () => {
    // A control labelled with its own current state reads as a status and gets
    // left alone.
    assert.equal(themeLabel('light'), 'Switch to dark')
    assert.equal(themeLabel('dark'), 'Switch to light')
  })
})

describe('reading the system', () => {
  test('reports what the machine says', () => {
    stubDom(true)
    assert.equal(systemTheme(), 'dark')
    stubDom(false)
    assert.equal(systemTheme(), 'light')
  })
})
