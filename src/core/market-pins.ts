// Market preferences owned by more than one surface: the pinned items, in top-bar order,
// and the quote currency. The Markets card writes them, the shell's ticker bar and its
// overflow menu read and write them, so the keys, the cap and the validation live here.
// Every write dispatches MARKET_PINS_EVENT so a second open surface repaints at once, and
// the ticker bar re-reads the store when its tab becomes visible so other tabs converge.
//
// Keys: 'market-pins' (string[], ids validated against the catalog, at most MAX_PINS),
// 'market-quote' (an ISO code from the catalog), 'market-snapshot' (the last pinned
// quotes and when they were fetched), 'market-pin-hint' (the first-pin notice was shown).
import { asQuote, defaultQuote, isMarketId, isQuoteCode, type MarketId, type Quote } from './market-data'
import { getItem, removeItem, setItem } from './store'

export const MARKET_PINS_EVENT = 'wt:market-pins'
export const MAX_PINS = 8

export interface MarketPrefs {
  pins: MarketId[]
  quote: string
}

let prefs: MarketPrefs = { pins: [], quote: defaultQuote() }
let loaded: Promise<MarketPrefs> | null = null

const clean = (v: unknown): MarketId[] => (Array.isArray(v) ? [...new Set(v.filter(isMarketId))].slice(0, MAX_PINS) : [])

async function read(): Promise<MarketPrefs> {
  try {
    const [pins, quote] = await Promise.all([getItem<unknown>('market-pins'), getItem<unknown>('market-quote')])
    return { pins: clean(pins), quote: isQuoteCode(quote) ? quote : defaultQuote() }
  } catch {
    return { pins: [], quote: defaultQuote() }
  }
}

function publish(next: MarketPrefs): void {
  prefs = next
  window.dispatchEvent(new CustomEvent<MarketPrefs>(MARKET_PINS_EVENT, { detail: next }))
}

/** The stored preferences, read once per page. */
export function loadMarketPrefs(): Promise<MarketPrefs> {
  loaded ??= read().then((p) => (prefs = p))
  return loaded
}

/** The preferences as last loaded or written. Valid after loadMarketPrefs() resolved. */
export function marketPrefs(): MarketPrefs {
  return prefs
}

/** The pins that have a price: a fiat pin equal to the quote currency is 1 by definition and is left out. */
export function activePins(p: MarketPrefs = prefs): MarketId[] {
  return p.pins.filter((id) => id !== `f:${p.quote}`)
}

/** Re-read the store, as when the tab comes back: another tab may have changed it. */
export async function reloadMarketPrefs(): Promise<void> {
  const next = await read()
  if (next.quote !== prefs.quote || next.pins.join() !== prefs.pins.join()) publish(next)
}

async function save(next: MarketPrefs): Promise<void> {
  publish(next)
  try {
    await Promise.all([setItem('market-pins', next.pins), setItem('market-quote', next.quote)])
    if (!next.pins.length) await dropSnapshot()
  } catch {
    // A locked or failing store keeps the change for this page only; nothing to report.
  }
}

export type PinResult = 'pinned' | 'unpinned' | 'full'

export async function togglePin(id: MarketId): Promise<PinResult> {
  const p = await loadMarketPrefs().then(() => prefs)
  if (p.pins.includes(id)) {
    await save({ ...p, pins: p.pins.filter((x) => x !== id) })
    return 'unpinned'
  }
  if (p.pins.length >= MAX_PINS) return 'full'
  await save({ ...p, pins: [...p.pins, id] })
  return 'pinned'
}

export async function unpin(id: MarketId): Promise<void> {
  const p = await loadMarketPrefs().then(() => prefs)
  if (p.pins.includes(id)) await save({ ...p, pins: p.pins.filter((x) => x !== id) })
}

/** Move a pin one place left (-1) or right (+1) in the bar. */
export async function movePin(id: MarketId, by: -1 | 1): Promise<void> {
  const p = await loadMarketPrefs().then(() => prefs)
  const i = p.pins.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= p.pins.length) return
  const pins = p.pins.slice()
  ;[pins[i], pins[j]] = [pins[j], pins[i]]
  await save({ ...p, pins })
}

export async function setQuote(quote: string): Promise<void> {
  const p = await loadMarketPrefs().then(() => prefs)
  if (isQuoteCode(quote) && quote !== p.quote) await save({ ...p, quote })
}

/** True exactly once per profile, for the notice explaining what pinning starts. */
export async function takePinHint(): Promise<boolean> {
  try {
    if (await getItem<boolean>('market-pin-hint')) return false
    await setItem('market-pin-hint', true)
    return true
  } catch {
    return false
  }
}

export async function readSnapshot(): Promise<{ quote: string; quotes: Quote[] } | null> {
  try {
    const v = await getItem<{ quote?: unknown; quotes?: unknown }>('market-snapshot')
    if (!v || !isQuoteCode(v.quote) || !Array.isArray(v.quotes)) return null
    return {
      quote: v.quote,
      quotes: v.quotes
        .slice(0, MAX_PINS * 2)
        .map(asQuote)
        .filter((q): q is Quote => q !== null),
    }
  } catch {
    return null
  }
}

/** With nothing pinned the stored prices describe nothing on the bar. */
export async function dropSnapshot(): Promise<void> {
  await removeItem('market-snapshot').catch(() => {})
}

export function writeSnapshot(quote: string, quotes: Quote[]): void {
  // Sparklines stay out: the bar does not draw them, and they would make every write 30x larger.
  void setItem('market-snapshot', { quote, quotes: quotes.map((q) => ({ ...q, spark: null, restored: undefined })) }).catch(() => {})
}

// A ticker click asks the Markets card to bring one row into view. The card may not be
// open yet, so the request is held until a card takes it.
let pendingFocus: MarketId | null = null
const focusListeners = new Set<(id: MarketId) => void>()

export function requestFocus(id: MarketId): void {
  pendingFocus = id
  for (const fn of focusListeners) fn(id)
}

export function takeFocus(): MarketId | null {
  const id = pendingFocus
  pendingFocus = null
  return id
}

export function onFocusRequest(fn: (id: MarketId) => void): () => void {
  focusListeners.add(fn)
  return () => focusListeners.delete(fn)
}
