// URL Check: two layers over one link, kept visibly apart because they make claims of
// very different strength.
//
//  1. Structural analysis, local and instant. Punycode homographs, a brand parked in a
//     subdomain, credentials before the @, free-registration TLDs, and the rest of the
//     tricks that are visible in the text of the URL itself. Never fetches anything.
//     This is a HEURISTIC: it reads the URL, not the site. "Nothing structurally
//     suspicious" means the shape of the link is not deceptive, not that it is safe.
//
//  2. Blocklist feeds, over the network. A hit here is a FACT with a source and a date:
//     somebody observed this URL phishing and published it. A miss is only ever "not on
//     the lists I hold, as of <age>", which is why every result states the feed and how
//     old the copy is. A stale feed answering "clean" is worse than no answer.
//
// Feed selection is constrained by CORS, not by preference: most of the well-known
// keyless phishing feeds (openphish.com direct, phishunt.io, urlhaus, phishstats,
// phishing.army) send no access-control headers, so a page cannot read them at all even
// though curl can. The three below were probed from a real browser and do work.
//
// URL Inspector used to be a second tool holding the component breakdown. One link asked
// two questions in two places, so it is merged in here: the verdict stays the headline and
// the breakdown sits underneath it as reference. parseUrl below is that breakdown, and is
// also the parse contract the clipboard tool imports (new URL on the trimmed input, null
// on failure).

import { createStore, del, get, set } from 'idb-keyval'
import { getItem, setItem } from '../core/store'
import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el, toast } from '../shell/ui'

export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  severity: Severity
  title: string
  reason: string
}

export interface Report {
  url: string
  score: number
  verdict: string
  findings: Finding[]
}

const WEIGHT: Record<Severity, number> = { high: 34, medium: 14, low: 5 }
const BADGE: Record<Severity, string> = { high: 'danger', medium: 'warn', low: 'ok' }

// ---------------------------------------------------------------- punycode

const P_BASE = 36
const P_TMIN = 1
const P_TMAX = 26
const P_SKEW = 38
const P_DAMP = 700
const P_BIAS = 72
const P_N = 128
const P_MAX = 0x7fffffff

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / P_DAMP) : delta >> 1
  d += Math.floor(d / numPoints)
  let k = 0
  while (d > ((P_BASE - P_TMIN) * P_TMAX) >> 1) {
    d = Math.floor(d / (P_BASE - P_TMIN))
    k += P_BASE
  }
  return k + Math.floor(((P_BASE - P_TMIN + 1) * d) / (d + P_SKEW))
}

function digitOf(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 26
  if (c >= 0x61 && c <= 0x7a) return c - 0x61
  if (c >= 0x41 && c <= 0x5a) return c - 0x41
  return P_BASE
}

/**
 * RFC 3492 decode of a single label WITHOUT its `xn--` prefix, or null if it is malformed.
 * Inlined (about 40 lines) rather than pulled from a dependency because it is the whole
 * point of the homograph check: the browser's URL parser normalizes a pasted Cyrillic host
 * to punycode, so without decoding, `xn--pypal-4ve.com` and the lookalike the user actually
 * saw are both opaque ASCII and the deception is invisible.
 */
export function punycodeDecode(label: string): string | null {
  let n = P_N
  let i = 0
  let bias = P_BIAS
  const out: number[] = []
  const delim = label.lastIndexOf('-')
  if (delim > 0) {
    for (let j = 0; j < delim; j++) {
      const c = label.charCodeAt(j)
      if (c >= 0x80) return null
      out.push(c)
    }
  }
  let idx = delim > 0 ? delim + 1 : 0
  if (idx >= label.length) return null
  while (idx < label.length) {
    const oldi = i
    let w = 1
    for (let k = P_BASE; ; k += P_BASE) {
      if (idx >= label.length) return null
      const digit = digitOf(label.charCodeAt(idx++))
      if (digit >= P_BASE) return null
      if (digit > Math.floor((P_MAX - i) / w)) return null
      i += digit * w
      const t = k <= bias ? P_TMIN : k >= bias + P_TMAX ? P_TMAX : k - bias
      if (digit < t) break
      if (w > Math.floor(P_MAX / (P_BASE - t))) return null
      w *= P_BASE - t
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0)
    n += Math.floor(i / (out.length + 1))
    i %= out.length + 1
    if (n > 0x10ffff) return null
    out.splice(i, 0, n)
    i++
  }
  return String.fromCodePoint(...out)
}

// Scripts whose letters are routinely used as Latin lookalikes. Cyrillic a/e/o/p/c and
// Greek omicron/nu are pixel-identical to their Latin twins in most UI fonts.
const SCRIPTS: [string, RegExp][] = [
  // Ranges are written as \u escapes on purpose. As literal boundary characters the
  // source is non-ASCII and unreadable: several of these code points render as nothing.
  ['Latin', /[A-Za-z\u00C0-\u024F]/],
  ['Cyrillic', /[\u0400-\u052F]/],
  ['Greek', /[\u0370-\u03FF\u1F00-\u1FFF]/],
  ['Han', /[\u3040-\u30FF\u4E00-\u9FFF]/],
  ['Arabic', /[\u0600-\u06FF\u0750-\u077F]/],
  ['Hebrew', /[\u0590-\u05FF]/],
]

