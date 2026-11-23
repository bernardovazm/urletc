// Markets: crypto prices and currency rates in one list, priced in a quote currency of the
// user's choosing. Data, cache and fallbacks live in core/market-data.ts and the pins in
// core/market-pins.ts, both shared with the shell's top-bar tickers, so pinning here puts a
// ticker on the bar with no reload and the bar and this card never disagree on a price.
//
// The card polls only while it is open, on screen and in a visible tab, the same rule as
// the disposable inbox, and never in stage view. Every name and symbol on screen comes from
// the catalog; the network supplies numbers only, and those are rendered as text.

import {
  ITEMS,
  FIAT_CODES,
  INTERVALS,
  SOURCE_NAME,
  currencyName,
  direction,
  formatChange,
  formatPrice,
  itemOf,
  knownQuote,
  loadCrypto,
  loadFiat,
  onQuotes,
  type LoadResult,
  type MarketId,
  type MarketItem,
  type MarketKind,
  type Quote,
} from '../core/market-data'
import { MARKET_PINS_EVENT, MAX_PINS, activePins, loadMarketPrefs, marketPrefs, movePin, onFocusRequest, setQuote, takeFocus, takePinHint, togglePin } from '../core/market-pins'
import { Poller, formatTime, setCardPolling, type Failure, type PollOutcome } from '../core/poll'
import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyText, el, toast } from '../shell/ui'

type Filter = 'all' | 'crypto' | 'fiat'

