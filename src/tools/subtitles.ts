// Local subtitle toolkit: parse, convert and retime SRT / WebVTT / plain transcript.
// Pure computation on a file the user already has, with no network at all.
//
// It deliberately does NOT fetch subtitles from YouTube. That needs a server: the
// timedtext endpoint answers with an empty body unless it is given player parameters
// that exist only inside the watch page, and the watch page sends no CORS headers, so
// no client-only app can read either one. Retiming and converting a file you already
// downloaded is the half that does work in a browser, and it is the half that breaks
// most often in practice.

import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

// ---------------------------------------------------------------- model

export interface Cue {
  /** WebVTT cue identifier, kept only when it carries meaning. SRT numbering is dropped:
   *  it is frequently absent, duplicated or non-sequential, and is regenerated on write. */
  id?: string
  start: number // ms
  end: number // ms
  settings?: string // WebVTT cue settings that trail the timing line (align, line, position)
  text: string // may contain newlines
}

export interface ParseIssue {
  line: number // 1-based, into the input the user pasted
  reason: string
  raw: string
}

export interface Parsed {
  format: 'srt' | 'vtt' | 'unknown'
  cues: Cue[]
  issues: ParseIssue[]
}

const SEP = '-->' // the cue timing separator, identical in both formats
const MAX_CHARS = 8_000_000 // a 2-hour subtitle file is well under 200 KB

// ---------------------------------------------------------------- timestamps

// Hours are optional (WebVTT allows MM:SS.mmm), and the fraction separator is a comma in
// SRT and a dot in WebVTT. Both are accepted on read; the writer picks the correct one.
const TS_RE = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/

export function parseTimestamp(raw: string): number | null {
  const m = TS_RE.exec(raw.trim())
  if (!m) return null
  const mins = Number(m[2])
  const secs = Number(m[3])
  if (mins > 59 || secs > 59) return null
  const hours = m[1] ? Number(m[1]) : 0
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0
  return ((hours * 60 + mins) * 60 + secs) * 1000 + frac
}

export function formatTimestamp(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms))
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)}${sep}${p(t % 1000, 3)}`
}

/** Human duration for the report, e.g. "1h 04m 12s" or "8.4s". */
export function humanDuration(ms: number): string {
  const t = Math.max(0, ms)
  if (t < 60_000) return `${(t / 1000).toFixed(1)}s`
  const s = Math.round(t / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  return `${h ? `${h}h ` : ''}${h ? String(m).padStart(2, '0') : m}m ${String(s % 60).padStart(2, '0')}s`
}

// ---------------------------------------------------------------- parse

export function parseSubtitles(input: string): Parsed {
  const lines = input
    .slice(0, MAX_CHARS)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const issues: ParseIssue[] = []
  const cues: Cue[] = []
  let format: Parsed['format'] = 'unknown'
  let head = 0

  if (/^WEBVTT/.test(lines[0] ?? '')) {
    format = 'vtt'
    while (head < lines.length && lines[head].trim() !== '') head++ // the header block ends at the first blank line
    // NOTE / STYLE / REGION blocks carry no cue. Blanked in place rather than removed, so
    // the line numbers reported back to the user still point at their own file.
    for (let i = head; i < lines.length; i++) {
      if (!/^(NOTE|STYLE|REGION)\b/.test(lines[i].trim())) continue
      while (i < lines.length && lines[i].trim() !== '') lines[i++] = ''
    }
  }

  // Cues are located by scanning for timing lines, not by splitting the file on blank
  // lines. A missing blank line between two cues is exactly the breakage this tool exists
  // to diagnose, and block splitting swallows it into the previous cue's text.
  const times: number[] = []
  for (let i = head; i < lines.length; i++) if (lines[i].includes(SEP)) times.push(i)
  if (!times.length) {
    if (input.trim()) {
      issues.push({ line: head + 1, reason: 'no cue timings found, so this is neither SRT nor WebVTT', raw: (lines[head] ?? '').slice(0, 60) })
    }
    return { format, cues, issues }
  }
  if (format === 'unknown') format = 'srt'

  /** The identifier line, if any, is the single non-blank line directly above a timing line. */
  const idAt = (t: number) => (t - 1 >= head && lines[t - 1].trim() !== '' && !lines[t - 1].includes(SEP) ? lines[t - 1].trim() : '')

  for (let k = 0; k < times.length; k++) {
    const t = times[k]
    const idRaw = idAt(t)

    if (k === 0) {
      const junk = lines.slice(head, t - (idRaw ? 1 : 0)).filter((l) => l.trim() !== '')
      if (junk.length) issues.push({ line: head + 1, reason: 'text before the first cue, ignored', raw: junk[0].slice(0, 60) })
    }

    const [rawStart, ...restParts] = lines[t].split(SEP)
    const rest = restParts.join(SEP).trim()
    const endMatch = /^(\S+)(?:\s+(.*))?$/.exec(rest)
    const start = parseTimestamp(rawStart)
    const end = endMatch ? parseTimestamp(endMatch[1]) : null
    if (start == null || end == null) {
      issues.push({ line: t + 1, reason: 'unreadable timestamp, cue dropped', raw: lines[t].trim().slice(0, 60) })
      continue
    }

    // The text runs to the next timing line, minus that cue's own identifier line.
    let stop = k + 1 < times.length ? times[k + 1] : lines.length
    if (k + 1 < times.length && idAt(times[k + 1])) stop -= 1
    const body = lines.slice(t + 1, Math.max(t + 1, stop))
    while (body.length && body[body.length - 1].trim() === '') body.pop()
    const text = body.join('\n').trim()

    if (!text) issues.push({ line: t + 1, reason: 'cue has no text', raw: lines[t].trim().slice(0, 60) })
    if (end < start) issues.push({ line: t + 1, reason: 'cue ends before it starts', raw: lines[t].trim().slice(0, 60) })
    const prev = cues[cues.length - 1]
    if (prev && start < prev.start) issues.push({ line: t + 1, reason: 'cue starts before the previous one', raw: lines[t].trim().slice(0, 60) })

    cues.push({
      // A bare number is SRT sequencing, not an identifier, so it is discarded and rewritten.
      id: idRaw && !/^\d+$/.test(idRaw) ? idRaw : undefined,
      start,
      end,
      settings: endMatch?.[2]?.trim() || undefined,
      text,
    })
  }
  return { format, cues, issues }
}

// ---------------------------------------------------------------- write

export function toSrt(cues: Cue[]): string {
  if (!cues.length) return ''
  // Renumbered from 1 whatever the input said: SRT numbering is not reliably present.
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} ${SEP} ${formatTimestamp(c.end, ',')}\n${stripCueTags(c.text, false)}`).join('\n\n') + '\n'
}