export function scriptsOf(text: string): string[] {
  return SCRIPTS.filter(([, re]) => re.test(text)).map(([name]) => name)
}

// ---------------------------------------------------------------- host tables

// Deliberately short. A full public suffix list is a 15k-entry download; these are the
// multi-label suffixes common enough that getting them wrong would misreport the
// registrable domain of an ordinary link.
const MULTI_SUFFIX = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'sch.uk',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'edu.br',
  'com.au',
  'net.au',
  'org.au',
  'gov.au',
  'edu.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'com.mx',
  'com.ar',
  'com.co',
  'com.pe',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'co.za',
  'co.in',
  'net.in',
  'org.in',
  'co.kr',
  'or.kr',
  'com.tr',
  'com.tw',
  'com.hk',
  'com.sg',
  'co.il',
  'com.es',
  'com.pl',
  'com.ua',
  'com.ru',
  'co.id',
  'com.my',
  'com.ph',
  'com.vn',
])

const SHORTENERS = new Set([
  'bit.ly',
  't.co',
  'goo.gl',
  'tinyurl.com',
  'ow.ly',
  'is.gd',
  'v.gd',
  'buff.ly',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'rb.gy',
  't.ly',
  'spoo.me',
  'tiny.cc',
  'lnkd.in',
  'bit.do',
  'shrtco.de',
  'urlz.fr',
  'clck.ru',
  'trib.al',
  'x.co',
  'adf.ly',
  'shorte.st',
  'soo.gd',
  's.id',
  'db.tt',
  'qr.ae',
  'su.pr',
  'tr.im',
  'chilp.it',
  'hyperurl.co',
  'mcaf.ee',
  'u.to',
])

// Registries that hand out names for free or near free, which is why bulk phishing lives
// there. Split from the merely cheap gTLDs so the severity stays honest.
const TLD_FREE = new Set(['tk', 'ml', 'ga', 'cf', 'gq'])
const TLD_LOOKALIKE = new Set(['zip', 'mov']) // collide with file extensions
const TLD_CHEAP = new Set([
  'top',
  'xyz',
  'click',
  'link',
  'work',
  'rest',
  'fit',
  'cam',
  'cfd',
  'sbs',
  'icu',
  'buzz',
  'quest',
  'bond',
  'autos',
  'boats',
  'monster',
  'cyou',
  'lol',
  'beauty',
  'hair',
  'skin',
  'mom',
  'bar',
  'uno',
  'gdn',
  'loan',
  'date',
  'faith',
  'win',
  'bid',
  'stream',
  'download',
  'racing',
  'review',
  'science',
  'party',
  'trade',
  'webcam',
  'accountant',
  'cricket',
  'men',
  'country',
  'kim',
  'wang',
  'support',
  'zone',
  'live',
])

const BRANDS = [
  'paypal',
  'google',
  'apple',
  'icloud',
  'microsoft',
  'outlook',
  'office365',
  'onedrive',
  'amazon',
  'netflix',
  'facebook',
  'instagram',
  'whatsapp',
  'twitter',
  'tiktok',
  'telegram',
  'discord',
  'linkedin',
  'dropbox',
  'github',
  'gitlab',
  'docusign',
  'adobe',
  'steam',
  'roblox',
  'epicgames',
  'blizzard',
  'binance',
  'coinbase',
  'metamask',
  'chase',
  'hsbc',
  'wellsfargo',
  'santander',
  'itau',
  'bradesco',
  'nubank',
  'caixa',
  'mercadolivre',
  'mercadopago',
  'correios',
  'dhl',
  'fedex',
  'usps',
  'spotify',
  'revolut',
]

const RISKY_EXT = ['exe', 'scr', 'msi', 'bat', 'cmd', 'apk', 'jar', 'vbs', 'hta', 'ps1', 'lnk', 'iso', 'dmg', 'pif']

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const NON_ASCII = /[^ -~]/

/** Split a host into its registrable domain and everything in front of it. */
export function splitHost(hostname: string): { labels: string[]; sld: string; tld: string; suffixLen: number } {
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) return { labels, sld: labels[0] ?? '', tld: '', suffixLen: 0 }
  const lastTwo = labels.slice(-2).join('.')
  const suffixLen = MULTI_SUFFIX.has(lastTwo) && labels.length >= 3 ? 2 : 1
  return { labels, sld: labels[labels.length - suffixLen - 1] ?? '', tld: labels[labels.length - 1], suffixLen }
}

// ---------------------------------------------------------------- analysis

function verdictFor(score: number): string {
  if (score === 0) return 'Nothing structurally suspicious'
  if (score <= 15) return 'Minor structural notes'
  if (score <= 44) return 'Several structural warning signs'
  return 'Strong structural warning signs'
}

