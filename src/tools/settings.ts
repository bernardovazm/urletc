import { disablePassphrase, enablePassphrase, getItem, getStoreMode, lock, setItem } from '../core/store'
import type { ToolModule } from '../shell/registry'
import { button, el, toast } from '../shell/ui'
import { getCloseGuard, setCloseGuard } from './close-guard'

// Manages the at-rest encryption mode (ARCHITECTURE section 9) plus the console's
// proactivity switches (auto-OCR on images, live mic captions). Built-in/trusted,
// so it talks to the store directly rather than through the capability facade.

const tool: ToolModule = {
  async activate(container: HTMLElement) {
    const render = async () => {
      container.replaceChildren()
      const mode = await getStoreMode()
      container.append(
        el('p', { class: 'muted', text: `At-rest encryption: ${mode === 'passphrase' ? 'passphrase lock, key held in memory only' : 'device key, stored on this device'}` }),
      )

      if (mode === 'device') {
        const pw1 = el('input', { type: 'password', class: 'full', placeholder: 'New vault passphrase', 'aria-label': 'New vault passphrase' }) as HTMLInputElement
        const pw2 = el('input', { type: 'password', class: 'full', placeholder: 'Confirm passphrase', 'aria-label': 'Confirm passphrase' }) as HTMLInputElement
        const enable = async () => {
          if (pw1.value.length < 8) {
            toast('Use at least 8 characters')
            return
          }
          if (pw1.value !== pw2.value) {
            toast('Passphrases do not match')
            return
          }
          try {
            await enablePassphrase(pw1.value)
            toast('Passphrase lock enabled')
            await render()
          } catch (e) {
            toast(`Failed: ${(e as Error).message}`)
          }
        }
        container.append(
          el('p', {
            class: 'muted',
            text: 'Passphrase lock derives the key from a passphrase held only in memory. That is the real protection against an offline copy and a later XSS. If you forget it, your stored data is unrecoverable by design.',
          }),
          pw1,
          pw2,
          el('div', { class: 'row' }, [button('Enable passphrase lock', () => void enable(), 'primary')]),
        )
      } else {
        const disable = async () => {
          if (!confirm('Disable passphrase lock? Data reverts to device-key encryption, which opens without a passphrase.')) return
          try {
            await disablePassphrase()
            toast('Passphrase lock disabled')
            await render()
          } catch (e) {
            toast(`Failed: ${(e as Error).message}`)
          }
        }
        container.append(
          el('div', { class: 'row' }, [
            button(
              'Lock now',
              () => {
                lock()
                location.reload()
              },
              'primary',
            ),
            button('Disable passphrase lock', () => void disable(), 'danger'),
          ]),
        )
      }

      // Console proactivity: how hard the surface works unprompted. Auto-OCR
      // default is "copy": an image that lands is usually wanted as text.
      const ocrSel = el('select', { title: 'What happens when an image is pasted or attached' }) as HTMLSelectElement
      ocrSel.append(
        el('option', { value: 'copy', text: 'read text + copy it automatically' }),
        el('option', { value: 'show', text: 'read text, but leave the clipboard alone' }),
        el('option', { value: 'off', text: 'off, with a manual Run OCR button' }),
      )
      const ocrCur = await getItem<string>('image-ocr')
      ocrSel.value = ocrCur === 'off' || ocrCur === 'show' ? ocrCur : 'copy'
      ocrSel.addEventListener('change', () => void setItem('image-ocr', ocrSel.value))
      const ccChk = el('input', { type: 'checkbox' }) as HTMLInputElement
      ccChk.checked = (await getItem<boolean>('live-captions')) ?? false
      ccChk.addEventListener('change', () => void setItem('live-captions', ccChk.checked))
      // Nearby is the one tier that announces you to strangers (same public IP),
      // so it gets an off switch. Applies live; the console listens for the event.
      const nbChk = el('input', { type: 'checkbox' }) as HTMLInputElement
      nbChk.checked = (await getItem<boolean>('nearby-on')) ?? true
      nbChk.addEventListener('change', () => {
        void setItem('nearby-on', nbChk.checked)
        window.dispatchEvent(new CustomEvent('wt:nearby', { detail: nbChk.checked }))
      })
      // Presence: OFF by default. Unlike nearby (same network) this announces you to
      // everyone running the app, so it is opt-in. It carries no messages/files/media.
      const prChk = el('input', { type: 'checkbox' }) as HTMLInputElement
      prChk.checked = (await getItem<boolean>('presence-on')) ?? false
      prChk.addEventListener('change', () => {
        void setItem('presence-on', prChk.checked)
        window.dispatchEvent(new CustomEvent('wt:presence', { detail: prChk.checked }))
      })
      // Ask when closing tab. A preference, not a utility: it belongs to the window and
      // has to survive a reload, so it lives here and is re-armed at boot rather than in
      // a tool card that would take the guard down with it when closed.
      const acChk = el('input', { type: 'checkbox' }) as HTMLInputElement
      acChk.checked = await getCloseGuard()
      acChk.addEventListener('change', () => void setCloseGuard(acChk.checked))
      container.append(
        el('div', { class: 'group-label', text: 'Console proactivity' }),
        el('label', { class: 'row small' }, [el('span', { text: 'Images pasted into the feed:' }), ocrSel]),
        el('label', { class: 'row small' }, [ccChk, el('span', { text: 'Live-caption my microphone with on-device Whisper whenever I share it' })]),
        el('div', { class: 'group-label', text: 'Presence' }),
        el('label', { class: 'row small' }, [
          nbChk,
          el('span', { text: 'Nearby discovery: devices on this network find each other automatically. Turn it off to stay invisible outside your rooms.' }),
        ]),
        el('label', { class: 'row small' }, [
          prChk,
          el('span', {
            text: 'Online list. See everyone else using the app right now, and let them see you. Presence only: no messages, files or media travel over it.',
          }),
        ]),
        el('div', { class: 'group-label', text: 'This tab' }),
        el('label', { class: 'row small' }, [
          acChk,
          el('span', {
            text: 'Ask when closing tab. The browser shows its own generic confirmation, only after you have interacted with the page, and the wording cannot be changed.',
          }),
        ]),
      )
    }
    await render()
  },
}

export default tool
