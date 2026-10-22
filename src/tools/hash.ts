import type { ToolContext, ToolModule } from '../shell/registry'
import { toHex } from '../core/crypto'
import { button, copyButton, el } from '../shell/ui'

// SHA family via native WebCrypto over text or file bytes, all on-device.
const ALGOS = ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'] as const
// WebCrypto has no streaming digest, so a file is read whole and then copied once more
// inside digest(); past this the tab runs out of memory rather than answering.
const HASH_FILE_MAX = 512 * 1024 * 1024

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
    let source: 'text' | 'file' | null = null // file bytes are not retained, so only text re-hashes on an algo change
    // Only the latest hash may answer: a slow file hash landing after the algorithm changed
    // showed a digest under the wrong name.
    let seq = 0

    const show = (hex: string, from: 'text' | 'file', my: number) => {
      if (my !== seq) return
      source = from
      out.classList.remove('muted')
      out.textContent = hex
    }
    const hashText = async () => {
      const my = ++seq
      show(await digestHex(algoSel.value, new TextEncoder().encode(input.value)), 'text', my)
    }

    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0]
      fileInput.value = ''
      if (!f) return
      const my = ++seq
      out.classList.remove('muted')
      if (f.size > HASH_FILE_MAX) {
        out.textContent = `${f.name} is too large to hash in the browser (limit ${HASH_FILE_MAX / 2 ** 20} MiB).`
        return
      }
      void (async () => {
        out.textContent = `Hashing ${f.name}...`
        try {
          show(await digestHex(algoSel.value, new Uint8Array(await f.arrayBuffer())), 'file', my)
        } catch (e) {
          if (my === seq) out.textContent = `Failed: ${(e as Error).message}`
        }
      })()
    })
    algoSel.addEventListener('change', () => {
      if (source === 'text') void hashText()
      else if (source === 'file' || out.textContent?.startsWith('Hashing ')) {
        seq++
        source = null
        out.classList.add('muted')
        out.textContent = 'Algorithm changed: pick the file again to hash it.'
      }
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
