// Monochrome theme: dark default, light toggle. Persisted in localStorage (not
// sensitive, and we want it applied synchronously before paint).

export type Theme = 'dark' | 'light'
const KEY = 'wt-theme'

export function currentTheme(): Theme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

export function applyTheme(t: Theme = currentTheme()): void {
  document.documentElement.setAttribute('data-theme', t)
  // Canvas tools paint with raw colours and cannot inherit a CSS variable, so they
  // re-resolve the palette on this event instead of hardcoding one theme's values.
  window.dispatchEvent(new CustomEvent('wt:theme', { detail: t }))
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  localStorage.setItem(KEY, next)
  applyTheme(next)
  return next
}
