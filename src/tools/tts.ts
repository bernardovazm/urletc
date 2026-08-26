import type { ToolContext, ToolModule } from '../shell/registry'
import { button, el, toast } from '../shell/ui'

// Default TTS uses the browser's built-in SpeechSynthesis, filtered to ON-DEVICE
// (localService) voices only. Cloud voices silently POST text off-device, which
// breaks privacy-by-default (ARCHITECTURE section 4.4). Kokoro is a planned opt-in
// add-on: higher quality, but a large download behind explicit consent.

// Per-card cleanup keyed by container: the cached module is shared across open cards, so
// a module-level handle would let one card's teardown detach another card's listener.
const cleanups = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    if (!('speechSynthesis' in window)) {
      container.append(el('p', { class: 'muted', text: 'SpeechSynthesis is not supported in this browser.' }))
      return
    }

    const input = el('textarea', { placeholder: 'Text to speak' }) as HTMLTextAreaElement
    const voiceSel = el('select') as HTMLSelectElement
    const rate = el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: '1' }) as HTMLInputElement
    const note = el('div', { class: 'muted small' })
    // Some platforms (e.g. Chrome on Linux) ship NO on-device voices, so the private
    // default would render an empty list. Cloud voices stay opt-in with a clear label.
    const cloudChk = el('input', { type: 'checkbox' }) as HTMLInputElement
    let shownVoices: SpeechSynthesisVoice[] = []

    const fillVoices = () => {
      const all = speechSynthesis.getVoices()
      const local = all.filter((v) => v.localService)
      shownVoices = cloudChk.checked ? all : local
      voiceSel.replaceChildren(...shownVoices.map((v, i) => el('option', { value: String(i), text: `${v.name} (${v.lang}${v.localService ? '' : ', cloud'})` })))
      note.textContent = shownVoices.length
        ? cloudChk.checked
          ? `${shownVoices.length} voice(s). Cloud voices send the text to the browser vendor to synthesize.`
          : `${shownVoices.length} on-device voice(s). Text never leaves this device.`
        : local.length === 0 && all.length > 0
          ? 'This platform has no on-device voices. Tick Show cloud voices to use the browser-vendor ones.'
          : 'No voices found yet. Voice lists load asynchronously and appear in a moment.'
    }
    fillVoices()
    speechSynthesis.addEventListener('voiceschanged', fillVoices)
    cloudChk.addEventListener('change', fillVoices)

    const speak = () => {
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(input.value)
      const v = shownVoices[Number(voiceSel.value)]
      if (v) u.voice = v
      u.rate = Number(rate.value)
      u.onerror = () => toast('Speech failed')
      speechSynthesis.speak(u)
    }

    const pasteAndSpeak = async () => {
      try {
        input.value = await ctx.clipboard.readText()
        speak()
      } catch {
        toast('Clipboard read blocked')
      }
    }

    container.append(
      input,
      el('div', { class: 'row' }, [
        el('label', { class: 'row' }, [el('span', { text: 'Voice' }), voiceSel]),
        el('label', { class: 'row' }, [el('span', { text: 'Rate' }), rate]),
        el('label', { class: 'row small' }, [cloudChk, el('span', { text: 'Show cloud voices' })]),
      ]),
      el('div', { class: 'row' }, [
        button('Speak', speak, 'primary', 'Speak the text above'),
        button('Paste & speak', () => void pasteAndSpeak(), 'ghost', 'Read the clipboard and speak it'),
        button('Pause', () => speechSynthesis.pause(), 'ghost'),
        button('Resume', () => speechSynthesis.resume(), 'ghost'),
        button('Stop', () => speechSynthesis.cancel(), 'ghost'),
      ]),
      note,
    )

    cleanups.set(container, () => {
      speechSynthesis.cancel()
      speechSynthesis.removeEventListener('voiceschanged', fillVoices)
    })
  },
  deactivate(container: HTMLElement) {
    cleanups.get(container)?.()
    cleanups.delete(container)
  },
}

export default tool
