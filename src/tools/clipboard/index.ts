import { detectItems, detectText, kindLabel, type Detected } from '../../core/clipboard'
import { OCR_MODE_EVENT, getOcrMode, setOcrMode } from '../../core/prefs'
import type { ToolContext, ToolModule } from '../../shell/registry'
import { button, copyButton, el } from '../../shell/ui'

// The clipboard router (ARCHITECTURE section 4.1). On activation it tries a
// permission-gated read, which succeeds on Chromium once granted; it always registers a
// paste listener as the zero-prompt fallback, and offers a Scan clipboard button. Detected
// content is routed to type-appropriate actions. Focus re-scan defaults on and the choice
// persists in the tool's own storage namespace. URLs are never auto-fetched.

// Per-card listener cleanup, keyed by container. launchTool shares one cached module
// across open cards, so a module-level array would let one card's deactivate remove
// another card's document and window listeners, leaving it non-functional.
const cleanups = new WeakMap<HTMLElement, Array<() => void>>()

const WATCH_KEY = 'watch-on-focus'

/**
 * Detected clipboard content, only where clipboard-read is already granted.
 *
 * Every other outcome returns an empty array: no Permissions API or no 'clipboard-read'
 * descriptor (Safari), state 'prompt' or 'denied', a rejected read, an empty clipboard. It
 * never throws and never logs, so a caller may run it on load without firing a permission
 * prompt from nothing more than the page loading, and without an error card or a console
 * line. State 'prompt' counts as "no", because a prompt the user did not ask for is worse
 * than the missing feature.
 *
 * `read` is injected so a tool passes its permission-gated facade (ctx.clipboard.read)
 * and the console, which has no ToolContext, gets the navigator default.
 */
