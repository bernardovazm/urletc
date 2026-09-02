// Live, on-device captions for the local mic, reusing the Whisper STT worker
// (ARCHITECTURE section 4.3; nothing leaves the device). The mic track is CLONED
// and recorded in ~4s standalone takes (a fresh MediaRecorder per take, because
// continuation chunks of one recording are not independently decodable). Each take
// decodes to 16 kHz mono, then Whisper-tiny. Silent takes are skipped cheaply by an
// RMS gate. If transcription falls behind, only the SINGLE most-recent take is kept,
// so captions stay current instead of lagging or queueing unboundedly. The worker +
// decode AudioContext are torn down by disposeCaptions() when captioning ends.

const MODEL = 'Xenova/whisper-tiny' // smallest model: realtime latency beats accuracy here

let worker: Worker | null = null
let decodeCtx: AudioContext | null = null
let seq = 0

export interface CaptionsHandle {
  stop(): void
}

function getWorker(): Worker {
  worker ??= new Worker(new URL('../workers/stt.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

function getDecodeCtx(): AudioContext {
  // One reused context for the whole session: decodeAudioData accepts a shared
  // context, and this avoids creating/closing an AudioContext every ~4s take.
  decodeCtx ??= new AudioContext()
  return decodeCtx
}

// Whisper takes a language NAME ('portuguese'), not a BCP-47 tag. Derive it from the
// browser locale so a pt-BR user gets Portuguese instead of tiny's shaky auto-detect.
function captionLanguage(): string {
  const lang = (navigator.language || '').toLowerCase().split('-')[0]
  const map: Record<string, string> = {
    en: 'english',
    pt: 'portuguese',
    es: 'spanish',
    fr: 'french',
    de: 'german',
    it: 'italian',
    nl: 'dutch',
    ja: 'japanese',
    ko: 'korean',
    zh: 'chinese',
    ru: 'russian',
    pl: 'polish',
    tr: 'turkish',
    ar: 'arabic',
    hi: 'hindi',
  }
  return map[lang] ?? '' // '' = let Whisper auto-detect
}

async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer()
  const decoded = await getDecodeCtx().decodeAudioData(arrayBuf)
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

function transcribe(audio: Float32Array, language: string, onStatus: (s: string) => void): Promise<string> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const w = getWorker()
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (m.id !== id) return
      if (m.type === 'status') onStatus(m.text)
      else if (m.type === 'progress') {
        if (m.data?.status === 'progress' && typeof m.data.progress === 'number') {
          onStatus(`Downloading caption model... ${Math.round(m.data.progress)}%`)
        }
      } else if (m.type === 'result') {
        w.removeEventListener('message', onMsg)
        resolve(m.text)
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMsg)
        reject(new Error(m.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ id, audio, model: MODEL, language })
  })
}

/** Whisper hallucinates on near-silence, so drop bracketed sound-effects and one-letter noise. */
function keepLine(text: string): boolean {
  if (text.length < 2) return false
  return !/^[[(].*[\])]$/s.test(text)
}

export function startCaptions(stream: MediaStream, onLine: (text: string) => void, onStatus: (s: string) => void): CaptionsHandle {
  const track = stream.getAudioTracks()[0]
  if (!track) {
    onStatus('No microphone track to caption.')
    return { stop() {} }
  }
  // Clone so stopping captions never touches the live share (and vice versa).
  const mic = new MediaStream([track.clone()])
  const language = captionLanguage()
  let stopped = false
  let rec: MediaRecorder | null = null
  let busy = false
  let pending: Blob | null = null // single-slot: only the newest take waits

  const enqueue = (blob: Blob) => {
    if (stopped || blob.size < 2000) return // empty/too-short take: skip
    if (busy) {
      pending = blob
      return
    }
    busy = true
    void run(blob)
  }

  const run = async (blob: Blob) => {
    try {
      const audio = await decodeToMono16k(blob)
      let rms = 0
      for (let i = 0; i < audio.length; i++) rms += audio[i] * audio[i]
      rms = Math.sqrt(rms / Math.max(1, audio.length))
      if (rms >= 0.008) {
        // above the silence floor, worth waking the model
        const text = (await transcribe(audio, language, onStatus)).trim()
        if (!stopped && text && keepLine(text)) onLine(text)
      }
    } catch {
      /* one bad take must not kill the loop */
    } finally {
      busy = false
      if (!stopped && pending) {
        const b = pending
        pending = null
        enqueue(b)
      }
    }
  }

  const cycle = () => {
    if (stopped) return
    const r = new MediaRecorder(mic)
    rec = r
    const chunks: Blob[] = []
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    r.onstop = () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
      cycle() // next take starts immediately; the capture gap stays tiny
      enqueue(blob)
    }
    r.start()
    window.setTimeout(() => {
      if (r.state === 'recording') r.stop()
    }, 4000)
  }
  cycle()

  return {
    stop() {
      stopped = true
      pending = null
      try {
        if (rec && rec.state !== 'inactive') rec.stop()
      } catch {
        /* already gone */
      }
      mic.getTracks().forEach((t) => t.stop())
    },
  }
}

/** Free the Whisper worker + decode context; models stay cached in the browser.
 *  The console calls this when captioning ends so nothing lingers for the page's life. */
export function disposeCaptions(): void {
  worker?.terminate()
  worker = null
  if (decodeCtx) {
    void decodeCtx.close()
    decodeCtx = null
  }
}
