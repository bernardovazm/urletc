import { getItem, setItem } from '../core/store'

// "Ask when closing tab". A beforeunload listener that calls preventDefault is the only
// lever a page has. The browser then shows its own generic confirmation, and only if the
// tab has already been interacted with. A custom message is not possible.
//
// Off by default, so the guard is installed only after it is turned on, and re-armed at
// boot if it was left on.
//
// State is module-level because there is exactly one window to guard, unlike per-card tool
// state which must be keyed by its container.

const KEY = 'ask-on-close'
let handler: ((e: BeforeUnloadEvent) => void) | null = null

/** Install or remove the listener. Idempotent. */
function applyCloseGuard(on: boolean): void {
  if (on === (handler !== null)) return
  if (on) {
    handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = true // legacy trigger, still needed by Safari and Chromium below 119
    }
    window.addEventListener('beforeunload', handler)
  } else if (handler) {
    window.removeEventListener('beforeunload', handler)
    handler = null
  }
}

export async function getCloseGuard(): Promise<boolean> {
  try {
    return (await getItem<boolean>(KEY)) ?? false
  } catch {
    return false
  }
}

export async function setCloseGuard(on: boolean): Promise<void> {
  applyCloseGuard(on) // applied first, so the guard holds even if the write fails
  await setItem(KEY, on)
}

/** Boot hook that re-arms a guard left on. Safe to call before any UI exists. */
export async function initCloseGuard(): Promise<void> {
  applyCloseGuard(await getCloseGuard())
}
