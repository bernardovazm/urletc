// Market prices for the Markets card and the pinned top-bar tickers. One module, so both
// surfaces share one cache, one request per URL in flight, and one view of whether a
// source is failing. Two pollers that each backed off on their own would both keep calling
// a source that is rate limiting the IP they share.
//
// Sources, each chosen because it answers a browser fetch with CORS and no key:
//   crypto  CoinGecko /coins/markets (card: price, 24h, 7d sparkline) and /simple/price
//           (tickers); fallback Coinbase /v2/exchange-rates, which has no 24h change
//   fiat    Frankfurter v2 /rates, a 30-day series for the change and the sparkline;
//           fallback fawazahmed0 currency-api on jsDelivr, latest only
// Keyless CoinGecko is a pool of about 5 calls a minute shared by everyone behind one IP,
// which is why the card and the tickers never fetch the same thing twice and why every
// failure backs off. What leaves the device is the item ids and the quote currency.
//
// Every value from these APIs is untrusted: numbers pass Number.isFinite and a range
// check, unknown ids are dropped, and names and symbols come from the catalog below
// rather than from a response. Nothing here writes to the console; the e2e suite treats
// console errors as failures and these services do fail.

import { backoffMs, finite, getJson, type Failure, type Res } from './poll'

export type MarketKind = 'crypto' | 'fiat'
/** 'c:<CoinGecko id>' or 'f:<ISO 4217 code>'. */
export type MarketId = string

export interface MarketItem {
  id: MarketId
  kind: MarketKind
  /** CoinGecko id for crypto, ISO code for fiat. */
  key: string
  sym: string
  name: string
  stable: boolean
}

const CRYPTO: ReadonlyArray<readonly [string, string, string, boolean?]> = [
  ['bitcoin', 'BTC', 'Bitcoin'],
  ['ethereum', 'ETH', 'Ethereum'],
  ['tether', 'USDT', 'Tether', true],
  ['binancecoin', 'BNB', 'BNB'],
  ['solana', 'SOL', 'Solana'],
  ['ripple', 'XRP', 'XRP'],
  ['usd-coin', 'USDC', 'USDC', true],
  ['dogecoin', 'DOGE', 'Dogecoin'],
  ['cardano', 'ADA', 'Cardano'],
  ['tron', 'TRX', 'TRON'],
  ['toncoin', 'TON', 'Toncoin'],
  ['chainlink', 'LINK', 'Chainlink'],
  ['avalanche-2', 'AVAX', 'Avalanche'],
  ['shiba-inu', 'SHIB', 'Shiba Inu'],
  ['litecoin', 'LTC', 'Litecoin'],
]

/** Every code is in the ECB set Frankfurter publishes, so the primary covers all of them. */
export const FIAT_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'BRL', 'CAD', 'AUD', 'CHF', 'INR', 'MXN', 'KRW', 'HKD', 'SGD', 'SEK', 'NOK', 'ZAR', 'TRY'] as const

const currencyNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'currency' })
  } catch {
    return null
  }
})()

export function currencyName(code: string): string {
  try {
    return currencyNames?.of(code) ?? code
  } catch {
    return code
  }
}

export const ITEMS: readonly MarketItem[] = [
  ...CRYPTO.map(([key, sym, name, stable]): MarketItem => ({ id: `c:${key}`, kind: 'crypto', key, sym, name, stable: !!stable })),
  ...FIAT_CODES.map((code): MarketItem => ({ id: `f:${code}`, kind: 'fiat', key: code, sym: code, name: currencyName(code), stable: false })),
]
const BY_ID = new Map(ITEMS.map((i) => [i.id, i]))

export const itemOf = (id: string): MarketItem | undefined => BY_ID.get(id)
export const isMarketId = (v: unknown): v is MarketId => typeof v === 'string' && BY_ID.has(v)
export const isQuoteCode = (v: unknown): v is string => typeof v === 'string' && (FIAT_CODES as readonly string[]).includes(v)

