// Weather: current conditions, the next 24 hours and 7 days for a saved place, from
// Open-Meteo. Data and the place rules live in core/weather-data.ts and the saved places,
// units and pin in core/weather-prefs.ts, both shared with the shell's top-bar ticker.
//
// Location is never automatic. A place comes from a typed search (the name and the
// interface language are sent) or from "Use my location", which asks the browser only on
// that click; either way the coordinates are rounded to about 1 km before they are stored
// or sent. The card polls every 15 minutes
// only while it is open, on screen and in a visible tab, and never in stage view.

import { Poller, formatTime, setCardPolling, type Failure, type PollOutcome } from '../core/poll'
import {
  WEATHER_MS,
  compass,
  condition,
  formatClock,
  formatHour,
  formatPrecip,
  formatTemp,
  formatWeekday,
  formatWind,
  isNight,
  knownForecast,
  loadForecast,
  makePlace,
  next24,
  onForecast,
  placeLabel,
  searchPlaces,
  tempUnit,
  type Forecast,
  type Place,
  type Units,
} from '../core/weather-data'
import {
  MAX_PLACES,
  WEATHER_PREFS_EVENT,
  addPlace,
  defaultPlace,
  loadWeatherPrefs,
  onShowDefaultPlace,
  removePlace,
  setDefaultPlace,
  setUnits,
  setWeatherPinned,
  takeWeatherPinHint,
  weatherPrefs,
} from '../core/weather-prefs'
import type { ToolModule } from '../shell/registry'
import { button, el, toast } from '../shell/ui'

const REASON: Record<Failure, string> = {
  limited: 'Open-Meteo is rate limiting',
  down: 'Open-Meteo did not answer',
  bad: 'Open-Meteo sent an answer that could not be read',
  offline: 'Open-Meteo cannot be reached while offline',
}

const isStageView = () => document.documentElement.classList.contains('stage-view')

