import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el, toast } from '../shell/ui'

export interface TextStats {
  chars: number
  charsNoSpaces: number
  words: number
  lines: number
  sentences: number
}

export function textStats(s: string): TextStats {
  return {
    chars: s.length,
    charsNoSpaces: s.replace(/\s/g, '').length,
    words: (s.match(/\S+/g) ?? []).length,
    lines: s ? s.split(/\r\n|\r|\n/).length : 0,
    sentences: (s.match(/[.!?]+(\s|$)/g) ?? []).length,
  }
}

const titleCase = (s: string) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('textarea', { placeholder: 'Paste or type text' }) as HTMLTextAreaElement
    const stats = el('div', { class: 'muted' })
    const out = el('pre', { text: '' })

    const showStats = () => {
      const s = textStats(input.value)
      stats.textContent = `${s.words} words, ${s.chars} chars (${s.charsNoSpaces} without spaces), ${s.lines} lines, ${s.sentences} sentences`
    }
    input.addEventListener('input', showStats)

    // A transform copies its own result, so a case change is one click, not two.
    const transform = (fn: (s: string) => string) => {
      const result = fn(input.value)
      out.textContent = result
      void ctx.clipboard
        .write(result)
        .then(() => toast('Transformed & copied'))
        .catch(() => toast('Transformed, but the copy was blocked'))
    }

    // NLP via compromise, lazy-loaded only when used (keeps the base bundle small).
    const nlp = async () => {
      out.textContent = 'Analyzing...'
      try {
        const { default: nlp } = await import('compromise')
        const doc = nlp(input.value)
        out.textContent = JSON.stringify(
          {
            people: doc.people().out('array'),
            places: doc.places().out('array'),
            organizations: doc.organizations().out('array'),
          },
          null,
          2,
        )
      } catch (e) {
        out.textContent = `NLP failed: ${(e as Error).message}`
      }
    }

    container.append(
      input,
      stats,
      el('div', { class: 'row' }, [
        button('UPPER', () => transform((s) => s.toUpperCase()), 'ghost', 'Uppercase + copy'),
        button('lower', () => transform((s) => s.toLowerCase()), 'ghost', 'Lowercase + copy'),
        button('Title', () => transform(titleCase), 'ghost', 'Title Case + copy'),
        button(
          'Trim lines',
          () =>
            transform((s) =>
              s
                .split('\n')
                .map((l) => l.trim())
                .join('\n'),
            ),
          'ghost',
          'Trim each line + copy',
        ),
        button('Entities', () => void nlp(), 'ghost', 'Extract people, places and organizations'),
        copyButton(() => out.textContent ?? '', ctx.clipboard.write, 'Copy', 'ghost'),
      ]),
      out,
    )
    showStats()
  },
}

export default tool
