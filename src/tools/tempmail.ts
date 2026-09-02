// Disposable inbox. Client-only like the rest of the app: the browser talks to the
// provider directly, there is no urletc backend in the path.
//
// The provider is load-bearing and was settled from a REAL BROWSER, not curl. mail.tm,
// tempmail.lol, etempmail, 1secmail and ulvis all answer curl happily and then fail a
// page fetch (no CORS headers), so a working curl proves nothing here. api.mail.gw sends
// the headers, so it is the one; swapping it means re-testing in a browser first, and
// adding the new origin to connect-src in BOTH vercel.json and vite.config.ts.
//
// Five calls make the whole tool:
//   GET  /domains        pick a live domain
//   POST /accounts       claim <random>@<domain> with a generated password
//   POST /token          exchange the same credentials for a bearer token
//   GET  /messages       poll the inbox, Authorization: Bearer <token>
//   GET  /messages/{id}  one message, including its text and html parts
// Collections come back as a hydra envelope by default and as a bare array when the
// request sets Accept: application/json, so `members()` accepts either.
//
// The receive path is verified, not assumed: an address claimed by this tool in a real
// browser was sent a real message over SMTP by a third party, and it appeared in the card
// within one poll with nothing clicked. So "no mail arrived" means no mail was sent, or
// one of the states below was hit. Each of them now says which.
//
// Nothing here may write to the console: the e2e suite fails the run on a console error,
// and a free third-party service WILL be down or rate limiting sometimes. Every failure
// path ends in a sentence in the status line instead.

import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'
import { stripHtml } from './html-strip'

const API = 'https://api.mail.gw'
const POLL_MS = 15_000
const MAX_POLL_MS = 120_000 // a 429 doubles the interval up to this, never faster
const REQ_TIMEOUT_MS = 12_000
const BODY_MAX = 20_000
const LIST_MAX = 25
const KEY = 'account'

const DOWN = 'The mail service did not answer. The next check waits longer, or use Refresh now.'
const LIMITED = 'The mail service is rate limiting, so the next check waits longer.'
const UNSAVED = 'This address is not being saved, so a reload will claim a different one.'

interface Account {
  address: string
  password: string
  token: string
}

interface ReqOpts {
  method?: string
  body?: string
  token?: string
  signal?: AbortSignal
}

/** status 0 means "no answer at all": offline, DNS, CORS, CSP or an aborted teardown. */
type Res<T> = { ok: true; data: T } | { ok: false; status: number }

type Outcome = 'ok' | 'auth' | 'down' | 'limited'

interface Row {
  id?: unknown
  from?: unknown
  subject?: unknown
  seen?: unknown
  createdAt?: unknown
}

interface Full extends Row {
  text?: unknown
  html?: unknown
}