export function toVtt(cues: Cue[]): string {
  if (!cues.length) return 'WEBVTT\n'
  const blocks = cues.map((c) => {
    const head = `${formatTimestamp(c.start, '.')} ${SEP} ${formatTimestamp(c.end, '.')}${c.settings ? ` ${c.settings}` : ''}`
    return `${c.id ? `${c.id}\n` : ''}${head}\n${c.text}`
  })
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

/** Plain transcript: no timings, no markup, one line per cue. */
export function toTranscript(cues: Cue[]): string {
  if (!cues.length) return ''
  return (
    cues
      .map((c) => stripCueTags(c.text, true).replace(/\n/g, ' '))
      .filter(Boolean)
      .join('\n') + '\n'
  )
}

// ---------------------------------------------------------------- transforms

/** Inline markup: WebVTT/SRT tags, timestamp tags, and ASS override blocks such as {\an8}. */
export function stripCueTags(s: string, on = true): string {
  if (!on) return s
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\{\s*\\?[a-zA-Z][^}]*\}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => l !== '' || i === a.length - 1)
    .join('\n')
    .trim()
}

/** Move every cue by `ms`, clamped at zero so a negative shift cannot invent a negative time. */
export function shiftCues(cues: Cue[], ms: number): Cue[] {
  return cues.map((c) => ({ ...c, start: Math.max(0, c.start + ms), end: Math.max(0, c.end + ms) }))
}

/** Multiply every time by `factor`, for a frame-rate mismatch (23.976 against 25 and friends). */
export function scaleCues(cues: Cue[], factor: number): Cue[] {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return cues
  return cues.map((c) => ({ ...c, start: Math.round(c.start * factor), end: Math.round(c.end * factor) }))
}

