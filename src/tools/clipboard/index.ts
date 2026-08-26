import { detectItems, detectText, kindLabel, type Detected } from '../../core/clipboard'
import type { ToolContext, ToolModule } from '../../shell/registry'
import { button, copyButton, el } from '../../shell/ui'

// The clipboard router, the single-user centerpiece (ARCHITECTURE section 4.1). On
// activation it tries a permission-gated read, which succeeds on Chromium once granted;
// it always registers a paste listener as the universal zero-prompt fallback, and offers
// a Scan clipboard button. Detected content is routed to type-appropriate actions.
// Focus re-scan is DEFAULT OFF, and the choice persists in the tool's own storage
// namespace. URLs are never auto-fetched.

// Per-card listener cleanup, keyed by container: launchTool shares one cached module
// across open cards, so a module-level array would let one card's deactivate remove
// another card's document/window listeners (and leave it non-functional).
const cleanups = new WeakMap<HTMLElement, Array<() => void>>()

const WATCH_KEY = 'watch-on-focus'

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    const local: Array<() => void> = []
    cleanups.set(container, local)
    const status = el('div', { class: 'muted' })
    const results = el('div', { class: 'stack' })
    // Focus re-scan is a persisted preference, OFF until asked for: it re-reads the
    // clipboard unattended. The DOM default was already unchecked; it LOOKED enabled
    // because the document declared no `color-scheme`, so an OS set to light painted the
    // unchecked box as a solid white square on this near-black page. tokens.css now
    // pins the control scheme to the app theme. A storage failure keeps it off.
    const watch = el('input', { type: 'checkbox' }) as HTMLInputElement
    try {
      watch.checked = (await ctx.storage.get<boolean>(WATCH_KEY)) ?? false
    } catch {
      watch.checked = false
    }
    watch.addEventListener('change', () => {
      void ctx.storage.set(WATCH_KEY, watch.checked).catch(() => ctx.toast('Could not save that preference'))
    })

    const render = (items: Detected[]) => {
      results.replaceChildren(...items.map((d) => renderItem(d, ctx)))
      status.textContent = items.length ? '' : 'Clipboard is empty or holds an unsupported type.'
    }

    const scan = async () => {
      status.textContent = 'Reading clipboard...'
      try {
        render(await detectItems(await ctx.clipboard.read()))
      } catch {
        status.textContent = 'Clipboard read blocked. Press Ctrl/Cmd+V to paste here, or click Scan clipboard.'
      }
    }

    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      e.preventDefault()
      void handlePaste(e.clipboardData).then(render)
    }
    document.addEventListener('paste', onPaste)
    local.push(() => document.removeEventListener('paste', onPaste))

    const onFocus = () => {
      if (watch.checked) void scan()
    }
    window.addEventListener('focus', onFocus)
    local.push(() => window.removeEventListener('focus', onFocus))

    container.append(
      el('div', { class: 'row' }, [
        button('Scan clipboard', () => void scan(), 'primary'),
        el('label', { class: 'row' }, [watch, el('span', { text: 'Re-scan the clipboard when this tab regains focus' })]),
      ]),
      el('p', { class: 'muted', text: 'Auto-reads on supported browsers once permission is granted; otherwise paste or scan.' }),
      status,
      results,
    )

    // Progressive auto-read: succeeds on Chromium with a prior grant, else falls back.
    await scan()
  },

  deactivate(container: HTMLElement) {
    for (const fn of cleanups.get(container) ?? []) fn()
    cleanups.delete(container)
  },
}

async function handlePaste(dt: DataTransfer): Promise<Detected[]> {
  const out: Detected[] = []
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i]
    if (f && f.type.startsWith('image/')) out.push({ kind: 'image', mime: f.type, blob: f })
  }
  if (out.length) return out
  const html = dt.getData('text/html')
  if (html) return [{ kind: 'html', mime: 'text/html', text: html }]
  return detectText(dt.getData('text/plain'))
}

function renderItem(d: Detected, ctx: ToolContext): HTMLElement {
  const card = el('div', { class: 'card stack' }, [el('strong', { text: kindLabel(d.kind) })])
  const body = el('div', { class: 'stack' })
  card.append(body)
  void buildActions(d, body, ctx)
  return card
}

async function buildActions(d: Detected, body: HTMLElement, ctx: ToolContext): Promise<void> {
  switch (d.kind) {
    case 'image': {
      const img = el('img', { class: 'preview', alt: 'clipboard image' }) as HTMLImageElement
      if (d.blob) {
        const u = URL.createObjectURL(d.blob)
        img.src = u
        img.onload = () => URL.revokeObjectURL(u)
        img.onerror = () => URL.revokeObjectURL(u) // revoke even if the image fails to decode
      }
      const out = el('pre', { class: 'muted', text: 'Run OCR to extract text' })
      const run = async () => {
        out.textContent = 'Loading OCR...'
        try {
          const { recognizeImage } = await import('../ocr')
          const { text } = await recognizeImage(d.blob as Blob, (p) => {
            out.textContent = `Recognizing... ${Math.round(p * 100)}%`
          })
          out.classList.remove('muted')
          out.textContent = text.trim() || '(no text found)'
        } catch (e) {
          out.textContent = `OCR failed: ${(e as Error).message}`
        }
      }
      body.append(img, el('div', { class: 'row' }, [button('Run OCR', () => void run(), 'primary'), copyButton(() => out.textContent ?? '', ctx.clipboard.write)]), out)
      break
    }
    case 'html': {
      const { stripHtml } = await import('../html-strip')
      const out = el('pre', { text: stripHtml(d.text ?? '') })
      body.append(el('div', { class: 'muted', text: 'Tags stripped:' }), out, el('div', { class: 'row' }, [copyButton(() => out.textContent ?? '', ctx.clipboard.write)]))
      break
    }
    case 'json': {
      let formatted = d.text ?? ''
      try {
        formatted = JSON.stringify(JSON.parse(d.text ?? ''), null, 2)
      } catch {
        /* leave as-is */
      }
      const out = el('pre', { text: formatted })
      body.append(out, el('div', { class: 'row' }, [copyButton(() => out.textContent ?? '', ctx.clipboard.write)]))
      break
    }
    case 'url': {
      const { parseUrl } = await import('../url-info')
      const parts = parseUrl(d.text ?? '')
      const box = el('div', { class: 'stack' })
      if (parts) {
        for (const p of parts) box.append(el('div', { class: 'row' }, [el('span', { class: 'muted', text: `${p.label}:` }), el('span', { text: p.value })]))
      }
      body.append(el('div', { class: 'muted', text: 'Parsed, never fetched:' }), box, el('div', { class: 'row' }, [copyButton(() => d.text ?? '', ctx.clipboard.write)]))
      break
    }
    case 'text': {
      const { textStats } = await import('../text-utils')
      const s = textStats(d.text ?? '')
      const out = el('pre', { text: d.text ?? '' })
      body.append(
        el('div', { class: 'muted', text: `${s.words} words, ${s.chars} chars, ${s.lines} lines` }),
        out,
        el('div', { class: 'row' }, [copyButton(() => d.text ?? '', ctx.clipboard.write)]),
      )
      break
    }
  }
}

export default tool
