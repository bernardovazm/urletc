// Shared, framework-free UI primitives (ARCHITECTURE section 10). All DOM is built
// with createElement + textContent, never innerHTML from untrusted strings (Trusted
// Types is enforced via CSP). DOMPurify is used only where trusted HTML must be
// rendered, in the clipboard tool.

import type { TrustTier } from './registry'

type Attrs = Record<string, unknown>

/** Hyperscript helper. `text` sets textContent; `on*` adds a listener. */
export function el(tag: string, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    if (k === 'class') node.className = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else {
      node.setAttribute(k, String(v))
    }
  }
  for (const c of children) node.append(c)
  return node
}

export function button(label: string, onClick: () => void, cls = '', title?: string): HTMLElement {
  const attrs: Attrs = { class: cls, text: label, onClick, title }
  // Icon buttons are emoji/glyph-only, so mirror the title into an accessible name.
  // Otherwise a screen reader announces the raw glyph. Text buttons keep their visible
  // label as the accessible name (WCAG 2.5.3, label-in-name).
  if (title && /\bicon\b/.test(cls)) attrs['aria-label'] = title
  return el('button', attrs)
}

export function toast(message: string, ms = 2500): void {
  const host = document.getElementById('toasts')
  if (!host) return
  const t = el('div', { class: 'toast', text: message })
  host.append(t)
  window.setTimeout(() => t.remove(), ms)
}

/**
 * Write text to the clipboard and toast the outcome. `write` defaults to the raw
 * navigator API; tools pass their permission-gated `ctx.clipboard.write` so the
 * same feedback path serves both host chrome and sandboxed capability facades.
 */
export async function copyText(text: string, write: (t: string) => Promise<void> = (t) => navigator.clipboard.writeText(t)): Promise<boolean> {
  try {
    await write(text)
    toast('Copied')
    return true
  } catch {
    toast('Copy blocked')
    return false
  }
}

/** A "Copy" button wired to {@link copyText}. `get` is read at click time. */
export function copyButton(get: () => string, write?: (t: string) => Promise<void>, label = 'Copy', cls = 'ghost'): HTMLElement {
  return button(label, () => void copyText(get(), write), cls, 'Copy to clipboard')
}

// Classes must match tokens.css (.badge.ok/.warn/.danger); the color is the trust signal.
const TIER_LABEL: Record<TrustTier, [string, string]> = {
  builtin: ['ok', 'built-in'],
  trusted: ['ok', 'peer-vouched'],
  self: ['warn', 'self-authored'],
  unverified: ['warn', 'unverified'],
  unsigned: ['danger', 'unsigned'],
}

export function badge(tier: TrustTier): HTMLElement {
  const [cls, label] = TIER_LABEL[tier]
  return el('span', { class: `badge ${cls}`, text: label })
}

export interface ConsentOptions {
  title: string
  version?: string
  author?: string
  hash?: string
  tier?: TrustTier
  permissions: string[]
  source?: string // full source / rules, shown expandable
  runLabel?: string
}

/**
 * The never-autorun consent gate (ARCHITECTURE sections 7, 8 and D5). Resolves true
 * only on an explicit Run click. The user always sees declared capabilities and, for
 * code, the full source before choosing. No "remember / auto-approve".
 */
export function consent(o: ConsentOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null
    const back = el('div', { class: 'modal-back' })
    const close = (v: boolean) => {
      back.remove()
      document.removeEventListener('keydown', onKey)
      prevFocus?.focus?.()
      resolve(v)
    }
    // Escape cancels; Tab is trapped inside the dialog so focus can't wander to the
    // page behind this security gate.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close(false)
        return
      }
      if (e.key !== 'Tab') return
      const f = modal.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)

    const head = el('div', { class: 'row' }, [el('strong', { text: `⚠ ${o.title}` })])
    if (o.version) head.append(el('span', { class: 'muted', text: `v${o.version}` }))
    if (o.tier) head.append(badge(o.tier))

    const perms = el('ul', {}, o.permissions.length ? o.permissions.map((p) => el('li', { text: p })) : [el('li', { class: 'muted', text: 'none' })])

    const body: (Node | string)[] = [head]
    if (o.author) body.push(el('div', { class: 'muted', text: `by ${o.author}` }))
    if (o.hash) body.push(el('div', { class: 'muted', text: `SHA-256: ${o.hash}` }))
    body.push(el('div', { text: 'Capabilities requested:' }), perms)
    if (o.source != null) {
      body.push(el('details', {}, [el('summary', { text: 'Source' }), el('pre', { text: o.source })]))
    }
    const runBtn = button(o.runLabel ?? 'Run once', () => close(true), 'primary')
    body.push(el('div', { class: 'row' }, [el('span', { class: 'spacer' }), button('Cancel', () => close(false)), runBtn]))

    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Consent required: ${o.title}` }, body)
    back.append(modal)
    back.addEventListener('click', (e) => {
      if (e.target === back) close(false)
    })
    document.body.append(back)
    runBtn.focus()
  })
}