/**
 * The quote currency until one is chosen. A region subtag wins (pt-PT is EUR, en-GB is
 * GBP); otherwise the base language picks the currency most of its speakers price in.
 */
export function defaultQuote(): string {
  const byRegion: Record<string, string> = { US: 'USD', GB: 'GBP', BR: 'BRL', JP: 'JPY', CN: 'CNY', CA: 'CAD', AU: 'AUD', CH: 'CHF', LI: 'CHF', IN: 'INR' }
  Object.assign(byRegion, { MX: 'MXN', KR: 'KRW', HK: 'HKD', SG: 'SGD', SE: 'SEK', NO: 'NOK', ZA: 'ZAR', TR: 'TRY' })
  for (const r of ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']) byRegion[r] = 'EUR'
  const byLang: Record<string, string> = {
    pt: 'BRL',
    de: 'EUR',
    fr: 'EUR',
    es: 'EUR',
    it: 'EUR',
    nl: 'EUR',
    ja: 'JPY',
    zh: 'CNY',
    ko: 'KRW',
    sv: 'SEK',
    nb: 'NOK',
    nn: 'NOK',
    no: 'NOK',
    tr: 'TRY',
    hi: 'INR',
    en: 'USD',
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const raw of langs) {
    const [lang, ...subtags] = (raw ?? '').split('-')
    for (const sub of subtags) {
      if (sub.length === 1) break // a BCP-47 extension starts here
      const hit = sub.length === 2 ? byRegion[sub.toUpperCase()] : undefined
      if (hit) return hit
    }
    const hit = byLang[(lang ?? '').toLowerCase()]
    if (hit) return hit
  }
  return 'USD'
}

// ---------- quotes ----------

export type Source = 'coingecko' | 'coinbase' | 'frankfurter' | 'currency-api'

export const SOURCE_NAME: Record<Source, string> = {
  coingecko: 'CoinGecko',
  coinbase: 'Coinbase',
  frankfurter: 'Frankfurter',
  'currency-api': 'currency-api',
}

export interface Quote {
  id: MarketId
  /** One unit of the item, priced in the quote currency. */
  price: number
  /** Percent. Crypto: over 24 hours. Fiat: against the previous reference day. null when the source has none. */
  change: number | null
  /** Oldest first. 7 days hourly for crypto, 30 days daily for fiat; null when the source has none. */
  spark: number[] | null
  /** Crypto: ISO time the source last updated. Fiat: the reference date, YYYY-MM-DD. */
  asOf: string
  /** When this browser received it, ms since the epoch. Staleness is measured from here. */
  fetchedAt: number
  source: Source
  /** Read back from the stored snapshot and not refreshed by this page yet. */
  restored?: boolean
}

const known = new Map<string, Quote>()
const slot = (quote: string, id: MarketId) => `${quote}|${id}`
const listeners = new Set<(quote: string) => void>()

export function knownQuote(quote: string, id: MarketId): Quote | undefined {
  return known.get(slot(quote, id))
}

/** Called after any load that stored quotes, with the quote currency they are priced in. */
export function onQuotes(fn: (quote: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function put(quote: string, quotes: Quote[]): void {
  for (const q of quotes) {
    // /simple/price and the fallbacks carry no series. Keeping the last one avoids the
    // sparkline blinking out between a ticker refresh and the card's next one.
    const prev = known.get(slot(quote, q.id))
    known.set(slot(quote, q.id), q.spark || !prev?.spark ? q : { ...q, spark: prev.spark })
  }
  for (const fn of listeners) fn(quote)
}

/** Restore quotes saved by an earlier page, never over something this page fetched since. */
export function seedQuotes(quote: string, quotes: Quote[]): void {
  const older = quotes.filter((q) => (known.get(slot(quote, q.id))?.fetchedAt ?? -1) < q.fetchedAt)
  if (older.length)
    put(
      quote,
      older.map((q) => ({ ...q, restored: true })),
    )
}

/** When the least recent of `ids` was fetched, 0 if any of them has never been. */
export function oldestFetch(quote: string, ids: readonly MarketId[]): number {
  let oldest = Infinity
  for (const id of ids) oldest = Math.min(oldest, known.get(slot(quote, id))?.fetchedAt ?? 0)
  return oldest === Infinity ? 0 : oldest
}

/** Validate a quote read back from storage: it was written by this app, but storage is not a type. */
export function asQuote(v: unknown): Quote | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  if (!isMarketId(o.id) || !num(o.price) || (o.price as number) <= 0 || !num(o.fetchedAt)) return null
  if (!(o.change === null || num(o.change)) || typeof o.asOf !== 'string' || !(typeof o.source === 'string' && o.source in SOURCE_NAME)) return null
  return {
    id: o.id,
    price: o.price as number,
    change: o.change as number | null,
    spark: null,
    asOf: o.asOf.slice(0, 32),
    fetchedAt: o.fetchedAt as number,
    source: o.source as Source,
  }
}

// ---------- transport ----------

const GECKO = 'https://api.coingecko.com/api/v3'
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates'
const FRANKFURTER = 'https://api.frankfurter.dev/v2/rates'
const CURRENCY_API = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies'

const positive = (v: unknown): number | null => {
  const n = finite(v)
  return n !== null && n > 0 && n < 1e15 ? n : null
}
const percent = (v: unknown): number | null => {
  const n = finite(v)
  return n !== null && Math.abs(n) < 1e6 ? n : null
}
// 8.64e15 ms is the Date range; past it toISOString throws, and one bad timestamp would
// take the whole response with it.
const isoTime = (v: unknown): string => {
  const t = typeof v === 'string' ? Date.parse(v.slice(0, 40)) : typeof v === 'number' ? v * 1000 : NaN
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : ''
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** At most `n` points, evenly spaced, always keeping the last one. */
function thin(values: number[], n: number): number[] {
  if (values.length <= n) return values
  const step = (values.length - 1) / (n - 1)
  return Array.from({ length: n }, (_, i) => values[Math.round(i * step)])
}

const CRYPTO_BY_KEY = new Map(ITEMS.filter((i) => i.kind === 'crypto').map((i) => [i.key, i]))

function parseGeckoMarkets(data: unknown, at: number): Quote[] {
  if (!Array.isArray(data)) return []
  const out: Quote[] = []
  for (const row of data.slice(0, 100)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const item = typeof r.id === 'string' ? CRYPTO_BY_KEY.get(r.id) : undefined
    const price = positive(r.current_price)
    if (!item || price === null) continue
    const raw = (r.sparkline_in_7d as { price?: unknown } | null | undefined)?.price
    const series = Array.isArray(raw)
      ? raw
          .slice(0, 400)
          .map(positive)
          .filter((n): n is number => n !== null)
      : []
    out.push({
      id: item.id,
      price,
      change: percent(r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h),
      spark: series.length >= 2 ? thin(series, 48) : null,
      asOf: isoTime(r.last_updated),
      fetchedAt: at,
      source: 'coingecko',
    })
  }
  return out
}

function parseGeckoSimple(data: unknown, quote: string, keys: readonly string[], at: number): Quote[] {
  if (!data || typeof data !== 'object') return []
  const q = quote.toLowerCase()
  const out: Quote[] = []
  for (const key of keys) {
    const row = (data as Record<string, unknown>)[key]
    const item = CRYPTO_BY_KEY.get(key)
    if (!item || !row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const price = positive(r[q])
    if (price === null) continue
    out.push({ id: item.id, price, change: percent(r[`${q}_24h_change`]), spark: null, asOf: isoTime(finite(r.last_updated_at) ?? NaN), fetchedAt: at, source: 'coingecko' })
  }
  return out
}

function parseCoinbase(data: unknown, keys: readonly string[], at: number): Quote[] {
  const rates = (data as { data?: { rates?: unknown } } | null)?.data?.rates
  if (!rates || typeof rates !== 'object') return []
  const out: Quote[] = []
  for (const key of keys) {
    const item = CRYPTO_BY_KEY.get(key)
    // Units of the coin per one unit of the quote currency, as a decimal string.
    const rate = item ? positive((rates as Record<string, unknown>)[item.sym]) : null
    // Inverting a subnormal rate gives Infinity, so the price is range-checked again.
    const price = rate === null ? null : positive(1 / rate)
    if (!item || price === null) continue
    out.push({ id: item.id, price, change: null, spark: null, asOf: new Date(at).toISOString(), fetchedAt: at, source: 'coinbase' })
  }
  return out
}

/** Frankfurter v2 rows, {date, base, quote, rate}: units of `quote` per one `base`. Dates can differ per quote. */
function parseFrankfurter(data: unknown, base: string, codes: readonly string[], at: number): Quote[] {
  if (!Array.isArray(data)) return []
  const series = new Map<string, Array<[string, number]>>()
  for (const row of data.slice(0, 5000)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    // Stored inverted, as the price of one unit of `quote`, and range-checked after the
    // inversion, which turns a subnormal rate into Infinity.
    const rate = positive(r.rate)
    const price = rate === null ? null : positive(1 / rate)
    if (r.base !== base || typeof r.quote !== 'string' || !codes.includes(r.quote) || typeof r.date !== 'string' || !DATE_RE.test(r.date) || price === null) continue
    const s = series.get(r.quote) ?? []
    s.push([r.date, price])
    series.set(r.quote, s)
  }
  const out: Quote[] = []
  for (const code of codes) {
    const s = series.get(code)
    if (!s?.length) continue // a code the response lacks is dropped, never shown as NaN
    s.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const [date, last] = s[s.length - 1]
    const prev = s.length > 1 ? s[s.length - 2][1] : null
    out.push({
      id: `f:${code}`,
      price: last,
      change: prev === null ? null : percent((last / prev - 1) * 100),
      spark: s.length >= 2 ? s.map(([, p]) => p) : null,
      asOf: date,
      fetchedAt: at,
      source: 'frankfurter',
    })
  }
  return out
}

/** currency-api: {date, <base>: {<code>: units of code per one base}}, lowercase codes. */
function parseCurrencyApi(data: unknown, base: string, codes: readonly string[], at: number): Quote[] {
  const d = data as Record<string, unknown> | null
  const rates = d?.[base.toLowerCase()]
  const date = typeof d?.date === 'string' && DATE_RE.test(d.date) ? d.date : ''
  if (!rates || typeof rates !== 'object' || !date) return []
  const out: Quote[] = []
  for (const code of codes) {
    const rate = positive((rates as Record<string, unknown>)[code.toLowerCase()])
    const price = rate === null ? null : positive(1 / rate)
    if (price !== null) out.push({ id: `f:${code}`, price, change: null, spark: null, asOf: date, fetchedAt: at, source: 'currency-api' })
  }
  return out
}

// ---------- loads ----------

export const CRYPTO_MS = 120_000
export const FIAT_MS = 3_600_000

/** How long a successful response is reused before the same URL is asked again. */
const REUSE_MS: Record<MarketKind, number> = { crypto: 30_000, fiat: 10 * 60_000 }
/** A forced refresh (the Refresh button) still reuses an answer this young. */
const FORCE_REUSE_MS = 15_000

interface Health {
  fails: number
  until: number
  last: Failure | null
}
const health: Record<MarketKind, Health> = { crypto: { fails: 0, until: 0, last: null }, fiat: { fails: 0, until: 0, last: null } }

export interface LoadResult {
  /** Fresh quotes were stored, from the primary or the fallback. */
  ok: boolean
  source: Source | null
  /** Why the primary was not used, when it was not. */
  primaryFailure: Failure | null
  /** Why nothing fresh came back, when `ok` is false. */
  failure: Failure | null
}

/**
 * Load from the primary unless it is cooling down after a failure, and fall back when the
 * primary has failed twice in a row or nothing is known yet for what was asked. One failed
 * call with a price already on screen is a blip, and switching to a source that carries
 * no 24h change over a blip loses information for nothing.
 */
async function load(
  kind: MarketKind,
  quote: string,
  ids: MarketId[],
  primary: () => Promise<Res>,
  parse: (r: Res & { ok: true }) => Quote[],
  fallback: () => Promise<Quote[] | Failure>,
): Promise<LoadResult> {
  const h = health[kind]
  let why: Failure | null = h.last
  if (Date.now() >= h.until) {
    const r = await primary()
    // A parser that throws on some shape nobody anticipated counts as an unreadable answer,
    // so the backoff and the fallback still run.
    let quotes: Quote[]
    try {
      quotes = r.ok ? parse(r) : []
    } catch {
      quotes = []
    }
    if (quotes.length) {
      h.fails = 0
      h.until = 0
      h.last = null
      put(quote, quotes)
      return { ok: true, source: quotes[0].source, primaryFailure: null, failure: null }
    }
    why = r.ok ? 'bad' : r.why
    if (why === 'offline') return { ok: false, source: null, primaryFailure: why, failure: why }
    h.fails++
    h.last = why
    h.until = Date.now() + backoffMs(h.fails - 1)
  }
  const knownAll = ids.every((id) => known.has(slot(quote, id)))
  if (h.fails < 2 && knownAll) return { ok: false, source: null, primaryFailure: why, failure: why }
  const fb = await fallback().catch((): Failure => 'bad')
  if (typeof fb === 'string') return { ok: false, source: null, primaryFailure: why, failure: fb }
  if (!fb.length) return { ok: false, source: null, primaryFailure: why, failure: 'bad' }
  put(quote, fb)
  return { ok: true, source: fb[0].source, primaryFailure: why, failure: null }
}

const failureOf = (r: Res): Failure => (r.ok ? 'bad' : r.why)

/** Crypto quotes for CoinGecko ids. `sparkline` asks /coins/markets (the card), otherwise /simple/price (tickers). */
export function loadCrypto(quote: string, keys: readonly string[], sparkline: boolean, force = false): Promise<LoadResult> {
  const want = keys.filter((k) => CRYPTO_BY_KEY.has(k))
  if (!want.length) return Promise.resolve({ ok: true, source: null, primaryFailure: null, failure: null })
  const q = encodeURIComponent(quote.toLowerCase())
  const ids = want.join(',')
  const reuse = force ? FORCE_REUSE_MS : REUSE_MS.crypto
  const url = sparkline
    ? `${GECKO}/coins/markets?vs_currency=${q}&ids=${ids}&sparkline=true&price_change_percentage=24h,7d`
    : `${GECKO}/simple/price?ids=${ids}&vs_currencies=${q}&include_24hr_change=true&include_last_updated_at=true`
  return load(
    'crypto',
    quote,
    want.map((k) => `c:${k}`),
    () => getJson(url, reuse),
    (r) => (sparkline ? parseGeckoMarkets(r.data, r.at) : parseGeckoSimple(r.data, quote, want, r.at)),
    async () => {
      const r = await getJson(`${COINBASE}?currency=${encodeURIComponent(quote)}`, reuse)
      return r.ok ? parseCoinbase(r.data, want, r.at) : failureOf(r)
    },
  )
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Fiat quotes for every catalog code but the quote itself: one URL whoever asks, so the card and the tickers share it. */
export function loadFiat(quote: string, force = false): Promise<LoadResult> {
  const codes = FIAT_CODES.filter((c) => c !== quote)
  const reuse = force ? FORCE_REUSE_MS : REUSE_MS.fiat
  const from = isoDay(Date.now() - 30 * 86_400_000)
  const url = `${FRANKFURTER}?from=${from}&base=${encodeURIComponent(quote)}&quotes=${codes.join(',')}`
  return load(
    'fiat',
    quote,
    codes.map((c) => `f:${c}`),
    () => getJson(url, reuse),
    (r) => parseFrankfurter(r.data, quote, codes, r.at),
    async () => {
      const r = await getJson(`${CURRENCY_API}/${encodeURIComponent(quote.toLowerCase())}.min.json`, reuse, true)
      return r.ok ? parseCurrencyApi(r.data, quote, codes, r.at) : failureOf(r)
    },
  )
}

/** The card and the bar run one schedule shape: crypto every 2 minutes, fiat hourly. */
export const INTERVALS: Record<MarketKind, number> = { crypto: CRYPTO_MS, fiat: FIAT_MS }

// ---------- formatting ----------

const formats = new Map<string, Intl.NumberFormat>()
function numberFormat(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  let f = formats.get(key)
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, opts)
    } catch {
      f = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 })
    }
    formats.set(key, f)
  }
  return f
}

