// Dev generators: every value is generated the moment it is shown, one click on a value
// copies it, 🔄 regenerates only that row. All local, nothing fetched. Region-aware,
// defaulting to the browser locale, with every ISO 3166-1 country selectable: a handful
// carry curated name, ID and phone pools, the rest reuse the international name pool with
// their own dialling code. The region is picked from a <select> in BOTH surfaces, the tool
// card and the Tools-launcher quick-copy flyout, and persisted under a SHARED store key
// (`gen-region`) so the two always agree.
// National IDs like CPF, CNPJ and SSN carry valid check digits and cards pass Luhn; every
// value is random test data, not tied to a real person or registration. No national ID is
// gated behind its country: the selected region's IDs are the prominent ones, every other
// country's are appended under its flag.

import { getItem, setItem } from '../core/store'
import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyText, el } from '../shell/ui'

/** An ISO 3166-1 alpha-2 code lowercased, `uk` for the United Kingdom, or `intl`. */
export type Region = string
/** Regions with curated pools. Every other country falls back to the international mix. */
type CuratedRegion = 'intl' | 'br' | 'us' | 'uk' | 'de' | 'fr' | 'jp' | 'mx'

const rnd = (n: number) => Math.floor(Math.random() * n)
const digits = (n: number) => Array.from({ length: n }, () => rnd(10))
const pick = <T>(a: readonly T[]): T => a[rnd(a.length)]
const p2 = () => String(10 + rnd(90))
const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + rnd(26))).join('')

