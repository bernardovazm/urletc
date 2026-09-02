import type { ToolContext, ToolModule } from '../shell/registry'
import { toHex } from '../core/crypto'
import { button, copyButton, el } from '../shell/ui'

// SHA family via native WebCrypto: text or file bytes, all on-device.
const ALGOS = ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'] as const

async function digestHex(algo: string, data: BufferSource): Promise<string> {
  return toHex(await crypto.subtle.digest(algo, data))
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const algoSel = el('select', { title: 'Hash algorithm' }) as HTMLSelectElement
    algoSel.append(...ALGOS.map((a) => el('option', { value: a, text: a })))
    const input = el('textarea', { placeholder: 'Text to hash' }) as HTMLTextAreaElement
    const fileInput = el('input', { type: 'file', class: 'hidden' }) as HTMLInputElement
    const out = el('pre', { class: 'muted', text: 'hex digest' })
    let source: 'text' | 'file' | null = null // file bytes aren't retained; only re-hash text on algo change

    const show = (hex: string, from: 'text' | 'file') => {
      source = from
      out.classList.remove('muted')
      out.textContent = hex
    }
    const hashText = async () => show(await digestHex(algoSel.value, new TextEncoder().encode(input.value)), 'text')

    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0]
      fileInput.value = ''
      if (!f) return
      void (async () => {
        out.classList.remove('muted')
        out.textContent = `Hashing ${f.name}...`
        try {
          show(await digestHex(algoSel.value, new Uint8Array(await f.arrayBuffer())), 'file')
        } catch (e) {
          out.textContent = `Failed: ${(e as Error).message}`
        }
      })()
    })
    algoSel.addEventListener('change', () => {
      if (source === 'text') void hashText()
    })

    container.append(
      el('div', { class: 'row' }, [el('label', { class: 'row' }, [el('span', { text: 'Algorithm' }), algoSel])]),
      input,
      el('div', { class: 'row' }, [
        button('Hash text', () => void hashText(), 'primary'),
        button('Hash a file', () => fileInput.click(), 'ghost', 'Hash the bytes of a file on-device'),
        copyButton(() => out.textContent ?? '', ctx.clipboard.write),
      ]),
      fileInput,
      out,
    )
  },
}

export default tool
