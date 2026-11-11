/// <reference lib="webworker" />
// Whisper speech-to-text via transformers.js, off the main thread (ARCHITECTURE section 4.3).
// Excluded from the app tsconfig because it runs in a worker global scope, and built by Vite.
// Receives 16 kHz mono Float32 audio plus model and language, posts back status, progress
// and result. Models load at a pinned Hugging Face commit (REVISIONS), and every file is
// checked against the byte length and SHA-256 kept for it in this repo (FILES) before
// transformers.js reads it, so neither a later push to the repo, the host serving other
// bytes for that commit, nor a stored copy changes what runs here.

import { pipeline, env } from '@huggingface/transformers'
import { installTrustedTypes } from '../core/trusted-types'
// The model pins and digests and ONNX Runtime's same-origin loader and binary.
import { FILES, MODEL_CACHE, ORT_MJS, ORT_WASM, REVISIONS } from './stt-assets'

// The worker is under the same require-trusted-types-for CSP as the page, and ONNX
// Runtime's threaded build starts its own workers from here, which throw without a policy.
installTrustedTypes()

env.allowLocalModels = false
// The wasm cache path re-imports the loader through a blob: URL, the step the CSP refuses.
// The binary is still cached by the service worker like any other /assets/ file.
env.useWasmCache = false
env.backends.onnx.wasm.wasmPaths = { mjs: ORT_MJS, wasm: ORT_WASM }

// The pin is applied to every request rather than through pipeline()'s `revision` option,
// which reaches the weights only: pipeline() first reads config.json and probes
// tokenizer_config.json and preprocessor_config.json at main to decide which parts to load.
// Every model file comes through env.fetch under the main URL transformers.js builds, and
// that URL is never fetched: the file comes from this worker's cache or from the pinned
// commit, and from either only once its size and SHA-256 match FILES. transformers.js keeps
// no cache of its own, since it would read its copy back unchecked. The cache keys still
// name main, so copies stored before the check existed are found and checked like any
// other, and the cache is named after the pins instead; the service worker drops the ones
// two deploys old (sw.ts).
env.useBrowserCache = false
const HF_FILE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/
const baseFetch = env.fetch
env.fetch = async (input, init) => {
  const req = new Request(input, init)
  const m = HF_FILE.exec(req.url)
  if (!m) {
    if (new URL(req.url).hostname === 'huggingface.co') throw new Error(`not a pinned model file: ${req.url}`)
    return baseFetch(input, init)
  }
  const [, model, path] = m
  if (!Object.hasOwn(REVISIONS, model) || !Object.hasOwn(FILES, model)) throw new Error(`model not allowed: ${model}`)
  // A file outside the pinned set reads as one the repo does not have.
  if (!Object.hasOwn(FILES[model], path)) return new Response(null, { status: 404 })
  const [size, sha256] = FILES[model][path]
  // transformers.js probes each file with a one-byte range request for its size before it
  // loads it. The size is pinned, so the answer needs no network, and a cached model loads
  // offline.
  if (req.headers.has('range')) {
    return new Response(new Uint8Array(1), { status: 206, headers: { 'content-range': `bytes 0-0/${size}` } })
  }
  return pinnedFile(req.url, model, path, size, sha256)
}

// A download that stops sending is abandoned, so the load fails and the next request
// retries rather than every request on this worker waiting on it for good.
const STALL_MS = 30_000