// --- name pools ---
const FIRST: Record<CuratedRegion, readonly string[]> = {
  intl: [
    'Liam',
    'Olivia',
    'Noah',
    'Emma',
    'Mohammed',
    'Sofia',
    'Hiroshi',
    'Yuki',
    'Aarav',
    'Priya',
    'Chen',
    'Mei',
    'Lucas',
    'Marie',
    'Hans',
    'Ingrid',
    'Omar',
    'Fatima',
    'Diego',
    'Ana',
    'Kwame',
    'Amara',
    'Sven',
    'Elena',
    'Mateo',
    'Nour',
    'Ravi',
    'Sakura',
  ],
  br: [
    'Ana',
    'Bruno',
    'Carla',
    'Diego',
    'Elisa',
    'Felipe',
    'Gabriela',
    'Hugo',
    'Iara',
    'João',
    'Karen',
    'Lucas',
    'Marina',
    'Nicolas',
    'Olívia',
    'Paulo',
    'Rafaela',
    'Sofia',
    'Thiago',
    'Vitória',
  ],
  us: [
    'James',
    'Mary',
    'John',
    'Patricia',
    'Robert',
    'Jennifer',
    'Michael',
    'Linda',
    'William',
    'Elizabeth',
    'David',
    'Susan',
    'Richard',
    'Jessica',
    'Joseph',
    'Sarah',
    'Daniel',
    'Karen',
    'Chris',
    'Nancy',
  ],
  uk: ['Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Ava', 'Noah', 'Emily', 'Jack', 'Sophie', 'Charlie', 'Grace', 'Oscar', 'Lily', 'Thomas', 'Freya'],
  de: ['Lukas', 'Emma', 'Leon', 'Mia', 'Finn', 'Hannah', 'Paul', 'Lena', 'Jonas', 'Lea', 'Felix', 'Marie', 'Elias', 'Sophie', 'Ben', 'Clara'],
  fr: ['Gabriel', 'Léa', 'Louis', 'Emma', 'Raphaël', 'Jade', 'Arthur', 'Chloé', 'Hugo', 'Manon', 'Jules', 'Camille', 'Lucas', 'Alice', 'Adam', 'Louise'],
  jp: ['Haruto', 'Yui', 'Sōta', 'Aoi', 'Yūto', 'Hina', 'Riku', 'Mei', 'Haru', 'Sakura', 'Ren', 'Yuna', 'Kaito', 'Rin', 'Sora', 'Hana'],
  mx: ['Santiago', 'Sofía', 'Mateo', 'Valentina', 'Sebastián', 'Regina', 'Diego', 'Camila', 'Emiliano', 'Ximena', 'Leonardo', 'Renata', 'Ángel', 'Lucía'],
}
const LAST: Record<CuratedRegion, readonly string[]> = {
  intl: [
    'Smith',
    'García',
    'Müller',
    'Rossi',
    'Nakamura',
    'Kim',
    'Patel',
    'Silva',
    'Nowak',
    'Ivanov',
    'Andersson',
    'Chen',
    'Okafor',
    'Haddad',
    'Santos',
    'Dubois',
    'Costa',
    'Yamamoto',
    'Novák',
    'Ali',
  ],
  br: ['Almeida', 'Barbosa', 'Cardoso', 'Dias', 'Ferreira', 'Gomes', 'Lima', 'Martins', 'Nogueira', 'Oliveira', 'Pereira', 'Ribeiro', 'Santos', 'Silva', 'Souza', 'Teixeira'],
  us: [
    'Smith',
    'Johnson',
    'Williams',
    'Brown',
    'Jones',
    'Garcia',
    'Miller',
    'Davis',
    'Rodriguez',
    'Martinez',
    'Wilson',
    'Anderson',
    'Taylor',
    'Thomas',
    'Moore',
    'Jackson',
    'Martin',
    'Lee',
  ],
  uk: ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright', 'Hughes', 'Green', 'Hall'],
  de: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Bauer', 'Richter', 'Klein'],
  fr: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Girard', 'Bonnet', 'Fontaine'],
  jp: ['Satō', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Itō', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Katō', 'Yoshida', 'Yamada', 'Sasaki', 'Matsumoto'],
  mx: ['Hernández', 'García', 'Martínez', 'López', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz'],
}
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ')
const CO_SUFFIX = ['Inc', 'LLC', 'Group', 'Labs', 'Studio', 'Systems', 'Global', 'Digital', 'Co']

// A country without a curated pool draws international names; only its dialling code,
// postal shape and ID formats then distinguish it.
const firstNames = (region: Region): readonly string[] => FIRST[region as CuratedRegion] ?? FIRST.intl
const lastNames = (region: Region): readonly string[] => LAST[region as CuratedRegion] ?? LAST.intl

function fullName(region: Region): string {
  const f = pick(firstNames(region))
  const l = pick(lastNames(region))
  return region === 'br' ? `${f} ${l} ${pick(LAST.br)}` : `${f} ${l}`
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '')

function email(region: Region): string {
  const [a, b] = slug(fullName(region)).split(' ')
  return `${a}.${b ?? 'user'}${rnd(99)}@example.com`
}
function username(region: Region): string {
  return `${slug(pick(firstNames(region)))}${rnd(1000)}`
}

// --- national IDs, with valid check digits ---
function cpf(): string {
  const d = digits(9)
  for (let round = 0; round < 2; round++) {
    const sum = d.reduce((acc, v, i) => acc + v * (d.length + 1 - i), 0)
    const dv = (sum * 10) % 11
    d.push(dv === 10 ? 0 : dv)
  }
  const s = d.join('')
  return `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
}
function cnpj(): string {
  const d = [...digits(8), 0, 0, 0, 1]
  for (const weights of [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ]) {
    const sum = d.reduce((acc, v, i) => acc + v * weights[i], 0)
    const dv = sum % 11
    d.push(dv < 2 ? 0 : 11 - dv)
  }
  const s = d.join('')
  return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`
}
const ssn = () => `${100 + rnd(800)}-${p2()}-${(1 + rnd(9999)).toString().padStart(4, '0')}`
const ein = () => `${10 + rnd(89)}-${1000000 + rnd(8999999)}`

// --- countries ---
// Every ISO 3166-1 alpha-2 code with its E.164 dialling code, packed as code + digits.
// This doubles as the country list: display names come from Intl.DisplayNames at runtime
// and flags are derived arithmetically, so no name or flag table is shipped.
const DIAL_DATA =
  'ad376 ae971 af93 ag1 ai1 al355 am374 ao244 aq672 ar54 as1 at43 au61 aw297 ax358 az994 ' +
  'ba387 bb1 bd880 be32 bf226 bg359 bh973 bi257 bj229 bl590 bm1 bn673 bo591 bq599 br55 bs1 ' +
  'bt975 bv47 bw267 by375 bz501 ca1 cc61 cd243 cf236 cg242 ch41 ci225 ck682 cl56 cm237 cn86 ' +
  'co57 cr506 cu53 cv238 cw599 cx61 cy357 cz420 de49 dj253 dk45 dm1 do1 dz213 ec593 ee372 ' +
  'eg20 eh212 er291 es34 et251 fi358 fj679 fk500 fm691 fo298 fr33 ga241 gb44 gd1 ge995 gf594 ' +
  'gg44 gh233 gi350 gl299 gm220 gn224 gp590 gq240 gr30 gs500 gt502 gu1 gw245 gy592 hk852 ' +
  'hm672 hn504 hr385 ht509 hu36 id62 ie353 il972 im44 in91 io246 iq964 ir98 is354 it39 je44 ' +
  'jm1 jo962 jp81 ke254 kg996 kh855 ki686 km269 kn1 kp850 kr82 kw965 ky1 kz7 la856 lb961 lc1 ' +
  'li423 lk94 lr231 ls266 lt370 lu352 lv371 ly218 ma212 mc377 md373 me382 mf590 mg261 mh692 ' +
  'mk389 ml223 mm95 mn976 mo853 mp1 mq596 mr222 ms1 mt356 mu230 mv960 mw265 mx52 my60 mz258 ' +
  'na264 nc687 ne227 nf672 ng234 ni505 nl31 no47 np977 nr674 nu683 nz64 om968 pa507 pe51 ' +
  'pf689 pg675 ph63 pk92 pl48 pm508 pn64 pr1 ps970 pt351 pw680 py595 qa974 re262 ro40 rs381 ' +
  'ru7 rw250 sa966 sb677 sc248 sd249 se46 sg65 sh290 si386 sj47 sk421 sl232 sm378 sn221 ' +
  'so252 sr597 ss211 st239 sv503 sx1 sy963 sz268 tc1 td235 tf262 tg228 th66 tj992 tk690 ' +
  'tl670 tm993 tn216 to676 tr90 tt1 tv688 tw886 tz255 ua380 ug256 um1 us1 uy598 uz998 va39 ' +
  'vc1 ve58 vg1 vi1 vn84 vu678 wf681 ws685 ye967 yt262 za27 zm260 zw263'
const DIAL: Record<string, string> = {}
for (const entry of DIAL_DATA.split(' ')) DIAL[entry.slice(0, 2)] = entry.slice(2)
// The curated UK pool is keyed 'uk' and that value is already persisted for users who
// picked it, so 'gb' is folded into it rather than shipped as a second United Kingdom.
DIAL.uk = DIAL.gb
delete DIAL.gb

/** Real ISO code for a region, undoing the 'uk' alias. Used for names and flags. */
const isoOf = (region: Region) => (region === 'uk' ? 'GB' : region.toUpperCase())
/** Flag emoji straight from the ISO code: A-Z maps onto the regional indicator block. */
const flagOf = (region: Region) => String.fromCodePoint(...[...isoOf(region)].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))

