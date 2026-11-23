// Weather for the Weather card and the pinned top-bar ticker, from Open-Meteo: one
// forecast call (current, 7 days hourly, 7 days daily) and a place-name search. No key, CORS
// open, free for non-commercial use with attribution, which the card carries.
//
// What leaves the device is a typed place name with the interface language (search, so
// results come back with localized names) or a pair of coordinates rounded to two
// decimals, about 1 km, before any request is built. Every place is stored rounded
// too, so no precise position is ever kept or sent. Values are requested in metric and
// converted here, so a unit toggle never costs a request and the cache is unit-free.
//
// Responses are untrusted: numbers pass Number.isFinite and a range check, strings are
// capped and rendered as text, and the hourly and daily arrays are length-capped.

import { finite, getJson, text, type Failure } from './poll'

export interface Place {
  /** The rounded coordinates, "lat,lon"; one entry per spot. */
  id: string
  name: string
  admin: string
  country: string
  lat: number
  lon: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A place with coordinates rounded to 2 decimals, or null when they are not real coordinates. */
export function makePlace(name: unknown, admin: unknown, country: unknown, lat: unknown, lon: unknown): Place | null {
  const la = finite(lat)
  const lo = finite(lon)
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  const rla = round2(la)
  const rlo = round2(lo)
  const n = text(name, 80)
  if (!n) return null
  return { id: `${rla.toFixed(2)},${rlo.toFixed(2)}`, name: n, admin: text(admin, 80), country: text(country, 60), lat: rla, lon: rlo }
}

/** Validate a place read back from storage. */
export function asPlace(v: unknown): Place | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return makePlace(o.name, o.admin, o.country, o.lat, o.lon)
}

/** "Lisbon, Portugal"; the admin area is added only where a name alone is ambiguous (the search list). */
export const placeLabel = (p: Place, withAdmin = false): string => [p.name, withAdmin && p.admin !== p.name ? p.admin : '', p.country].filter(Boolean).join(', ')

// ---------- WMO weather codes ----------

// Text glyphs, not emoji: each code point defaults to text presentation, and U+FE0E pins it
// there on platforms that would otherwise swap in a colour emoji. The word carries the
// meaning; the glyph is a scanning aid and is hidden from screen readers.
const T = '\uFE0E'
const SUN = `☀${T}`
const MOON = '☾'
const PART = '◐'
const CLOUD = `☁${T}`
const FOG = '≡'
const DRIZZLE = '∴'
const RAIN = `☂${T}`
const SNOW = `❄${T}`
const STORM = '↯'

const WMO: Record<number, [string, string]> = {
  0: ['Clear', SUN],
  1: ['Mostly clear', SUN],
  2: ['Partly cloudy', PART],
  3: ['Overcast', CLOUD],
  45: ['Fog', FOG],
  48: ['Rime fog', FOG],
  51: ['Light drizzle', DRIZZLE],
  53: ['Drizzle', DRIZZLE],
  55: ['Heavy drizzle', DRIZZLE],
  56: ['Freezing drizzle', DRIZZLE],
  57: ['Freezing drizzle', DRIZZLE],
  61: ['Light rain', RAIN],
  63: ['Rain', RAIN],
  65: ['Heavy rain', RAIN],
  66: ['Freezing rain', RAIN],
  67: ['Freezing rain', RAIN],
  71: ['Light snow', SNOW],
  73: ['Snow', SNOW],
  75: ['Heavy snow', SNOW],
  77: ['Snow grains', SNOW],
  80: ['Light showers', RAIN],
  81: ['Showers', RAIN],
  82: ['Heavy showers', RAIN],
  85: ['Snow showers', SNOW],
  86: ['Snow showers', SNOW],
  95: ['Thunderstorm', STORM],
  96: ['Thunderstorm, hail', STORM],
  99: ['Thunderstorm, hail', STORM],
}

export function condition(code: number, isDay = true): { word: string; glyph: string } {
  const hit = WMO[code]
  if (!hit) return { word: 'Unknown', glyph: '·' }
  return { word: hit[0], glyph: !isDay && hit[1] === SUN ? MOON : hit[1] }
}

// ---------- forecast ----------

