// Weather ticker: the default place's current conditions, when pinned from the Weather
// card. Refreshes every 15 minutes while the tab is visible, through the same cache and
// backoff as the card, so an open card showing that place costs no extra request.

import { Poller, cardIsPolling, formatTime, type PollOutcome } from '../core/poll'
import { WEATHER_MS, condition, formatTemp, isStaleForecast, knownForecast, loadForecast, onForecast, seedForecast, tempUnit } from '../core/weather-data'
import {
  WEATHER_PREFS_EVENT,
  dropWeatherSnapshot,
  defaultPlace,
  loadWeatherPrefs,
  readWeatherSnapshot,
  reloadWeatherPrefs,
  setWeatherPinned,
  showDefaultPlace,
  weatherPrefs,
  writeWeatherSnapshot,
} from '../core/weather-prefs'
import type { SourceHost, TickerItem, TickerSource } from './tickers'

export function weatherTicker(): TickerSource {
  let host: SourceHost | null = null
  let failing = false
  let snapshotAt = 0

  const active = () => (weatherPrefs().pinned ? defaultPlace() : null)

  const item = (): TickerItem | null => {
    const place = active()
    if (!place) return null
    const { units } = weatherPrefs()
    const f = knownForecast(place.id)
    const offline = !navigator.onLine
    const base = {
      key: 'weather',
      attr: ['weather', place.id] as [string, string],
      name: `the weather for ${place.name}`,
      open: () => {
        host?.openCard('weather')
        showDefaultPlace()
      },
      unpin: () => void setWeatherPinned(false),
      chg: null,
    }
    if (!f)
      return { ...base, sym: '·', value: '–', stale: true, label: `Weather in ${place.name}, not loaded yet`, title: offline ? 'No forecast yet, offline' : 'No forecast yet' }
    const c = condition(f.current.code, f.current.isDay)
    // The stored snapshot carries no hours: it paints at once, dimmed until refreshed.
    const stale = offline || isStaleForecast(f) || !f.hours.length
    const at = formatTime(f.fetchedAt)
    const t = formatTemp(f.current.temp, units)
    return {
      ...base,
      sym: c.glyph,
      value: t,
      stale,
      label: `Weather in ${place.name}: ${t.replace('°', ` ${tempUnit(units)}`)}, ${c.word.toLowerCase()}${stale ? `, updated ${at}` : ''}`,
      title: stale ? `Updated ${at}, ${offline ? 'offline' : failing ? 'unreachable' : 'refreshing'}` : `${place.name}: ${c.word}, updated ${at}. Opens Weather.`,
    }
  }

  const run = async (_kind: 'forecast', force: boolean): Promise<PollOutcome> => {
    const place = active()
    if (!place) return 'idle'
    const f = knownForecast(place.id)
    const wait = WEATHER_MS + (cardIsPolling('weather') ? 15_000 : -5_000)
    // A snapshot has no hours or days, so it never counts as fresh for this check.
    if (!force && f && f.hours.length && Date.now() - f.fetchedAt < wait) return { dueAt: f.fetchedAt + wait }
    const r = await loadForecast(place, force)
    failing = !r.ok
    return r.ok ? 'ok' : 'fail'
  }

  const nextStale = () => {
    const place = active()
    const f = place && knownForecast(place.id)
    const at = f ? f.fetchedAt + 2 * WEATHER_MS + 1000 : Infinity
    return at > Date.now() ? at : Infinity
  }

  const save = () => {
    const place = active()
    const f = place && knownForecast(place.id)
    if (f && f.fetchedAt > snapshotAt) {
      snapshotAt = f.fetchedAt
      writeWeatherSnapshot(f)
    }
  }

  const poller = new Poller<'forecast'>(
    { forecast: WEATHER_MS },
    run,
    () => !document.hidden && navigator.onLine && !!active(),
    nextStale,
    () => {
      host?.changed()
      save()
    },
  )

  return {
    items: () => {
      const it = item()
      return it ? [it] : []
    },
    start(h) {
      host = h
      window.addEventListener(WEATHER_PREFS_EVENT, () => {
        poller.invalidate()
        h.changed()
        void poller.poke()
      })
      onForecast((id) => {
        if (id !== active()?.id) return
        h.changed()
        save()
      })
      void (async () => {
        await loadWeatherPrefs()
        const snap = await readWeatherSnapshot()
        // A snapshot for anything but the pinned default is leftover, from a write that
        // landed after an unpin or a removal; it holds coordinates, so it goes.
        if (snap && snap.placeId === active()?.id) {
          seedForecast(snap)
          snapshotAt = snap.fetchedAt
        } else if (snap) {
          void dropWeatherSnapshot()
        }
        h.changed()
        void poller.poke()
      })()
    },
    pause: () => poller.stop(),
    resume(reconnected) {
      if (reconnected) {
        failing = false
        poller.invalidate()
      }
      void reloadWeatherPrefs().finally(() => void poller.poke())
    },
  }
}
