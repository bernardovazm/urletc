import type { ToolContext, ToolModule } from '../../shell/registry'
import { button, consent, el, toast } from '../../shell/ui'

// Speech-to-text (ARCHITECTURE section 4.3). Files and mic recordings transcribe
// PRIVATELY on-device via Whisper, running transformers.js in a worker. Audio is decoded
// and resampled to 16 kHz mono with the Web Audio API; there is no ffmpeg yet, so video
// may fail until that add-on lands. The live path uses the browser SpeechRecognition
// service and is opt-in plus warned, because it sends audio to a third party.

const MODELS = [
  { id: 'Xenova/whisper-base', label: 'whisper-base: multilingual, more accurate' },
  { id: 'Xenova/whisper-tiny', label: 'whisper-tiny: smaller, faster' },
]

const LANGS: Array<{ v: string; label: string; bcp: string }> = [
  { v: '', label: 'Auto-detect', bcp: 'en-US' },
  { v: 'english', label: 'English', bcp: 'en-US' },
  { v: 'portuguese', label: 'Portuguese', bcp: 'pt-BR' },
  { v: 'spanish', label: 'Spanish', bcp: 'es-ES' },
  { v: 'french', label: 'French', bcp: 'fr-FR' },
  { v: 'german', label: 'German', bcp: 'de-DE' },
]

// The Whisper worker is deliberately one shared instance (loading the model twice would
// double the memory/download); requests are routed by monotonic `reqSeq` id, so several
// cards can share it safely. Teardown is per-card (keyed by container) and refcounted so
// closing one card never terminates a worker another card is still using.
let worker: Worker | null = null
let consented = false
let liveInstances = 0
const cleanups = new WeakMap<HTMLElement, () => void>()
let reqSeq = 0