function finish(raw: string, u: URL, findings: Finding[]): Report {
  const order: Severity[] = ['high', 'medium', 'low']
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
  const score = Math.min(
    100,
    findings.reduce((s, x) => s + WEIGHT[x.severity], 0),
  )
  return { url: u.href || raw, score, verdict: verdictFor(score), findings }
}

export interface UrlPart {
  label: string
  value: string
}

/**
 * The component breakdown, merged in from the old URL Inspector tool. Reads the text of
 * the URL and nothing else: no request is ever made. Returns null on anything `new URL`
 * rejects, which is the same contract analyzeUrl answers on.
 */
export function parseUrl(input: string): UrlPart[] | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  const parts: UrlPart[] = [
    { label: 'protocol', value: u.protocol },
    { label: 'host', value: u.host },
    { label: 'hostname', value: u.hostname },
    { label: 'port', value: u.port || '(default)' },
    { label: 'path', value: u.pathname },
    { label: 'hash', value: u.hash || '(none)' },
  ]
  for (const [k, v] of u.searchParams) parts.push({ label: `query ${k}`, value: v })
  return parts
}

/** Percent-decoded form of whatever was typed, unchanged when it will not decode. */
export function decodedUrl(input: string): string {
  const raw = input.trim()
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Returns null when the input is not a URL at all, matching {@link parseUrl}. */
export function analyzeUrl(input: string): Report | null {
  const raw = input.trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const f: Finding[] = []
  const add = (severity: Severity, title: string, reason: string) => f.push({ severity, title, reason })

  const scheme = u.protocol.replace(':', '')
  if (scheme !== 'http' && scheme !== 'https') {
    add(
      'high',
      `Not a web link (${scheme}:)`,
      'This does not open a web page. Schemes like javascript:, data: and file: run or load something locally, and a link that presents itself as a site while using one of them is hostile by design.',
    )
    return finish(raw, u, f)
  }
  if (scheme === 'http') {
    add(
      'medium',
      'Plain http, not https',
      'The connection is unencrypted, so anyone on the path can read and rewrite the page. Real login and payment pages stopped shipping over http years ago.',
    )
  }

  if (u.username) {
    add(
      'high',
      'Login credentials in the URL',
      `Everything before the @ is a username, not the destination. This link goes to "${u.hostname}", while "${u.username}" is parked in front of it so the address reads like somewhere else.`,
    )
  }

  const host = u.hostname
  const isV6 = host.startsWith('[')
  const isV4 = IPV4.test(host)

  if (isV4 || isV6) {
    add(
      'high',
      'The host is a raw IP address',
      'There is no domain name, so there is no registrar, no certificate name and nothing to recognise. Services are reached by name; a bare IP standing in for a site is typical of a compromised or throwaway machine.',
    )
  } else {
    const { labels, sld, tld, suffixLen } = splitHost(host)

    // punycode and mixed-script homographs
    const decoded = labels.map((l) => (/^xn--/i.test(l) ? punycodeDecode(l.slice(4)) : null))
    if (decoded.some((d) => d !== null)) {
      const shown = labels.map((l, idx) => decoded[idx] ?? l).join('.')
      const scripts = scriptsOf(decoded.filter((d): d is string => d !== null).join(''))
      const confusable = scripts.includes('Cyrillic') || scripts.includes('Greek')
      if (scripts.includes('Latin') && confusable) {
        add(
          'high',
          'Mixed-script host (homograph attack)',
          `The host displays as "${shown}" but resolves as "${host}". It mixes ${scripts.join(' and ')} letters inside one name, which is only ever done so characters like Cyrillic a and o can stand in for their Latin twins.`,
        )
      } else if (confusable) {
        add(
          'high',
          'Host written in a lookalike script',
          `The host displays as "${shown}" but resolves as "${host}". Every letter comes from ${scripts.join(' and ')}, a script whose letters are visually identical to Latin ones, so the name can imitate a familiar brand exactly.`,
        )
      } else {
        add(
          'low',
          'Internationalised (punycode) host',
          `The host is stored as "${host}" and displays as "${shown}". Normal for a non-English domain, but worth knowing that what you read is not what is resolved.`,
        )
      }
    } else if (NON_ASCII.test(host)) {
      const scripts = scriptsOf(host)
      if (scripts.length > 1) {
        add(
          'high',
          'Mixed-script host (homograph attack)',
          `"${host}" mixes ${scripts.join(' and ')} letters inside one name. That is the standard way to make a fake domain render identically to a real one.`,
        )
      }
    }

    // subdomain depth
    const depth = Math.max(0, labels.length - suffixLen - 1)
    if (depth >= 5) {
      add(
        'high',
        `${depth} levels of subdomain`,
        'A stack of subdomains pushes the only part that matters, the registrable domain, off the right edge of a phone address bar. The reader is left looking at whatever word the author chose to put first.',
      )
    } else if (depth >= 3) {
      add(
        'medium',
        `${depth} levels of subdomain`,
        'Deep subdomains bury the real domain behind reassuring words. Read a host from the right: the labels just before the first slash are the ones somebody actually bought.',
      )
    }

    // brand placement
    const domain = labels.slice(-(suffixLen + 1)).join('.')
    const front = labels
      .slice(0, Math.max(0, labels.length - suffixLen - 1))
      .join('.')
      .toLowerCase()
    const rest = `${u.pathname} ${u.search}`.toLowerCase()
    for (const brand of BRANDS) {
      if (sld.toLowerCase().includes(brand)) continue
      if (front.includes(brand)) {
        add(
          'high',
          `Brand "${brand}" sits in a subdomain, not the domain`,
          `The registrable domain is "${domain}", and that is who this link belongs to. "${brand}" appears only in front of it, where anyone can put any word for free. This is the paypal.com.evil.tld pattern.`,
        )
        break
      }
      if (rest.includes(brand)) {
        add(
          'low',
          `Brand "${brand}" appears outside the domain`,
          `"${brand}" is in the path or query while the site is "${domain}". Common and often innocent; noted because it makes an unfamiliar domain read like a familiar one.`,
        )
        break
      }
    }

    if (SHORTENERS.has(domain.toLowerCase())) {
      add(
        'medium',
        'Known link shortener',
        `"${domain}" hides the real destination behind a redirect, so nothing past this point can be judged from the link itself. Expand it before trusting it.`,
      )
    }

    const t = tld.toLowerCase()
    if (TLD_LOOKALIKE.has(t)) {
      add(
        'medium',
        `.${t} looks like a file extension`,
        `A ".${t}" domain reads exactly like a filename, so "invoice.${t}" is a website while the reader believes it is an attachment.`,
      )
    } else if (TLD_FREE.has(t)) {
      add(
        'medium',
        `.${t} is a free-registration domain`,
        `Names under .${t} cost nothing and need no verification, so they are registered in bulk and abandoned after a campaign. Established services rarely use them.`,
      )
    } else if (TLD_CHEAP.has(t)) {
      add(
        'low',
        `.${t} is a high-abuse registry`,
        `Plenty of legitimate sites use .${t}; it is listed only because the low price makes it heavily over-represented in phishing. On its own this means very little.`,
      )
    }

    if (host.length > 70) {
      add(
        'medium',
        `Very long host (${host.length} characters)`,
        'A host this long cannot be read at a glance and will be truncated in most address bars, which is usually the point of it.',
      )
    } else if (host.length > 45) {
      add('low', `Long host (${host.length} characters)`, 'Long enough to be cut off on a narrow screen, so check the end of the name rather than the start.')
    }
  }

  if (u.port) {
    const dev = ['8080', '8443', '8000', '3000', '5000']
    if (dev.includes(u.port)) {
      add('low', `Non-standard port ${u.port}`, `Web traffic uses 80 and 443. Port ${u.port} is ordinary for a development server and unusual for a public site.`)
    } else {
      add(
        'medium',
        `Non-standard port ${u.port}`,
        `Public sites answer on 80 and 443. A service parked on ${u.port} is usually running outside the hosting a real company would use.`,
      )
    }
  }

  const escapes = raw.match(/%[0-9A-Fa-f]{2}/g)?.length ?? 0
  if (/%25/.test(raw)) {
    add(
      'medium',
      'Double percent-encoding',
      'A "%25" is an encoded percent sign, so this URL is encoded twice. That is a standard way to slip a payload past a filter that decodes only once.',
    )
  }
  if (escapes >= 8) {
    add(
      'medium',
      `Heavy percent-encoding (${escapes} escapes)`,
      'This much encoding makes the URL unreadable to a person while resolving normally for the browser, which is the entire reason to do it.',
    )
  } else if (escapes >= 4) {
    add('low', `Percent-encoding (${escapes} escapes)`, 'Some encoding is normal for spaces and accents. Listed so you can decode the link and read what it actually says.')
  }

  const ext = u.pathname.toLowerCase().match(/\.([a-z0-9]{2,4})$/)?.[1]
  if (ext && RISKY_EXT.includes(ext)) {
    add(
      'medium',
      `Path ends in .${ext}`,
      'The link points straight at an executable or installer rather than a page. Downloading is the whole interaction, and the URL vouches for nothing about the file.',
    )
  }

  return finish(raw, u, f)
}

// ---------------------------------------------------------------- feeds

/**
 * How strong a listing is. `url` means this exact address was published as phishing.
 * `host` means a different address on the same hostname was. `domain` means only the
 * registrable domain matched, so the listed thing may be a sibling subdomain. They are
 * reported separately on purpose: collapsing them into one "known bad" would let the
 * weakest evidence borrow the credibility of the strongest.
 */
export type MatchKind = 'url' | 'host' | 'domain'

export interface FeedSpec {
  id: string
  name: string
  url: string
  /** `urls` entries are full addresses; `hosts` entries are bare hostnames. */
  kind: 'urls' | 'hosts'
  /** Bulk feeds are megabytes, so they are opt in, downloaded once and cached. */
  bulk: boolean
  ttlMs: number
  size: string
}

const HOUR = 3_600_000

export const FEEDS: FeedSpec[] = [
  {
    id: 'openphish',
    name: 'OpenPhish',
    url: 'https://raw.githubusercontent.com/openphish/public_feed/main/feed.txt',
    kind: 'urls',
    bulk: false,
    ttlMs: HOUR / 2,
    size: 'about 300 live URLs, 15 KB',
  },
  {
    id: 'phishing-database',
    name: 'Phishing.Database',
    url: 'https://cdn.jsdelivr.net/gh/mitchellkrogza/Phishing.Database@master/phishing-domains-ACTIVE.txt',
    kind: 'hosts',
    bulk: true,
    ttlMs: 24 * HOUR,
    size: 'about 390000 hostnames, 3.6 MB compressed',
  },
  {
    id: 'blocklistproject',
    name: 'The Blocklist Project',
    url: 'https://raw.githubusercontent.com/blocklistproject/Lists/master/phishing.txt',
    kind: 'hosts',
    bulk: true,
    ttlMs: 24 * HOUR,
    size: 'about 190000 hostnames, 5.6 MB',
  },
]

export function feedById(id: string): FeedSpec | undefined {
  return FEEDS.find((f) => f.id === id)
}

// Feed bodies live in their own IndexedDB store, NOT in the encrypted vault. They are
// public blocklists with nothing personal in them, and putting eleven megabytes in the
// vault would mean re-wrapping all of it on every passphrase mode switch and losing
// access to it whenever the vault is locked. Cost with no benefit.
const feedStore = createStore('wt-feeds', 'kv')

interface CachedFeed {
  /** Cleaned entries, one per line. Storing the parsed form skips re-reading comments. */
  text: string
  fetchedAt: number
  /** Bytes as delivered, so the card can show what the download actually cost. */
  bytes: number
}

export interface FeedState {
  spec: FeedSpec
  fetchedAt: number
  entries: number
  bytes: number
  stale: boolean
}

/**
 * Parsed indexes, keyed by feed id. Module level and shared across every card on
 * purpose: unlike per-card UI state this is immutable public data, and rebuilding a
 * 390000-entry Set per open card would be pure waste.
 */
const indexes = new Map<string, { urls: Set<string>; hosts: Set<string>; domains: Set<string>; state: FeedState }>()
/** In-flight fetches, so two cards pasted at once share one download. */
const inflight = new Map<string, Promise<FeedState | null>>()

/**
 * Comparison key for a URL. The scheme is deliberately dropped: feeds list the address
 * they observed, and http vs https is not the identity of a phishing page. Credentials
 * and the fragment go too (neither reaches the server), a default port is normalised
 * away, and a bare "/" path is treated as no path so a pasted "https://x" matches a
 * listed "https://x/".
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  const dflt = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')
  const port = u.port && !dflt ? `:${u.port}` : ''
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
  return `${host}${port}${path}${u.search}`
}

/** The part of a hostname somebody actually bought, using the same suffix table as above. */
export function registrableDomain(hostname: string): string {
  const { labels, suffixLen } = splitHost(hostname.toLowerCase().replace(/\.$/, ''))
  return labels.slice(-(suffixLen + 1)).join('.')
}

function hostOf(line: string): string | null {
  // Accepts a bare hostname and the hosts-file form ("0.0.0.0 evil.example").
  const parts = line.split(/\s+/).filter(Boolean)
  const h = (parts.length > 1 ? parts[1] : parts[0])?.toLowerCase().replace(/\.$/, '')
  if (!h || h.includes('/') || !h.includes('.')) return null
  if (h === '0.0.0.0' || h === 'localhost' || IPV4.test(h)) return null
  return h
}

/** Strip comments and blank lines, and reduce every entry to its comparison form. */
function cleanFeed(body: string, kind: FeedSpec['kind']): string {
  const out: string[] = []
  for (const line of body.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#') || s.startsWith('!')) continue
    if (kind === 'urls') {
      const n = normalizeUrl(s)
      if (n) out.push(n)
    } else {
      const h = hostOf(s)
      if (h) out.push(h)
    }
  }
  return out.join('\n')
}

function buildIndex(spec: FeedSpec, cached: CachedFeed): FeedState {
  const urls = new Set<string>()
  const hosts = new Set<string>()
  const domains = new Set<string>()
  const lines = cached.text ? cached.text.split('\n') : []
  for (const line of lines) {
    if (!line) continue
    if (spec.kind === 'urls') {
      urls.add(line)
      const h = line.split('/')[0].split(':')[0]
      hosts.add(h)
      domains.add(registrableDomain(h))
    } else {
      hosts.add(line)
      domains.add(registrableDomain(line))
    }
  }
  const state: FeedState = {
    spec,
    fetchedAt: cached.fetchedAt,
    entries: spec.kind === 'urls' ? urls.size : hosts.size,
    bytes: cached.bytes,
    stale: Date.now() - cached.fetchedAt > spec.ttlMs,
  }
  indexes.set(spec.id, { urls, hosts, domains, state })
  return state
}

/** Read the cached copy from IndexedDB (or memory) without touching the network. */
export async function loadFeed(spec: FeedSpec): Promise<FeedState | null> {
  const held = indexes.get(spec.id)
  if (held) {
    held.state.stale = Date.now() - held.state.fetchedAt > spec.ttlMs
    return held.state
  }
  const cached = await get<CachedFeed>(spec.id, feedStore)
  return cached ? buildIndex(spec, cached) : null
}

/** Download and cache a feed. Rejects with a readable message; callers surface it. */
export async function refreshFeed(spec: FeedSpec): Promise<FeedState> {
  const running = inflight.get(spec.id)
  if (running) {
    const done = await running
    if (done) return done
  }
  const job = (async (): Promise<FeedState | null> => {
    const res = await fetch(spec.url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`${spec.name} returned HTTP ${res.status}`)
    const body = await res.text()
    const cached: CachedFeed = { text: cleanFeed(body, spec.kind), fetchedAt: Date.now(), bytes: body.length }
    if (!cached.text) throw new Error(`${spec.name} returned nothing usable`)
    await set(spec.id, cached, feedStore)
    return buildIndex(spec, cached)
  })()
  inflight.set(spec.id, job)
  try {
    const out = await job
    if (!out) throw new Error(`${spec.name} could not be indexed`)
    return out
  } finally {
    inflight.delete(spec.id)
  }
}

export async function deleteFeed(spec: FeedSpec): Promise<void> {
  indexes.delete(spec.id)
  await del(spec.id, feedStore)
}

export interface FeedHit {
  feed: string
  match: MatchKind
  fetchedAt: number
  entries: number
}

export interface FeedOutcome {
  hits: FeedHit[]
  /** Feeds that answered, hit or not. An empty list means nothing was actually checked. */
  consulted: FeedState[]
  /** Bulk feeds the user has not downloaded. Named so a miss is never mistaken for a pass. */
  absent: FeedSpec[]
  errors: { feed: string; message: string }[]
}

function matchIn(id: string, norm: string, host: string, domain: string): MatchKind | null {
  const idx = indexes.get(id)
  if (!idx) return null
  if (idx.urls.has(norm)) return 'url'
  if (idx.hosts.has(host)) return 'host'
  if (idx.domains.has(domain)) return 'domain'
  return null
}

/**
 * Check one URL against the feeds. The small feed is fetched on demand and reused for
 * its TTL; bulk feeds are consulted ONLY when already downloaded, so a check never
 * silently pulls megabytes. Never throws: a dead feed becomes an entry in `errors`,
 * because a network failure must not be able to look like a clean result.
 */
export async function checkFeeds(input: string): Promise<FeedOutcome> {
  const out: FeedOutcome = { hits: [], consulted: [], absent: [], errors: [] }
  const norm = normalizeUrl(input)
  if (!norm) return out
  const host = norm.split('/')[0].split(':')[0]
  const domain = registrableDomain(host)

  for (const spec of FEEDS) {
    let state = await loadFeed(spec)
    if (spec.bulk) {
      // Opt in only. A missing bulk feed is reported, never fetched behind the user.
      if (!state) {
        out.absent.push(spec)
        continue
      }
    } else if (!state || state.stale) {
      try {
        state = await refreshFeed(spec)
      } catch (e) {
        out.errors.push({ feed: spec.name, message: (e as Error).message })
        if (!state) continue
      }
    }
    if (!state) continue
    out.consulted.push(state)
    const m = matchIn(spec.id, norm, host, domain)
    if (m) out.hits.push({ feed: spec.name, match: m, fetchedAt: state.fetchedAt, entries: state.entries })
  }
  // Strongest evidence first, so the headline claim is the one best supported.
  const rank: MatchKind[] = ['url', 'host', 'domain']
  out.hits.sort((a, b) => rank.indexOf(a.match) - rank.indexOf(b.match))
  return out
}

// ---------------------------------------------------------------- wording

export function ageText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 90) return `${s}s old`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min old`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h old` : `${Math.round(h / 24)} days old`
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MATCH_WORD: Record<MatchKind, string> = {
  url: 'this exact URL is listed',
  host: 'this hostname is listed',
  domain: 'the registrable domain is listed',
}