const MERGE_GAP_MS = 1500 // silence longer than this is a real pause, not a split
const MERGE_MAX_MS = 12_000 // never build a cue that hangs on screen forever
const MERGE_MAX_CHARS = 200
// A sentence that is finished, allowing one closing quote or bracket after the stop.
const SENTENCE_END = /[.!?\u2026][")\]\u201d\u2019]?$/

/** Join a cue into the next one when the first ends mid-sentence. */
export function mergeSplitCues(cues: Cue[]): Cue[] {
  const out: Cue[] = []
  for (const cue of cues) {
    const prev = out[out.length - 1]
    const flat = (s: string) => s.replace(/\n/g, ' ').trim()
    const joinable =
      prev &&
      prev.text &&
      cue.text &&
      !SENTENCE_END.test(flat(prev.text)) &&
      !/^[-\u2013\u2014]/.test(flat(cue.text)) && // a leading dash marks a new speaker
      cue.start - prev.end <= MERGE_GAP_MS &&
      cue.end - prev.start <= MERGE_MAX_MS &&
      flat(prev.text).length + flat(cue.text).length + 1 <= MERGE_MAX_CHARS
    if (joinable) {
      prev.end = cue.end
      prev.text = `${flat(prev.text)} ${flat(cue.text)}`
    } else {
      out.push({ ...cue })
    }
  }
  return out
}

// ---------------------------------------------------------------- UI

type Fmt = 'srt' | 'vtt' | 'txt'
const EXT: Record<Fmt, string> = { srt: 'srt', vtt: 'vtt', txt: 'txt' }
const MIME: Record<Fmt, string> = { srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain' }

// label, source fps, target fps. A file authored for `src` and played against `dst` runs
// at src/dst of its original rate, so that ratio is the factor.
const RATES: Array<[string, number, number]> = [
  ['Keep the timings as they are', 1, 1],
  ['23.976 fps file, 25 fps video', 23.976, 25],
  ['25 fps file, 23.976 fps video', 25, 23.976],
  ['24 fps file, 25 fps video', 24, 25],
  ['25 fps file, 24 fps video', 25, 24],
  ['23.976 fps file, 24 fps video', 23.976, 24],
  ['24 fps file, 23.976 fps video', 24, 23.976],
  ['29.97 fps file, 30 fps video', 29.97, 30],
  ['30 fps file, 29.97 fps video', 30, 29.97],
]

// Per-card state, keyed by the container: launchTool shares one cached ToolModule across
// every open card, so a module-level object URL would be revoked by whichever card closed
// first and would break the download link in the others.
const state = new WeakMap<HTMLElement, { url: string | null }>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    const own = { url: null as string | null }
    state.set(container, own)

    const input = el('textarea', { class: 'full subs-in', rows: '8', placeholder: 'Paste an SRT or WebVTT file here, or load one from disk' }) as HTMLTextAreaElement
    const file = el('input', { type: 'file', class: 'hidden subs-file', accept: '.srt,.vtt,.txt,text/plain,text/vtt' }) as HTMLInputElement

    const fmt = el('select', { class: 'subs-format', title: 'Output format' }) as HTMLSelectElement
    fmt.append(
      el('option', { value: 'srt', text: 'SubRip (.srt)' }),
      el('option', { value: 'vtt', text: 'WebVTT (.vtt)' }),
      el('option', { value: 'txt', text: 'Plain transcript (.txt)' }),
    )

    const offset = el('input', {
      type: 'number',
      step: '0.001',
      value: '0',
      class: 'mono-input subs-offset',
      title: 'Seconds to add to every cue, negative to pull earlier',
    }) as HTMLInputElement
    const rate = el('select', { class: 'subs-rate', title: 'Frame-rate mismatch preset' }) as HTMLSelectElement
    rate.append(...RATES.map(([label], i) => el('option', { value: String(i), text: label })))
    const factor = el('input', { type: 'number', step: '0.000001', value: '1', class: 'mono-input subs-factor', title: 'Multiply every timing by this' }) as HTMLInputElement

    const stripBox = el('input', { type: 'checkbox', class: 'subs-strip' }) as HTMLInputElement
    const mergeBox = el('input', { type: 'checkbox', class: 'subs-merge' }) as HTMLInputElement

    const report = el('div', { class: 'muted small subs-report', text: 'Load or paste a file, then convert.' })
    const issues = el('div', { class: 'stack subs-issues' })
    const out = el('textarea', { class: 'full subs-out', rows: '10', readonly: 'readonly', placeholder: 'The converted file appears here' }) as HTMLTextAreaElement
    const dl = el('a', { class: 'small hidden subs-download', download: 'subtitles.srt', text: '💾 Download' }) as HTMLAnchorElement
    let base = 'subtitles' // file name stem, taken from a loaded file

    const setDownload = (text: string, kind: Fmt) => {
      if (own.url) URL.revokeObjectURL(own.url) // the previous link is gone from the DOM already
      own.url = text ? URL.createObjectURL(new Blob([text], { type: MIME[kind] })) : null
      dl.classList.toggle('hidden', !own.url)
      if (own.url) {
        dl.href = own.url
        dl.download = `${base}.${EXT[kind]}`
      } else {
        dl.removeAttribute('href')
      }
    }

    const run = () => {
      const parsed = parseSubtitles(input.value)
      let cues = parsed.cues
      const f = Number(factor.value)
      // Rescale first, then shift: a frame-rate error is multiplicative on the original
      // timeline, while an offset is a constant on the timeline you end up watching.
      cues = scaleCues(cues, Number.isFinite(f) && f > 0 ? f : 1)
      const secs = Number(offset.value)
      if (Number.isFinite(secs) && secs !== 0) cues = shiftCues(cues, Math.round(secs * 1000))
      if (stripBox.checked) cues = cues.map((c) => ({ ...c, text: stripCueTags(c.text) }))
      if (mergeBox.checked) cues = mergeSplitCues(cues)

      const kind = fmt.value as Fmt
      const text = kind === 'srt' ? toSrt(cues) : kind === 'vtt' ? toVtt(cues) : toTranscript(cues)
      out.value = text
      setDownload(text, kind)

      const last = cues.reduce((m, c) => Math.max(m, c.end), 0)
      const spoken = cues.reduce((s, c) => s + Math.max(0, c.end - c.start), 0)
      const src = parsed.format === 'vtt' ? 'WebVTT' : parsed.format === 'srt' ? 'SubRip' : 'unrecognised'
      report.textContent = cues.length
        ? `${cues.length} cues read as ${src}. Ends at ${formatTimestamp(last, '.')}, ${humanDuration(spoken)} of cue time.`
        : `No cues found. Read as ${src}.`
      issues.replaceChildren(
        ...(parsed.issues.length
          ? [
              el('div', { class: 'group-label', text: `${parsed.issues.length} problem${parsed.issues.length === 1 ? '' : 's'} in the source` }),
              ...parsed.issues.slice(0, 25).map((i) => el('div', { class: 'small subs-issue', text: `line ${i.line}: ${i.reason}${i.raw ? ` (${i.raw})` : ''}` })),
            ]
          : []),
      )
    }

    file.addEventListener('change', () => {
      const f = file.files?.[0]
      file.value = ''
      if (!f) return
      void (async () => {
        try {
          input.value = (await f.text()).slice(0, MAX_CHARS)
          base = f.name.replace(/\.[^.]+$/, '') || 'subtitles'
          run()
        } catch (e) {
          report.textContent = `Could not read the file: ${(e as Error).message}`
        }
      })()
    })
    rate.addEventListener('change', () => {
      const [, src, dst] = RATES[Number(rate.value)] ?? RATES[0]
      factor.value = String(Number((src / dst).toFixed(6)))
      run()
    })
    for (const c of [fmt, offset, factor, stripBox, mergeBox]) c.addEventListener('change', run)

    container.append(
      el('div', { class: 'group-label', text: 'Source' }),
      input,
      el('div', { class: 'row' }, [
        button('Load a file', () => file.click(), 'ghost', 'Read an SRT or WebVTT file from this device'),
        button(
          'Clear',
          () => {
            input.value = ''
            out.value = ''
            base = 'subtitles'
            setDownload('', fmt.value as Fmt)
            issues.replaceChildren()
            report.textContent = 'Load or paste a file, then convert.'
          },
          'ghost',
          'Empty both boxes',
        ),
        file,
      ]),
      el('div', { class: 'group-label', text: 'Output' }),
      el('div', { class: 'row' }, [
        el('label', { class: 'row' }, [el('span', { class: 'small', text: 'Format' }), fmt]),
        el('label', { class: 'row' }, [el('span', { class: 'small', text: 'Shift (s)' }), offset]),
        el('label', { class: 'row' }, [el('span', { class: 'small', text: 'Factor' }), factor]),
      ]),
      el('div', { class: 'row' }, [el('label', { class: 'row' }, [el('span', { class: 'small', text: 'Frame rate' }), rate])]),
      el('div', { class: 'row' }, [
        el('label', { class: 'row' }, [stripBox, el('span', { class: 'small', text: 'Strip formatting tags' })]),
        el('label', { class: 'row' }, [mergeBox, el('span', { class: 'small', text: 'Merge cues split mid-sentence' })]),
      ]),
      el('div', { class: 'row' }, [button('Convert', run, 'primary', 'Parse, retime and rewrite'), copyButton(() => out.value, ctx.clipboard.write), dl]),
      report,
      issues,
      out,
    )
  },

  deactivate(container: HTMLElement) {
    const own = state.get(container)
    if (own?.url) URL.revokeObjectURL(own.url)
    state.delete(container)
  },
}

export default tool
