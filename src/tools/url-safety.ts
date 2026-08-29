// URL risk analysis that never leaves the device.
//
// Why not a reputation lookup: every keyless service in this space (urlvoid and friends)
// either answers without CORS headers, so a browser cannot read the response at all, or
// needs an API key. A key shipped in a client-only app is public by construction, so a
// third-party lookup is not on the table here. What IS on the table is the structural
// analysis a careful reader does by hand: the tricks below are all visible in the text of
// the URL itself. That is genuinely useful, completely private, and needs no network.
//
// The honest limit, stated in the card too: this reads the URL, not the site. A clean
// result means "nothing about the shape of this link is deceptive", not "safe".
//
// Parsing follows url-info.ts (new URL on the trimmed input, null on failure). The
// component breakdown stays there; this module only reports risk, never the parts.

import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

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

/** Returns null when the input is not a URL at all, matching url-info's parse contract. */
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

/** Plain-text version of a report, for the copy button. */
export function reportToText(r: Report): string {
  const head = `${r.url}\nStructural risk ${r.score}/100, ${r.verdict}`
  const body = r.findings.map((x) => `\n\n[${x.severity}] ${x.title}\n${x.reason}`).join('')
  return `${head}${body}\n\nStructural analysis of the URL text only. Not a reputation check.`
}

// ---------------------------------------------------------------- ui

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    const input = el('input', { type: 'text', class: 'full', placeholder: 'https://example.com/path', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement
    const out = el('div', { class: 'stack url-safety-out' })
    let current: Report | null = null

    const render = () => {
      current = analyzeUrl(input.value)
      const r = current
      if (!r) {
        out.replaceChildren(el('div', { class: 'muted url-safety-score', text: 'Not a valid URL' }))
        return
      }
      const head = el('div', { class: 'row url-safety-score' }, [
        el('span', { class: `badge ${r.score >= 45 ? 'danger' : r.score >= 16 ? 'warn' : 'ok'}`, text: `${r.score}/100` }),
        el('strong', { text: r.verdict }),
      ])
      const items = r.findings.map((x) =>
        el('div', { class: 'stack url-safety-finding' }, [
          el('div', { class: 'row' }, [el('span', { class: `badge ${BADGE[x.severity]}`, text: x.severity }), el('strong', { text: x.title })]),
          el('div', { class: 'muted small', text: x.reason }),
        ]),
      )
      out.replaceChildren(
        head,
        ...(items.length ? items : [el('div', { class: 'muted small', text: 'No structural warning signs in the shape of this link.' })]),
        el('div', {
          class: 'muted small',
          text: 'This reads the text of the URL, not the site behind it. It is structural analysis and not a reputation check, so a clean result is not a promise that the destination is safe.',
        }),
      )
    }

    container.append(
      input,
      el('div', { class: 'row' }, [button('Analyze', render, 'primary'), copyButton(() => (current ? reportToText(current) : ''), ctx.clipboard.write, 'Copy report', 'ghost')]),
      el('p', { class: 'muted small', text: 'Runs entirely on this device. The link is never fetched and nothing is sent anywhere.' }),
      out,
    )
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') render()
    })
  },
}

export default tool
