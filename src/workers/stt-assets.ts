// What the speech-to-text worker loads, shared with the service worker, which keeps the
// model cache and the runtime binary across deploys (sw.ts activate).

// The only models the worker loads, each at the commit it was tested against. A model not
// listed is refused rather than fetched from the repo's moving main branch.
export const REVISIONS: Record<string, string> = {
  'Xenova/whisper-base': '64da57285918e20ea79ea5c88eed7197933abaa8',
  'Xenova/whisper-tiny': '5332fcc35e32a33b86612b9a57a89be7906102b1',
}

// The model cache is named after the pins, since its keys name main (stt.worker.ts): a
// changed pin opens a new cache instead of serving the old commit's files forever.
export const MODEL_CACHE = `transformers-cache-${Object.values(REVISIONS)
  .map((sha) => sha.slice(0, 8))
  .join('')}`

// ONNX Runtime's WebAssembly loader and binary, served from this origin. By default
// transformers.js fetches the loader from cdn.jsdelivr.net and imports it as a blob: URL,
// which script-src 'self' refuses, so every transcription failed with "no available
// backend found". Same-origin, the loader is a plain module import, and no third-party
// code runs in the worker.
//
// The plain CPU build, not the library's default asyncify one: asyncify exists for the
// WebGPU backend, which the worker never selects, and costs 25.6 MB against 13.6 MB. The
// library itself falls back to the plain build on Safari below 26.
export { default as ORT_MJS } from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
export { default as ORT_WASM } from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