export async function readClipboardIfGranted(read: () => Promise<ClipboardItem[]> = () => navigator.clipboard.read()): Promise<Detected[]> {
  try {
    if (!navigator.clipboard?.read || !navigator.permissions?.query) return []
    // 'clipboard-read' is not in lib.dom's PermissionName union, hence the descriptor cast.
    const status = await navigator.permissions.query({ name: 'clipboard-read' } as unknown as PermissionDescriptor)
    if (status.state !== 'granted') return []
    return await detectItems(await read())
  } catch {
    return []
  }
}

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    const local: Array<() => void> = []
    cleanups.set(container, local)
    const status = el('div', { class: 'muted' })
    const results = el('div', { class: 'stack' })
    // Focus re-scan is a persisted preference, on by default, since routing whatever is
    // on the clipboard is what this card is for. It used to default off because the
    // unchecked box looked enabled: the document declared no `color-scheme`, so an OS set
    // to light painted the unchecked box as a solid white square on this near-black page.
    // tokens.css now pins the control scheme to the app theme, so the box reads true.
    // `typeof` rather than `??` keeps "never set" and "set to false" distinguishable, so
    // someone who turned this off is not opted back in by the changed default. A storage
    // read failure cannot prove there is no stored false, so it falls back to off, because
    // an unattended clipboard read needs a positive signal rather than a guess.
    const watch = el('input', { type: 'checkbox' }) as HTMLInputElement
    try {
      const stored = await ctx.storage.get<boolean>(WATCH_KEY)
      watch.checked = typeof stored === 'boolean' ? stored : true
    } catch {
      watch.checked = false
    }
    watch.addEventListener('change', () => {
      void ctx.storage.set(WATCH_KEY, watch.checked).catch(() => ctx.toast('Could not save that preference'))
    })

    // Auto-OCR lives in Settings as a three-way (off / read / read and copy), and the
    // state worth reaching quickly is repeated here, because this card is what refocusing
    // the tab opens and 'copy' replaces whatever was held with the text found in an image.
    // A preference that overwrites the clipboard belongs beside the switch that decides
    // when the clipboard is read at all. Checked maps to 'copy' and unchecked to 'show',
    // so unticking it stops the overwrite without also switching image reading off; 'off'
    // stays reachable in Settings.
    const autoCopy = el('input', { type: 'checkbox' }) as HTMLInputElement
    autoCopy.checked = (await getOcrMode()) === 'copy'
    autoCopy.addEventListener('change', () => {
      void setOcrMode(autoCopy.checked ? 'copy' : 'show').catch(() => ctx.toast('Could not save that preference'))
    })
    const onOcrMode = (e: Event) => {
      autoCopy.checked = (e as CustomEvent<'off' | 'show' | 'copy'>).detail === 'copy'
    }
    window.addEventListener(OCR_MODE_EVENT, onOcrMode)
    local.push(() => window.removeEventListener(OCR_MODE_EVENT, onOcrMode))

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

    // Focus re-scan is unattended, so it takes the same permission gate as the boot
    // pre-read. With it on by default, an ungranted browser must not paint "Clipboard read
    // blocked" over the card every time the tab is refocused. Only a non-empty read
    // replaces what is on screen, so refocusing with an unchanged or unreadable clipboard
    // leaves the routed results alone instead of wiping them.
    const onFocus = () => {
      if (!watch.checked) return
      void readClipboardIfGranted(ctx.clipboard.read).then((items) => {
        if (items.length) render(items)
      })
    }
    window.addEventListener('focus', onFocus)
    local.push(() => window.removeEventListener('focus', onFocus))

    container.append(
      el('div', { class: 'row' }, [
        button('Scan clipboard', () => void scan(), 'primary'),
        el('label', { class: 'row' }, [watch, el('span', { text: 'Re-scan the clipboard when this tab regains focus' })]),
        el('label', { class: 'row' }, [autoCopy, el('span', { text: 'Replace my clipboard with text found in images (OCR)' })]),
      ]),
      el('p', { class: 'muted', text: 'Auto-reads on supported browsers once permission is granted; otherwise paste or scan.' }),
      status,
      results,
    )

    // Open with the clipboard already read, but only where the permission is already
    // granted, because opening a card must never raise a permission prompt. No grant, no
    // Permissions API or an empty clipboard all fall through in silence to the paste
    // listener and the Scan button. Nothing is reported as blocked because nothing was
    // attempted; the Scan button is the one that may ask, since a click is the asking.
    const preread = await readClipboardIfGranted(ctx.clipboard.read)
    if (preread.length) render(preread)
    else status.textContent = 'Press Ctrl/Cmd+V to paste here, or click Scan clipboard.'
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
      const out = el('pre', { class: 'muted', text: 'Reading text...' })
      const run = async (copyAfter: boolean) => {
        out.classList.add('muted')
        out.textContent = 'Reading text...'
        try {
          const { recognizeImage } = await import('../ocr')
          const { text } = await recognizeImage(d.blob as Blob, (p) => {
            out.textContent = `Recognizing... ${Math.round(p * 100)}%`
          })
          const clean = text.trim()
          out.classList.remove('muted')
          out.textContent = clean || '(no text found)'
          if (clean && copyAfter) {
            try {
              await ctx.clipboard.write(clean)
              ctx.toast('Image text copied')
            } catch {
              /* clipboard blocked; the text is on the card either way */
            }
          }
        } catch (e) {
          out.textContent = `OCR failed: ${(e as Error).message}`
        }
      }
      // Same three modes the feed's image cards use, read from the one preference owner.
      // This branch used to ignore it and always render a Run OCR button, so an image on
      // the clipboard was read automatically in the feed but not here.
      const mode = await getOcrMode()
      const actions = el('div', { class: 'row' }, [copyButton(() => out.textContent ?? '', ctx.clipboard.write)])
      if (mode === 'off') {
        out.textContent = 'OCR is off in Settings.'
        actions.prepend(button('Run OCR', () => void run(false), 'primary'))
      }
      body.append(img, actions, out)
      if (mode !== 'off') void run(mode === 'copy')
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
      // The verdict, then the breakdown. This branch used to render only the breakdown, so
      // the card that opens on arrival answered "what is in this link" and never "is it
      // safe", while the pasted-link card in the feed answered the second. Same order as
      // the URL Check tool, meaning blocklist result, structural read, then the parts.
      const { parseUrl, partsBlock, renderPasteVerdict } = await import('../url-safety')
      const raw = d.text ?? ''
      const verdict = el('div', { class: 'stack url-check-card' }, [el('div', { class: 'muted small', text: 'Checking blocklist feeds...' })])
      const parts = parseUrl(raw)
      body.append(verdict, ...(parts ? [partsBlock(parts)] : []), el('div', { class: 'row' }, [copyButton(() => raw, ctx.clipboard.write)]))
      // Never fetches the URL itself; the feeds are downloaded and matched locally.
      void renderPasteVerdict(raw, verdict)
      break
    }
    case 'text': {
      const { textStats } = await import('../text-utils')
      const s = textStats(d.text ?? '')
      const out = el('pre', { text: d.text ?? '' })
      // The text leads. This branch used to open with "N words, N chars, N lines", so
      // copied prose arrived as a measurement of itself. The count stays, below the text.
      body.append(
        out,
        el('div', { class: 'muted', text: `${s.words} words, ${s.chars} chars, ${s.lines} lines` }),
        el('div', { class: 'row' }, [copyButton(() => d.text ?? '', ctx.clipboard.write)]),
      )
      break
    }
  }
}

export default tool
