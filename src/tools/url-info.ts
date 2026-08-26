import type { ToolContext, ToolModule } from '../shell/registry'
import { button, el, toast } from '../shell/ui'

export interface UrlPart {
  label: string
  value: string
}

export function parseUrl(input: string): UrlPart[] | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  const parts: UrlPart[] = [
    { label: 'protocol', value: u.protocol },
    { label: 'host', value: u.host },
    { label: 'hostname', value: u.hostname },
    { label: 'port', value: u.port || '(default)' },
    { label: 'path', value: u.pathname },
    { label: 'hash', value: u.hash || '(none)' },
  ]
  for (const [k, v] of u.searchParams) parts.push({ label: `query ${k}`, value: v })
  return parts
}

function renderParts(parts: UrlPart[]): HTMLElement {
  const box = el('div', { class: 'stack' })
  for (const p of parts) {
    box.append(el('div', { class: 'row' }, [el('span', { class: 'muted', text: `${p.label}:` }), el('span', { text: p.value })]))
  }
  return box
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('input', { type: 'text', class: 'full', placeholder: 'https://example.com/path?q=1' }) as HTMLInputElement
    const out = el('div')

    const render = () => {
      const parts = parseUrl(input.value)
      out.replaceChildren(parts ? renderParts(parts) : el('div', { class: 'muted', text: 'Not a valid URL' }))
    }
    const copyDecoded = async () => {
      try {
        await ctx.clipboard.write(decodeURIComponent(input.value.trim()))
        toast('Copied decoded URL')
      } catch {
        toast('Copy blocked or malformed')
      }
    }

    container.append(
      input,
      el('div', { class: 'row' }, [button('Parse', render, 'primary'), button('Copy decoded', copyDecoded)]),
      el('p', { class: 'muted', text: 'Manual only. The app never auto-fetches URLs from your clipboard.' }),
      out,
    )
  },
}

export default tool
