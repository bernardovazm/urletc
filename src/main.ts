import './styles/tokens.css'
import { registerSW } from 'virtual:pwa-register'

import { probeCrypto, type CryptoCaps } from './core/crypto'
import { initStore, unlock } from './core/store'
import { installTrustedTypes } from './core/trusted-types'
import { importPersonalSecret } from './p2p/personal'
import { mountConsole } from './shell/console'
import { applyTheme } from './shell/theme'
import { button, el } from './shell/ui'
import { registerBuiltins } from './tools'
import { initCloseGuard } from './tools/close-guard'

installTrustedTypes() // before anything can construct a Worker
applyTheme() // before paint

async function afterUnlock(app: HTMLElement, caps: CryptoCaps): Promise<void> {
  registerBuiltins()
  void initCloseGuard() // re-arm "Ask when closing tab" if it was left on; never blocks boot

  // Pairing deep-link: import the personal-room secret, then enter the console.
  if (location.hash.startsWith('#/pair')) {
    const s = new URLSearchParams(location.hash.split('?')[1] ?? '').get('s')
    if (s) {
      try {
        await importPersonalSecret(decodeURIComponent(s))
      } catch {
        /* ignore an invalid pairing link */
      }
    }
    history.replaceState(null, '', location.pathname)
  }

  await mountConsole(app, caps)
  registerSW({ immediate: true })
}

function renderUnlock(app: HTMLElement, caps: CryptoCaps): void {
  app.replaceChildren()
  const input = el('input', { type: 'password', class: 'full', placeholder: 'Vault passphrase', 'aria-label': 'Vault passphrase' }) as HTMLInputElement
  const status = el('div', { class: 'muted' })
  const submit = async () => {
    status.textContent = 'Unlocking...'
    try {
      if (await unlock(input.value)) await afterUnlock(app, caps)
      else status.textContent = 'Wrong passphrase.'
    } catch (e) {
      status.textContent = `Unlock failed: ${(e as Error).message}`
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit()
  })
  app.append(
    el('div', { class: 'feed' }, [
      el('div', { class: 'feed-inner stack' }, [
        el('h3', { text: '🔒 utilscript is locked' }),
        el('div', { class: 'muted', text: 'Enter your vault passphrase to decrypt your on-device data.' }),
        input,
        el('div', { class: 'row' }, [button('Unlock', () => void submit(), 'primary')]),
        status,
      ]),
    ]),
  )
  input.focus()
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return
  const caps = await probeCrypto()
  const { locked } = await initStore()
  if (locked) renderUnlock(app, caps)
  else await afterUnlock(app, caps)
}

void boot().catch((e) => {
  const app = document.getElementById('app')
  if (!app) return
  app.replaceChildren(el('pre', { text: `Boot failed:\n${(e as Error).stack ?? String(e)}` }))
})
