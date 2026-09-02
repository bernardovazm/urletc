// Canvas preprocessing for Tesseract.
//
// Tesseract's LSTM was trained on roughly 300 DPI scans. A screenshot is 96 DPI, so a
// period between two hostname labels is one or two pixels wide and is the first feature
// the recogniser drops: a dotted hostname came back with its dots missing from
// the unprocessed bitmap. Upscaling before recognition is what puts that period back.
//
// Every constant here was measured on a fixture set (a real browser screenshot, a 1080p
// and a 4K composite of it, a light-on-dark terminal, a light document, a dense body-copy
// block and the canvas-rendered image the e2e suite generates), not assumed:
//
//  - integer upscale to a pixel budget beats native everywhere and never regresses a
//    fixture. It is what recovers dotted hostnames.
//  - luma grayscale is a clear win on the screenshot and neutral elsewhere.
//  - contrast stretch is neutral to negative. Not applied.
//  - binarisation, global OR local adaptive, LOSES accuracy. These images are mixed
//    polarity (light text on dark browser chrome above, dark text on a light page below),
//    and one threshold destroys whichever region it was not fitted to. Leptonica already
//    thresholds per region inside Tesseract, so doing it here only throws information
//    away. Not applied.

/** Largest integer upscale. Past 4x the fixtures stop improving and only cost memory. */
const MAX_SCALE = 4

/** Output size we aim for. A 4x upscale of a 760x527 screenshot is 6.4 MP and fits. */
const TARGET_OUT_PX = 12e6

/** Output size we will never exceed, and the size an oversized source is reduced to. */
const HARD_CAP_PX = 36e6

/** Below 2x, small glyph features do not survive: a 3840x2160 screenshot left at native
 *  size lost BOTH dotted hostnames in the fixture set, and recovered both at 2x. So the
 *  target budget is an aim, not a floor, and 2x wins over it whenever the hard cap allows. */
const MIN_UPSCALE = 2

/** Integer upscale factor for `w` x `h`, or a fraction below 1 when the source is itself
 *  larger than the hard cap. Exported so the rule can be asserted without a canvas. */
export function chooseScale(w: number, h: number): number {
  const px = w * h
  if (px <= 0) return 1
  if (px * MIN_UPSCALE * MIN_UPSCALE > HARD_CAP_PX) {
    // Too big to upscale usefully. Only shrink if it is over the cap outright; a large
    // photo already has large glyphs, and downscaling one that fits would destroy them.
    return px > HARD_CAP_PX ? Math.sqrt(HARD_CAP_PX / px) : 1
  }
  const byBudget = Math.floor(Math.sqrt(TARGET_OUT_PX / px))
  return Math.max(MIN_UPSCALE, Math.min(MAX_SCALE, byBudget))
}

/** Luma grayscale, in place. Rec.601 coefficients, the same weighting Leptonica uses. */
export function toGrayscale(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    d[i] = d[i + 1] = d[i + 2] = y
  }
}

/** Rows per grayscale pass. A 2x upscale of a 4K screenshot is 33 MP, and pulling that
 *  back as one ImageData would allocate 133 MB on top of the canvas itself. Banding caps
 *  the extra allocation at a few MB for any input size. */
const BAND_PX = 2e6

function grayscaleCanvas(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, w: number, h: number): void {
  const rows = Math.max(1, Math.min(h, Math.floor(BAND_PX / Math.max(1, w))))
  for (let y = 0; y < h; y += rows) {
    const band = Math.min(rows, h - y)
    const img = ctx.getImageData(0, y, w, band)
    toGrayscale(img.data)
    ctx.putImageData(img, 0, y)
  }
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Upscaled, grayscaled copy of `src` ready for `worker.recognize`. tesseract.js accepts
 *  a canvas directly (it calls convertToBlob/toBlob itself), so nothing is encoded twice.
 *  Returns null when the source cannot be decoded, and the caller falls back to the
 *  original bitmap rather than failing the recognition. */
export async function prepareForOcr(src: Blob): Promise<OffscreenCanvas | HTMLCanvasElement | null> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(src)
  } catch {
    return null
  }
  try {
    const scale = chooseScale(bmp.width, bmp.height)
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d') as (OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) | null
    if (!ctx) return null
    // A screenshot pasted from the clipboard can carry an alpha channel. Compositing it
    // onto white first stops transparent pixels from being read as black strokes.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    grayscaleCanvas(ctx, w, h)
    return canvas
  } catch {
    return null
  } finally {
    bmp.close()
  }
}