function getWorker(): Worker {
  worker ??= new Worker(new URL('../../workers/stt.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

async function decodeToMono16k(file: Blob): Promise<Float32Array> {
  const arrayBuf = await file.arrayBuffer()
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(arrayBuf)
  } finally {
    await ctx.close()
  }
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

function transcribe(audio: Float32Array, model: string, language: string, onStatus: (s: string) => void): Promise<string> {
  const id = ++reqSeq
  return new Promise((resolve, reject) => {
    const w = getWorker()
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (m.id !== id) return // a different in-flight request
      if (m.type === 'status') onStatus(m.text)
      else if (m.type === 'progress') {
        if (m.data?.status === 'progress' && typeof m.data.progress === 'number') {
          onStatus(`Downloading ${m.data.file ?? 'model'}... ${Math.round(m.data.progress)}%`)
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
    w.postMessage({ id, audio, model, language })
  })
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    liveInstances++
    let torn = false // set on deactivate: teardown must not transcribe or respawn the worker
    const modelSel = el('select') as HTMLSelectElement
    modelSel.append(...MODELS.map((m) => el('option', { value: m.id, text: m.label })))
    const langSel = el('select') as HTMLSelectElement
    langSel.append(...LANGS.map((l) => el('option', { value: l.v, text: l.label })))

    const fileInput = el('input', { type: 'file', accept: 'audio/*,video/*' }) as HTMLInputElement
    const status = el('div', { class: 'muted' })
    const out = el('pre', { text: '' })

    const ensureConsent = async (): Promise<boolean> => {
      if (consented) return true
      consented = await consent({
        title: 'Download speech model',
        permissions: ['Download a Whisper model of tens of MB from huggingface.co, cached after the first use', 'Run speech-to-text fully on your device'],
        runLabel: 'Download & transcribe',
      })
      return consented
    }

    const runAudio = async (blob: Blob, append: boolean) => {
      if (torn) return // deactivated before/while this fired: never respawn the worker or prompt
      if (!(await ensureConsent())) return
      status.textContent = 'Decoding audio...'
      try {
        const audio = await decodeToMono16k(blob)
        const text = await transcribe(audio, modelSel.value, langSel.value, (s) => {
          status.textContent = s
        })
        const clean = text.trim() || '(no speech detected)'
        out.textContent = append && out.textContent ? `${out.textContent}\n${clean}` : clean
        status.textContent = 'Done.'
      } catch (e) {
        status.textContent = `Failed: ${(e as Error).message}. Video files may need the ffmpeg add-on, which is not shipped yet.`
      }
    }

    const runFile = () => {
      const f = fileInput.files?.[0]
      if (!f) {
        toast('Choose an audio/video file')
        return
      }
      void runAudio(f, false)
    }

    // --- Private mic recording, transcribed by Whisper ---
    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = []
    const recBtn = button('🔴 Record', () => void toggleRecord(), 'ghost', 'Record the mic, transcribe on-device')
    async function toggleRecord() {
      if (recorder && recorder.state === 'recording') {
        recorder.stop()
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        chunks = []
        recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (ev) => {
          if (ev.data.size) chunks.push(ev.data)
        }
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop())
          recBtn.textContent = '🔴 Record'
          if (torn) return // stopped by teardown, not the user: don't transcribe
          const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
          void runAudio(blob, true)
        }
        recorder.start()
        recBtn.textContent = '⏹ Stop & transcribe'
      } catch {
        toast('Microphone blocked')
      }
    }

    // --- Opt-in live cloud transcription via Web Speech ---
    const SR = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
    const SpeechRec = (SR.SpeechRecognition ?? SR.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined
    let recognition: SpeechRecognitionLike | null = null
    const liveBtn = button('Live (cloud)', toggleLive, 'ghost', 'Real-time via the browser speech service, which sends audio to a third party')
    function toggleLive() {
      if (recognition) {
        recognition.stop()
        return
      }
      if (!SpeechRec) {
        toast('Live recognition not supported here')
        return
      }
      if (!confirm('Live transcription uses your browser speech service, which sends audio to a third party such as Google on Chrome. Continue?')) return
      const r = new SpeechRec()
      recognition = r
      r.continuous = true
      r.interimResults = true
      r.lang = (LANGS.find((l) => l.v === langSel.value) ?? LANGS[0]).bcp
      let finalText = out.textContent ?? ''
      r.onresult = (ev) => {
        let interim = ''
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i]
          if (res.isFinal) finalText += res[0].transcript
          else interim += res[0].transcript
        }
        out.textContent = finalText + interim
      }
      r.onend = () => {
        recognition = null
        liveBtn.textContent = 'Live (cloud)'
      }
      r.onerror = () => toast('Live recognition error')
      r.start()
      liveBtn.textContent = '⏹ Stop live'
    }

    const copy = async () => {
      try {
        await ctx.clipboard.write(out.textContent ?? '')
        toast('Copied')
      } catch {
        toast('Copy blocked')
      }
    }

    container.append(
      el('div', { class: 'row' }, [
        el('label', { class: 'row' }, [el('span', { text: 'Model' }), modelSel]),
        el('label', { class: 'row' }, [el('span', { text: 'Language' }), langSel]),
      ]),
      el('div', { class: 'row gap' }, [fileInput, button('Transcribe file', runFile, 'primary', 'Transcribe the chosen file on-device')]),
      el('div', { class: 'row gap' }, [recBtn, liveBtn, button('Copy', copy, 'ghost', 'Copy the transcript')]),
      el('p', {
        class: 'muted',
        text: 'Files and recordings transcribe privately on your device with Whisper. Live (cloud) uses the browser speech service and sends audio to a third party.',
      }),
      status,
      out,
    )

    cleanups.set(container, () => {
      torn = true
      try {
        recognition?.stop()
      } catch {
        /* ignore */
      }
      try {
        if (recorder?.state === 'recording') recorder.stop()
      } catch {
        /* ignore */
      }
    })
  },

  deactivate(container: HTMLElement) {
    cleanups.get(container)?.()
    cleanups.delete(container)
    // Only terminate the shared worker when the last card closes.
    if (--liveInstances <= 0) {
      liveInstances = 0
      worker?.terminate()
      worker = null
    }
  },
}

// Minimal structural type for the Web Speech API, which lib.dom does not type across engines.
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

export default tool