// --- phone / postal, region-formatted ---
function phone(region: Region): string {
  switch (region) {
    case 'br': {
      const ddd = [11, 21, 31, 41, 51, 61, 71, 81, 85, 48][rnd(10)]
      return `(${ddd}) 9${String(1000 + rnd(9000))}-${String(1000 + rnd(9000))}`
    }
    case 'us':
      return `(${200 + rnd(800)}) ${200 + rnd(800)}-${String(1000 + rnd(9000))}`
    case 'uk':
      return `+44 7${String(100 + rnd(900))} ${String(100000 + rnd(900000))}`
    case 'de':
      return `+49 ${String(30 + rnd(9000))} ${String(100000 + rnd(900000))}`
    case 'fr':
      return `+33 ${1 + rnd(9)} ${p2()} ${p2()} ${p2()} ${p2()}`
    case 'jp':
      return `+81 ${p2()}-${String(1000 + rnd(9000))}-${String(1000 + rnd(9000))}`
    case 'mx':
      return `+52 ${p2()} ${String(1000 + rnd(9000))} ${String(1000 + rnd(9000))}`
    default: {
      // A country without a curated format still gets its own dialling code; 'intl' has
      // none, so it borrows one of the widest-known codes.
      const cc = DIAL[region] ?? [1, 44, 49, 33, 39, 81, 91, 55][rnd(8)]
      return `+${cc} ${100 + rnd(900)} ${100 + rnd(900)} ${String(1000 + rnd(9000))}`
    }
  }
}
function postal(region: Region): string {
  switch (region) {
    case 'br':
      return `${String(10000 + rnd(90000))}-${String(100 + rnd(900))}`
    case 'us':
      return `${String(10000 + rnd(89999))}-${String(1000 + rnd(9000))}`
    case 'uk':
      return `${letters(2)}${1 + rnd(9)} ${rnd(10)}${letters(2)}`
    case 'jp':
      return `${String(100 + rnd(900))}-${String(1000 + rnd(9000))}`
    default:
      return String(10000 + rnd(89999))
  }
}
const postalLabel = (region: Region) => (region === 'br' ? 'CEP' : region === 'us' ? 'ZIP' : region === 'uk' ? 'Postcode' : 'Postal code')

