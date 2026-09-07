/// <reference lib="webworker" />
// Whisper speech-to-text via transformers.js, off the main thread (ARCHITECTURE section 4.3).
// Excluded from the app tsconfig because it runs in a worker global scope, and built by Vite.
// Receives 16 kHz mono Float32 audio plus model and language, posts back status, progress
// and result. Deferred hardening (ARCHITECTURE section 9, P1 gate): pinned model-weight
// SHA-256 verification is not wired yet, and transformers.js fetches and caches the model.

import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels = false

let transcriber = null
let currentModel = ''

self.onmessage = async (e) => {
  const { id, audio, model, language } = e.data
  const post = (m) => postMessage({ id, ...m }) // echo the request id so callers can demux
  try {
    if (!transcriber || currentModel !== model) {
      post({ type: 'status', text: 'Loading model. First run downloads and caches it...' })
      transcriber = await pipeline('automatic-speech-recognition', model, {
        dtype: 'q8',
        progress_callback: (p) => post({ type: 'progress', data: p }),
      })
      currentModel = model
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
  }
}
