/// <reference lib="webworker" />
// Whisper speech-to-text via transformers.js, off the main thread (ARCHITECTURE section 4.3).
// Excluded from the app tsconfig because it runs in a worker global scope, and built by Vite.
// Receives 16 kHz mono Float32 audio plus model and language, posts back status, progress
// and result. Deferred hardening (ARCHITECTURE section 9, P1 gate): pinned model-weight
// SHA-256 verification is not wired yet, and transformers.js fetches and caches the model.

import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false

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
