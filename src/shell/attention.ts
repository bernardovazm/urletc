// Background-tab activity signal. With the tab hidden the feed is not on screen at all,
// so peer activity is reported in the two surfaces a backgrounded tab still owns: the
// document title, and the favicon for a pinned tab that renders no title. No Notification
// permission is asked for; a permission prompt on a utility page costs more than the
// problem it solves, and with no backend there is nothing to deliver a push anyway.

/** The title index.html shipped. Captured at module evaluation, which runs inside main.ts's
 *  import graph before any code can write to it, so the restore is the original string and
 *  not a second hardcoded copy that can drift from the markup. */
const BASE_TITLE = document.title
const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
const BASE_ICON = iconLink?.getAttribute('href') ?? ''
/** Same mark, same geometry, inverted ground: at 16px in a tab strip a light/dark flip is
 *  legible where a corner dot would read as a fourth node of the graph already drawn there. */
const ALERT_ICON = '/icon-alert.svg'

/** Above this the count renders as "9+". A tab strip shows only the leading characters, so
 *  an unbounded count ("(147) urletc") spends all of them on digits and pushes the name out;
 *  past a handful the exact figure stops carrying information anyway. */
const MAX_SHOWN = 9

let pending = 0

function render(): void {
  const n = pending > MAX_SHOWN ? `${MAX_SHOWN}+` : String(pending)
  // Prefix, not suffix: a truncated tab shows "(3) ur...", so the count survives the clip
  // that the tail of the title does not.
  document.title = pending ? `(${n}) ${BASE_TITLE}` : BASE_TITLE
  if (iconLink && BASE_ICON) iconLink.setAttribute('href', pending ? ALERT_ICON : BASE_ICON)
  // Installed-PWA-only and Chromium-only, which is why it rides on top of the title rather
  // than replacing it. It answers with a promise, so a browser that refuses lands in the
  // catch instead of throwing into the event handler that got us here.
  if ('setAppBadge' in navigator) void (pending ? navigator.setAppBadge(pending) : navigator.clearAppBadge()).catch(() => {})
}

/**
 * Count one peer-originated event, if the tab is in the background.
 *
 * Called from the individual peer-event handlers and not from the feed's single append
 * point, addCard(): addCard renders everything, including the card for a message you just
 * sent, a tool you just launched and a clipboard scan, so a hook there would mark the tab
 * for the user's own actions and would opt every card added later in by default. Naming
 * the peer-originated events instead is an allow-list, which fails closed.
 */
export function markActivity(): void {
  if (document.visibilityState !== 'hidden') return
  pending++
  render()
}

function clearActivity(): void {
  if (!pending) return
  pending = 0
  render()
}

export function initAttention(): void {
  // Both events, because neither covers every return on its own: switching tabs raises the
  // visibility change while the window keeps the focus it already had, and restoring a
  // minimized or occluded window raises focus on a page some platforms never reported
  // hidden in the first place.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') clearActivity()
  })
  window.addEventListener('focus', clearActivity)
}