const CRYPTO_KEYS = ITEMS.filter((i) => i.kind === 'crypto').map((i) => i.key)
const PRIMARY: Record<MarketKind, string> = { crypto: 'CoinGecko', fiat: 'Frankfurter' }
const WHAT: Record<MarketKind, string> = { crypto: 'Crypto prices', fiat: 'Currency rates' }
const REASON: Record<Failure, string> = {
  limited: 'is rate limiting',
  down: 'did not answer',
  bad: 'sent an answer that could not be read',
  offline: 'cannot be reached while offline',
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A 64x20 polyline, stretched by CSS. Built with createElementNS and setAttribute, so no markup string is parsed. */
function sparkline(values: number[] | null | undefined): Element {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'mk-spark')
  svg.setAttribute('viewBox', '0 0 64 20')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (values && values.length >= 2) {
    const min = Math.min(...values)
    const span = Math.max(...values) - min || 1
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 64).toFixed(2)},${(18.5 - ((v - min) / span) * 17).toFixed(2)}`)
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', pts.join(' '))
    svg.append(line)
  }
  return svg
}

const dayFormat = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
  } catch {
    return null
  }
})()
/** A YYYY-MM-DD reference date in the reader's format, read as a calendar day (UTC) so no timezone shifts it. */
const formatDay = (iso: string) => (dayFormat && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayFormat.format(new Date(`${iso}T12:00:00Z`)) : iso)

const isStageView = () => document.documentElement.classList.contains('stage-view')

// Per-card teardown keyed by the container: launchTool shares one module instance across
// every open card, so module-level timers would let a second card clobber the first.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    container.classList.add('mk')
    // Announced before the first await, so a ticker starting in the same page load (a
    // reload on #/t/markets) leaves CoinGecko to this card instead of calling it too.
    setCardPolling('markets', container, !document.hidden && navigator.onLine && !isStageView())
    await loadMarketPrefs()

    let dead = false
    let onScreen = true
    let filter: Filter = 'all'
    let query = ''
    // The row a ticker click brought into view, highlighted briefly. Kept here rather than
    // only as a class, because opening a collapsed card starts a refresh that rebuilds rows.
    let flash: { id: MarketId; until: number } | null = null
    let offline = !navigator.onLine
    let shownQuote = marketPrefs().quote
    const result: Record<MarketKind, LoadResult | null> = { crypto: null, fiat: null }

    const quote = () => marketPrefs().quote

    // ---------- header ----------
    const quoteSel = el('select', { class: 'mk-quote', 'aria-label': 'Quote currency' }) as HTMLSelectElement
    quoteSel.replaceChildren(...FIAT_CODES.map((c) => el('option', { value: c, text: `${c} · ${currencyName(c)}` })))
    quoteSel.value = quote()
    // Arrow keys on a focused select fire one change per press. The quote is committed once
    // the user stops, so stepping through four currencies costs one CoinGecko call, not four.
    let pendingQuote: string | null = null
    let quoteTimer = 0
    quoteSel.addEventListener('change', () => {
      pendingQuote = quoteSel.value
      window.clearTimeout(quoteTimer)
      quoteTimer = window.setTimeout(() => {
        const q = pendingQuote
        pendingQuote = null
        if (q && !dead) void setQuote(q)
      }, 400)
    })

    const segButtons = (
      [
        ['all', 'All'],
        ['crypto', 'Crypto'],
        ['fiat', 'Currencies'],
      ] as const
    ).map(([value, label]) => {
      const b = button(label, () => {
        filter = value
        syncSeg()
        renderLists()
      })
      b.dataset.filter = value
      return b
    })
    const syncSeg = () => segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)))
    syncSeg()

    const search = el('input', {
      type: 'search',
      class: 'mk-search',
      placeholder: 'Search',
      'aria-label': 'Search markets',
      spellcheck: 'false',
      autocomplete: 'off',
    }) as HTMLInputElement
    search.addEventListener('input', () => {
      query = search.value.slice(0, 40)
      renderLists()
    })

    const statusEl = el('div', { class: 'mk-status small' })
    const lists = el('div', { class: 'mk-lists' })
    const sourcesEl = el('p', { class: 'mk-sources' })
    const updatedEl = el('span', { class: 'mk-updated' })
    const refreshBtn = button('Refresh', () => void poller.poke(true), 'ghost', 'Fetch prices now')

    container.append(
      el('div', { class: 'mk-head' }, [
        el('label', { class: 'mk-quote-label' }, [el('span', { class: 'muted small', text: 'Prices in' }), quoteSel]),
        el('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Show' }, segButtons),
        search,
      ]),
      statusEl,
      lists,
      el('div', { class: 'mk-foot muted small' }, [sourcesEl, el('div', { class: 'mk-foot-row' }, [updatedEl, el('span', { class: 'spacer' }), refreshBtn])]),
    )

    // ---------- rows ----------
    const onPin = async (item: MarketItem) => {
      const r = await togglePin(item.id)
      if (r === 'full') {
        toast(`Up to ${MAX_PINS} prices can be pinned. Unpin one first.`, 4000)
        return
      }
      if (r === 'pinned' && (await takePinHint())) {
        toast('Pinned prices refresh only while this tab is visible: crypto from CoinGecko every 2 minutes, currencies from Frankfurter hourly.', 8000)
      }
    }

    const row = (item: MarketItem, sec: 'pinned' | 'list', index = 0, count = 0): HTMLElement => {
      const q = knownQuote(quote(), item.id)
      const pinned = marketPrefs().pins.includes(item.id)
      const pin = el('button', {
        class: 'mk-pin',
        type: 'button',
        text: pinned ? '★' : '☆',
        title: pinned ? 'Unpin' : 'Pin to the top bar',
        'aria-label': `Pin ${item.name}`,
        'aria-pressed': String(pinned),
      })
      pin.dataset.part = 'pin'
      pin.addEventListener('click', () => void onPin(item))

      const name = el('span', { class: 'mk-name', title: item.name }, [el('span', { class: 'mk-sym', text: item.sym }), el('span', { class: 'mk-label', text: item.name })])
      if (item.stable) name.append(el('span', { class: 'mk-tag', text: 'stable' }))
      if (sec === 'pinned') {
        const step = (by: -1 | 1) => {
          const b = el('button', {
            class: 'mk-step',
            type: 'button',
            text: by < 0 ? '←' : '→',
            title: by < 0 ? 'Move left in the top bar' : 'Move right in the top bar',
            'aria-label': `Move ${item.name} ${by < 0 ? 'left' : 'right'} in the top bar`,
          }) as HTMLButtonElement
          b.dataset.part = by < 0 ? 'left' : 'right'
          b.disabled = by < 0 ? index === 0 : index === count - 1
          b.addEventListener('click', () => void movePin(item.id, by))
          return b
        }
        name.append(el('span', { class: 'mk-move' }, [step(-1), step(1)]))
      }

      let price: HTMLElement
      let chg: HTMLElement
      if (q) {
        const text = formatPrice(q.price, quote(), 'symbol', item.kind)
        const when =
          item.kind === 'fiat' ? `1 ${item.key} in ${quote()}, daily reference rate, as of ${formatDay(q.asOf)}` : `${SOURCE_NAME[q.source]}, updated ${formatTime(q.fetchedAt)}`
        price = el('button', { class: 'mk-price', type: 'button', text, title: `Copy ${text} (${when})` })
        price.dataset.part = 'price'
        price.addEventListener('click', () => void copyText(text, ctx.clipboard.write))
        const d = direction(q.change, 2)
        chg = el('span', {
          class: `mk-chg ${d}`,
          text: formatChange(q.change, 2, ' '),
          title:
            d === 'na' ? `${SOURCE_NAME[q.source]} does not publish this change` : item.kind === 'crypto' ? 'Change over 24 hours' : 'Change against the previous reference day',
        })
      } else {
        price = el('span', { class: 'mk-price none', text: '–' })
        chg = el('span', { class: 'mk-chg na', text: '' })
      }
      const r = el('div', { class: 'mk-row' }, [pin, name, sparkline(q?.spark), price, chg])
      r.dataset.market = item.id
      if (flash?.id === item.id && Date.now() < flash.until) r.classList.add('mk-flash')
      return r
    }

    // ---------- status ----------
    const lastFetch = (kind?: MarketKind) => Math.max(0, ...ITEMS.filter((i) => !kind || i.kind === kind).map((i) => knownQuote(quote(), i.id)?.fetchedAt ?? 0))

    const statusLines = (): string[] => {
      if (offline) {
        const at = lastFetch()
        return [at ? `Offline. These prices are from ${formatTime(at)} and refresh when the connection returns.` : 'Offline. Prices load when the connection returns.']
      }
      const out: string[] = []
      for (const kind of ['crypto', 'fiat'] as const) {
        const r = result[kind]
        const have = lastFetch(kind) > 0
        if (!r) {
          if (!have) out.push(`Loading ${WHAT[kind].toLowerCase()}...`)
          continue
        }
        const why = r.primaryFailure ? `${PRIMARY[kind]} ${REASON[r.primaryFailure]}` : ''
        if (r.ok && r.source && r.source !== 'coingecko' && r.source !== 'frankfurter') {
          out.push(
            kind === 'crypto'
              ? `${why || 'CoinGecko is unavailable'}, so crypto prices come from ${SOURCE_NAME[r.source]}, without the 24h change.`
              : `${why || 'Frankfurter is unavailable'}, so currency rates come from ${SOURCE_NAME[r.source]}, without the daily change.`,
          )
        } else if (!r.ok) {
          const fb = kind === 'crypto' ? 'Coinbase' : 'currency-api'
          if (have) out.push(`${why || `${PRIMARY[kind]} is unavailable`}. Showing ${WHAT[kind].toLowerCase()} from ${formatTime(lastFetch(kind))}; retrying later.`)
          else out.push(`${WHAT[kind]} could not be loaded: ${why || `${PRIMARY[kind]} is unavailable`}, and ${fb} ${REASON[r.failure ?? 'down']}. Retrying later, or use Refresh.`)
        }
      }
      return out
    }

    const renderFooter = () => {
      const crypto = ITEMS.filter((i) => i.kind === 'crypto')
        .map((i) => knownQuote(quote(), i.id))
        .find((q): q is Quote => !!q)
      const fiat = ITEMS.filter((i) => i.kind === 'fiat')
        .map((i) => knownQuote(quote(), i.id))
        .filter((q): q is Quote => !!q)
      const cryptoLine = crypto?.source === 'coinbase' ? 'Crypto prices from Coinbase while CoinGecko is unavailable.' : 'Prices from CoinGecko, about 1-2 min delay.'
      const fiatLine =
        fiat[0]?.source === 'currency-api' ? 'Currency rates via currency-api while Frankfurter is unavailable, daily.' : 'ECB reference rates via Frankfurter, daily.'
      const link = el('a', { href: 'https://www.coingecko.com', target: '_blank', rel: 'noopener noreferrer', text: 'CoinGecko' })
      sourcesEl.replaceChildren(`${cryptoLine} ${fiatLine} Data provided by `, link, '.')
      const at = lastFetch()
      updatedEl.textContent = at ? `Updated ${formatTime(at)}` : 'Not updated yet'
    }

    // ---------- lists ----------
    // A re-render replaces every row, so the focused control is found again by row, part
    // and section; a keyboard user pressing ← keeps their place.
    const renderLists = () => {
      const active = document.activeElement as HTMLElement | null
      const was =
        active && lists.contains(active)
          ? { id: active.closest<HTMLElement>('.mk-row')?.dataset.market, part: active.dataset.part, sec: active.closest<HTMLElement>('[data-sec]')?.dataset.sec }
          : null

      const qt = quote()
      const needle = query.trim().toLowerCase()
      const match = (i: MarketItem) => !needle || i.sym.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle) || i.key.toLowerCase().includes(needle)
      const parts: HTMLElement[] = []

      const pins = activePins()
        .map(itemOf)
        .filter((i): i is MarketItem => !!i)
      if (pins.length && !needle) {
        parts.push(
          el('div', { class: 'mk-sec', 'data-sec': 'pinned' }, [el('div', { class: 'group-label', text: 'Pinned' }), ...pins.map((i, n) => row(i, 'pinned', n, pins.length))]),
        )
      }

      const kinds: MarketKind[] = filter === 'all' ? ['crypto', 'fiat'] : [filter]
      let matched = 0
      for (const kind of kinds) {
        const items = ITEMS.filter((i) => i.kind === kind && !(kind === 'fiat' && i.key === qt) && match(i))
        const shown = items.filter((i) => knownQuote(qt, i.id))
        matched += shown.length
        if (needle && !shown.length) continue
        // Reference dates can differ per currency; the label names the newest, each price's title its own.
        const newest = shown.reduce((d, i) => ((knownQuote(qt, i.id)?.asOf ?? '') > d ? (knownQuote(qt, i.id)?.asOf ?? '') : d), '')
        const label = el('div', {
          class: 'group-label',
          text: kind === 'crypto' ? 'Crypto' : newest ? `Currencies, daily reference rate, as of ${formatDay(newest)}` : 'Currencies',
        })
        const body: HTMLElement[] = shown.length
          ? shown.map((i) => row(i, 'list'))
          : [el('div', { class: 'mk-empty muted small', text: result[kind] ? 'No prices to show.' : 'Loading...' })]
        parts.push(el('div', { class: 'mk-sec', 'data-sec': kind }, [label, ...body]))
      }
      if (needle && !matched) parts.push(el('div', { class: 'mk-empty muted small', text: `Nothing matches "${query.trim()}".` }))
      lists.replaceChildren(...parts)

      if (was?.id && was.part) {
        const scope = (sec?: string) => lists.querySelector<HTMLElement>(`[data-sec="${sec}"] .mk-row[data-market="${CSS.escape(was.id ?? '')}"]`)
        const rowEl = scope(was.sec) ?? lists.querySelector<HTMLElement>(`.mk-row[data-market="${CSS.escape(was.id)}"]`)
        let target = rowEl?.querySelector<HTMLButtonElement>(`[data-part="${was.part}"]`) ?? null
        if (target?.disabled) target = rowEl?.querySelector<HTMLButtonElement>(`[data-part="${was.part === 'left' ? 'right' : 'left'}"]`) ?? null
        ;(target ?? rowEl?.querySelector<HTMLElement>('[data-part="pin"]'))?.focus({ preventScroll: true })
      }
    }

    const render = () => {
      if (dead) return
      quoteSel.value = pendingQuote ?? quote()
      const lines = statusLines()
      statusEl.replaceChildren(...lines.map((t) => el('div', { text: t })))
      statusEl.classList.toggle('hidden', !lines.length)
      renderLists()
      renderFooter()
    }

    const focusRow = (id: MarketId) => {
      const item = itemOf(id)
      if (!item || dead) return
      if (query || (filter !== 'all' && filter !== item.kind)) {
        query = ''
        search.value = ''
        filter = 'all'
        syncSeg()
        renderLists()
      }
      const target = lists.querySelector<HTMLElement>(`.mk-row[data-market="${CSS.escape(id)}"]`)
      if (!target) return
      target.scrollIntoView({ block: 'center' })
      // The price, not the ★ that precedes it: Enter on a focused ★ would unpin the item
      // the user just opened.
      ;(target.querySelector<HTMLElement>('[data-part="price"]') ?? target.querySelector<HTMLElement>('[data-part="pin"]'))?.focus({ preventScroll: true })
      flash = { id, until: Date.now() + 1600 }
      target.classList.add('mk-flash')
      window.setTimeout(() => lists.querySelectorAll('.mk-flash').forEach((r) => r.classList.remove('mk-flash')), 1600)
    }

    // ---------- polling ----------
    const canRun = () => !dead && !document.hidden && onScreen && !offline && !isStageView()
    const run = async (kind: MarketKind, force: boolean): Promise<PollOutcome> => {
      const qt = quote()
      const r = kind === 'crypto' ? await loadCrypto(qt, CRYPTO_KEYS, true, force) : await loadFiat(qt, force)
      if (dead) return 'idle'
      if (qt === quote()) result[kind] = r
      return r.ok ? 'ok' : 'fail'
    }
    const poller = new Poller<MarketKind>(INTERVALS, run, canRun, undefined, render)
    const gate = () => {
      setCardPolling('markets', container, canRun())
      if (canRun()) void poller.poke()
      else poller.stop()
    }

    const offQuotes = onQuotes((qt) => {
      if (qt === quote()) render()
    })
    const offFocus = onFocusRequest((id) => {
      takeFocus()
      focusRow(id)
    })
    const onPrefs = () => {
      if (quote() !== shownQuote) {
        shownQuote = quote()
        result.crypto = result.fiat = null
        poller.invalidate()
        void poller.poke()
      }
      render()
    }
    window.addEventListener(MARKET_PINS_EVENT, onPrefs)
    const onVis = () => gate()
    document.addEventListener('visibilitychange', onVis)
    const onOnline = () => {
      offline = !navigator.onLine
      if (!offline) poller.invalidate()
      render()
      gate()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOnline)
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting)
        if (vis === onScreen) return
        onScreen = vis
        gate()
      },
      { threshold: 0 },
    )
    io.observe(container)

    render()
    const pending = takeFocus()
    if (pending) focusRow(pending)
    gate()

    detachers.set(container, () => {
      dead = true
      poller.stop()
      window.clearTimeout(quoteTimer)
      setCardPolling('markets', container, false)
      offQuotes()
      offFocus()
      window.removeEventListener(MARKET_PINS_EVENT, onPrefs)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOnline)
      io.disconnect()
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
