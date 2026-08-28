/**
 * Light, dark, or the system.
 *
 * The failure this guards against is a toggle that works in one direction:
 * an explicit "light" that a dark system overrides, or an explicit "dark" that
 * a light system ignores. Both look fine on whichever machine they were built
 * on and are broken on the other.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { applyTheme, nextTheme, readTheme, themeLabel, type Theme } from '../src/core/theme.ts'

/** The two globals the module touches, replaced with something inspectable. */
function stubDom(prefersDark: boolean) {
  const attributes = new Map<string, string>()
  const store = new Map<string, string>()

  globalThis.document = {
    documentElement: {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null,
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

describe('applying a theme', () => {
  test('an explicit choice is stamped on the root', () => {
    const { attributes } = stubDom(true)
    applyTheme('light')
    assert.equal(attributes.get('data-theme'), 'light')
    applyTheme('dark')
    assert.equal(attributes.get('data-theme'), 'dark')
  })

  test('system removes the attribute rather than setting a third value', () => {
    // The stylesheet keys off the attribute being absent, so a value of
    // "system" would match nothing and leave the page on whatever was last set.
    const { attributes } = stubDom(false)
    applyTheme('dark')
    applyTheme('system')
    assert.equal(attributes.has('data-theme'), false)
  })

  test('an explicit choice survives a reload', () => {
    const { store } = stubDom(false)
    applyTheme('dark')
    assert.equal(store.get('automa-flow-canvas:theme'), 'dark')
    assert.equal(readTheme(), 'dark')
  })

  test('choosing system forgets the stored preference', () => {
    // Otherwise "follow the system" would only last until the next reload,
    // which is the one state where that is most obviously wrong.
    const { store } = stubDom(false)
    applyTheme('light')
    applyTheme('system')
    assert.equal(store.has('automa-flow-canvas:theme'), false)
    assert.equal(readTheme(), 'system')
  })

  test('an unset or corrupt preference reads as system', () => {
    const { store } = stubDom(false)
    assert.equal(readTheme(), 'system')
    store.set('automa-flow-canvas:theme', 'chartreuse')
    assert.equal(readTheme(), 'system')
  })
})

describe('cycling', () => {
  test('light, dark, system, and back', () => {
    const seen: Theme[] = []
    let current: Theme = 'light'
    for (let i = 0; i < 3; i++) {
      seen.push(current)
      current = nextTheme(current)
    }
    assert.deepEqual(seen, ['light', 'dark', 'system'])
    assert.equal(current, 'light')
  })

  test('two presses from system land somewhere explicit', () => {
    // System sits last on purpose: someone reaching for the button usually
    // wants a specific theme, not a round trip back to where they started.
    assert.equal(nextTheme(nextTheme('system')), 'dark')
  })
})

describe('the label', () => {
  test('names what the system currently is, not just that it is the system', () => {
    stubDom(true)
    assert.equal(themeLabel('system'), 'System (dark)')
    stubDom(false)
    assert.equal(themeLabel('system'), 'System (light)')
  })

  test('an explicit choice says only itself', () => {
    assert.equal(themeLabel('light'), 'Light')
    assert.equal(themeLabel('dark'), 'Dark')
  })
})
