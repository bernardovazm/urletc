// Pinned tickers in the top bar: market prices (ticker-markets.ts) and the default place's
// weather (ticker-weather.ts). This host owns placement, fit, the overflow menu and the
// page lifecycle; each source owns its data and its one refresh loop. Those loops are the
// shell's only background fetches, so they run only while the tab is visible and online,
// and the console never mounts any of this in stage view, so an OBS source or a second
// screen makes no request.
//
// Placement: right after the code chip, before the spacer, so the tickers sit with the
// identity side of the bar and never displace a control. When the bar runs out of room the
// trailing tickers are hidden whole, never clipped, and a "+N" button lists them all. At
// 560px and below the bar has no room for any, so they move to a scrollable rail under it,
// a sibling of .topbar rather than a child, which keeps the bar's own fit unchanged.

import type { Direction } from '../core/market-data'
import { button, el } from './ui'

/** One button on the bar, as a source describes it. */
export interface TickerItem {
  /** Unique across sources. */
  key: string
  /** The data attribute that addresses this ticker, e.g. ['market', 'c:bitcoin']. */
  attr: [string, string]
  sym: string
  value: string
  chg: { text: string; dir: Direction } | null
  stale: boolean
  label: string
  title: string
  /** For the overflow menu's button titles. */
  name: string
  open(): void
  unpin(): void
}

export interface SourceHost {
  /** Repaint the bar from the sources' current items. */
  changed(): void
  /** Bring a tool's card into view, or launch one. True when a card was already open. */
  openCard(toolId: string): boolean
  /** An open card of the tool is still loading its module, as on a reload of #/t/<id>. */
  cardLoading(toolId: string): boolean
}

export interface TickerSource {
  items(): TickerItem[]
  start(host: SourceHost): void
  /** The tab was hidden or went offline: hold no timer. */
  pause(): void
  /** The tab is visible again, or back online (`reconnected`): refresh whatever is due. */
  resume(reconnected: boolean): void
}

export interface TickerBar {
  /** The narrow-screen row; the console places it between the top bar and the body. */
  rail: HTMLElement
  /** Repaint and re-fit, as after the bar's other contents changed. */
  render(): void
}

interface Options {
  topbar: HTMLElement
  /** The bar child the tickers follow. */
  after: HTMLElement
  /** The console's floating-menu placement, so the "+N" menu opens like every other one. */
  placeMenu: (menu: HTMLElement, anchor: DOMRect) => void
  /** Open a new card of a tool. */
  launch: (toolId: string) => void
  sources: TickerSource[]
}

const RAIL_QUERY = '(max-width: 560px)'