// --- universal dev values ---
function password(len = 16): string {
  const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*-_+='
  return [...crypto.getRandomValues(new Uint8Array(len))].map((b) => pool[b % pool.length]).join('')
}
const pin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')

/** 16-digit test card (Visa-style prefix 4) with a valid Luhn check digit. */
function creditCard(): string {
  const body = [4, ...digits(14)] // 15 digits; the 16th is the check digit
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    let d = body[body.length - 1 - i]
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  const check = (10 - (sum % 10)) % 10
  return [...body, check]
    .join('')
    .replace(/(.{4})/g, '$1 ')
    .trim()
}
const ipv4 = () => `${rnd(256)}.${rnd(256)}.${rnd(256)}.${rnd(256)}`
const mac = () => Array.from({ length: 6 }, () => rnd(256).toString(16).padStart(2, '0')).join(':')
const company = () => `${pick(LAST.intl)} ${pick(CO_SUFFIX)}`
function lorem(words = 12): string {
  const out = Array.from({ length: words }, () => LOREM[rnd(LOREM.length)]).join(' ')
  return out[0].toUpperCase() + out.slice(1) + '.'
}
const hexColor = () => `#${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('')}`

export interface Generator {
  label: string
  gen: () => string
}

/** National ID formats, keyed by the country whose documents they are. Every one is
 *  reachable from every region: a user on Germany still needs a CPF now and then. */
const NATIONAL_IDS: ReadonlyArray<readonly [Region, readonly Generator[]]> = [
  [
    'br',
    [
      { label: 'CPF', gen: cpf },
      { label: 'CNPJ', gen: cnpj },
    ],
  ],
  [
    'us',
    [
      { label: 'SSN', gen: ssn },
      { label: 'EIN', gen: ein },
    ],
  ],
]

/** Region-aware generator list: people/contact formats and national IDs for the region,
 *  shared universals, then the other countries' IDs so none is gated behind its region. */
