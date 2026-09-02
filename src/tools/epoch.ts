import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyText, el } from '../shell/ui'

// Timestamp converter: epoch (s or ms), ISO 8601, local, UTC, relative. All local.

/** Parse an epoch number (s/ms auto-detected by magnitude) or any Date-parseable string. */
export function parseWhen(raw: string): Date | null {
  const t = raw.trim()
  if (!t) return null
  if (/^-?\d+$/.test(t)) {
    const n = Number(t)
    if (!Number.isFinite(n)) return null
    const d = new Date(Math.abs(n) >= 1e12 ? n : n * 1000) // >= 1e12 is already milliseconds
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [31_536_000_000, 'year'],
  [2_592_000_000, 'month'],
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
  [1000, 'second'],
]

export function relative(d: Date, now: number): string {
  const diff = d.getTime() - now
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [ms, unit] of UNITS) {
    if (Math.abs(diff) >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit)
  }
  return 'now'
}

const FIELDS: Array<{ label: string; get: (d: Date) => string }> = [
  { label: 'Epoch (s)', get: (d) => String(Math.floor(d.getTime() / 1000)) },
  { label: 'Epoch (ms)', get: (d) => String(d.getTime()) },
  { label: 'ISO 8601 (UTC)', get: (d) => d.toISOString() },
  { label: 'Local', get: (d) => d.toLocaleString() },
  { label: 'UTC', get: (d) => d.toUTCString() },
  { label: 'Relative', get: (d) => relative(d, Date.now()) },
]

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('input', { type: 'text', class: 'full mono-input', placeholder: 'Epoch or a date string' }) as HTMLInputElement
    const rows = FIELDS.map((f) => {
      const value = el('button', { class: 'gen-value', text: '-', title: 'Click to copy' })
      value.addEventListener('click', () => void copyText(value.textContent ?? '', ctx.clipboard.write))
      return { f, value, row: el('div', { class: 'gen-row' }, [el('span', { class: 'gen-label', text: f.label }), value]) }
    })

    const refresh = () => {
      const d = parseWhen(input.value)
      for (const { f, value } of rows) value.textContent = d ? f.get(d) : '-'
    }
    input.addEventListener('input', refresh)

    container.append(
      el('div', { class: 'row' }, [
        input,
        button(
          'Now',
          () => {
            input.value = String(Date.now())
            refresh()
          },
          'ghost',
          'Fill the current time',
        ),
      ]),
      ...rows.map((r) => r.row),
      el('div', { class: 'muted small', text: 'Numbers auto-detect seconds vs. milliseconds. Click any value to copy.' }),
    )
    input.value = String(Date.now())
    refresh()
  },
}

export default tool
