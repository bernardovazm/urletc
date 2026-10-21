import './styles/tokens.css'
import { registerSW } from 'virtual:pwa-register'

import { probeCrypto, type CryptoCaps } from './core/crypto'
import { initStore, unlock } from './core/store'
import { updateHeld } from './core/update-hold'
import { installTrustedTypes } from './core/trusted-types'
import { importPersonalSecret } from './p2p/personal'
import { initAttention } from './shell/attention'
import { mountConsole } from './shell/console'
import { applyTheme } from './shell/theme'
import { button, el } from './shell/ui'
import { registerBuiltins } from './tools'
import { initCloseGuard } from './tools/close-guard'

installTrustedTypes() // before anything can construct a Worker
applyTheme() // before paint
initAttention() // listeners for the return, before anything can mark the tab

async function afterUnlock(app: HTMLElement, caps: CryptoCaps): Promise<void> {
  registerBuiltins()
  void initCloseGuard() // re-arm "Ask when closing tab" if it was left on; never blocks boot

  // Pairing deep-link: import the personal-room secret, then enter the console. Holding
  // the secret is all it takes to be an own device (history replay, cam/mic/screen,
  // clipboard auto-share), and anyone can send a #/pair link, so replacing a secret this
  // device already has needs a yes. A fresh install has nothing to hand over yet.
  if (location.hash.startsWith('#/pair')) {
    const s = new URLSearchParams(location.hash.split('?')[1] ?? '').get('s')
    if (s) {
      try {
        await importPersonalSecret(decodeURIComponent(s), () =>
          confirm(
            'Pair this browser with the device that made this link? That device will receive your messages and earlier ' +
              'history, your camera, mic and screen when you share them, and an auto-shared clipboard. ' +
              'Devices paired with your current link disconnect until you pair them again.',
          ),
        )
      } catch {
        /* ignore an invalid pairing link */
      }
    }
    history.replaceState(null, '', location.pathname)
  }

  await mountConsole(app, caps)
  registerSW({ immediate: true, onNeedReload: () => void bundleIsCurrent().then((current) => current || updateWhenIdle()) })
}

// After a deploy the new worker activates and claims every open tab as soon as any tab of
// the origin navigates, and the plugin's default answer is an immediate reload, which ends
// a call or a share mid-stream. The page keeps running on the old bundle instead, says an
// update is ready, and reloads by itself once nothing would be lost.
//
// Read off the DOM because the state lives inside the console: a media element on a live
// track is local or remote media, and an ok peer-state badge is a peer that messages
// reach. A hidden tab with no media reloads even with peers, since they rejoin on their
// own. An armed close guard would turn the reload into a prompt nobody asked for. Work the
// DOM does not show, a transfer in a hidden tab or a dictation, holds it via update-hold.ts.
function liveMedia(): boolean {
  return [...document.querySelectorAll<HTMLMediaElement>('video, audio')].some(
    (m) => m.srcObject instanceof MediaStream && m.srcObject.getTracks().some((t) => t.readyState === 'live'),
  )
}

function reloadIfIdle(): boolean {
  if (updateHeld() || liveMedia() || document.documentElement.dataset.closeGuard === 'on') return false
  if (document.visibilityState !== 'hidden' && document.querySelector('.peer-state.ok')) return false
  location.reload()
  return true
}

/** Whether the bundle this page runs is part of the build now active. The first load after a
 *  deploy already runs the new build from the network, and its worker activating a moment
 *  later read as an update: the page reloaded itself, or showed a false notice. */
async function bundleIsCurrent(): Promise<boolean> {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src
  if (!src) return false
  // sw.ts records the active build's cache name under this key at every activate.
  const current = await (await (await caches.open('wt-meta')).match('/__wt-current-build'))?.text()
  return !!current && !!(await (await caches.open(current)).match(src, { ignoreVary: true }))
}

let noticeShown = false
function showUpdateNotice(): void {
  if (noticeShown) return
  noticeShown = true
  document
    .getElementById('toasts')
    ?.append(
      el('div', { class: 'toast update-ready' }, [
        el('span', { text: 'Update ready. It loads once this tab is idle, or reload when you are done. ' }),
        button('Reload', () => location.reload(), 'small'),
      ]),
    )
}

let updatePending = false
function updateWhenIdle(): void {
  if (updatePending || reloadIfIdle()) return
  updatePending = true
  showUpdateNotice()
  document.addEventListener('visibilitychange', () => void reloadIfIdle())
  window.setInterval(() => void reloadIfIdle(), 5000)
}

// A lazy chunk this tab has not loaded yet is gone from the server once a newer build is
// deployed, and Vite reports the failed import here. Only the notice is shown: an offline
// tab lands here too, and a reload there would not help. Reloading on its own would loop
// when the chunk is missing for another reason, since a #/t/ link reopens the same tool.
window.addEventListener('vite:preloadError', () => {
  if (navigator.onLine) showUpdateNotice()
})

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
        el('h3', { text: '🔒 urletc is locked' }),
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
