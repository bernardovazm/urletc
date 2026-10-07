// TURN relay configuration: parsing, validation and a reachability check. No Trystero
// import, because Settings loads this module and must not pull the P2P engine into its
// chunk. session.ts applies the result to the ICE list (see ICE_SERVERS there).
//
// A relay comes from two places, neither of them committed: a list pasted into Settings
// (stored in the encrypted store, never sent to peers), or VITE_TURN_SERVERS set in the
// hosting provider's build environment. The second is compiled into the public bundle,
// so anyone who reads the bundle can spend that relay's quota.

const MAX_INPUT_CHARS = 8000
const MAX_ENTRIES = 10
const MAX_URLS_PER_ENTRY = 10
const MAX_SECRET_CHARS = 256
// Every TURN URL is one more server ICE gathers from, and the whole list (STUN included)
// stays at four URLs or fewer: Firefox warns from five, and a server that never answers
// costs a connection a full gathering timeout.
const MAX_TURN_URLS = 3

// scheme:host[:port][?transport=udp|tcp]. Nothing else: no user@, no path, no other query.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])`
const ICE_URL = new RegExp(`^(stuns?|turns?):(${HOST})(?::(\\d{1,5}))?(?:\\?transport=(udp|tcp))?$`)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

type Transport = 'udp' | 'tcp' | 'tls'
const TRANSPORT_ORDER: Transport[] = ['udp', 'tcp', 'tls']
const TRANSPORT_LABEL: Record<Transport, string> = { udp: 'UDP', tcp: 'TCP', tls: 'TLS' }

interface ParsedUrl {
  scheme: string
  host: string
  port: number | null
  transport: Transport
}

// The pattern alone admits hosts Chromium takes and Firefox's RTCPeerConnection throws on
// (999.999.999.999, [1::2::3]), and Trystero does not catch that throw, so every room on
// the device would fail. A name ending in a numeric label is an IPv4 address to the URL
// parser, so it must be a plain dotted quad; a bracketed host must parse as IPv6.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
function okHost(host: string): boolean {
  if (host.length > 253) return false
  if (host.startsWith('[')) {
    try {
      return new URL(`http://${host}/`).hostname.startsWith('[')
    } catch {
      return false
    }
  }
  return !/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1)) || IPV4.test(host)
}

function parseUrl(url: string): ParsedUrl | null {
  if (url.length > 300) return null
  const m = ICE_URL.exec(url)
  if (!m || !okHost(m[2])) return null
  const port = m[3] === undefined ? null : Number(m[3])
  if (port !== null && (port < 1 || port > 65535)) return null
  const scheme = m[1]
  // turns: is TLS over TCP whatever the query says; browsers have no TLS-over-UDP TURN.
  const transport: Transport = scheme === 'turns' ? 'tls' : m[4] === 'tcp' ? 'tcp' : 'udp'
  return { scheme, host: m[2].toLowerCase(), port, transport }
}

function okSecret(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_SECRET_CHARS && !CONTROL.test(v)
}

/**
 * Turn the JavaScript snippet a provider dashboard hands out into JSON text, without ever
 * evaluating it: comments are dropped, single-quoted strings and bare keys are quoted,
 * trailing commas go. Anything this does not cover fails JSON.parse and is reported.
 */
function jsToJson(src: string): string {
  let s = src.trim()
  s = s.replace(/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/, '')
  let out = ''
  for (let i = 0; i < s.length;) {
    const c = s[i]
    if (c === '"' || c === "'") {
      // Copy a string, re-quoted with double quotes.
      let j = i + 1
      let body = ''
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) {
          body += s[j + 1] === "'" ? "'" : s[j] + s[j + 1]
          j += 2
        } else {
          body += s[j] === '"' ? '\\"' : s[j]
          j++
        }
      }
      out += `"${body}"`
      i = j + 1
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < s.length && /[\w$]/.test(s[j])) j++
      const word = s.slice(i, j)
      let k = j
      while (k < s.length && /\s/.test(s[k])) k++
      out += s[k] === ':' ? `"${word}"` : word
      i = j
    } else {
      out += c
      i++
    }
  }
  out = out.trim().replace(/;$/, '')
  // Trailing commas, outside strings: a comma whose next non-space character closes.
  let res = ''
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (c === '"') {
      let j = i + 1
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1
      res += out.slice(i, j + 1)
      i = j
      continue
    }
    if (c === ',') {
      let k = i + 1
      while (k < out.length && /\s/.test(out[k])) k++
      if (out[k] === ']' || out[k] === '}') continue
    }
    res += c
  }
  return res
}

