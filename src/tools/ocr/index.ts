import { createWorker, OEM } from 'tesseract.js'
import type { ToolContext, ToolModule } from '../../shell/registry'
import { button, copyButton, el, toast } from '../../shell/ui'

// Tesseract.js v7, fully self-hosted core + worker (see public/tesseract/), so the
// strict CSP keeps script-src 'self'. Only the language data is fetched from a CDN
// (allowed in connect-src) on first use and cached by the library in IndexedDB.

// The Tesseract worker is a shared singleton (loading its WASM core twice is wasteful) and
// is reached from BOTH this tool's cards and the clipboard tool's inline OCR. `inFlight`
// guards teardown so closing one consumer can't terminate a recognition another is running;
// `liveCards` refcounts this tool's cards so the heap is freed only when the last one closes.
let workerPromise: ReturnType<typeof createWorker> | null = null
let progressCb: ((p: number) => void) | null = null
let inFlight = 0
let liveCards = 0

function getWorker(): ReturnType<typeof createWorker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    // Points at our shim, not the vendored worker: a worker has its own Trusted Types
    // context, so the policy installed by the page does not cover its importScripts call.
    workerPath: '/tesseract/worker-tt.js',
    // Load that shim by URL instead of the library's default of fetching it and wrapping
    // it in a blob: worker. Inside a blob worker `self.location` is the opaque blob URL,
    // so the shim cannot resolve the sibling script it needs to import.
    workerBlobURL: false,
    corePath: '/tesseract',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
    logger: (m) => {
      if (m.status === 'recognizing text') progressCb?.(m.progress)
    },
  })
  return workerPromise
}

export interface OcrResult {
  text: string
}

export async function recognizeImage(image: Blob | string, onProgress?: (p: number) => void): Promise<OcrResult> {
  progressCb = onProgress ?? null
  inFlight++
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(image)
    return { text: data.text }
  } finally {
    inFlight--
  }
}

/** Free the OCR worker + WASM heap (the heap cannot shrink while alive). No-op while a
 *  recognition is in flight: another card or the clipboard tool may still need the worker. */
export async function disposeOcr(): Promise<void> {
  if (inFlight > 0 || !workerPromise) return
  const w = await workerPromise
  await w.terminate()
  workerPromise = null
  progressCb = null
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    liveCards++
    const file = el('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement
    const status = el('div', { class: 'muted' })
    const preview = el('img', { class: 'preview', alt: 'OCR input preview' }) as HTMLImageElement
    const out = el('pre', { class: 'muted', text: 'extracted text' })
    let previewUrl = ''

    const run = async (src: Blob) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl) // drop a prior preview replaced before it loaded
      const url = URL.createObjectURL(src)
      previewUrl = url
      preview.src = url
      preview.onload = () => URL.revokeObjectURL(url)
      preview.onerror = () => URL.revokeObjectURL(url) // decode failure would otherwise leak the URL
      status.textContent = 'Loading the OCR engine and language. The first run downloads the model.'
      try {
        const { text } = await recognizeImage(src, (p) => {
          status.textContent = `Recognizing... ${Math.round(p * 100)}%`
        })
        out.classList.remove('muted')
        out.textContent = text.trim() || '(no text found)'
        status.textContent = 'Done.'
      } catch (e) {
        status.textContent = `OCR failed: ${(e as Error).message}`
      }
    }

    file.addEventListener('change', () => {
      const f = file.files?.[0]
      if (f) void run(f)
    })

    const fromClipboard = async () => {
      try {
        const items = await ctx.clipboard.read()
        for (const it of items) {
          const t = it.types.find((x) => x.startsWith('image/'))
          if (t) {
            void run(await it.getType(t))
            return
          }
        }
        toast('No image in clipboard')
      } catch {
        toast('Clipboard image read blocked')
      }
    }

    container.append(
      el('div', { class: 'row' }, [file, button('Use clipboard image', () => void fromClipboard())]),
      status,
      preview,
      el('div', { class: 'row' }, [copyButton(() => out.textContent ?? '', ctx.clipboard.write, 'Copy text')]),
      out,
    )
  },
  deactivate() {
    if (--liveCards > 0) return // another card still open; keep the shared worker warm
    liveCards = 0
    void disposeOcr()
  },
}

export default tool
