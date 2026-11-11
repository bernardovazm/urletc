// What the speech-to-text worker loads, shared with the service worker, which keeps the
// model cache and the runtime binary across deploys (sw.ts activate).

// The only models the worker loads, each at the commit it was tested against. A model not
// listed is refused rather than fetched from the repo's moving main branch.
export const REVISIONS: Record<string, string> = {
  'Xenova/whisper-base': '64da57285918e20ea79ea5c88eed7197933abaa8',
  'Xenova/whisper-tiny': '5332fcc35e32a33b86612b9a57a89be7906102b1',
}

// Byte length and SHA-256 of every file the q8 pipeline reads at each pin. The worker
// checks each file against these before transformers.js reads it, from the network and from
// its cache alike, so neither the host nor a stored copy can change what runs. The .onnx
// digests are the Git LFS object ids the commit names; the JSON files hash to the git blob
// ids in the commit's tree. Any other file of the repo is answered as missing.
export const FILES: Record<string, Record<string, readonly [size: number, sha256: string]>> = {
  'Xenova/whisper-base': {
    'config.json': [2248, 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b'],
    'generation_config.json': [3776, '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05'],
    'preprocessor_config.json': [339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
    'tokenizer.json': [2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'],
    'tokenizer_config.json': [282683, '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'],
    'onnx/encoder_model_quantized.onnx': [23200850, '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9'],
    'onnx/decoder_model_merged_quantized.onnx': [53707539, 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861'],
  },
  'Xenova/whisper-tiny': {
    'config.json': [2248, '2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94'],
    'generation_config.json': [3716, '68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c'],
    'preprocessor_config.json': [339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
    'tokenizer.json': [2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'],
    'tokenizer_config.json': [282683, '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'],
    'onnx/encoder_model_quantized.onnx': [10124910, 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e'],
    'onnx/decoder_model_merged_quantized.onnx': [30727765, '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0'],
  },
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
