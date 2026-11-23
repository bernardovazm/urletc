// Shared transport and schedule for the live-data tools (Markets, Weather) and their
// top-bar tickers. Both surfaces of one tool ask for the same URLs, so a GET joins any
// request already in flight and reuses a recent answer, and both back off on failure, so
// a card and a ticker never double the calls against a free service's rate limit.
//
// Nothing here writes to the console: these services do fail, and the e2e suite treats
// console errors as failures.

const TIMEOUT_MS = 10_000
const MAX_BYTES = 1_000_000

/** 'limited' is a 429, 'down' a 5xx or no answer, 'bad' an answer that did not parse. */
export type Failure = 'limited' | 'down' | 'offline' | 'bad'
export type Res = { ok: true; data: unknown; at: number } | { ok: false; why: Failure }

const cache = new Map<string, { at: number; data: unknown }>()
const inflight = new Map<string, Promise<Res>>()

/**
 * GET one JSON document. A response younger than `maxAge` is served from memory and a
 * request already in flight is joined, so two surfaces asking at once cost one call.
 * Nothing aborts a request but its own timeout: another surface may be waiting on it.
 */
export function getJson(url: string, maxAge: number, noCache = false): Promise<Res> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < maxAge) return Promise.resolve({ ok: true, data: hit.data, at: hit.at })
  const running = inflight.get(url)
  if (running) return running
  const run = (async (): Promise<Res> => {
    if (!navigator.onLine) return { ok: false, why: 'offline' }
    const ac = new AbortController()
    const timer = window.setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const r = await fetch(url, { signal: ac.signal, credentials: 'omit', cache: noCache ? 'no-cache' : 'default' })
      if (!r.ok) return { ok: false, why: r.status === 429 ? 'limited' : r.status >= 500 ? 'down' : 'bad' }
      const text = await r.text()
      if (text.length > MAX_BYTES) return { ok: false, why: 'bad' }
      const data: unknown = JSON.parse(text)
      const at = Date.now()
      cache.set(url, { at, data })
      if (cache.size > 24) cache.delete(cache.keys().next().value as string)
      return { ok: true, data, at }
    } catch (e) {
      // A timeout, a network or CORS failure, and a body that is not JSON.
      return { ok: false, why: e instanceof SyntaxError ? 'bad' : navigator.onLine ? 'down' : 'offline' }
    } finally {
      window.clearTimeout(timer)
    }
  })()
  inflight.set(url, run)
  void run.finally(() => inflight.delete(url))
  return run
}

/** A finite number, from a number or a short numeric string; null for anything else. */
export const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.length < 64 ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** A string from an untrusted payload, trimmed and capped; '' for anything else. */
export const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// Cards currently polling, per tool. A ticker defers to an open card of its tool, so one
// open card does not double the calls against a shared rate limit.
const pollingCards = new Map<string, Set<object>>()
export function setCardPolling(tool: string, card: object, on: boolean): void {
  const set = pollingCards.get(tool) ?? new Set<object>()
  if (on) set.add(card)
  else set.delete(card)
  pollingCards.set(tool, set)
}
export const cardIsPolling = (tool: string): boolean => (pollingCards.get(tool)?.size ?? 0) > 0

export const MAX_BACKOFF_MS = 15 * 60_000
const BACKOFF_BASE_MS = 120_000
/** Consecutive failures n wait 2 min x 2^n, capped: 4, 8, 15 minutes. */
export const backoffMs = (fails: number): number => Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, fails))

export type PollOutcome = 'ok' | 'fail' | 'idle' | { dueAt: number }

/**
 * One timer for several families of data (crypto and fiat, or one forecast). Each family is
 * due again its interval after a success, after a growing backoff after a failure, at an
 * explicit time when the caller found the data fresh already, or never when it has
 * nothing to fetch. `canRun` gates every pass and every re-arm, so a hidden tab, an
 * offline browser or a card off screen holds no timer at all, and `poke()` on the way back
 * runs only what fell due meanwhile.
 */
export class Poller<K extends string> {
  private readonly kinds: K[]
  private due = {} as Record<K, number>
  private fails = {} as Record<K, number>
  // Bumped by invalidate(). A pass that was already in flight when its family was
  // invalidated (a place or quote switched mid-request) must not write its outcome over
  // the due=0 invalidate() set, or the switch is never fetched.
  private gen = {} as Record<K, number>
  private timer = 0
  private busy = false
  private again = false
  private forceNext = false

  constructor(
    private readonly intervals: Record<K, number>,
    private readonly run: (kind: K, force: boolean) => Promise<PollOutcome>,
    private readonly canRun: () => boolean,
    /** Extra wake-up time, for a repaint when something turns stale between fetches. */
    private readonly wakeAt: () => number = () => Infinity,
    private readonly onPass: () => void = () => {},
  ) {
    this.kinds = Object.keys(intervals) as K[]
    for (const k of this.kinds) {
      this.due[k] = 0
      this.fails[k] = 0
      this.gen[k] = 0
    }
  }

  /** Run every family that is due (all of them when `force`), then re-arm. */
  async poke(force = false): Promise<void> {
    if (this.busy) {
      this.again = true
      this.forceNext ||= force
      return
    }
    this.stop()
    if (!this.canRun()) return
    this.busy = true
    try {
      const now = Date.now()
      await Promise.all(this.kinds.filter((k) => force || this.due[k] <= now).map((k) => this.runOne(k, force)))
    } finally {
      this.busy = false
    }
    this.onPass()
    if (this.again) {
      const f = this.forceNext
      this.again = false
      this.forceNext = false
      return this.poke(f)
    }
    this.arm()
  }

  /** Make one family, or all, due now, as when a new pin or place has no data yet. */
  invalidate(kind?: K): void {
    for (const k of this.kinds) {
      if (kind && kind !== k) continue
      this.due[k] = 0
      this.gen[k]++
    }
  }

  stop(): void {
    window.clearTimeout(this.timer)
    this.timer = 0
  }

  private async runOne(kind: K, force: boolean): Promise<void> {
    const gen = this.gen[kind]
    let out: PollOutcome
    try {
      out = await this.run(kind, force)
    } catch {
      out = 'fail'
    }
    if (this.gen[kind] !== gen) {
      // Superseded: leave due at 0 and run the family again once this pass ends.
      this.again = true
      return
    }
    const now = Date.now()
    if (out === 'ok') {
      this.fails[kind] = 0
      this.due[kind] = now + this.intervals[kind]
    } else if (out === 'fail') {
      this.fails[kind]++
      this.due[kind] = now + backoffMs(this.fails[kind])
    } else if (out === 'idle') {
      this.due[kind] = Infinity
    } else {
      this.due[kind] = out.dueAt
    }
  }

  private arm(): void {
    this.stop()
    if (!this.canRun()) return
    const next = Math.min(this.wakeAt(), ...this.kinds.map((k) => this.due[k]))
    if (next === Infinity) return
    // setTimeout overflows past 2^31-1 ms; the clamp to an hour is for clock jumps.
    const delay = Math.min(Math.max(0, next - Date.now()), 3_600_000)
    this.timer = window.setTimeout(() => void this.poke(), delay + 50)
  }
}

const clock = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
})()

/** hh:mm in the reader's own clock and format. */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  return clock ? clock.format(d) : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