// Per-card teardown keyed by the container: launchTool shares one module instance across
// every open card, so module-level timers would let a second card clobber the first.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  async activate(container: HTMLElement) {
    container.replaceChildren()
    container.classList.add('wx')
    await loadWeatherPrefs()
    // Announced before the first fetch, like Markets, so a ticker starting in the same page
    // load can see the card coming. The place it shows is fetched through the same cache.
    setCardPolling('weather', container, !!defaultPlace() && !document.hidden && navigator.onLine && !isStageView())

    let dead = false
    let onScreen = true
    let offline = !navigator.onLine
    // The place on screen. Starts on the default; an unsaved search pick can sit here too.
    let viewed: Place | null = defaultPlace()
    let lastFailure: Failure | null = null
    let geoBusy = false
    let geoNote = ''

    const units = (): Units => weatherPrefs().units
    const isSaved = (p: Place | null) => !!p && weatherPrefs().places.some((x) => x.id === p.id)

    // ---------- place picker ----------
    const placesEl = el('div', { class: 'wx-places', role: 'group', 'aria-label': 'Saved places' })
    const search = el('input', {
      type: 'search',
      class: 'wx-search',
      placeholder: 'Search a place',
      'aria-label': 'Search a place by name',
      spellcheck: 'false',
      autocomplete: 'off',
    }) as HTMLInputElement
    const results = el('div', { class: 'wx-results hidden', role: 'group', 'aria-label': 'Places found' })
    const geoBtn = button('Use my location', () => void locate(), 'ghost wx-geo', 'Ask the browser for your position once; it is rounded to about 1 km before it is used')
    const note = el('p', {
      class: 'wx-note muted small',
      text: 'Only the place name you type and your interface language, or your coordinates rounded to about 1 km, are sent to Open-Meteo.',
    })
    const statusEl = el('div', { class: 'wx-status small hidden', role: 'status' })
    const nowEl = el('div', { class: 'wx-now-wrap' })
    const hoursEl = el('div', { class: 'wx-sec' })
    const daysEl = el('div', { class: 'wx-sec' })
    const updatedEl = el('span', { class: 'wx-updated' })
    const refreshBtn = button('Refresh', () => void poller.poke(true), 'ghost', 'Fetch the forecast now')
    const attribution = el('p', { class: 'wx-sources' }, [
      'Weather data by ',
      el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo.com' }),
      ', free for non-commercial use. Times are local to the place.',
    ])

    container.append(
      placesEl,
      el('div', { class: 'wx-find' }, [search, ...('geolocation' in navigator ? [geoBtn] : [])]),
      results,
      note,
      statusEl,
      nowEl,
      hoursEl,
      daysEl,
      el('div', { class: 'wx-foot muted small' }, [attribution, el('div', { class: 'wx-foot-row' }, [updatedEl, el('span', { class: 'spacer' }), refreshBtn])]),
    )

    const view = (p: Place | null) => {
      viewed = p
      lastFailure = null
      render()
      poller.invalidate()
      gate()
    }

    /** Show a place and keep it when there is room. The first place saved becomes the default. */
    const choose = async (p: Place) => {
      clearSearch()
      const r = await addPlace(p)
      if (r === 'full') toast(`${MAX_PLACES} places are saved already. Remove one to keep ${p.name}.`, 5000)
      view(p)
    }

    // ---------- search ----------
    let searchTimer = 0
    let searchSeq = 0
    const clearSearch = () => {
      window.clearTimeout(searchTimer)
      searchSeq++
      search.value = ''
      results.replaceChildren()
      results.classList.add('hidden')
    }
    const showResults = (nodes: HTMLElement[]) => {
      results.replaceChildren(...nodes)
      results.classList.toggle('hidden', !nodes.length)
    }
    const runSearch = async () => {
      const q = search.value.trim()
      const seq = ++searchSeq
      if (q.length < 2) {
        showResults([])
        return
      }
      showResults([el('div', { class: 'muted small wx-res-note', text: 'Searching...' })])
      const r = await searchPlaces(q)
      if (dead || seq !== searchSeq) return
      if (!r.ok) {
        showResults([el('div', { class: 'muted small wx-res-note', text: `${REASON[r.why]}. Try again in a moment.` })])
        return
      }
      if (!r.places.length) {
        showResults([el('div', { class: 'muted small wx-res-note', text: `No place matches "${q.slice(0, 40)}".` })])
        return
      }
      showResults(
        r.places.map((p) => {
          const b = el('button', { class: 'wx-result', type: 'button' }, [
            el('span', { class: 'wx-res-name', text: p.name }),
            el('span', { class: 'wx-res-where', text: [p.admin !== p.name ? p.admin : '', p.country].filter(Boolean).join(', ') }),
          ])
          b.addEventListener('click', () => void choose(p))
          b.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              clearSearch()
              search.focus()
            }
          })
          return b
        }),
      )
    }
    search.addEventListener('input', () => {
      window.clearTimeout(searchTimer)
      searchTimer = window.setTimeout(() => void runSearch(), 350)
    })
    search.addEventListener('keydown', (e) => {
      const first = results.querySelector<HTMLButtonElement>('button.wx-result')
      if (e.key === 'Enter' && first) {
        e.preventDefault()
        first.click()
      } else if (e.key === 'ArrowDown' && first) {
        e.preventDefault()
        first.focus()
      } else if (e.key === 'Escape') {
        clearSearch()
      }
    })

    // ---------- geolocation ----------
    // Called only from the button. The position is rounded by makePlace before it is shown,
    // saved or sent; the browser's own prompt still applies the first time.
    const locate = async () => {
      if (geoBusy) return
      geoBusy = true
      geoNote = 'Asking the browser for your location...'
      render()
      const pos = await new Promise<GeolocationPosition | GeolocationPositionError>((resolve) =>
        navigator.geolocation.getCurrentPosition(resolve, resolve, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 }),
      )
      geoBusy = false
      if (dead) return
      if (!('coords' in pos)) {
        geoNote =
          pos.code === 1
            ? 'Location access is blocked for this site. Search for a place instead.'
            : pos.code === 3
              ? 'Your location could not be found in time. Try again, or search for a place.'
              : 'Your location is unavailable right now. Search for a place instead.'
        render()
        return
      }
      const lat = Math.round(pos.coords.latitude * 100) / 100
      const lon = Math.round(pos.coords.longitude * 100) / 100
      const p = makePlace(`Near ${lat.toFixed(2)}, ${lon.toFixed(2)}`, '', '', lat, lon)
      geoNote = ''
      if (p) await choose(p)
      else render()
    }

    // ---------- rendering ----------
    const keep = (b: HTMLElement, key: string) => {
      b.dataset.k = key
      return b
    }

    const renderPlaces = () => {
      const { places, defaultId } = weatherPrefs()
      const chips = places.map((p) => {
        const isDefault = p.id === defaultId
        const b = el(
          'button',
          {
            class: 'wx-place',
            type: 'button',
            'aria-pressed': String(p.id === viewed?.id),
            title: isDefault ? `${placeLabel(p)}. Default place: opens first and is the one pinned to the top bar.` : placeLabel(p),
          },
          [...(isDefault ? [el('span', { class: 'wx-home', text: '⌂', 'aria-hidden': 'true' })] : []), el('span', { class: 'wx-place-name', text: p.name })],
        )
        if (isDefault) b.setAttribute('aria-label', `${p.name}, default place`)
        b.addEventListener('click', () => view(p))
        return keep(b, `place:${p.id}`)
      })
      if (viewed && !isSaved(viewed)) {
        chips.push(el('span', { class: 'wx-place unsaved', text: viewed.name, title: 'Not saved' }))
      }
      // Empty collapses the row: the status line already says how to choose a place.
      placesEl.replaceChildren(...chips)
    }

    const statusLines = (f: Forecast | undefined): string[] => {
      const out: string[] = []
      if (geoNote) out.push(geoNote)
      if (!viewed) {
        if (!geoNote) out.push('Search for a place by name, or use your location, to see its weather.')
        return out
      }
      const at = f ? formatTime(f.fetchedAt) : ''
      if (offline) out.push(f ? `Offline. This forecast is from ${at} and refreshes when the connection returns.` : 'Offline. The forecast loads when the connection returns.')
      else if (lastFailure && f) out.push(`${REASON[lastFailure]}. Showing the forecast from ${at}; retrying later.`)
      else if (lastFailure) out.push(`The forecast could not be loaded: ${REASON[lastFailure]}. Retrying later, or use Refresh.`)
      else if (!f || !f.hours.length) out.push(`Loading the forecast for ${viewed.name}...`)
      return out
    }

    const renderNow = (f: Forecast | undefined) => {
      if (!viewed || !f) {
        nowEl.replaceChildren()
        return
      }
      const u = units()
      const c = f.current
      const cond = condition(c.code, c.isDay)
      const today = f.days[0]
      const facts: Array<[string, string]> = []
      if (c.feels !== null) facts.push(['Feels like', formatTemp(c.feels, u)])
      if (c.humidity !== null) facts.push(['Humidity', `${c.humidity}%`])
      if (c.wind !== null) facts.push(['Wind', `${formatWind(c.wind, u)}${c.windDir !== null && c.wind >= 1 ? ` ${compass(c.windDir)}` : ''}`])
      if (c.precip !== null) facts.push(['Precipitation', formatPrecip(c.precip, u)])
      if (today?.sunrise) facts.push(['Sunrise', formatClock(today.sunrise)])
      if (today?.sunset) facts.push(['Sunset', formatClock(today.sunset)])

      const unitSeg = el(
        'div',
        { class: 'wx-units', role: 'group', 'aria-label': 'Units' },
        (
          [
            ['metric', '°C, km/h'],
            ['imperial', '°F, mph'],
          ] as const
        ).map(([value, label]) => {
          const b = button(label, () => void setUnits(value))
          b.setAttribute('aria-pressed', String(u === value))
          b.dataset.units = value
          return keep(b, `units:${value}`)
        }),
      )

      const { pinned, defaultId } = weatherPrefs()
      const def = defaultPlace()
      const actions: HTMLElement[] = []
      if (def) {
        const pin = button(
          pinned ? '★ Pinned to the top bar' : '☆ Pin to the top bar',
          () => void togglePin(),
          'ghost wx-pin',
          pinned ? 'Unpin' : `Pin the weather for ${def.name}, the default place, to the top bar`,
        )
        pin.setAttribute('aria-pressed', String(pinned))
        actions.push(keep(pin, 'pin'))
      }
      if (isSaved(viewed) && viewed.id !== defaultId)
        actions.push(
          keep(
            button('Make default', () => void setDefaultPlace(viewed?.id ?? ''), 'ghost', 'Open on this place first, and show it on the top bar when pinned'),
            'default',
          ),
        )
      if (isSaved(viewed))
        actions.push(
          keep(
            button('Remove', () => void removePlace(viewed?.id ?? ''), 'ghost', `Remove ${viewed.name} from saved places`),
            'remove',
          ),
        )
      else
        actions.push(
          keep(
            button(
              'Save place',
              () => {
                if (viewed) void choose(viewed)
              },
              'ghost',
              `Keep ${viewed.name} in saved places`,
            ),
            'save',
          ),
        )

      nowEl.replaceChildren(
        el('div', { class: 'wx-now' }, [
          el('span', { class: 'wx-glyph', text: cond.glyph, 'aria-hidden': 'true' }),
          el('span', { class: 'wx-temp', text: formatTemp(c.temp, u), 'aria-label': `${formatTemp(c.temp, u).replace('°', ` ${tempUnit(u)}`)}` }),
          el('div', { class: 'wx-cond' }, [el('div', { class: 'wx-word', text: cond.word }), el('div', { class: 'wx-where muted small', text: placeLabel(viewed) })]),
          el('span', { class: 'spacer' }),
          unitSeg,
        ]),
        el(
          'dl',
          { class: 'wx-facts' },
          facts.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: v })])),
        ),
        el('div', { class: 'wx-actions' }, actions),
      )
    }

    const renderHours = (f: Forecast | undefined) => {
      const hours = f ? next24(f) : []
      if (!hours.length) {
        hoursEl.replaceChildren()
        return
      }
      const u = units()
      hoursEl.replaceChildren(
        el('div', { class: 'group-label', text: 'Next 24 hours' }),
        el(
          'div',
          { class: 'wx-hours', role: 'list' },
          hours.map((h, i) => {
            const cond = condition(h.code, !isNight(f as Forecast, h.time))
            return el('div', { class: 'wx-hour', role: 'listitem' }, [
              el('span', { class: 'wx-h-time', text: i === 0 ? 'Now' : formatHour(h.time) }),
              el('span', { class: 'wx-h-glyph', text: cond.glyph, 'aria-hidden': 'true' }),
              el('span', { class: 'sr-only', text: cond.word }),
              el('span', { class: 'wx-h-temp', text: formatTemp(h.temp, u) }),
              el('span', { class: `wx-h-pop${(h.pop ?? 0) >= 30 ? ' wet' : ''}`, text: h.pop === null ? '' : `${h.pop}%`, title: 'Chance of rain' }),
            ])
          }),
        ),
      )
    }

    const renderDays = (f: Forecast | undefined) => {
      const days = f?.days ?? []
      if (!days.length) {
        daysEl.replaceChildren()
        return
      }
      const u = units()
      const lo = Math.min(...days.map((d) => d.min))
      const span = Math.max(...days.map((d) => d.max)) - lo || 1
      daysEl.replaceChildren(
        el('div', { class: 'group-label', text: '7 days' }),
        el(
          'div',
          { class: 'wx-days' },
          days.map((d, i) => {
            const cond = condition(d.code)
            // Per-property CSSOM, which style-src 'self' allows; a style attribute it would not.
            const fill = el('span', { class: 'wx-fill' })
            fill.style.left = `${(((d.min - lo) / span) * 100).toFixed(1)}%`
            fill.style.width = `${Math.max(4, ((d.max - d.min) / span) * 100).toFixed(1)}%`
            return el('div', { class: 'wx-day' }, [
              el('span', { class: 'wx-d-name', text: i === 0 ? 'Today' : formatWeekday(d.date), title: formatWeekday(d.date, true) }),
              el('span', { class: 'wx-d-glyph', text: cond.glyph, 'aria-hidden': 'true' }),
              el('span', { class: 'wx-d-word', text: cond.word }),
              el('span', { class: `wx-d-pop${(d.pop ?? 0) >= 30 ? ' wet' : ''}`, text: d.pop === null ? '' : `${d.pop}%`, title: 'Chance of rain' }),
              el('span', { class: 'wx-d-min', text: formatTemp(d.min, u), 'aria-label': `low ${formatTemp(d.min, u)}` }),
              el('span', { class: 'wx-range', 'aria-hidden': 'true' }, [fill]),
              el('span', { class: 'wx-d-max', text: formatTemp(d.max, u), 'aria-label': `high ${formatTemp(d.max, u)}` }),
            ])
          }),
        ),
      )
    }

    const render = () => {
      if (dead) return
      const active = document.activeElement as HTMLElement | null
      const focusKey = active && container.contains(active) ? active.dataset.k : undefined
      const f = viewed ? knownForecast(viewed.id) : undefined
      renderPlaces()
      const lines = statusLines(f)
      statusEl.replaceChildren(...lines.map((t) => el('div', { text: t })))
      statusEl.classList.toggle('hidden', !lines.length)
      geoBtn.textContent = geoBusy ? 'Locating...' : 'Use my location'
      ;(geoBtn as HTMLButtonElement).disabled = geoBusy
      renderNow(f)
      renderHours(f)
      renderDays(f)
      updatedEl.textContent = f ? `Updated ${formatTime(f.fetchedAt)}` : ''
      refreshBtn.classList.toggle('hidden', !viewed)
      if (focusKey) container.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true })
    }

    const togglePin = async () => {
      const on = !weatherPrefs().pinned
      await setWeatherPinned(on)
      if (on && (await takeWeatherPinHint())) toast('Pinned weather refreshes from Open-Meteo every 15 minutes, only while this tab is visible.', 7000)
    }

    // ---------- polling ----------
    const canRun = () => !dead && !!viewed && !document.hidden && onScreen && !offline && !isStageView()
    const run = async (_k: 'forecast', force: boolean): Promise<PollOutcome> => {
      const p = viewed
      if (!p) return 'idle'
      const f = knownForecast(p.id)
      // A forecast loaded by the ticker or a previous visit is used while it is fresh.
      if (!force && f?.hours.length && Date.now() - f.fetchedAt < WEATHER_MS - 5000) return { dueAt: f.fetchedAt + WEATHER_MS }
      const r = await loadForecast(p, force)
      if (dead) return 'idle'
      // A place switched mid-request invalidated this pass, so its outcome is discarded by
      // the poller and the new place runs next; only the place on screen sets the status.
      if (viewed?.id === p.id) lastFailure = r.ok ? null : r.why
      return r.ok ? 'ok' : 'fail'
    }
    const poller = new Poller<'forecast'>({ forecast: WEATHER_MS }, run, canRun, undefined, render)
    const gate = () => {
      setCardPolling('weather', container, canRun())
      if (canRun()) void poller.poke()
      else poller.stop()
    }

    const offForecast = onForecast((id) => {
      if (id === viewed?.id) render()
    })
    const offShow = onShowDefaultPlace(() => {
      const def = defaultPlace()
      if (def && def.id !== viewed?.id) view(def)
    })
    // Saved places as of the last prefs event, to tell a removal of the place on screen
    // from an unsaved search pick that was never in the list.
    let wasSaved = new Set(weatherPrefs().places.map((x) => x.id))
    const onPrefs = () => {
      const places = weatherPrefs().places
      const removed = !!viewed && wasSaved.has(viewed.id) && !places.some((x) => x.id === viewed?.id)
      wasSaved = new Set(places.map((x) => x.id))
      if (removed || !viewed) {
        const def = defaultPlace()
        if (removed || def) return view(def)
      }
      render()
    }
    window.addEventListener(WEATHER_PREFS_EVENT, onPrefs)
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
    gate()

    detachers.set(container, () => {
      dead = true
      poller.stop()
      window.clearTimeout(searchTimer)
      setCardPolling('weather', container, false)
      offForecast()
      offShow()
      window.removeEventListener(WEATHER_PREFS_EVENT, onPrefs)
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
