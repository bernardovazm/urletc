import { disablePassphrase, enablePassphrase, getItem, getStoreMode, lock, setItem } from '../core/store'
import type { ToolModule } from '../shell/registry'
import { currentTheme, toggleTheme } from '../shell/theme'
import { button, el, toast } from '../shell/ui'
import { getCloseGuard, setCloseGuard } from './close-guard'

// Manages the at-rest encryption mode (ARCHITECTURE section 9) plus the console's
// proactivity switches (auto-OCR on images, live mic captions). Built-in/trusted,
// so it talks to the store directly rather than through the capability facade.
//
// It is also the only entry point to the theme: the topbar button was removed because the
// topbar is the surface that runs out of room on a phone, and appearance is the least
// frequently touched control on it. The select below drives the same toggleTheme() the
// button did, so nothing can hold a second opinion about which theme is current.

const tool: ToolModule = {
  async activate(container: HTMLElement) {
    const render = async () => {
      container.replaceChildren()

      // First, because it is the one control here people arrive looking for.
      const themeSel = el('select', { class: 'theme-select', title: 'Light or dark appearance for the whole app' }) as HTMLSelectElement
      themeSel.append(el('option', { value: 'dark', text: 'dark' }), el('option', { value: 'light', text: 'light' }))
      themeSel.value = currentTheme()
      themeSel.addEventListener('change', () => {
        if (themeSel.value !== currentTheme()) toggleTheme()
        themeSel.value = currentTheme() // re-read rather than trust the widget
      })
      container.append(el('div', { class: 'group-label', text: 'Appearance' }), el('label', { class: 'row small' }, [el('span', { text: 'Theme:' }), themeSel]))

      const mode = await getStoreMode()
      container.append(
        el('div', { class: 'group-label', text: 'Storage' }),
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
      // 'show' IS the off switch for the automatic copy, so there is no second control
      // for it. It was worded as "leave the clipboard alone" under a label that said
      // neither "OCR" nor "copy", which is why people looked for a switch that was
      // already here; the wording now names the thing being turned off.
      const ocrSel = el('select', {
        class: 'ocr-select',
        title: 'Whether text in an image you paste or attach is read by OCR, and whether that text is copied to your clipboard automatically',
      }) as HTMLSelectElement
      ocrSel.append(
        el('option', { value: 'copy', text: 'read it and copy it to my clipboard automatically' }),
        el('option', { value: 'show', text: 'read it, but never copy to my clipboard' }),
        el('option', { value: 'off', text: 'do not read it; give me a Run OCR button' }),
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
        el('label', { class: 'row small' }, [el('span', { text: 'Text in images you paste or attach (OCR):' }), ocrSel]),
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