export function generatorsFor(region: Region): Generator[] {
  const list: Generator[] = [
    { label: 'Name', gen: () => fullName(region) },
    { label: 'Email', gen: () => email(region) },
    { label: 'Username', gen: () => username(region) },
    { label: 'Phone', gen: () => phone(region) },
    { label: postalLabel(region), gen: () => postal(region) },
  ]
  for (const [r, ids] of NATIONAL_IDS) if (r === region) list.push(...ids)
  list.push(
    { label: 'Password', gen: () => password(16) },
    { label: 'PIN', gen: pin },
    { label: 'UUID', gen: () => crypto.randomUUID() },
    { label: 'Credit card', gen: creditCard },
    { label: 'Company', gen: company },
    { label: 'IPv4', gen: ipv4 },
    { label: 'MAC', gen: mac },
    { label: 'Hex color', gen: hexColor },
    { label: 'Lorem', gen: () => lorem(12) },
    { label: 'Timestamp', gen: () => String(Date.now()) },
    { label: 'ISO date', gen: () => new Date().toISOString() },
  )
  // Off-region IDs come last and carry their flag, so the selected region's own IDs stay
  // the prominent, unqualified ones.
  for (const [r, ids] of NATIONAL_IDS) if (r !== region) list.push(...ids.map((g) => ({ ...g, label: `${flagOf(r)} ${g.label}` })))
  return list
}

// Intl.DisplayNames localises all ~250 country names into the user's own language with no
// shipped data. It is guarded because it is absent on older engines, where the bare ISO
// code stands in as the label.
const displayNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'region' })
  } catch {
    return null
  }
})()

function nameOf(region: Region): string {
  const code = isoOf(region)
  try {
    return displayNames?.of(code) ?? code
  } catch {
    return code
  }
}

function buildRegions(): Array<[Region, string]> {
  const collator = new Intl.Collator(navigator.language)
  const countries = Object.keys(DIAL)
    .map((code) => [code, nameOf(code)] as const)
    .sort((a, b) => collator.compare(a[1], b[1]))
    .map(([code, name]): [Region, string] => [code, `${flagOf(code)} ${name}`])
  const home = regionFromLocale()
  return [['intl', '🌍 International'], ...countries.filter(([v]) => v === home), ...countries.filter(([v]) => v !== home)]
}

/** `[value, label]` for every selectable region, localised. International and the
 *  detected country are pinned first so neither is buried under ~250 alphabetical rows. */
export const REGIONS: Array<[Region, string]> = buildRegions()

const REGION_KEY = 'gen-region'

/** Best-guess region from the browser locale, used until the user picks one. A real
 *  country subtag wins; otherwise the base language picks the closest curated test-data
 *  pool, which is a data choice and not a nationality claim. */
function regionFromLocale(): Region {
  const byLang: Partial<Record<string, Region>> = { pt: 'br', en: 'us', de: 'de', fr: 'fr', ja: 'jp', es: 'mx' }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const raw of langs) {
    const [lang, ...subtags] = (raw ?? '').toLowerCase().split('-')
    for (const sub of subtags) {
      // A script subtag can sit before the country one (zh-Hans-CN), so scan. A
      // single-letter subtag opens a BCP-47 extension, where two letters mean an
      // option key, not a country.
      if (sub.length === 1) break
      const country = sub === 'gb' ? 'uk' : sub
      if (country.length === 2 && country in DIAL) return country
    }
    if (lang && byLang[lang]) return byLang[lang]
  }
  return 'intl'
}

/** The persisted region, shared by the tool card and the Tools-launcher hover preview.
 *  Falls back to the browser locale when the user never chose one. */
export async function loadRegion(): Promise<Region> {
  const r = await getItem<Region>(REGION_KEY)
  return r && (r === 'intl' || r in DIAL) ? r : regionFromLocale()
}
export function saveRegion(region: Region): void {
  void setItem(REGION_KEY, region)
}

export interface GenRow {
  el: HTMLElement
  regenerate: () => void
  current: () => string
}

/** One generator row: label, click-to-copy value, per-row 🔄. `write` gates the copy. */
export function generatorRow(g: Generator, write?: (t: string) => Promise<void>): GenRow {
  let value = g.gen()
  const valueBtn = el('button', { class: 'gen-value', text: value, title: `Copy ${g.label}` })
  valueBtn.addEventListener('click', () => void copyText(value, write))
  const set = () => {
    value = g.gen()
    valueBtn.textContent = value
  }
  const refresh = button('🔄', set, 'icon sm', `New ${g.label}`)
  return {
    el: el('div', { class: 'gen-row' }, [el('span', { class: 'gen-label', text: g.label }), valueBtn, refresh]),
    regenerate: set,
    current: () => value,
  }
}

