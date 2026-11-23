// Market tickers: one per pinned price, in the order the Markets card sets, and ONE refresh
// loop for all of them: crypto every 2 minutes and fiat hourly while the tab is visible,
// with market-data.ts backing off and falling back when a source fails. Returning to the
// tab refreshes only what fell due meanwhile.

import {
  INTERVALS,
  changePhrase,
  currencyName,
  direction,
  formatChange,
  formatPrice,
  intervalOf,
  isStale,
  itemOf,
  knownQuote,
  loadCrypto,
  loadFiat,
  oldestFetch,
  onQuotes,
  seedQuotes,
  type MarketId,
  type MarketKind,
  type Quote,
} from '../core/market-data'
import { MARKET_PINS_EVENT, activePins, loadMarketPrefs, marketPrefs, readSnapshot, reloadMarketPrefs, requestFocus, unpin, writeSnapshot, dropSnapshot } from '../core/market-pins'
import { Poller, cardIsPolling, formatTime, type PollOutcome } from '../core/poll'
import type { SourceHost, TickerItem, TickerSource } from './tickers'

export function marketTickers(): TickerSource {
  const failing: Record<MarketKind, boolean> = { crypto: false, fiat: false }
  let host: SourceHost | null = null
  let snapshotAt = 0

  const pinnedQuotes = (): Quote[] => {
    const { quote } = marketPrefs()
    return activePins()
      .map((id) => knownQuote(quote, id))
      .filter((q): q is Quote => !!q)
  }

  // The card is opened first: a row inside a collapsed <details> cannot be scrolled to or
  // focused. A card launched here takes the request when it activates.
  const open = (id: MarketId) => {
    host?.openCard('markets')
    requestFocus(id)
  }

  const item = (id: MarketId): TickerItem | null => {
    const it = itemOf(id)
    if (!it) return null
    const { quote } = marketPrefs()
    const q = knownQuote(quote, id)
    const offline = !navigator.onLine
    const tag = it.sym === it.name ? it.name : `${it.sym} ${it.name}`
    const base = { key: id, attr: ['market', id] as [string, string], sym: it.sym, name: it.name, open: () => open(id), unpin: () => void unpin(id) }
    if (!q) {
      return { ...base, value: '–', chg: null, stale: true, label: `${tag}, no price yet`, title: offline ? 'No price yet, offline' : 'No price yet' }
    }
    const d = direction(q.change, 1)
    // A restored snapshot paints at once but stays dimmed until this page has refreshed it.
    const stale = offline || isStale(q, it.kind) || !!q.restored
    const at = formatTime(q.fetchedAt)
    return {
      ...base,
      value: formatPrice(q.price, quote, 'plain', it.kind),
      chg: d === 'na' ? null : { text: formatChange(q.change, 1), dir: d },
      stale,
      label: `${tag} ${formatPrice(q.price, quote, 'name', it.kind)}, ${changePhrase(q.change, it.kind)}${stale ? `, updated ${at}` : ''}`,
      title: stale
        ? `Updated ${at}, ${offline ? 'offline' : failing[it.kind] ? 'unreachable' : 'refreshing'}`
        : `${it.name} in ${currencyName(quote)}, updated ${at}. Opens Markets.`,
    }
  }

  const saveSnapshot = () => {
    const quotes = pinnedQuotes()
    const newest = Math.max(0, ...quotes.map((q) => q.fetchedAt))
    if (!quotes.length || newest <= snapshotAt) return
    snapshotAt = newest
    writeSnapshot(marketPrefs().quote, quotes)
  }

  const run = async (kind: MarketKind, force: boolean): Promise<PollOutcome> => {
    const { quote } = marketPrefs()
    const ids = activePins().filter((id) => itemOf(id)?.kind === kind)
    if (!ids.length) return 'idle'
    // An open Markets card polls /coins/markets for every coin, and that answer fills these
    // pins too, so while one polls the bar never asks CoinGecko itself: a reload, a tab
    // return, a reconnect or a quote change then costs one call, not two. Fiat needs no
    // such rule, because the card and the bar ask for the same Frankfurter URL and the
    // shared cache joins them.
    // On a reload of #/t/markets the bar starts before the card's module has loaded, so a
    // card still loading counts too, with a shorter wait in case it ends up off screen.
    if (!force && kind === 'crypto') {
      if (cardIsPolling('markets')) return { dueAt: Date.now() + 15_000 }
      if (host?.cardLoading('markets')) return { dueAt: Date.now() + 3_000 }
    }
    // A quote restored from the snapshot is always due: it is dimmed until this page has
    // fetched it once.
    const oldest = oldestFetch(quote, ids)
    const restored = ids.some((id) => knownQuote(quote, id)?.restored)
    const wait = intervalOf(kind) - 5_000
    if (!force && oldest && !restored && Date.now() - oldest < wait) return { dueAt: oldest + wait }
    const keys = ids.map((id) => itemOf(id)?.key ?? '')
    const r = kind === 'crypto' ? await loadCrypto(quote, keys, false, force) : await loadFiat(quote, force)
    failing[kind] = !r.ok
    return r.ok ? 'ok' : 'fail'
  }

  /** The next moment a pinned quote turns stale, so the dimmed state lands on time between fetches. */
  const nextStale = () => {
    const now = Date.now()
    let next = Infinity
    for (const q of pinnedQuotes()) {
      const at = q.fetchedAt + 2 * intervalOf(itemOf(q.id)?.kind ?? 'crypto') + 1000
      if (at > now) next = Math.min(next, at)
    }
    return next
  }

  const poller = new Poller<MarketKind>(
    INTERVALS,
    run,
    () => !document.hidden && navigator.onLine && activePins().length > 0,
    nextStale,
    () => {
      host?.changed()
      saveSnapshot()
    },
  )

  return {
    items: () => activePins().flatMap((id) => item(id) ?? []),
    start(h) {
      host = h
      // A new pin or quote currency makes both families due; run() finds anything already
      // fresh and only re-arms for it, so this costs no request when the data is there.
      window.addEventListener(MARKET_PINS_EVENT, () => {
        poller.invalidate()
        h.changed()
        void poller.poke()
      })
      onQuotes(() => {
        h.changed()
        saveSnapshot()
      })
      void (async () => {
        const p = await loadMarketPrefs()
        const snap = await readSnapshot()
        if (snap && !p.pins.length) {
          void dropSnapshot()
        } else if (snap && snap.quote === p.quote) {
          seedQuotes(p.quote, snap.quotes)
          snapshotAt = Math.max(0, ...snap.quotes.map((q) => q.fetchedAt))
        }
        h.changed()
        void poller.poke()
      })()
    },
    pause: () => poller.stop(),
    resume(reconnected) {
      if (reconnected) {
        failing.crypto = failing.fiat = false
        poller.invalidate()
      }
      // Another tab may have changed the pins while this one was hidden.
      void reloadMarketPrefs().finally(() => void poller.poke())
    },
  }
}
