import type { ToolModule } from '../shell/registry'
import { button, el, toast } from '../shell/ui'

// The pre-meeting gear check, without leaving the app: see yourself, watch the mic
// level, hear yourself through a delayed loopback so the echo is distinguishable from
// your own voice, record a short sample to play back or download, and beep the
// speakers. Everything stays on-device.

// Per-card teardown, keyed by container: several open cards share this module object,
// so a module-scoped handle would let a second card's teardown clobber the first's.
const cleanups = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement) {
    let stream: MediaStream | null = null
    let ac: AudioContext | null = null
    let raf = 0
    let loop: { src: MediaStreamAudioSourceNode; delay: DelayNode } | null = null
    let recorder: MediaRecorder | null = null
    let recInterval = 0
    let lastUrl = ''

    const video = el('video', { class: 'preview mirror', autoplay: '', playsinline: '' }) as HTMLVideoElement
    video.muted = true
    const meterFill = el('div', { class: 'meter-fill' })
    const meter = el('div', { class: 'meter', title: 'Mic level' }, [meterFill])
    const status = el('div', { class: 'muted small', text: 'Everything runs on this device; nothing is uploaded.' })
    const info = el('div', { class: 'muted small' })
    const camSel = el('select', { title: 'Camera' }) as HTMLSelectElement
    const micSel = el('select', { title: 'Microphone' }) as HTMLSelectElement
    const results = el('div', { class: 'stack' })

    const fillDevices = async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const fill = (kind: MediaDeviceKind, sel: HTMLSelectElement, label: string) => {
          const cur = sel.value
          sel.replaceChildren(...devs.filter((d) => d.kind === kind).map((d, i) => el('option', { value: d.deviceId, text: d.label || `${label} ${i + 1}` })))
          if (cur) sel.value = cur
        }
        fill('videoinput', camSel, 'Camera')
        fill('audioinput', micSel, 'Microphone')
      } catch {
        /* enumeration blocked until permission is granted */
      }
    }

    const stopAll = () => {
      cancelAnimationFrame(raf)
      if (recInterval) {
        window.clearInterval(recInterval)
        recInterval = 0
      }
      try {
        if (recorder?.state === 'recording') recorder.stop()
      } catch {
        /* already stopped */
      }
      recorder = null
      loop?.src.disconnect()
      loop?.delay.disconnect()
      loop = null
      loopChk.checked = false
      if (ac) {
        void ac.close()
        ac = null
      }
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.srcObject = null
      video.classList.add('hidden')
      meterFill.style.width = '0%'
      startBtn.textContent = 'Start test'
    }

    const start = async () => {
      stopAll()
      status.textContent = 'Requesting camera and microphone...'
      const audio: MediaStreamConstraints['audio'] = micSel.value ? { deviceId: { exact: micSel.value } } : true
      const videoC: MediaStreamConstraints['video'] = camSel.value ? { deviceId: { exact: camSel.value } } : true
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: videoC })
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio })
          toast('Camera unavailable. Testing the mic only')
        } catch {
          status.textContent = 'Microphone/camera denied or unavailable. Check the browser permission prompt.'
          return
        }
      }
      await fillDevices() // device labels only appear after permission
      const vt = stream.getVideoTracks()[0]
      const at = stream.getAudioTracks()[0]
      if (vt) {
        video.srcObject = stream
        video.classList.remove('hidden')
      }
      const vs = vt?.getSettings()
      info.textContent = [
        vt ? `📷 ${vt.label || 'camera'} (${vs?.width ?? '?'}x${vs?.height ?? '?'}${vs?.frameRate ? ` @ ${Math.round(vs.frameRate)} fps` : ''})` : '📷 no camera',
        at ? `🎙 ${at.label || 'microphone'}` : '🎙 no microphone',
      ].join(',   ')
      if (at) {
        ac = new AudioContext()
        const src = ac.createMediaStreamSource(new MediaStream([at]))
        const an = ac.createAnalyser()
        an.fftSize = 512
        src.connect(an)
        const buf = new Float32Array(an.fftSize)
        const tick = () => {
          an.getFloatTimeDomainData(buf)
          let peak = 0
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
          meterFill.style.width = `${Math.min(100, Math.round(peak * 140))}%`
          meterFill.classList.toggle('hot', peak > 0.9)
          raf = requestAnimationFrame(tick)
        }
        tick()
      }
      status.textContent = 'Live. Speak, and the level bar should move. If the picture and the bar look right, you are meeting-ready.'
      startBtn.textContent = '🔄 Restart'
    }

    const startBtn = button('Start test', () => void start(), 'primary', 'Turn the camera and microphone on locally; nothing is shared')

    // Loopback: route the mic to the speakers a beat later, so you can judge your own
    // audio without the "talking over myself" effect. Headphones, or it will feed back.
    const loopChk = el('input', { type: 'checkbox' }) as HTMLInputElement
    loopChk.addEventListener('change', () => {
      if (!ac || !stream?.getAudioTracks().length) {
        loopChk.checked = false
        toast('Start the test first')
        return
      }
      if (loopChk.checked) {
        const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
        const delay = ac.createDelay(1)
        delay.delayTime.value = 0.25
        src.connect(delay)
        delay.connect(ac.destination)
        loop = { src, delay }
      } else {
        loop?.src.disconnect()
        loop?.delay.disconnect()
        loop = null
      }
    })

    const record = () => {
      if (!stream) {
        toast('Start the test first')
        return
      }
      if (recorder) return
      const isVideo = stream.getVideoTracks().length > 0
      const chunks: Blob[] = []
      const r = new MediaRecorder(stream)
      recorder = r
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      r.onstop = () => {
        recorder = null
        recBtn.textContent = '🔴 Record 5s sample'
        const blob = new Blob(chunks, { type: chunks[0]?.type || (isVideo ? 'video/webm' : 'audio/webm') })
        if (lastUrl) URL.revokeObjectURL(lastUrl)
        lastUrl = URL.createObjectURL(blob)
        const media = el(isVideo ? 'video' : 'audio', { controls: '', class: isVideo ? 'preview' : '' }) as HTMLMediaElement
        media.src = lastUrl
        results.replaceChildren(
          el('div', { class: 'muted small', text: 'Play it back. This is exactly what others would get.' }),
          media,
          el('a', { href: lastUrl, download: `device-check-${Date.now()}.webm`, class: 'small', text: '💾 Download recording' }),
        )
      }
      r.start()
      let left = 5
      recBtn.textContent = `⏹ Recording ${left}s`
      recInterval = window.setInterval(() => {
        left--
        recBtn.textContent = `⏹ Recording ${left}s`
        if (left <= 0) {
          window.clearInterval(recInterval)
          recInterval = 0
          if (r.state === 'recording') r.stop()
        }
      }, 1000)
    }
    const recBtn = button('🔴 Record 5s sample', record, 'ghost', 'Record the mic and camera, then play it back or download it')

    // Speaker check: a short beep through the default output.
    const tone = () => {
      const a = ac ?? new AudioContext()
      const osc = a.createOscillator()
      const g = a.createGain()
      g.gain.value = 0.08
      osc.frequency.value = 440
      osc.connect(g)
      g.connect(a.destination)
      osc.start()
      osc.stop(a.currentTime + 0.6)
      if (!ac) osc.onended = () => void a.close()
      toast('Playing a beep; if you hear it, output works')
    }

    for (const sel of [camSel, micSel]) {
      sel.addEventListener('change', () => {
        if (stream) void start() // live switch: restart on the newly chosen device
      })
    }

    video.classList.add('hidden')
    container.append(
      el('div', { class: 'row' }, [
        startBtn,
        button(
          '⏹ Stop',
          () => {
            stopAll()
            status.textContent = 'Stopped. Camera and microphone are off.'
          },
          'ghost',
          'Turn the camera and microphone off',
        ),
        button('🔔 Test speakers', tone, 'ghost', 'Play a short beep through the default output'),
        recBtn,
      ]),
      el('div', { class: 'row' }, [
        el('label', { class: 'row small' }, [el('span', { text: 'Camera' }), camSel]),
        el('label', { class: 'row small' }, [el('span', { text: 'Mic' }), micSel]),
      ]),
      status,
      video,
      meter,
      el('label', { class: 'row small' }, [loopChk, el('span', { text: 'Hear myself, delayed by a quarter second. Wear headphones, open speakers will feed back' })]),
      info,
      results,
    )
    void fillDevices()

    cleanups.set(container, () => {
      stopAll()
      if (lastUrl) URL.revokeObjectURL(lastUrl)
    })
  },

  deactivate(container: HTMLElement) {
    cleanups.get(container)?.()
    cleanups.delete(container)
  },
}

export default tool
