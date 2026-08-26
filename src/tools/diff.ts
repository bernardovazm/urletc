import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

// Line-level diff via a classic LCS DP: pure, dependency-free, all local.
export type DiffTag = ' ' | '-' | '+'
export interface DiffLine {
  tag: DiffTag
  text: string
}

const MAX_LINES = 1500 // bounds the O(n*m) table (~2.25M cells) so the main thread stays responsive

export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i++] })
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ tag: '-', text: a[i++] })
    else out.push({ tag: '+', text: b[j++] })
  }
  while (i < n) out.push({ tag: '-', text: a[i++] })
  while (j < m) out.push({ tag: '+', text: b[j++] })
  return out
}

const CLASS: Record<DiffTag, string> = { '+': 'diff-add', '-': 'diff-del', ' ': 'diff-ctx' }

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const a = el('textarea', { placeholder: 'Original', rows: '6' }) as HTMLTextAreaElement
    const b = el('textarea', { placeholder: 'Changed', rows: '6' }) as HTMLTextAreaElement
    const stat = el('div', { class: 'muted small' })
    const out = el('pre', { class: 'diff muted', text: 'line diff appears here' })
    let plain = '' // block-per-line divs have no newlines in textContent; keep a copy-able version

    const run = () => {
      const la = a.value.split('\n')
      const lb = b.value.split('\n')
      if (la.length > MAX_LINES || lb.length > MAX_LINES) {
        out.classList.remove('muted')
        out.textContent = `Too many lines to diff (max ${MAX_LINES} per side).`
        return
      }
      const lines = diffLines(la, lb)
      plain = lines.map((l) => `${l.tag} ${l.text}`).join('\n')
      out.classList.remove('muted')
      out.replaceChildren(...lines.map((l) => el('div', { class: CLASS[l.tag], text: `${l.tag} ${l.text}` })))
      const add = lines.filter((l) => l.tag === '+').length
      const del = lines.filter((l) => l.tag === '-').length
      stat.textContent = add || del ? `+${add} added, -${del} removed` : 'Identical'
    }

    container.append(
      el('div', { class: 'muted small', text: 'Original' }),
      a,
      el('div', { class: 'muted small', text: 'Changed' }),
      b,
      el('div', { class: 'row' }, [button('Diff', run, 'primary'), copyButton(() => plain, ctx.clipboard.write)]),
      stat,
      out,
    )
  },
}

export default tool