async function req<T>(path: string, o: ReqOpts = {}): Promise<Res<T>> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  o.signal?.addEventListener('abort', onAbort)
  const timer = window.setTimeout(onAbort, REQ_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (o.body != null) headers['Content-Type'] = 'application/json'
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`
    const r = await fetch(API + path, { method: o.method ?? 'GET', body: o.body, headers, signal: ac.signal })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, data: (await r.json()) as T }
  } catch {
    // Swallowed on purpose. A rejected fetch here is normal operation for a free service,
    // and re-throwing or logging it would put red in a console the suite treats as fatal.
    return { ok: false, status: 0 }
  } finally {
    window.clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

/** Collection payloads: hydra envelope by default, bare array under Accept: application/json. */
function members<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  const m = (data as { 'hydra:member'?: unknown } | null)?.['hydra:member']
  return Array.isArray(m) ? (m as T[]) : []
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

function randomText(n: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/**
 * `from` is declared as an array of strings in the provider's own OpenAPI and arrives as
 * {address, name} in practice, so accept object, string or array. A shape change then
 * degrades to a blank label instead of printing "[object Object]" at the user.
 */
function addressOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(addressOf).filter(Boolean).join(', ')
  if (v && typeof v === 'object') {
    const o = v as { address?: unknown; name?: unknown }
    const a = typeof o.address === 'string' ? o.address : ''
    const n = typeof o.name === 'string' ? o.name : ''
    return n && a ? `${n} <${a}>` : a || n
  }
  return ''
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * A tempmail body is hostile input from a stranger, so it never becomes markup. The plain
 * part is used as-is (the caller writes it with textContent) and an html-only message is
 * flattened by stripHtml, which parses into an inert document through the narrow named
 * Trusted Types policy in html-strip.ts and reads back only textContent.
 */
function bodyText(m: Full): string {
  const text = str(m.text).trim()
  if (text) return text.slice(0, BODY_MAX)
  const html = Array.isArray(m.html) ? m.html.map(str).filter(Boolean).join('\n') : str(m.html)
  return html ? stripHtml(html).slice(0, BODY_MAX) : ''
}

function when(v: unknown): string {
  const d = new Date(str(v))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

async function login(address: string, password: string, signal: AbortSignal): Promise<{ token: string; status: number }> {
  const r = await req<{ token?: unknown }>('/token', { method: 'POST', body: JSON.stringify({ address, password }), signal })
  if (!r.ok) return { token: '', status: r.status }
  return { token: str(r.data.token), status: 200 }
}

const fail = (status: number, message = ''): { ok: false; outcome: Outcome; message: string } =>
  status === 429 ? { ok: false, outcome: 'limited', message: LIMITED } : { ok: false, outcome: 'down', message: message || DOWN }

/**
 * Claim a fresh address on a live domain.
 *
 * `isActive` is checked strictly: the provider rotates domains and keeps the retired ones
 * listed, and a retired domain still accepts an account while silently accepting no mail,
 * which is indistinguishable from a working inbox nobody wrote to.
 */
async function issue(signal: AbortSignal): Promise<{ ok: true; account: Account } | { ok: false; outcome: Outcome; message: string }> {
  const d = await req<unknown>('/domains', { signal })
  if (!d.ok) return fail(d.status)
  const domain = members<{ domain?: unknown; isActive?: unknown }>(d.data).find((x) => x.isActive === true && str(x.domain))?.domain
  if (!str(domain)) return fail(-1, 'The mail service has no active domain right now.')
  const password = randomText(20, ALNUM)
  // A collision on a 10-character local part is vanishingly unlikely, but 422 is the
  // provider's "address taken" and retrying is cheaper than telling the user to click again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const address = `${randomText(1, LETTERS)}${randomText(9, ALNUM)}@${str(domain)}`
    const acc = await req<unknown>('/accounts', { method: 'POST', body: JSON.stringify({ address, password }), signal })
    if (!acc.ok) {
      if (acc.status === 422) continue
      return fail(acc.status)
    }
    // The account now EXISTS on the provider and its address is already receiving. Failing
    // the token exchange here used to throw the whole thing away and claim a second one,
    // which orphaned a live inbox on every transient blip; hand back the credentials with
    // an empty token instead and let the caller log in on its next pass.
    const t = await login(address, password, signal)
    return { ok: true, account: { address, password, token: t.token } }
  }
  return fail(-1, 'Every generated address was already taken. Use New address to retry.')
}

// Per-card teardown keyed by the container. launchTool shares ONE cached module instance
// across every open card, so a module-level timer or account would let a second card
// clobber the first's poll loop and leak it.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()

    const life = new AbortController()
    const signal = life.signal
    let account: Account | null = null
    let timer = 0
    let pollMs = POLL_MS
    let busy = false
    let openId = ''
    // A card scrolled out of the feed, or collapsed, is not being read by anyone, so it
    // stops polling exactly like a hidden tab does. Without this the card keeps calling a
    // free service for the whole session from somewhere off screen, and its traffic lands
    // in the middle of whatever the user is actually doing.
    let onScreen = true
    // Set by deactivate. Every await below re-checks it, so a late response can never
    // write into a container the console has already torn down.
    let dead = false

    const status = el('div', { class: 'muted small tm-status', text: 'Claiming an address...' })
    const addr = el('input', {
      class: 'mono-input full tm-addr',
      readonly: 'readonly',
      spellcheck: 'false',
      'aria-label': 'Disposable address',
      placeholder: 'no address yet',
    }) as HTMLInputElement
    const listEl = el('div', { class: 'stack tm-list' })
    const bodyHead = el('div', { class: 'group-label tm-subject' })
    const bodyEl = el('pre', { class: 'tm-body' })

    const setStatus = (t: string) => {
      status.textContent = t
    }

    // ctx.storage is the gated facade and the vault can be locked behind a passphrase, so
    // persistence is best effort: a failure costs the address on reload, never the session.
    // It is not silent, though. A locked vault makes every reload claim a DIFFERENT
    // address, so mail sent to the one on screen lands in an inbox this card can no longer
    // open, which reads exactly like "the mail never arrived". The status line says so.
    let persists = true
    const save = async (a: Account) => {
      try {
        await ctx.storage.set(KEY, a)
        persists = true
      } catch {
        persists = false
      }
    }
    const forget = async () => {
      try {
        await ctx.storage.remove(KEY)
      } catch {
        // same as save: nothing to do about it, and nothing to say about it
      }
    }
    const load = async (): Promise<Account | null> => {
      try {
        const v = await ctx.storage.get<Partial<Account>>(KEY)
        if (v && str(v.address) && str(v.password) && str(v.token)) {
          return { address: v.address as string, password: v.password as string, token: v.token as string }
        }
      } catch {
        // no stored inbox is reachable, so fall through and claim a new one
      }
      return null
    }

    const schedule = () => {
      window.clearTimeout(timer)
      timer = 0
      // A hidden tab or an off-screen card must not keep hammering a free service, and a
      // torn-down card must not poll at all. Each re-arms through its own listener rather
      // than ticking on regardless.
      //
      // Note there is no `!account` guard: a card that has NO address yet is the case that
      // most needs the timer, because the claim itself can fail.
      if (dead || document.hidden || !onScreen) return
      timer = window.setTimeout(() => void tick(), pollMs)
    }

    const openMessage = async (id: string) => {
      if (!account || dead) return
      openId = id
      bodyHead.textContent = 'Opening...'
      bodyEl.textContent = ''
      const r = await req<Full>(`/messages/${encodeURIComponent(id)}`, { token: account.token, signal })
      if (dead || openId !== id) return
      if (!r.ok) {
        bodyHead.textContent = ''
        bodyEl.textContent = r.status === 0 ? DOWN : `That message could not be opened (${r.status}).`
        return
      }
      bodyHead.textContent = `${addressOf(r.data.from) || 'unknown sender'}: ${str(r.data.subject) || '(no subject)'}`
      bodyEl.textContent = bodyText(r.data) || 'This message carries no readable text.'
    }

    const renderList = (rows: Row[]) => {
      if (!rows.length) {
        listEl.replaceChildren(el('div', { class: 'muted small', text: 'No mail yet. Send something to the address above.' }))
        return
      }
      const items = rows.slice(0, LIST_MAX).map((m) => {
        const id = str(m.id)
        const label = `${addressOf(m.from) || 'unknown sender'}: ${str(m.subject) || '(no subject)'}`
        const stamp = when(m.createdAt)
        // Sender and subject are attacker-controlled and go in as button text, which
        // button() sets with textContent.
        return el('div', { class: 'row' }, [
          el('span', { class: m.seen === true ? 'dot' : 'dot on' }),
          button(label, () => void openMessage(id), 'ghost tm-msg', stamp || 'Open this message'),
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted small', text: stamp }),
        ])
      })
      listEl.replaceChildren(el('div', { class: 'group-label', text: `Inbox (${rows.length})` }), ...items)
    }

    /**
     * Read the inbox, logging in first whenever there is no usable token.
     *
     * Only a 401 on the LOGIN is 'auth', because only that proves the account itself is
     * gone. A 401 on /messages is an expired token, and a status 0 is a network blip; both
     * used to be able to end as a re-claim, and a re-claim silently abandons every message
     * already sitting in the old inbox.
     */
    const fetchInbox = async (retried = false): Promise<Outcome> => {
      if (!account) return 'auth'
      if (!account.token) {
        const t = await login(account.address, account.password, signal)
        // `account` is re-read because New address can null it across the await.
        if (dead || !account) return 'down'
        if (!t.token) return t.status === 401 ? 'auth' : t.status === 429 ? 'limited' : 'down'
        account = { ...account, token: t.token }
        await save(account)
        if (dead || !account) return 'down'
      }
      const r = await req<unknown>('/messages', { token: account.token, signal })
      if (dead || !account) return 'down'
      if (!r.ok && r.status === 401 && !retried) {
        account = { ...account, token: '' }
        return fetchInbox(true)
      }
      if (!r.ok) return r.status === 429 ? 'limited' : r.status === 401 ? 'auth' : 'down'
      renderList(members<Row>(r.data))
      return 'ok'
    }

    /**
     * The whole loop, in one pass: claim an address if there is none, then read the inbox,
     * then re-arm. Claiming lives INSIDE the loop deliberately. It used to sit outside, so
     * a claim that failed (the provider rate limits new accounts long before it rate limits
     * reads) left the card with an empty address box, a status line promising a next check,
     * and no timer anywhere: 0 further requests until someone pressed Refresh. That is
     * indistinguishable from a tool that is simply broken.
     */
    const tick = async () => {
      if (busy || dead) return
      busy = true
      let outcome: Outcome = 'down'
      let message = ''
      try {
        if (!account) {
          setStatus('Claiming an address...')
          addr.value = ''
          listEl.replaceChildren()
          bodyHead.textContent = ''
          bodyEl.textContent = ''
          const r = await issue(signal)
          if (dead) return
          if (r.ok) {
            account = r.account
            addr.value = account.address
            await save(account)
          } else {
            outcome = r.outcome
            message = r.message
          }
        }
        if (account && !dead) outcome = await fetchInbox()
      } finally {
        busy = false
      }
      if (dead) return
      if (outcome === 'auth') {
        // The provider retains an inbox for days, not forever, so a dead account is
        // expected eventually. Drop it and let the NEXT pass claim, rather than re-claiming
        // inline: an account that 401s the moment it is created would otherwise spin here,
        // creating accounts against a free service as fast as the network allows.
        account = null
        addr.value = ''
        await forget()
        if (dead) return
        outcome = 'down'
        message = 'That inbox expired. Claiming another one shortly.'
      }
      if (outcome === 'ok') pollMs = POLL_MS
      else pollMs = Math.min(MAX_POLL_MS, pollMs * 2)
      const secs = Math.round(pollMs / 1000)
      // "while this card is open" is not filler: polling really does stop when the card is
      // collapsed, scrolled out of the feed or in a background tab, and a status claiming
      // an unconditional 15-second check would be false in all three.
      const ready = `Inbox ready, checking every ${secs} seconds while this card is open.`
      setStatus(`${outcome === 'ok' ? ready : outcome === 'limited' ? LIMITED : message || DOWN}${persists ? '' : ` ${UNSAVED}`}`)
      schedule()
    }

    // Both resume paths run the full driver, not just a poll: coming back on screen with
    // no address yet has to retry the claim, which is the state the user is most stuck in.
    const onVis = () => {
      if (document.hidden) {
        window.clearTimeout(timer)
        timer = 0
      } else if (!dead) {
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting)
        if (vis === onScreen) return
        onScreen = vis
        if (!onScreen) {
          window.clearTimeout(timer)
          timer = 0
        } else if (!dead) {
          void tick()
        }
      },
      { threshold: 0 },
    )
    io.observe(container)

    container.append(
      el('div', { class: 'row' }, [addr, copyButton(() => addr.value, ctx.clipboard.write)]),
      el('div', { class: 'row' }, [
        button('Refresh', () => void tick(), 'primary', 'Check for new mail now'),
        button(
          'New address',
          () => {
            account = null
            window.clearTimeout(timer)
            timer = 0
            pollMs = POLL_MS
            void forget().then(() => (dead ? undefined : tick()))
          },
          'ghost',
          'Throw this inbox away and claim another',
        ),
      ]),
      status,
      el('div', {
        class: 'muted small',
        text: 'Anyone who knows this address can read it and a third party runs the server, so keep it for signup noise and never for anything private.',
      }),
      listEl,
      bodyHead,
      bodyEl,
    )

    void (async () => {
      const saved = await load()
      if (dead) return
      if (saved) {
        account = saved
        addr.value = saved.address
        setStatus('Restoring your inbox...')
      }
      await tick()
    })()

    detachers.set(container, () => {
      dead = true
      window.clearTimeout(timer)
      timer = 0
      document.removeEventListener('visibilitychange', onVis)
      io.disconnect()
      life.abort() // drop any in-flight request instead of letting it land on a dead card
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