export function hitText(h: FeedHit): string {
  return `Listed by ${h.feed}: ${MATCH_WORD[h.match]}. Feed ${ageText(h.fetchedAt)}, ${h.entries} entries.`
}

/** One line for the top of a card: the fact layer, never the heuristic one. */
export function feedHeadline(o: FeedOutcome): { cls: string; text: string } {
  if (o.hits.length) {
    const top = o.hits[0]
    const strong = top.match === 'url'
    return {
      cls: strong ? 'danger' : 'warn',
      text: strong ? `Known bad, listed by ${top.feed}` : `Related listing in ${top.feed}`,
    }
  }
  if (!o.consulted.length) return { cls: 'warn', text: 'No feed answered' }
  const oldest = o.consulted.reduce((a, b) => (a.fetchedAt < b.fetchedAt ? a : b))
  const where = o.consulted.length === 1 ? o.consulted[0].spec.name : `${o.consulted.length} feeds`
  // A stale copy answering "clean" is worse than no answer, so it never gets the green
  // badge: the age is in the text either way, but the colour must not vouch for it.
  const fresh = o.consulted.some((c) => !c.stale)
  return { cls: fresh ? 'ok' : 'warn', text: `Not on ${where}, ${ageText(oldest.fetchedAt)}${fresh ? '' : ', not refreshed'}` }
}

