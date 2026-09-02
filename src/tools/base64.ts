import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

// UTF-8 safe Base64 via TextEncoder/TextDecoder (btoa/atob are latin1-only).
function encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function decodeUtf8(b64: string): string {
  const bin = atob(b64.trim())
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('textarea', { placeholder: 'Text or Base64' }) as HTMLTextAreaElement
    const out = el('pre', { text: '' })

    const enc = () => {
      try {
        out.textContent = encodeUtf8(input.value)
      } catch (e) {
        out.textContent = `Error: ${(e as Error).message}`
      }
    }
    const dec = () => {
      try {
        out.textContent = decodeUtf8(input.value)
      } catch {
        out.textContent = 'Invalid Base64'
      }
    }

    container.append(
      input,
      el('div', { class: 'row' }, [button('Encode', enc, 'primary'), button('Decode', dec), copyButton(() => out.textContent ?? '', ctx.clipboard.write)]),
      out,
    )
  },
}

export default tool