/**
 * Validate and normalize an iceServers value already parsed from JSON (or read back from
 * the store). STUN entries are dropped, since the app has its own STUN; what remains is at
 * most MAX_TURN_URLS TURN URLs, one per transport where possible, grouped by credentials.
 * Error text never repeats a username or credential.
 */
export function validateIceServers(value: unknown): { servers: RTCIceServer[] } | { error: string } {
  let list: unknown = value
  if (list && typeof list === 'object' && !Array.isArray(list) && 'iceServers' in list) list = (list as { iceServers: unknown }).iceServers
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list]
  if (!Array.isArray(list)) return { error: 'Expected a list of servers, each with urls, username and credential.' }
  if (!list.length) return { error: 'The list is empty.' }
  if (list.length > MAX_ENTRIES) return { error: `At most ${MAX_ENTRIES} entries are accepted, and this has ${list.length}.` }

  const turn: Array<ParsedUrl & { url: string; username: string; credential: string; idx: number }> = []
  for (let i = 0; i < list.length; i++) {
    const n = i + 1
    const entry: unknown = list[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `Entry ${n} is not an object with urls.` }
    const e = entry as Record<string, unknown>
    const urls = typeof e.urls === 'string' ? [e.urls] : e.urls
    if (!Array.isArray(urls) || !urls.length || urls.length > MAX_URLS_PER_ENTRY || !urls.every((u) => typeof u === 'string'))
      return { error: `Entry ${n}: urls must be one address or a list of at most ${MAX_URLS_PER_ENTRY}.` }
    const parsed: Array<ParsedUrl & { url: string }> = []
    for (let j = 0; j < urls.length; j++) {
      const p = parseUrl(urls[j] as string)
      if (!p) return { error: `Entry ${n}, address ${j + 1}: expected stun:, stuns:, turn: or turns: with a host, an optional port and an optional ?transport=udp or tcp.` }
      parsed.push({ ...p, url: urls[j] as string })
    }
    const relays = parsed.filter((p) => p.scheme === 'turn' || p.scheme === 'turns')
    if (!relays.length) continue // STUN only
    if (e.username === undefined || e.credential === undefined) return { error: `Entry ${n}: a TURN server needs a username and a credential.` }
    if (!okSecret(e.username) || !okSecret(e.credential))
      return { error: `Entry ${n}: the username and credential must be text of 1 to ${MAX_SECRET_CHARS} characters without control characters.` }
    for (const p of relays) turn.push({ ...p, username: e.username, credential: e.credential, idx: turn.length })
  }
  if (!turn.length) return { error: 'No TURN server in the list. STUN entries are ignored, since the app has its own.' }

  // Dedupe by URL, first wins.
  const seen = new Set<string>()
  const unique = turn.filter((t) => (seen.has(t.url) ? false : (seen.add(t.url), true)))
  // One per transport first, in UDP, TCP, TLS order (TLS on 443 preferred, the port a
  // restrictive firewall leaves open), then fill any free slot in the same order.
  const rank = (t: (typeof unique)[number]) => TRANSPORT_ORDER.indexOf(t.transport) * 2 + (t.transport === 'tls' && t.port !== 443 && t.port !== null ? 1 : 0)
  const ordered = [...unique].sort((a, b) => rank(a) - rank(b) || a.idx - b.idx)
  const picked: typeof unique = []
  for (const tr of TRANSPORT_ORDER) {
    const hit = ordered.find((t) => t.transport === tr)
    if (hit && picked.length < MAX_TURN_URLS) picked.push(hit)
  }
  for (const t of ordered) if (picked.length < MAX_TURN_URLS && !picked.includes(t)) picked.push(t)
  picked.sort((a, b) => rank(a) - rank(b) || a.idx - b.idx)

  // Group URLs sharing credentials into one RTCIceServer, in first-seen order.
  const servers: RTCIceServer[] = []
  for (const t of picked) {
    const same = servers.find((s) => s.username === t.username && s.credential === t.credential)
    if (same) (same.urls as string[]).push(t.url)
    else servers.push({ urls: [t.url], username: t.username, credential: t.credential })
  }
  // The browser has the last word on what it accepts: a list its RTCPeerConnection throws
  // on would break every connection Trystero builds from it.
  if (typeof RTCPeerConnection === 'function') {
    try {
      new RTCPeerConnection({ iceServers: servers }).close()
    } catch {
      return { error: 'This browser rejects one of these addresses.' }
    }
  }
  return { servers }
}

