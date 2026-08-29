// Link shortener. This is the ONE built-in that sends your data off the device: the URL
// you submit is posted to spoo.me, which mints and stores the short link. Everything else
// in this app runs locally, so that disclosure is stated in the card itself rather than
// buried in a doc, and nothing is sent until you press the button.
//
// The provider is not interchangeable. is.gd, ulvis.net and cleanuri were all checked from
// a real browser and none of them answers with CORS headers, so a client-only page cannot
// read their response at all. spoo.me accepts a form-encoded POST and answers JSON with
// permissive CORS, which is why it is the one wired up here. Its request is deliberately
// CORS-"simple" (form content type + Accept), so there is no preflight to be refused.
//
// History is intentionally session-only and lives in the DOM of this card: no 'storage'
// permission is declared, so the list of things you shortened does not outlive the tab.

import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

const ENDPOINT = 'https://spoo.me/'
const HISTORY_MAX = 12

export type Validation = { url: string } | { error: string }

/**
 * Gate the input before anything leaves the device. Only an absolute http(s) URL with a
 * plausible host is accepted, so a typo, a bare search phrase or a `javascript:` payload
 * is rejected locally instead of being handed to a third party.
 */
export function validateTarget(input: string): Validation {
  const raw = input.trim()
  if (!raw) return { error: 'Paste a link first.' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { error: 'Not a URL. Include the scheme, for example https://example.com/page.' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: `Only http and https links can be shortened, not ${u.protocol.replace(':', '')}.` }
  }
  if (!u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost')) {
    return { error: 'That host does not look like a real domain.' }
  }
  return { url: u.toString() }
}

/** Pull the short link out of whatever spoo.me answered, tolerating a shape change. */
function readShortUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const rec = body as Record<string, unknown>
  for (const k of ['short_url', 'shortUrl', 'short', 'url']) {
    const v = rec[k]
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
  }
  return null
}

/** Best-effort human message from an error payload, so a rejection is not just a status. */
function readError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    for (const k of ['error', 'message', 'detail']) {
      const v = rec[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return status ? `spoo.me refused the link (HTTP ${status}).` : 'spoo.me could not be reached.'
}

/**
 * POST the URL and return the short link. Rejects with a message meant to be shown, never
 * logged: the caller renders it in the card, so a dead network is a visible outcome rather
 * than a red console line.
 */
export async function shortenUrl(target: string, signal?: AbortSignal): Promise<string> {
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ url: target }).toString(),
      signal,
    })
  } catch {
    // Offline, DNS failure, blocked by an extension, or connect-src refusing the origin.
    throw new Error('Could not reach spoo.me. Check the connection and try again.')
  }
  const text = await res.text().catch(() => '')
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // Provider answered with something that is not JSON (an HTML error page, usually).
  }
  const short = readShortUrl(body)
  if (!res.ok || !short) throw new Error(readError(body, res.status))
  return short
}

// Per-card teardown keyed by container: launchTool shares one cached module across every
// open card, so the in-flight request handle must be per-activation. A module-level
// controller would let a second card abort the first card's request.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    let inflight: AbortController | null = null

    const input = el('input', { type: 'url', class: 'full', placeholder: 'https://example.com/a/very/long/path', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement
    const status = el('div', { class: 'muted small shorten-status' })
    const result = el('div', { class: 'stack shorten-result hidden' })
    const historyBox = el('div', { class: 'stack shorten-history' })
    const historyHead = el('div', { class: 'group-label hidden', text: 'This session' })

    const showResult = (shortUrl: string, original: string) => {
      const link = el('a', { class: 'shorten-short', href: shortUrl, target: '_blank', rel: 'noopener noreferrer', text: shortUrl })
      result.replaceChildren(
        el('div', { class: 'row' }, [link, copyButton(() => shortUrl, ctx.clipboard.write, 'Copy', 'ghost')]),
        el('div', { class: 'muted small', text: original }),
      )
      result.classList.remove('hidden')
      historyHead.classList.remove('hidden')
      historyBox.prepend(
        el('div', { class: 'row shorten-history-item' }, [
          el('span', { class: 'shorten-short-code', text: shortUrl }),
          el('span', { class: 'muted small', text: original.length > 60 ? `${original.slice(0, 57)}...` : original }),
          el('span', { class: 'spacer' }),
          copyButton(() => shortUrl, ctx.clipboard.write, 'Copy', 'ghost'),
        ]),
      )
      while (historyBox.childElementCount > HISTORY_MAX) historyBox.lastElementChild?.remove()
    }

    const go = button('Shorten', () => void run(), 'primary') as HTMLButtonElement

    const run = async () => {
      const v = validateTarget(input.value)
      if ('error' in v) {
        result.classList.add('hidden')
        status.textContent = v.error
        return
      }
      inflight?.abort()
      inflight = new AbortController()
      const mine = inflight
      go.disabled = true
      status.textContent = 'Sending to spoo.me...'
      try {
        const short = await shortenUrl(v.url, mine.signal)
        if (mine.signal.aborted) return
        status.textContent = 'Short link ready.'
        showResult(short, v.url)
      } catch (e) {
        if (mine.signal.aborted) return
        result.classList.add('hidden')
        // The message is rendered, never logged: a failed provider is a UI state here.
        status.textContent = e instanceof Error ? e.message : 'Shortening failed.'
      } finally {
        if (inflight === mine) inflight = null
        go.disabled = false
      }
    }

    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void run()
    })

    container.append(
      input,
      el('div', { class: 'row' }, [
        go,
        button('Clear', () => {
          input.value = ''
          status.textContent = ''
          result.replaceChildren()
          result.classList.add('hidden')
        }),
      ]),
      el('p', {
        class: 'muted small',
        text: 'The link you submit is sent to spoo.me, a third party, which creates and stores the short URL. Unlike the rest of this app, that leaves your device.',
      }),
      status,
      result,
      historyHead,
      historyBox,
    )

    detachers.set(container, () => {
      inflight?.abort()
      inflight = null
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