export function mountTickers(o: Options): TickerBar {
  const host = el('div', { class: 'tickers hidden', role: 'group', 'aria-label': 'Pinned to the top bar' })
  // A disclosure, not a menu: the list is a group of ordinary buttons reached with Tab.
  const more = el('button', { class: 'ticker-more tk-off', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'ticker-menu' })
  host.append(more)
  const rail = el('div', { class: 'ticker-rail' })
  const rootEl = document.documentElement
  const narrow = window.matchMedia(RAIL_QUERY)
  const buttons = new Map<string, HTMLElement>()
  let items: TickerItem[] = []
  let menu: HTMLElement | null = null
  let fitQueued = 0

  const place = () => {
    if (narrow.matches) rail.append(host)
    else o.after.after(host)
  }
  place()

  const openCard = (toolId: string): boolean => {
    closeMenu()
    const card = document.querySelector<HTMLDetailsElement>(`.feed details.card[data-tool="${toolId}"]`)
    if (!card) {
      o.launch(toolId)
      return false
    }
    card.open = true
    card.scrollIntoView({ block: 'nearest' })
    return true
  }

  const create = (it: TickerItem): HTMLElement => {
    const b = el('button', { class: 'ticker', type: 'button' }, [el('span', { class: 'tk-sym' }), el('span', { class: 'tk-price' }), el('span', { class: 'tk-chg' })])
    b.dataset[it.attr[0]] = it.attr[1]
    b.addEventListener('click', () => items.find((x) => x.key === it.key)?.open())
    buttons.set(it.key, b)
    return b
  }

  const paint = (b: HTMLElement, it: TickerItem) => {
    const [sym, value, chg] = b.children
    sym.textContent = it.sym
    value.textContent = it.value
    chg.textContent = it.chg?.text ?? ''
    chg.className = `tk-chg ${it.chg?.dir ?? ''}`
    b.classList.toggle('stale', it.stale)
    b.setAttribute('aria-label', it.label)
    b.title = it.title
  }

  // ---------- fit ----------
  // Every bar child is nowrap (tokens.css), so nothing hides overflow by wrapping. The last
  // visible control must also end inside the content box: scrollWidth leaves the inline-end
  // padding out, and on its own let a full bar push the roster toggle flush with the edge.
  const fits = () => {
    const t = o.topbar
    if (t.scrollWidth > t.clientWidth) return false
    const kids = [...t.children]
    for (let i = kids.length - 1; i >= 0; i--) {
      const r = kids[i].getBoundingClientRect()
      if (!r.width && !r.height) continue // display: none
      return r.right <= t.getBoundingClientRect().right - parseFloat(getComputedStyle(t).paddingRight) + 0.5
    }
    return true
  }
  const visible = (b: HTMLElement) => !b.classList.contains('tk-off') && b.offsetParent !== null
  /** Focus "+N" when it shows, else the first ticker on the bar. */
  const focusBar = () => (visible(more) ? more : [...buttons.values()].find(visible))?.focus()
  const fit = () => {
    window.cancelAnimationFrame(fitQueued)
    fitQueued = 0
    const focused = document.activeElement as HTMLElement | null
    const focusedHere = !!focused && host.contains(focused)
    fitPass()
    // A ticker that is now behind "+N" cannot hold focus; hand it to "+N" instead.
    if (focusedHere && focused && (document.activeElement !== focused || !visible(focused))) {
      if (visible(focused)) focused.focus({ preventScroll: true })
      else focusBar()
    }
  }
  const fitPass = () => {
    const list = items.map((it) => buttons.get(it.key)).filter((b): b is HTMLElement => !!b)
    for (const b of list) b.classList.remove('tk-off')
    more.classList.add('tk-off')
    if (narrow.matches || !list.length || fits()) {
      // Everything fits, so "+N" is gone; a list anchored to it closes, and focus that was
      // in it moves to the first ticker.
      if (menu) {
        const had = menu.contains(document.activeElement)
        closeMenu()
        if (had) focusBar()
      }
      return
    }
    more.classList.remove('tk-off')
    let hidden = 0
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].classList.add('tk-off')
      hidden++
      more.textContent = `+${hidden}`
      if (fits()) break
    }
    more.setAttribute('aria-label', `${hidden} more pinned ${hidden === 1 ? 'item' : 'items'}`)
    more.title = 'Everything pinned to the top bar'
    // Not even "+N" fits: the bar's own controls take the whole width. The cards still
    // hold every pin.
    if (!fits()) more.classList.add('tk-off')
  }
  const queueFit = () => {
    if (!fitQueued) fitQueued = window.requestAnimationFrame(fit)
  }
  new ResizeObserver(queueFit).observe(o.topbar)
  // The other children change width on their own (status chip, code chip, tool pins, the
  // screen controls), and none of that resizes the bar itself. Mutations inside the host
  // are this module's own.
  new MutationObserver((records) => {
    if (records.some((r) => !host.contains(r.target))) queueFit()
  }).observe(o.topbar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  narrow.addEventListener('change', () => {
    closeMenu()
    place()
    fit()
  })
  void document.fonts?.ready.then(queueFit)

  // ---------- overflow menu ----------
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu()
      focusBar()
    }
  }
  const onMenuPointer = (e: Event) => {
    const t = e.target as Node
    if (menu && !menu.contains(t) && !more.contains(t)) closeMenu()
  }
  function closeMenu() {
    if (!menu) return
    menu.remove()
    menu = null
    more.setAttribute('aria-expanded', 'false')
    document.removeEventListener('keydown', onMenuKey)
    document.removeEventListener('pointerdown', onMenuPointer, true)
  }
  // Rebuilt on every repaint (each price or forecast load), so the focused button is found
  // again by row and part afterwards: the same row, else the row that took the place of an
  // unpinned one, else the one before it.
  function fillMenu() {
    if (!menu) return
    const active = document.activeElement as HTMLElement | null
    const had = !!active && menu.contains(active)
    if (!items.length) {
      closeMenu()
      if (had) focusBar()
      return
    }
    const was = had && active ? { key: active.closest<HTMLElement>('.tk-menu-row')?.dataset.key ?? '', part: active.dataset.part ?? '' } : null
    const before = [...menu.querySelectorAll<HTMLElement>('.tk-menu-row')].map((r) => r.dataset.key ?? '')
    const part = (b: HTMLElement, name: string) => {
      b.dataset.part = name
      return b
    }
    menu.replaceChildren(
      el('div', { class: 'group-label', text: 'Pinned to the top bar' }),
      ...items.map((it) =>
        el('div', { class: `tk-menu-row${it.stale ? ' stale' : ''}`, 'data-key': it.key }, [
          el('span', { class: 'tk-sym', text: it.sym }),
          el('span', { class: 'tk-price', text: it.value }),
          el('span', { class: `tk-chg ${it.chg?.dir ?? ''}`, text: it.chg?.text ?? '' }),
          el('span', { class: 'spacer' }),
          part(
            button('Open', () => it.open(), 'ghost', `Open ${it.name}`),
            'open',
          ),
          part(
            button('Unpin', () => it.unpin(), 'ghost', `Take ${it.name} off the top bar`),
            'unpin',
          ),
        ]),
      ),
    )
    if (!was) return
    const now = new Set(items.map((it) => it.key))
    const i = before.indexOf(was.key)
    const key = now.has(was.key)
      ? was.key
      : (before.slice(i + 1).find((k) => now.has(k)) ??
        before
          .slice(0, Math.max(0, i))
          .reverse()
          .find((k) => now.has(k)))
    const target = key ? menu.querySelector<HTMLElement>(`.tk-menu-row[data-key="${CSS.escape(key)}"] [data-part="${was.part || 'open'}"]`) : null
    if (target) target.focus({ preventScroll: true })
    else focusBar()
  }
  more.addEventListener('click', () => {
    if (menu) {
      closeMenu()
      return
    }
    menu = el('div', { class: 'menu ticker-menu', id: 'ticker-menu', role: 'group', 'aria-label': 'Pinned to the top bar' })
    fillMenu()
    document.body.append(menu)
    o.placeMenu(menu, more.getBoundingClientRect())
    more.setAttribute('aria-expanded', 'true')
    document.addEventListener('keydown', onMenuKey)
    document.addEventListener('pointerdown', onMenuPointer, true)
    menu.querySelector<HTMLElement>('button')?.focus()
  })

  // ---------- render ----------
  const render = () => {
    items = o.sources.flatMap((s) => s.items())
    rootEl.classList.toggle('has-tickers', items.length > 0)
    host.classList.toggle('hidden', !items.length)
    const keys = new Set(items.map((it) => it.key))
    for (const [key, b] of buttons) {
      if (!keys.has(key)) {
        b.remove()
        buttons.delete(key)
      }
    }
    items.forEach((it, i) => {
      const b = buttons.get(it.key) ?? create(it)
      if (host.children[i] !== b) host.insertBefore(b, host.children[i] ?? more)
      paint(b, it)
    })
    if (menu) fillMenu()
    fit()
  }

  // ---------- lifecycle ----------
  // launchTool appends an empty container to the card body and the tool fills it on
  // activation; a failed load fills it with the error, so empty means still loading.
  const cardLoading = (toolId: string) => !!document.querySelector(`.feed details.card[data-tool="${toolId}"][open] > .card-body > div:empty`)
  const sourceHost: SourceHost = { changed: render, openCard, cardLoading }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const s of o.sources) s.pause()
      return
    }
    render() // flip anything that aged into stale while hidden
    for (const s of o.sources) s.resume(false)
  })
  window.addEventListener('offline', () => {
    for (const s of o.sources) s.pause()
    render()
  })
  window.addEventListener('online', () => {
    render()
    for (const s of o.sources) s.resume(true)
  })
  for (const s of o.sources) s.start(sourceHost)

  return { rail, render }
}
