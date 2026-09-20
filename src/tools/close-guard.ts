import { getItem, setItem } from '../core/store'

// "Ask when closing tab". A beforeunload listener that calls preventDefault is the only
// lever a page has. The browser then shows its own generic confirmation, and only if the
// tab has already been interacted with. A custom message is not possible.
//
// Two independent reasons arm it, ORed: the stored preference, off by default and
// re-armed at boot if it was left on, and live local media, which is transient and never
// stored. Because they are ORed, turning the preference off mid-share leaves the share
// guarded, and ending a share leaves the preference guarded.
//
// State is module-level because there is exactly one window to guard, unlike per-card tool
// state which must be keyed by its container.

const KEY = 'ask-on-close'
let handler: ((e: BeforeUnloadEvent) => void) | null = null
let stored = false
let transient = false

/** Install or remove the listener for the OR of the two reasons. Idempotent. */
function applyCloseGuard(): void {
  const on = stored || transient
  // beforeunload leaves no trace anywhere else, so the decision is mirrored on the root
  // element: it is the only way to observe the armed state from outside this module.
  document.documentElement.dataset.closeGuard = on ? 'on' : 'off'
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
  stored = on
  applyCloseGuard() // applied first, so the guard holds even if the write fails
  await setItem(KEY, on)
}

/** Arm the guard for as long as something closing the tab would destroy is running, with
 *  no effect on the stored preference: local media, which no reload can bring back. */
export function setTransientGuard(on: boolean): void {
  if (transient === on) return
  transient = on
  applyCloseGuard()
}

/** Boot hook that re-arms a guard left on. Safe to call before any UI exists. */
export async function initCloseGuard(): Promise<void> {
  stored = await getCloseGuard()
  applyCloseGuard()
}