/**
 * Four significant digits under 1, so SHIB at 0.00001734 keeps its digits instead of
 * rounding to 0.00. From 1 up, cents for crypto and four places for a currency, the way
 * exchange rates are quoted; whole units from 1000 up in the compact form and from
 * 100,000 up in the card.
 */
function digits(p: number, kind: MarketKind, compact: boolean): [string, Intl.NumberFormatOptions] {
  const places = (n: number): Intl.NumberFormatOptions => ({ minimumFractionDigits: n, maximumFractionDigits: n })
  // Whole units from 100,000 up, so BTC in KRW or JPY still fits its column.
  if (p >= 1000) return compact || p >= 100_000 ? ['0', places(0)] : ['2', places(2)]
  if (p >= 1) return kind === 'fiat' ? ['4', places(4)] : ['2', places(2)]
  return ['s', { minimumSignificantDigits: 4, maximumSignificantDigits: 4 }]
}

/** 'symbol' for the card ($60,815.12), 'plain' for the bar (60,815), 'name' for screen readers (60,815 US dollars). */
export function formatPrice(p: number, quote: string, style: 'symbol' | 'plain' | 'name', kind: MarketKind = 'crypto'): string {
  const [band, opts] = digits(p, kind, style !== 'symbol')
  const key = `${style}|${quote}|${band}`
  if (style === 'plain') return numberFormat(key, opts).format(p)
  return numberFormat(key, { style: 'currency', currency: quote, currencyDisplay: style === 'name' ? 'name' : 'narrowSymbol', ...opts }).format(p)
}

