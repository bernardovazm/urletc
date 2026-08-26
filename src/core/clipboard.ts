// Clipboard content detection + routing (ARCHITECTURE section 4.1). Pure detection logic;
// the actual clipboard *read* goes through ToolContext.clipboard (permission-gated),
// so this module never touches navigator directly. Routing by ClipboardItem.types
// first; text heuristics only for text/plain, capped at the first 10 KB.

export type DetectedKind = 'image' | 'html' | 'json' | 'url' | 'text'

export interface Detected {
  kind: DetectedKind
  mime: string
  text?: string
  blob?: Blob
}

const TEXT_CAP = 10_240
const JSON_CAP = 2_000_000

export async function detectItems(items: ClipboardItem[]): Promise<Detected[]> {
  const out: Detected[] = []
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith('image/'))
    if (imageType) {
      out.push({ kind: 'image', mime: imageType, blob: await item.getType(imageType) })
      continue
    }
    if (item.types.includes('text/html')) {
      out.push({ kind: 'html', mime: 'text/html', text: await (await item.getType('text/html')).text() })
      continue
    }
    if (item.types.includes('text/plain')) {
      out.push(...detectText(await (await item.getType('text/plain')).text()))
    }
  }
  return out
}

export function detectText(full: string): Detected[] {
  const t = full.trim()
  if (!t) return []
  if (isUrl(t)) return [{ kind: 'url', mime: 'text/plain', text: t }]
  if (isJson(t)) return [{ kind: 'json', mime: 'text/plain', text: full }]
  const head = t.slice(0, TEXT_CAP)
  if (/<([a-z][\w-]*)(\s[^>]*)?\/?>/i.test(head) && /<\/?[a-z]/i.test(head)) {
    return [{ kind: 'html', mime: 'text/plain', text: full }]
  }
  return [{ kind: 'text', mime: 'text/plain', text: full }]
}

function isUrl(s: string): boolean {
  if (/\s/.test(s)) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function isJson(s: string): boolean {
  if (!/^[[{]/.test(s) || s.length > JSON_CAP) return false
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

export function kindLabel(kind: DetectedKind): string {
  const labels: Record<DetectedKind, string> = {
    image: '🖼 Image',
    html: '🏷 HTML',
    json: '🧩 JSON',
    url: '🔗 URL',
    text: '📝 Text',
  }
  return labels[kind]
}