export interface Current {
  temp: number
  feels: number | null
  humidity: number | null
  precip: number | null
  code: number
  wind: number | null
  windDir: number | null
  isDay: boolean
}
export interface Hour {
  /** Local time at the place, YYYY-MM-DDTHH:MM. */
  time: string
  temp: number
  pop: number | null
  code: number
}
export interface Day {
  date: string
  code: number
  max: number
  min: number
  pop: number | null
  sunrise: string
  sunset: string
}
export interface Forecast {
  placeId: string
  /** Seconds east of UTC at the place, for the place's own "now". */
  offset: number
  current: Current
  hours: Hour[]
  days: Day[]
  fetchedAt: number
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const temp = (v: unknown): number | null => {
  const n = finite(v)
  return n !== null && n > -100 && n < 70 ? n : null
}
const pct = (v: unknown): number | null => {
  const n = finite(v)
  return n !== null && n >= 0 && n <= 100 ? Math.round(n) : null
}
const nonNeg = (v: unknown, max: number): number | null => {
  const n = finite(v)
  return n !== null && n >= 0 && n < max ? n : null
}
const code = (v: unknown): number | null => {
  const n = finite(v)
  return n !== null && Number.isInteger(n) && n >= 0 && n < 100 ? n : null
}
const arr = (o: unknown, key: string, max: number): unknown[] => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined
  return Array.isArray(v) ? v.slice(0, max) : []
}

export function parseForecast(data: unknown, placeId: string, at: number): Forecast | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const c = d.current as Record<string, unknown> | undefined
  const t = temp(c?.temperature_2m)
  const cc = code(c?.weather_code)
  if (!c || t === null || cc === null) return null
  const offset = finite(d.utc_offset_seconds)
  const current: Current = {
    temp: t,
    feels: temp(c.apparent_temperature),
    humidity: pct(c.relative_humidity_2m),
    precip: nonNeg(c.precipitation, 1000),
    code: cc,
    wind: nonNeg(c.wind_speed_10m, 500),
    windDir: nonNeg(c.wind_direction_10m, 360.5),
    isDay: c.is_day !== 0,
  }
  const hours: Hour[] = []
  const ht = arr(d.hourly, 'time', 400)
  const htemp = arr(d.hourly, 'temperature_2m', 400)
  const hpop = arr(d.hourly, 'precipitation_probability', 400)
  const hcode = arr(d.hourly, 'weather_code', 400)
  ht.forEach((time, i) => {
    const tv = temp(htemp[i])
    const cv = code(hcode[i])
    if (typeof time === 'string' && LOCAL_TIME.test(time) && tv !== null && cv !== null) hours.push({ time, temp: tv, pop: pct(hpop[i]), code: cv })
  })
  const days: Day[] = []
  const dt = arr(d.daily, 'time', 16)
  const dmax = arr(d.daily, 'temperature_2m_max', 16)
  const dmin = arr(d.daily, 'temperature_2m_min', 16)
  const dcode = arr(d.daily, 'weather_code', 16)
  const dpop = arr(d.daily, 'precipitation_probability_max', 16)
  const rise = arr(d.daily, 'sunrise', 16)
  const set = arr(d.daily, 'sunset', 16)
  dt.forEach((date, i) => {
    const hi = temp(dmax[i])
    const lo = temp(dmin[i])
    const cv = code(dcode[i])
    if (typeof date !== 'string' || !LOCAL_DATE.test(date) || hi === null || lo === null || cv === null) return
    const r = rise[i]
    const s = set[i]
    days.push({
      date,
      code: cv,
      max: Math.max(hi, lo),
      min: Math.min(hi, lo),
      pop: pct(dpop[i]),
      sunrise: typeof r === 'string' && LOCAL_TIME.test(r) ? r : '',
      sunset: typeof s === 'string' && LOCAL_TIME.test(s) ? s : '',
    })
  })
  return { placeId, offset: offset !== null && Math.abs(offset) <= 18 * 3600 ? offset : 0, current, hours, days, fetchedAt: at }
}

/** The place's local time now, as YYYY-MM-DDTHH:MM, from the offset Open-Meteo reported. */
export const placeNow = (f: Forecast, now = Date.now()): string => new Date(now + f.offset * 1000).toISOString().slice(0, 16)

/** The next 24 hours from the current one. */
export function next24(f: Forecast, now = Date.now()): Hour[] {
  const hour = `${placeNow(f, now).slice(0, 13)}:00`
  const i = f.hours.findIndex((h) => h.time >= hour)
  return i < 0 ? [] : f.hours.slice(i, i + 24)
}

/** Night at the place, by that day's sunrise and sunset, so a clear night hour shows the moon. */
export function isNight(f: Forecast, time: string): boolean {
  const day = f.days.find((d) => d.date === time.slice(0, 10))
  return !!day?.sunrise && !!day.sunset && (time < day.sunrise || time >= day.sunset)
}

const known = new Map<string, Forecast>()
const listeners = new Set<(placeId: string) => void>()

export const knownForecast = (placeId: string): Forecast | undefined => known.get(placeId)