/** Plain-text version of a report, for the copy button. */
export function reportToText(r: Report, o?: FeedOutcome): string {
  const lines = [r.url]
  if (o) {
    lines.push('', o.hits.length ? o.hits.map(hitText).join('\n') : `Feeds: ${feedHeadline(o).text}`)
    for (const e of o.errors) lines.push(`${e.feed} unavailable: ${e.message}`)
    for (const a of o.absent) lines.push(`${a.name} not downloaded, so it was not consulted.`)
  }
  lines.push('', `Structural risk ${r.score}/100, ${r.verdict}`)
  for (const x of r.findings) lines.push('', `[${x.severity}] ${x.title}`, x.reason)
  lines.push('', 'A listing is a reported fact. The structural score is a heuristic reading of the URL text, not of the site.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- shared rendering

const PASTE_KEY = 'url-check-paste'

/** Whether a pasted link is checked without being asked. Defaults on (proactive). */
export async function pasteCheckEnabled(): Promise<boolean> {
  try {
    return ((await getItem<boolean>(PASTE_KEY)) ?? true) !== false
  } catch {
    return true
  }
}

export async function setPasteCheckEnabled(on: boolean): Promise<void> {
  try {
    await setItem(PASTE_KEY, on)
  } catch {
    /* vault locked; the default stands for this session */
  }
}

/** The fact layer, as DOM. Kept separate from the findings so the two never blur. */
export function feedBlock(o: FeedOutcome): HTMLElement {
  const head = feedHeadline(o)
  const box = el('div', { class: 'stack url-check-feedresult' }, [
    el('div', { class: 'row' }, [el('span', { class: `badge ${head.cls}`, text: 'feeds' }), el('strong', { text: head.text })]),
  ])
  for (const h of o.hits) box.append(el('div', { class: 'small url-check-hit', text: hitText(h) }))
  if (!o.hits.length && o.consulted.length) {
    box.append(el('div', { class: 'muted small', text: o.consulted.map((c) => `${c.spec.name} (${c.entries} entries, ${ageText(c.fetchedAt)})`).join(', ') }))
  }
  for (const e of o.errors) box.append(el('div', { class: 'muted small url-check-feederror', text: `${e.feed} unavailable: ${e.message}` }))
  if (o.absent.length) {
    box.append(el('div', { class: 'muted small', text: `Not consulted, not downloaded: ${o.absent.map((a) => a.name).join(', ')}. Open URL Check to add them.` }))
  }
  return box
}

/**
 * The breakdown, as DOM. Reference material: it makes no claim about the link, so it goes
 * below the verdict rather than competing with it for the top of the card.
 */
export function partsBlock(parts: UrlPart[]): HTMLElement {
  const box = el('div', { class: 'stack url-check-parts' }, [el('div', { class: 'group-label', text: 'How the link is put together' })])
  for (const p of parts) {
    box.append(el('div', { class: 'row small' }, [el('span', { class: 'muted', text: `${p.label}:` }), el('span', { text: p.value })]))
  }
  return box
}

/** The heuristic layer, as DOM. */
export function structuralBlock(r: Report): HTMLElement {
  const box = el('div', { class: 'stack url-check-structural' }, [
    el('div', { class: 'row url-check-score' }, [
      el('span', { class: `badge ${r.score >= 45 ? 'danger' : r.score >= 16 ? 'warn' : 'ok'}`, text: `${r.score}/100` }),
      el('strong', { text: r.verdict }),
    ]),
  ])
  for (const x of r.findings) {
    box.append(
      el('div', { class: 'stack url-check-finding' }, [
        el('div', { class: 'row' }, [el('span', { class: `badge ${BADGE[x.severity]}`, text: x.severity }), el('strong', { text: x.title })]),
        el('div', { class: 'muted small', text: x.reason }),
      ]),
    )
  }
  if (!r.findings.length) box.append(el('div', { class: 'muted small', text: 'No structural warning signs in the shape of this link.' }))
  return box
}

/**
 * Proactive check for a link pasted into the console feed (ARCHITECTURE section 4.1).
 * Renders the local verdict at once and fills the feed answer in when it lands, so the
 * paste is never blocked on the network. Mirrors the auto-OCR path for images, including
 * its off switch: with the switch off the caller gets a button instead.
 */
export async function renderPasteVerdict(url: string, out: HTMLElement): Promise<void> {
  const report = analyzeUrl(url)
  if (!report) return
  if (!(await pasteCheckEnabled())) {
    out.replaceChildren(button('Check this link', () => void runPasteVerdict(report, out), 'ghost'))
    return
  }
  await runPasteVerdict(report, out)
}

async function runPasteVerdict(report: Report, out: HTMLElement): Promise<void> {
  const pending = el('div', { class: 'muted small url-check-pending', text: 'Checking blocklist feeds...' })
  out.replaceChildren(structuralBlock(report), pending)
  let outcome: FeedOutcome
  try {
    outcome = await checkFeeds(report.url)
  } catch (e) {
    pending.textContent = `Feeds unavailable: ${(e as Error).message}`
    return
  }
  if (!out.isConnected) return
  out.replaceChildren(feedBlock(outcome), structuralBlock(report))
}

// ---------------------------------------------------------------- ui

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    const input = el('input', { type: 'text', class: 'full', placeholder: 'https://example.com/path', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement
    const out = el('div', { class: 'stack url-check-out' })
    const feeds = el('div', { class: 'stack url-check-feeds' })
    // Per-card state: this closure runs once per container, so nothing here is shared
    // with another open copy of the card.
    let current: Report | null = null
    let outcome: FeedOutcome | null = null

    const paint = () => {
      const r = current
      if (!r) {
        out.replaceChildren(el('div', { class: 'muted url-check-score', text: 'Not a valid URL' }))
        return
      }
      const parts = parseUrl(r.url)
      out.replaceChildren(
        ...(outcome ? [feedBlock(outcome)] : [el('div', { class: 'muted small url-check-pending', text: 'Checking blocklist feeds...' })]),
        structuralBlock(r),
        el('div', {
          class: 'muted small',
          text: 'A listing is a reported fact with a date. The structural score is a heuristic reading of the URL text and not of the site behind it, so a clean score is not a promise that the destination is safe.',
        }),
        // Merged in from URL Inspector, deliberately last: it answers "what is in this
        // link", which is only worth reading after the verdict has answered "is it safe".
        ...(parts ? [partsBlock(parts)] : []),
      )
    }

    const render = () => {
      current = analyzeUrl(input.value)
      outcome = null
      paint()
      if (!current) return
      const target = current.url
      void checkFeeds(target)
        .then((o) => {
          // A slow feed must not overwrite a newer check.
          if (current?.url !== target || !out.isConnected) return
          outcome = o
          paint()
          // A check populates the small feed's cache, so the feed rows below are now
          // stale: repaint them or the card claims the feed is still undownloaded.
          void renderFeeds()
        })
        .catch((e: Error) => {
          if (current?.url !== target || !out.isConnected) return
          outcome = { hits: [], consulted: [], absent: [], errors: [{ feed: 'feeds', message: e.message }] }
          paint()
        })
    }

    async function renderFeeds(): Promise<void> {
      feeds.replaceChildren(el('div', { class: 'group-label', text: 'Blocklist feeds' }))
      for (const spec of FEEDS) {
        const row = el('div', { class: 'stack url-check-feed-row' })
        const status = el('div', { class: 'muted small url-check-feed-status' })
        const actions = el('div', { class: 'row' })
        const state = await loadFeed(spec)
        status.textContent = state
          ? `${state.entries} entries, ${sizeText(state.bytes)}, fetched ${ageText(state.fetchedAt)}${state.stale ? ', stale' : ''}`
          : spec.bulk
            ? `Not downloaded. ${spec.size}.`
            : `Fetched automatically when you run a check. ${spec.size}.`
        const busy = (label: string, job: () => Promise<unknown>) =>
          button(
            label,
            () => {
              status.textContent = `${label}...`
              void job()
                .catch((e: Error) => toast(e.message))
                .then(() => void renderFeeds())
            },
            'ghost',
          )
        actions.append(busy(state ? 'Refresh' : 'Download', () => refreshFeed(spec)))
        if (state) actions.append(busy('Delete', () => deleteFeed(spec)))
        row.append(
          el('div', { class: 'row' }, [el('strong', { text: spec.name }), el('span', { class: 'badge', text: spec.kind === 'urls' ? 'URLs' : 'hostnames' })]),
          status,
          actions,
        )
        feeds.append(row)
      }
    }

    const auto = el('input', { type: 'checkbox' }) as HTMLInputElement
    void pasteCheckEnabled().then((on) => {
      auto.checked = on
    })
    auto.addEventListener('change', () => void setPasteCheckEnabled(auto.checked))

    container.append(
      input,
      el('div', { class: 'row' }, [
        button('Check', render, 'primary'),
        copyButton(() => (current ? reportToText(current, outcome ?? undefined) : ''), ctx.clipboard.write, 'Copy report', 'ghost'),
        copyButton(() => decodedUrl(input.value), ctx.clipboard.write, 'Copy decoded', 'ghost'),
      ]),
      el('p', {
        class: 'muted small',
        text: 'The structural read is local and never fetches the link. Feed lookups compare the address against published phishing lists downloaded here; the link itself is still never opened.',
      }),
      out,
      el('label', { class: 'row small url-check-auto' }, [auto, el('span', { text: 'Check links pasted into the feed automatically' })]),
      feeds,
    )
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') render()
    })
    void renderFeeds()
  },
}

export default tool