export type Direction = 'up' | 'down' | 'flat' | 'na'

/** Direction of a change as it reads at `decimals` places, so a change shown as 0.0% is flat. */
export function direction(change: number | null, decimals: number): Direction {
  if (change === null) return 'na'
  const r = Math.round(change * 10 ** decimals)
  return r > 0 ? 'up' : r < 0 ? 'down' : 'flat'
}

/** "▲ 1.2%", with the glyph carrying the sign so colour is never the only signal. */
export function formatChange(change: number | null, decimals: number, gap = ''): string {
  const d = direction(change, decimals)
  if (d === 'na' || change === null) return 'n/a'
  const n = numberFormat(`pct|${decimals}`, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(change))
  return `${d === 'up' ? `▲${gap}` : d === 'down' ? `▼${gap}` : ''}${n}%`
}

/** How a change reads aloud: "up 1.2% in 24 hours". */
export function changePhrase(change: number | null, kind: MarketKind): string {
  const span = kind === 'crypto' ? 'in 24 hours' : 'since the previous reference day'
  const d = direction(change, 1)
  if (d === 'na' || change === null) return kind === 'crypto' ? '24-hour change unavailable' : 'change unavailable'
  if (d === 'flat') return `unchanged ${span}`
  return `${d} ${formatChange(change, 1).replace(/^[▲▼]/, '')} ${span}`
}

export const intervalOf = (kind: MarketKind): number => INTERVALS[kind]

/** Older than two refresh intervals: at least one refresh was due and did not land. */
export const isStale = (q: Quote, kind: MarketKind, now = Date.now()): boolean => now - q.fetchedAt > 2 * intervalOf(kind)