/** Parse pasted text: a JSON array or object, or a provider's JavaScript snippet. */
export function parseIceServers(text: string): { servers: RTCIceServer[] } | { error: string } {
  if (text.length > MAX_INPUT_CHARS) return { error: `Too long: paste at most ${MAX_INPUT_CHARS} characters.` }
  if (!text.trim()) return { error: 'Nothing to save: paste the iceServers list first.' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    try {
      value = JSON.parse(jsToJson(text))
    } catch {
      return { error: 'Not readable as JSON or as an iceServers snippet: expected [{ urls, username, credential }, ...].' }
    }
  }
  return validateIceServers(value)
}

function urlsOf(servers: RTCIceServer[]): ParsedUrl[] {
  const out: ParsedUrl[] = []
  for (const s of servers)
    for (const u of typeof s.urls === 'string' ? [s.urls] : s.urls) {
      const p = parseUrl(u)
      if (p) out.push(p)
    }
  return out
}

/** "global.relay.metered.ca (UDP, TCP, TLS)". Hosts and transports only, no credentials. */
export function describeRelay(servers: RTCIceServer[]): string {
  const urls = urlsOf(servers).filter((p) => p.scheme === 'turn' || p.scheme === 'turns')
  const hosts = [...new Set(urls.map((p) => p.host))]
  const transports = TRANSPORT_ORDER.filter((t) => urls.some((p) => p.transport === t)).map((t) => TRANSPORT_LABEL[t])
  return `${hosts.join(', ')} (${transports.join(', ')})`
}

export type RelayCheck = 'ok' | 'auth' | 'unreachable'

/**
 * Ask the relay for an allocation and report what came back. A relay-only connection
 * gathers candidates from these servers alone, so a 'relay' candidate means a working
 * allocation. A 401 is remembered rather than final: the first Allocate of a working
 * exchange is also challenged, so 'auth' is reported only when gathering ends without
 * a relay candidate.
 */
export function checkRelay(servers: RTCIceServer[], timeoutMs = 8000): Promise<RelayCheck> {
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' })
  } catch {
    return Promise.resolve('unreachable')
  }
  return new Promise((resolve) => {
    let refused = false
    let done = false
    const finish = (r: RelayCheck) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        pc.close()
      } catch {
        // already closed
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish(refused ? 'auth' : 'unreachable'), timeoutMs)
    pc.addEventListener('icecandidate', (e) => {
      const c = e.candidate
      if (!c) finish(refused ? 'auth' : 'unreachable')
      else if (c.type === 'relay' || / typ relay( |$)/.test(c.candidate)) finish('ok')
    })
    pc.addEventListener('icecandidateerror', (e) => {
      if ((e as RTCPeerConnectionIceErrorEvent).errorCode === 401) refused = true
    })
    pc.createDataChannel('relay-check')
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish('unreachable'))
  })
}

let deployment: RTCIceServer[] | null = null

/**
 * The relay this deployment was built with (VITE_TURN_SERVERS), or an empty list. Parsed
 * once with the same parser as a pasted list. An unusable value is reported by name only:
 * the value carries credentials.
 */
export function deploymentRelay(): RTCIceServer[] {
  if (deployment) return deployment
  deployment = []
  const raw = import.meta.env.VITE_TURN_SERVERS
  if (raw) {
    const r = parseIceServers(raw)
    if ('servers' in r) deployment = r.servers
    else console.warn('VITE_TURN_SERVERS is set but not a usable TURN list, so this deployment has no relay.')
  }
  return deployment
}
