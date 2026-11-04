/// <reference lib="webworker" />
// Whisper speech-to-text via transformers.js, off the main thread (ARCHITECTURE section 4.3).
// Excluded from the app tsconfig because it runs in a worker global scope, and built by Vite.
// Receives 16 kHz mono Float32 audio plus model and language, posts back status, progress
// and result. Models load at a pinned Hugging Face commit (REVISIONS): a commit names its
// files' content, so a later push to the repo cannot change what runs here. Not built: a
// SHA-256 check of each fetched file against digests kept in this repo, which would also
// stand against the host serving other bytes for that commit.

import { pipeline, env } from '@huggingface/transformers'
import { installTrustedTypes } from '../core/trusted-types'
// The model pins and ONNX Runtime's same-origin loader and binary (see stt-assets.ts).
import { MODEL_CACHE, ORT_MJS, ORT_WASM, REVISIONS } from './stt-assets'

// The worker is under the same require-trusted-types-for CSP as the page, and ONNX
// Runtime's threaded build starts its own workers from here, which throw without a policy.
installTrustedTypes()

env.allowLocalModels = false
// The wasm cache path re-imports the loader through a blob: URL, the step the CSP refuses.
// The binary is still cached by the service worker like any other /assets/ file.
env.useWasmCache = false
env.backends.onnx.wasm.wasmPaths = { mjs: ORT_MJS, wasm: ORT_WASM }

// One load per model, shared by every request for it. Switching models disposes the
// previous pipeline: its ONNX sessions held hundreds of MB in this shared worker. Not
// while a request is still transcribing with it, since STT cards share this worker, so
// the last such request disposes it when it ends.

// The pin is applied to every request rather than through pipeline()'s `revision` option.
// That option reaches the weights only: pipeline() first reads config.json and probes
// tokenizer_config.json and preprocessor_config.json at main to decide which parts to load.
// Those probes then decided what ran, and since their cache keys named main while the files
// were stored under the commit, they missed the cache and a cached model still failed
// offline. Rewritten here, every URL keeps main in its cache key and fetches the commit.
// The cache is named after the pins instead, and the service worker drops the ones two
// deploys old (sw.ts).
env.cacheKey = MODEL_CACHE
const HF_RESOLVE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\//
const baseFetch = env.fetch
env.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const m = HF_RESOLVE.exec(url)
  const rev = m && REVISIONS[m[1]]
  if (m && !rev) return Promise.reject(new Error(`model not allowed: ${m[1]}`))
  return baseFetch(rev ? url.replace(m[0], `https://huggingface.co/${m[1]}/resolve/${rev}/`) : input, init)
}

let loading = null // { model, promise, users, superseded, settled }
const waiting = new Set() // request ids waiting on a load, each told its download progress

function release(entry) {
  if (--entry.users > 0 || !entry.superseded) return
  void entry.promise.then((p) => p?.dispose?.()).catch(() => {})
}

self.onmessage = async (e) => {
  const { id, audio, model, language } = e.data
  const post = (m) => postMessage({ id, ...m }) // echo the request id so callers can demux
  let entry = null
  try {
    if (!REVISIONS[model]) throw new Error(`model not allowed: ${model}`)
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
          progress_callback: (p) => {
            for (const wid of waiting) postMessage({ id: wid, type: 'progress', data: p })
          },
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
