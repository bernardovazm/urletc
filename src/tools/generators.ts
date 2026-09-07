// Dev generators. Values are generated on render, a click copies one, 🔄 regenerates a
// single row. National IDs carry valid check digits and card numbers pass Luhn.
//
// Only regions with curated name, phone and ID pools are selectable. Every ISO 3166-1
// country used to be listed, so picking China returned an international-pool name. Adding
// a region means adding its pools below rather than adding a code here.
//
// Both surfaces (the tool card and the Tools-launcher flyout) read and write one store key,
// `gen-region`, so they cannot disagree.

import { getItem, setItem } from '../core/store'
import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyText, el } from '../shell/ui'

/** An ISO 3166-1 alpha-2 code lowercased, `uk` for the United Kingdom, or `intl`. */
export type Region = string
/** The regions with curated pools, which is exactly the set the picker offers. */
type CuratedRegion = 'intl' | 'br' | 'us' | 'uk' | 'de' | 'fr' | 'jp' | 'mx'
const CURATED: readonly CuratedRegion[] = ['intl', 'br', 'us', 'uk', 'de', 'fr', 'jp', 'mx']
const isCurated = (r: string): r is CuratedRegion => (CURATED as readonly string[]).includes(r)

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
// E.164 dialling codes for the curated regions only. This used to carry every ISO 3166-1
// code and double as the country list, which is what let the picker offer 250 countries
// that had no name or ID pools behind them. Display names come from Intl.DisplayNames and
// flags are derived arithmetically, so no name or flag table is shipped.
const DIAL: Record<string, string> = { br: '55', gb: '44', de: '49', fr: '33', jp: '81', mx: '52', us: '1' }
// The curated UK pool is keyed 'uk' and that value is already persisted for anyone who
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

/** The region's own national IDs first, then people and contact formats, then the shared
 *  universals, then other regions' IDs under their flag. The national ID leads because it
 *  is the value this tool gets opened for; burying CPF under five contact rows put the
 *  most-wanted field furthest from the top. */
export function generatorsFor(region: Region): Generator[] {
  const list: Generator[] = []
  for (const [r, ids] of NATIONAL_IDS) if (r === region) list.push(...ids)
  list.push(
    { label: 'Name', gen: () => fullName(region) },
    { label: 'Email', gen: () => email(region) },
    { label: 'Username', gen: () => username(region) },
    { label: 'Phone', gen: () => phone(region) },
    { label: postalLabel(region), gen: () => postal(region) },
  )
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
  const countries = CURATED.filter((c) => c !== 'intl')
    .map((code) => [code, nameOf(code)] as const)
    .sort((a, b) => collator.compare(a[1], b[1]))
    .map(([code, name]): [Region, string] => [code, `${flagOf(code)} ${name}`])
  const home = regionFromLocale()
  return [['intl', '🌍 International'], ...countries.filter(([v]) => v === home), ...countries.filter(([v]) => v !== home)]
}

/** `[value, label]` for every selectable region, localised, detected region pinned first. */
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
      // option key rather than a country.
      if (sub.length === 1) break
      const country = sub === 'gb' ? 'uk' : sub
      if (country.length === 2 && isCurated(country)) return country
    }
    if (lang && byLang[lang]) return byLang[lang]
  }
  return 'intl'
}

/** The persisted region, shared by the tool card and the Tools-launcher hover preview.
 *  Falls back to the browser locale when the user never chose one. */
export async function loadRegion(): Promise<Region> {
  const r = await getItem<Region>(REGION_KEY)
  return r && isCurated(r) ? r : regionFromLocale()
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

/** The region control both surfaces use. Persists the pick to the shared store before
 *  calling `onPick`. Styling is by class, `full` where the control owns its whole line. */
function regionPicker(region: Region, onPick: (r: Region) => void, cls?: string): HTMLSelectElement {
  const sel = el('select', { class: cls, 'aria-label': 'Region' }) as HTMLSelectElement
  sel.replaceChildren(...REGIONS.map(([v, label]) => el('option', { value: v, text: label })))
  sel.value = region
  sel.addEventListener('change', () => {
    saveRegion(sel.value)
    onPick(sel.value)
  })
  return sel
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
      list.replaceChildren(picker, ...rows())
      onChange?.()
    },
    'full',
  )
  list.replaceChildren(picker, ...rows())
}

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    let region = await loadRegion()
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
    const picker = regionPicker(region, (r) => {
      region = r
      build()
    })

    container.append(el('div', { class: 'row gap' }, [el('label', { class: 'row' }, [el('span', { text: 'Region' }), picker])]), list)
    build()
  },
}

export default tool
