/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, because "follow the system" is a real choice
 * and not the absence of one: someone whose laptop switches at sunset wants the
 * editor to switch with it, and a two-way toggle silently takes that away the
 * first time it is pressed.
 *
 * The choice is applied by setting `data-theme` on the root element, or
 * removing it for system. The stylesheet does the rest — see the guarded media
 * query in app.css, which is what lets an explicit light beat a dark system
 * and the reverse.
 */

const STORAGE_KEY = 'automa-flow-canvas:theme'

export type Theme = 'light' | 'dark' | 'system'

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // Private mode, or storage disabled. Following the system is the right
    // fallback: it is what someone gets before they have ever chosen.
    return 'system'
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)

  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // The theme still applies for this session; it just will not persist.
  }
}

/** What the machine currently says, for labelling the system option. */
export function systemTheme(): 'light' | 'dark' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/**
 * The next state in the cycle.
 *
 * Light → dark → system → light. System sits last so that pressing the button
 * twice from a fresh start lands somewhere explicit rather than back where it
 * began, which is what someone reaching for it usually wants.
 */
export function nextTheme(theme: Theme): Theme {
  if (theme === 'light') return 'dark'
  if (theme === 'dark') return 'system'
  return 'light'
}

export function themeLabel(theme: Theme): string {
  if (theme === 'light') return 'Light'
  if (theme === 'dark') return 'Dark'
  return `System (${systemTheme()})`
}

export function themeGlyph(theme: Theme): string {
  if (theme === 'light') return '☀'
  if (theme === 'dark') return '☾'
  return '◐'
}