async function pinnedFile(key, model, path, size, sha256) {
  let cache = null
  try {
    cache = await caches.open(MODEL_CACHE)
  } catch {
    // no Cache Storage here (a private window in some browsers), so every load downloads
  }
  // Read as a Blob: it is immutable, so the bytes checked are the bytes handed on, and its
  // contents can stay on disk while transformers.js reads them. Handing on the checked copy
  // itself would keep it in memory beside the one transformers.js makes.
  const hit = await cache?.match(key).catch(() => undefined)
  const stored = hit && (await hit.blob().catch(() => null))
  if (stored) {
    if (await intact(new Uint8Array(await stored.arrayBuffer().catch(() => new ArrayBuffer(0))), size, sha256)) {
      return new Response(stored, { headers: { 'content-length': String(stored.size) } })
    }
    await cache.delete(key).catch(() => {})
  }
  const stall = new AbortController()
  const stop = () => stall.abort(new Error(`${model}/${path} stopped downloading`))
  let timer = setTimeout(stop, STALL_MS)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(stop, STALL_MS)
  }
  try {
    const res = await baseFetch(`https://huggingface.co/${model}/resolve/${REVISIONS[model]}/${path}`, { signal: stall.signal })
    if (!res.ok) return res // transformers.js reports the status
    let shown = -1
    const bytes = await readCapped(res, size, (loaded) => {
      alive()
      const pct = Math.floor((loaded / size) * 100)
      if (pct === shown) return
      shown = pct
      progress({ status: 'progress', name: model, file: path, progress: (loaded / size) * 100, loaded, total: size })
    })
    clearTimeout(timer)
    if (!(await intact(bytes, size, sha256))) throw new Error(`${model}/${path} does not match its pinned SHA-256`)
    // Stored before it is handed on, so the copy the cache reads is released before
    // transformers.js makes its own and a file is never held three times at once: a decoder
    // is tens of MB. A full disk only costs the cache.
    await cache?.put(key, new Response(bytes)).catch(() => {})
    return inMemory(bytes)
  } finally {
    clearTimeout(timer)
  }
}

/** The body, read up to the pinned size: a larger one is cut off rather than buffered. */
async function readCapped(res, size, onProgress) {
  const out = new Uint8Array(size)
  const reader = res.body?.getReader()
  let loaded = 0
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    if (loaded + value.byteLength > size) {
      await reader.cancel().catch(() => {})
      throw new Error('a model file is larger than its pinned size')
    }
    out.set(value, loaded)
    loaded += value.byteLength
    onProgress(loaded)
  }
  return loaded === size ? out : out.subarray(0, loaded)
}

async function intact(bytes, size, sha256) {
  if (bytes.byteLength !== size) return false
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') === sha256
}

/** A response that hands its reader `bytes` itself, where a BufferSource body is copied. */
function inMemory(bytes) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  return new Response(body, { headers: { 'content-length': String(bytes.byteLength) } })
}

// One load per model, shared by every request for it. Switching models disposes the
// previous pipeline: its ONNX sessions held hundreds of MB in this shared worker. Not
// while a request is still transcribing with it, since STT cards share this worker, so
// the last such request disposes it when it ends.
let loading = null // { model, promise, users, superseded, settled }
const waiting = new Set() // request ids waiting on a load, each told its download progress
function progress(data) {
  for (const wid of waiting) postMessage({ id: wid, type: 'progress', data })
}

function release(entry) {
  if (--entry.users > 0 || !entry.superseded) return
  void entry.promise.then((p) => p?.dispose?.()).catch(() => {})
}

self.onmessage = async (e) => {
  const { id, audio, model, language } = e.data
  const post = (m) => postMessage({ id, ...m }) // echo the request id so callers can demux
  let entry = null
  try {
    if (!Object.hasOwn(REVISIONS, model)) throw new Error(`model not allowed: ${model}`)
    if (!loading || loading.model !== model) {
      const prev = loading
      if (prev) {
        prev.superseded = true
        if (prev.users === 0) void prev.promise.then((p) => p?.dispose?.()).catch(() => {})
      }
      const next = {
        model,
        users: 0,
        superseded: false,
        settled: false,
        promise: pipeline('automatic-speech-recognition', model, {
          dtype: 'q8',
          progress_callback: progress,
        }),
      }
      next.promise.then(
        () => (next.settled = true),
        () => {
          if (loading === next) loading = null
        },
      )
      loading = next
    }
    entry = loading
    entry.users++
    // Every request waiting on a load hears about it, not only the one that started it.
    waiting.add(id)
    if (!entry.settled) post({ type: 'status', text: 'Loading model. First run downloads and caches it...' })
    let transcriber
    try {
      transcriber = await entry.promise
    } finally {
      waiting.delete(id)
    }
    post({ type: 'status', text: 'Transcribing...' })
    const out = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language || null,
      task: 'transcribe',
    })
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
    post({ type: 'result', text: typeof text === 'string' ? text : '' })
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) })
  } finally {
    if (entry) release(entry)
  }
}
