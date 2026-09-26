import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el, toast } from '../shell/ui'
import { JsonPrecisionError, parseJson } from './json-lossless'

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('textarea', { placeholder: 'Paste JSON' }) as HTMLTextAreaElement
    const out = el('pre', { class: 'muted', text: 'output' })

    const run = (indent: number) => {
      try {
        const parsed = parseJson(input.value)
        out.classList.remove('muted')
        out.textContent = JSON.stringify(parsed, null, indent)
      } catch (e) {
        out.classList.remove('muted')
        out.textContent = e instanceof JsonPrecisionError ? `Not reformatted: ${e.message}` : `Invalid JSON: ${(e as Error).message}`
      }
    }

    const paste = async () => {
      try {
        input.value = await ctx.clipboard.readText()
      } catch {
        toast('Clipboard read blocked')
      }
    }

    container.append(
      input,
      el('div', { class: 'row' }, [
        button('Format', () => run(2), 'primary'),
        button('Minify', () => run(0)),
        button('Paste from clipboard', paste),
        copyButton(() => out.textContent ?? '', ctx.clipboard.write),
      ]),
      out,
    )
  },
}

export default tool