export function onForecast(fn: (placeId: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function put(f: Forecast): void {
  known.set(f.placeId, f)
  for (const fn of listeners) fn(f.placeId)
}

/** Restore the ticker's last current conditions from storage, never over a fresher forecast. */
export function seedForecast(f: Forecast): void {
  if ((known.get(f.placeId)?.fetchedAt ?? -1) < f.fetchedAt) put(f)
}

const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FIELDS =
  'current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
  '&hourly=temperature_2m,precipitation_probability,weather_code' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
  '&timezone=auto&forecast_days=7'

export const WEATHER_MS = 15 * 60_000
const REUSE_MS = 5 * 60_000
const FORCE_REUSE_MS = 15_000

/** Older than two refresh intervals: at least one refresh was due and did not land. */
export const isStaleForecast = (f: Forecast, now = Date.now()): boolean => now - f.fetchedAt > 2 * WEATHER_MS

export type ForecastResult = { ok: true } | { ok: false; why: Failure }

export async function loadForecast(p: Place, force = false): Promise<ForecastResult> {
  // Rounded again here, so a place that somehow kept more precision still never sends it.
  const url = `${FORECAST}?latitude=${round2(p.lat).toFixed(2)}&longitude=${round2(p.lon).toFixed(2)}&${FIELDS}`
  const r = await getJson(url, force ? FORCE_REUSE_MS : REUSE_MS)
  if (!r.ok) return r
  let f: Forecast | null = null
  try {
    f = parseForecast(r.data, p.id, r.at)
  } catch {
    // An unanticipated shape counts as an unreadable answer and backs off like one.
  }
  if (!f) return { ok: false, why: 'bad' }
  put(f)
  return { ok: true }
}

// The base language subtag only (pt, not pt-BR), sent with every search for localized names.
const uiLang = (() => {
  const l = (navigator.language ?? 'en').split('-')[0].toLowerCase()
  return /^[a-z]{2}$/.test(l) ? l : 'en'
})()

/** Places matching a typed name, localised to the interface language. */
export async function searchPlaces(query: string): Promise<{ ok: true; places: Place[] } | { ok: false; why: Failure }> {
  const name = query.trim().slice(0, 80)
  const r = await getJson(`${GEOCODE}?name=${encodeURIComponent(name)}&count=8&language=${uiLang}&format=json`, 10 * 60_000)
  if (!r.ok) return r
  const out: Place[] = []
  for (const row of arr(r.data, 'results', 20)) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const p = makePlace(o.name, o.admin1, o.country, o.latitude, o.longitude)
    if (p && !out.some((x) => x.id === p.id)) out.push(p)
  }
  return { ok: true, places: out }
}

// ---------- units and formatting ----------

export type Units = 'metric' | 'imperial'

/** Imperial where the locale's region uses it (US, Liberia, Myanmar), metric everywhere else. */
export function defaultUnits(): Units {
  const region = (navigator.language ?? '').split('-').find((s, i) => i > 0 && s.length === 2)
  return region && ['US', 'LR', 'MM'].includes(region.toUpperCase()) ? 'imperial' : 'metric'
}

const toF = (c: number) => (c * 9) / 5 + 32

/** Whole degrees: "23°". */
export const formatTemp = (c: number, u: Units): string => `${Math.round(u === 'imperial' ? toF(c) : c)}°`
export const tempUnit = (u: Units): string => (u === 'imperial' ? '°F' : '°C')
export const formatWind = (kmh: number, u: Units): string => (u === 'imperial' ? `${Math.round(kmh / 1.609344)} mph` : `${Math.round(kmh)} km/h`)
export const formatPrecip = (mm: number, u: Units): string => (u === 'imperial' ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`)

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
/** 16-point compass name of the direction the wind blows from. */
export const compass = (deg: number): string => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

function utcFormat(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' })
  } catch {
    return null
  }
}
// Open-Meteo times are already local to the place, so they are formatted as UTC wall time:
// the reader's own timezone must not shift them.
const hourFmt = utcFormat({ hour: 'numeric' })
const clockFmt = utcFormat({ hour: '2-digit', minute: '2-digit' })
const dayFmt = utcFormat({ weekday: 'short' })
const longDayFmt = utcFormat({ weekday: 'long' })
const asUtc = (local: string) => new Date(`${local.length === 10 ? `${local}T12:00` : local}:00Z`)

export const formatHour = (local: string): string => hourFmt?.format(asUtc(local)) ?? local.slice(11, 13)
export const formatClock = (local: string): string => (local ? (clockFmt?.format(asUtc(local)) ?? local.slice(11, 16)) : '')
export const formatWeekday = (date: string, long = false): string => (long ? longDayFmt : dayFmt)?.format(asUtc(date)) ?? date
