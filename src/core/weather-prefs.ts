// Weather preferences shared by the Weather card and the shell's top-bar ticker: saved
// places (at most MAX_PLACES, coordinates already rounded), which one is the default, the
// unit system, and whether the default place's weather is pinned to the bar. Writes
// dispatch WEATHER_PREFS_EVENT so a second open surface repaints, and the ticker re-reads
// the store when its tab becomes visible so other tabs converge.
//
// Keys: 'weather-places' (Place[]), 'weather-default' (a place id), 'weather-units'
// ('metric' | 'imperial'), 'weather-pin' (boolean), 'weather-pin-hint' (the first-pin
// notice was shown), 'weather-snapshot' (the pinned place's last conditions).
import { asPlace, defaultUnits, type Current, type Forecast, type Place, type Units } from './weather-data'
import { getItem, removeItem, setItem } from './store'

export const WEATHER_PREFS_EVENT = 'wt:weather-prefs'
export const MAX_PLACES = 5

export interface WeatherPrefs {
  places: Place[]
  defaultId: string | null
  units: Units
  pinned: boolean
}

let prefs: WeatherPrefs = { places: [], defaultId: null, units: defaultUnits(), pinned: false }
let loaded: Promise<WeatherPrefs> | null = null

// With no place left the pin goes too: kept, it would silently pin, and poll for, the
// next place anyone looks at.
function normalise(p: WeatherPrefs): WeatherPrefs {
  const places = p.places.slice(0, MAX_PLACES)
  const defaultId = places.some((x) => x.id === p.defaultId) ? p.defaultId : (places[0]?.id ?? null)
  return { ...p, places, defaultId, pinned: p.pinned && defaultId !== null }
}

async function read(): Promise<WeatherPrefs> {
  try {
    const [places, def, units, pinned] = await Promise.all([
      getItem<unknown>('weather-places'),
      getItem<unknown>('weather-default'),
      getItem<unknown>('weather-units'),
      getItem<unknown>('weather-pin'),
    ])
    const list = Array.isArray(places) ? places.map(asPlace).filter((x): x is Place => !!x) : []
    return normalise({
      places: list.filter((x, i) => list.findIndex((y) => y.id === x.id) === i),
      defaultId: typeof def === 'string' ? def : null,
      units: units === 'metric' || units === 'imperial' ? units : defaultUnits(),
      pinned: pinned === true,
    })
  } catch {
    return { places: [], defaultId: null, units: defaultUnits(), pinned: false }
  }
}

function publish(next: WeatherPrefs): void {
  prefs = next
  window.dispatchEvent(new CustomEvent<WeatherPrefs>(WEATHER_PREFS_EVENT, { detail: next }))
}

export function loadWeatherPrefs(): Promise<WeatherPrefs> {
  loaded ??= read().then((p) => (prefs = p))
  return loaded
}

/** The preferences as last loaded or written. Valid after loadWeatherPrefs() resolved. */
export function weatherPrefs(): WeatherPrefs {
  return prefs
}

export function defaultPlace(p: WeatherPrefs = prefs): Place | null {
  return p.places.find((x) => x.id === p.defaultId) ?? null
}

export async function reloadWeatherPrefs(): Promise<void> {
  const next = await read()
  if (JSON.stringify(next) !== JSON.stringify(prefs)) publish(next)
}

async function save(next: WeatherPrefs): Promise<void> {
  const n = normalise(next)
  const prev = prefs
  publish(n)
  try {
    await Promise.all([setItem('weather-places', n.places), setItem('weather-default', n.defaultId), setItem('weather-units', n.units), setItem('weather-pin', n.pinned)])
    // The snapshot holds the pinned place's rounded coordinates. It goes as soon as it no
    // longer describes the pinned default: unpinned, removed, or replaced as the default.
    if (!n.pinned || n.defaultId !== prev.defaultId) await dropWeatherSnapshot()
  } catch {
    // A locked or failing store keeps the change for this page only.
  }
}

export async function dropWeatherSnapshot(): Promise<void> {
  await removeItem('weather-snapshot').catch(() => {})
}

const current = () => loadWeatherPrefs().then(() => prefs)

export type AddResult = 'added' | 'exists' | 'full'

/** Save a place. The first one saved becomes the default. */
export async function addPlace(place: Place): Promise<AddResult> {
  const p = await current()
  if (p.places.some((x) => x.id === place.id)) return 'exists'
  if (p.places.length >= MAX_PLACES) return 'full'
  await save({ ...p, places: [...p.places, place] })
  return 'added'
}

export async function removePlace(id: string): Promise<void> {
  const p = await current()
  await save({ ...p, places: p.places.filter((x) => x.id !== id) })
}

export async function setDefaultPlace(id: string): Promise<void> {
  const p = await current()
  if (p.places.some((x) => x.id === id) && p.defaultId !== id) await save({ ...p, defaultId: id })
}

export async function setUnits(units: Units): Promise<void> {
  const p = await current()
  if (units !== p.units) await save({ ...p, units })
}

export async function setWeatherPinned(pinned: boolean): Promise<void> {
  const p = await current()
  if (pinned !== p.pinned) await save({ ...p, pinned })
}

/** True exactly once per profile, for the notice explaining what pinning starts. */
export async function takeWeatherPinHint(): Promise<boolean> {
  try {
    if (await getItem<boolean>('weather-pin-hint')) return false
    await setItem('weather-pin-hint', true)
    return true
  } catch {
    return false
  }
}

/** The pinned place's current conditions as a Forecast with no hours or days, for a reload to paint at once. */
export async function readWeatherSnapshot(): Promise<Forecast | null> {
  try {
    const v = await getItem<{ placeId?: unknown; current?: unknown; fetchedAt?: unknown; offset?: unknown }>('weather-snapshot')
    const c = v?.current as Partial<Current> | undefined
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
    if (!v || typeof v.placeId !== 'string' || !c || !num(c.temp) || !num(c.code) || !num(v.fetchedAt)) return null
    return {
      placeId: v.placeId.slice(0, 32),
      offset: num(v.offset) ? (v.offset as number) : 0,
      current: { temp: c.temp as number, code: c.code as number, isDay: c.isDay !== false, feels: null, humidity: null, precip: null, wind: null, windDir: null },
      hours: [],
      days: [],
      fetchedAt: v.fetchedAt as number,
    }
  } catch {
    return null
  }
}

export function writeWeatherSnapshot(f: Forecast): void {
  void setItem('weather-snapshot', {
    placeId: f.placeId,
    offset: f.offset,
    current: { temp: f.current.temp, code: f.current.code, isDay: f.current.isDay },
    fetchedAt: f.fetchedAt,
  }).catch(() => {})
}

// A ticker click asks an open Weather card to switch to the default place, the one the
// ticker shows. A newly launched card starts there anyway.
const showListeners = new Set<() => void>()
export function showDefaultPlace(): void {
  for (const fn of showListeners) fn()
}
export function onShowDefaultPlace(fn: () => void): () => void {
  showListeners.add(fn)
  return () => showListeners.delete(fn)
}
