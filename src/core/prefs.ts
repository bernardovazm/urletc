// Preferences owned by more than one surface. The auto-OCR mode is read by the console
// (which runs the OCR), written by Settings, and both read and written by the Clipboard
// card, so the key, the legal values and the default live here instead of in three places
// that have to agree. Writing it dispatches an event so a second open surface repaints
// instead of showing a stale control.
import { getItem, setItem } from './store'

/** off: never read images. show: read, leave the clipboard alone. copy: read and copy. */
export type OcrMode = 'off' | 'show' | 'copy'
export const OCR_MODE_EVENT = 'wt:ocr-mode'

/**
 * Default 'copy': an image that lands in the feed is usually there for its text.
 *
 * A failed read falls back to 'show' rather than to the default, because a read failure
 * cannot prove that nobody chose 'show' or 'off', and defaulting to 'copy' there would
 * overwrite a clipboard the user was holding something in.
 */
export async function getOcrMode(): Promise<OcrMode> {
  try {
    const v = await getItem<string>('image-ocr')
    if (v === 'off' || v === 'show' || v === 'copy') return v
    return v === undefined ? 'copy' : 'show'
  } catch {
    return 'show'
  }
}

export async function setOcrMode(mode: OcrMode): Promise<void> {
  await setItem('image-ocr', mode)
  window.dispatchEvent(new CustomEvent<OcrMode>(OCR_MODE_EVENT, { detail: mode }))
}