interface RegionPicker {
  el: HTMLSelectElement
  /** Rebuild the options from a search string, keeping the picked region selected. */
  filter: (query: string) => void
}

/** The region control both surfaces use: a `<select>` over every country that persists the
 *  pick to the shared store before calling `onPick`. The picked region stays listed even
 *  when a search hides it, so the control can never report a region the caller is not
 *  showing. Styling is by class, `full` where the control owns its whole line. */
function regionPicker(region: Region, onPick: (r: Region) => void, cls?: string): RegionPicker {
  let picked = region
  const sel = el('select', { class: cls, 'aria-label': 'Region' }) as HTMLSelectElement
  const labelOf = (r: Region) => REGIONS.find(([v]) => v === r)?.[1] ?? r
  const filter = (query: string) => {
    const q = query.trim().toLowerCase()
    const hits = q ? REGIONS.filter(([v, label]) => v.includes(q) || label.toLowerCase().includes(q)) : REGIONS
    const shown: Array<[Region, string]> = hits.some(([v]) => v === picked) ? hits : [[picked, labelOf(picked)], ...hits]
    sel.replaceChildren(...shown.map(([v, label]) => el('option', { value: v, text: label })))
    sel.value = picked
  }
  sel.addEventListener('change', () => {
    picked = sel.value
    saveRegion(picked)
    onPick(picked)
  })
  filter('')
  return { el: sel, filter }
}

/** Fill the Tools-launcher quick-copy flyout: a full-width region `<select>` above the
 *  value rows. The hover path is where most users meet these generators, so the region has
 *  to be changeable there and not just displayed; the pick persists through the same store
 *  key, so the tool card opens on whatever was chosen here. `onChange` runs after a
 *  re-render, letting the caller re-place a flyout whose height just changed. */
export async function mountQuickCopy(list: HTMLElement, onChange?: () => void): Promise<void> {
  let region = await loadRegion()
  const rows = () => generatorsFor(region).map((g) => generatorRow(g).el)
  const picker = regionPicker(
    region,
    (r) => {
      region = r
      list.replaceChildren(picker.el, ...rows())
      onChange?.()
    },
    'full',
  )
  list.replaceChildren(picker.el, ...rows())
}

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    let region = await loadRegion()
    const search = el('input', { type: 'search', 'aria-label': 'Search region', autocomplete: 'off' }) as HTMLInputElement
    const list = el('div', { class: 'stack' })
    const build = () => {
      const defs = generatorsFor(region)
      const rows = defs.map((g) => generatorRow(g, ctx.clipboard.write))
      list.replaceChildren(
        el('div', { class: 'row' }, [
          button('🔄 Regenerate all', () => rows.forEach((r) => r.regenerate()), 'ghost', 'Refresh every value'),
          button(
            'Copy all',
            () => void copyText(rows.map((r, i) => `${defs[i].label}: ${r.current()}`).join('\n'), ctx.clipboard.write),
            'ghost',
            'Copy every value as "label: value"',
          ),
        ]),
        ...rows.map((r) => r.el),
      )
    }
    // The card holds exactly one <select>, the region one; the search box beside it filters
    // that select's options rather than adding a second control.
    const picker = regionPicker(region, (r) => {
      region = r
      picker.filter(search.value)
      build()
    })
    search.addEventListener('input', () => picker.filter(search.value))

    container.append(
      el('div', { class: 'row gap' }, [
        el('label', { class: 'row' }, [el('span', { text: 'Region' }), picker.el]),
        el('label', { class: 'row' }, [el('span', { class: 'muted', text: 'Search' }), search]),
      ]),
      list,
      el('div', {
        class: 'muted small',
        text: 'Hover "Generators" in the Tools menu to copy these values and switch region without opening a card. Everything is generated locally; IDs are valid-format test data, not real registrations.',
      }),
    )
    build()
  },
}

export default tool
