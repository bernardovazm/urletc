/*
 * Trusted Types shim for the Tesseract worker.
 *
 * A worker has its own Trusted Types context. The default policy installed by the page
 * (src/core/trusted-types.ts) does NOT apply inside it, so tesseract's own
 * `importScripts(corePath)` call was blocked with:
 *
 *   Failed to execute 'importScripts' on 'WorkerGlobalScope':
 *   This document requires 'TrustedScriptURL' assignment.
 *
 * which surfaced in the UI as "OCR failed". This file is what `workerPath` points at. It
 * installs the same narrow policy inside the worker scope and only then loads the real
 * worker, so the vendored minified file stays untouched and survives a dependency update.
 *
 * Same restriction as the page policy: script URLs are converted only for our own origin
 * or blob:, and no createHTML or createScript is provided.
 *
 * It also pins the language data, the one thing this worker fetches, from a third-party
 * host. Each traineddata file is checked against the byte length and SHA-256 below before
 * tesseract reads it, from the network and from this worker's cache alike, and any other
 * fetch is refused. The library's own IndexedDB cache is off (cacheMethod 'none' in
 * src/tools/ocr/index.ts): it stores the decompressed file, which no digest here covers.
 */
;(() => {
  const tt = self.trustedTypes
  if (!tt || !tt.createPolicy || tt.defaultPolicy) return
  try {
    tt.createPolicy('default', {
      createScriptURL: (input) => {
        const url = new URL(input, self.location.href)
        if (url.protocol === 'blob:' || url.origin === self.location.origin) return input
        throw new TypeError('Blocked a cross-origin script URL: ' + url.origin)
      },
    })
  } catch {
    /* a policy already exists; importScripts below will fail loudly if it is too strict */
  }
})()

;(() => {
  // `langPath` in src/tools/ocr/index.ts, and every language it can ask for. The digests
  // are of the files as served; decompressed, each matches tesseract-ocr/tessdata_fast at
  // tag 4.0.0.
  const BASE = 'https://tessdata.projectnaptha.com/4.0.0_fast/'
  const PINNED = {
    deu: [854318, 'acb48fa5d63b5088b6299bda4a700d86e97bb9421253be8fc4af8ea2d8247740'],
    eng: [1984273, '18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b'],
    fra: [609363, '9800c70d1db21689e1ee91b5c81fe4c822120fa92cf5f0dab0d2b81b616fd468'],
    ind: [611736, '09e72d02ac65360f8be30dff934f9cb86b8167acc69b36ec96c3aa366f34d3a0'],
    ita: [1287268, '8a4a1415e492f78d046dab8b8b0efa2c32bd377960ec7db8e9e7b0d28ba54d20'],
    nld: [2997142, '4d966ff690c60dcf8421d0033a95d696f8069d6946b8668ac6e8ead2e2610518'],
    pol: [2058686, '97abef6a21f4d70e58f7b2c6b4dfe6861ef63d00359eaef6adf9b4b5ecfb3bef'],
    por: [1009185, '7b0f1749aa255a593b14160c75f74690be740edcae94c5a45efc24ab50235f4d'],
    rus: [1622027, '56703dfb466e5d3bac7a5758ab479c5c8a173eb419a146fd934d11406b4bccf3'],
    spa: [1137561, '8db1167a8c9bb015ac8e97278384c3b07dfa9bc8271569beea071d9e296b4487'],
    tur: [2031682, '9e60b54f226a708cddb15b64521abb2d77f06072b2f7d4be5bb9c7638eb4e4b5'],
    vie: [422253, 'c98a3f7bd4c7564bf38409cd1203aef1d5f4afae722a45429d85fb0b48fd61ed'],
  }
  const CACHE = 'tessdata-4.0.0_fast'
  const nativeFetch = self.fetch.bind(self)

  const intact = async (bytes, [size, sha256]) => {
    if (bytes.byteLength !== size) return false
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') === sha256
  }

  // Read up to the pinned size: a larger body is cut off rather than buffered.
  const readCapped = async (res, size, onChunk) => {
    const out = new Uint8Array(size)
    const reader = res.body && res.body.getReader()
    let loaded = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      if (loaded + value.byteLength > size) {
        await reader.cancel().catch(() => {})
        throw new Error('a language file is larger than its pinned size')
      }
      out.set(value, loaded)
      loaded += value.byteLength
      onChunk()
    }
    return loaded === size ? out : out.subarray(0, loaded)
  }

  // A download that stops sending is abandoned. tesseract then fails the load, and the next
  // recognition starts over, where a stalled one held every OCR caller in the tab for good.
  const STALL_MS = 30000

  self.fetch = async (input, init) => {
    const url = new Request(input, init).url
    const lang = url.startsWith(BASE) ? url.slice(BASE.length).replace(/\.traineddata\.gz$/, '') : ''
    if (!Object.hasOwn(PINNED, lang) || url !== `${BASE}${lang}.traineddata.gz`) {
      throw new TypeError('Blocked a fetch outside the pinned language data: ' + url)
    }
    const pin = PINNED[lang]
    let cache = null
    try {
      cache = await caches.open(CACHE)
    } catch {
      // no Cache Storage here (a private window in some browsers), so every load downloads
    }
    const hit = await (cache ? cache.match(url).catch(() => undefined) : undefined)
    const stored = hit && new Uint8Array(await hit.arrayBuffer().catch(() => new ArrayBuffer(0)))
    if (stored) {
      if (await intact(stored, pin)) return new Response(stored)
      await cache.delete(url).catch(() => {})
    }
    const stall = new AbortController()
    const stop = () => stall.abort(new Error(`${lang}.traineddata.gz stopped downloading`))
    let timer = setTimeout(stop, STALL_MS)
    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(stop, STALL_MS)
    }
    let bytes
    try {
      const res = await nativeFetch(url, { credentials: 'omit', signal: stall.signal })
      if (!res.ok) return res // tesseract reports the status
      bytes = await readCapped(res, pin[0], alive)
    } finally {
      clearTimeout(timer)
    }
    if (!(await intact(bytes, pin))) throw new Error(`${lang}.traineddata.gz does not match its pinned SHA-256`)
    if (cache) await cache.put(url, new Response(bytes)).catch(() => {})
    return new Response(bytes)
  }
})()

importScripts('/tesseract/worker.min.js')
