/// <reference lib="webworker" />
// Whisper speech-to-text via transformers.js, off the main thread (ARCHITECTURE section 4.3).
// Excluded from the app tsconfig because it runs in a worker global scope, and built by Vite.
// Receives 16 kHz mono Float32 audio plus model and language, posts back status, progress
// and result. Not built (ARCHITECTURE sections 4.3 and 9, Phase 1 gate in section 11):
// pinned model-weight SHA-256 verification. pipeline() gets no `revision`, so
// transformers.js fetches the model repo's main branch from Hugging Face and caches it
// with no digest check.

import { pipeline, env } from '@huggingface/transformers'
import { installTrustedTypes } from '../core/trusted-types'
// ONNX Runtime's WebAssembly loader and binary, served from this origin. By default
// transformers.js fetches the loader from cdn.jsdelivr.net and imports it as a blob: URL,
// which script-src 'self' refuses, so every transcription failed with "no available
// backend found". Same-origin, the loader is a plain module import, and no third-party
// code runs in the worker.
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

// The worker is under the same require-trusted-types-for CSP as the page, and ONNX
// Runtime's threaded build starts its own workers from here, which throw without a policy.
installTrustedTypes()

env.allowLocalModels = false
// The wasm cache path re-imports the loader through a blob: URL, the step the CSP refuses.
// The binary is still cached by the service worker like any other /assets/ file.
env.useWasmCache = false
env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }

// One load per model, shared by every request for it. Switching models disposes the
// previous pipeline: its ONNX sessions held hundreds of MB in this shared worker. Not
// while a request is still transcribing with it, since STT cards share this worker, so
// the last such request disposes it when it ends.
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
