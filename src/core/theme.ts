/**
 * Light or dark. Nothing else.
 *
 * There is no "follow the system" state: the choice is always explicit and
 * always stamped on the root element. The system is consulted exactly once —
 * for the very first visit, when there is no stored preference and guessing
 * light would be wrong half the time — and never again.
 */

const STORAGE_KEY = 'automa-flow-canvas:theme'

export type Theme = 'light' | 'dark'

export function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Private mode, or storage disabled. The system's current setting is a
    // better first guess than a hard-coded one.
  }
  return systemTheme()
}

export function applyTheme(theme: Theme): void {
  // Always stamped, never removed. With no system state there is nothing for an
  // absent attribute to mean, and leaving it off would hand control back to
  // prefers-color-scheme — which is the behaviour this deliberately drops.
  document.documentElement.setAttribute('data-theme', theme)

  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // The theme still applies for this session; it just will not persist.
  }
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light'
}

/** What the button will do, not what is currently on — a control labelled with
 *  its own current state reads as a status and gets left alone. */
export function themeLabel(theme: Theme): string {
  return theme === 'light' ? 'Switch to dark' : 'Switch to light'
}

export function themeGlyph(theme: Theme): string {
  return theme === 'light' ? '☾' : '☀'
}
