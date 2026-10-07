// Shared whiteboard over the room `game` channel (session.ts). Every connected peer
// sees one document and draws or types on it at the same time, and a peer opening the
// tool later receives the full document through hello and state messages. Transport
// encrypted by the room password like media, and the payloads carry only coordinates.

// The document is module-level and shared by every open card on the page, while each
// card keeps its own canvas, toolbar state, listeners and poll in a WeakMap entry.
// launchTool caches this module, so a module-level canvas or timer would let a second
// card clobber the first.

import { getAllSessions, type RoomSession } from '../p2p/session'
import type { ToolModule } from '../shell/registry'
import { button, el } from '../shell/ui'
import { addGameHandler } from './room-handlers'

type StrokeOp = { id: string; kind: 'stroke'; color: string; width: number; pts: number[] }
type TextOp = { id: string; kind: 'text'; color: string; size: number; x: number; y: number; text: string }
type Op = StrokeOp | TextOp

const MAX_OPS = 3000
const MAX_PTS = 1200 // flat numbers, meaning 600 points per stroke
const MAX_TEXT = 300
const MAX_ID = 40
const STATE_BATCH = 100
const SEND_MS = 80
const COLOR_RE = /^#[0-9a-f]{6}$/i
const MIN_WIDTH = 0.001
const MAX_WIDTH = 0.05
const MIN_SIZE = 0.01
const MAX_SIZE = 0.2

const COLORS: Array<{ name: string; hex: string }> = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Red', hex: '#ff3b30' },
  { name: 'Orange', hex: '#ff9500' },
  { name: 'Yellow', hex: '#ffcc00' },
  { name: 'Green', hex: '#34c759' },
  { name: 'Blue', hex: '#0a84ff' },
]
// One background for every viewer whatever their theme: a stroke is stored as a colour,
// and a white stroke drawn on a dark board would vanish on a peer with a light one.
const BOARD_BG = '#111315'

const SIZES: Record<string, { width: number; size: number }> = {
  thin: { width: 0.004, size: 0.035 },
  medium: { width: 0.008, size: 0.05 },
  thick: { width: 0.014, size: 0.075 },
}

// The shared document. Authors are transport peer ids, recorded when an op arrives,
// never a field in the payload. Ops drawn here are authored by SELF, which no peer id
// equals, so a peer can never remove or rewrite them.
const SELF = 'self'
const ops = new Map<string, Op>()
const authors = new Map<string, string>()
let epoch = 0
let maxSeen = 0
const redraws = new Set<() => void>()
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const round3 = (v: number) => Math.round(v * 1000) / 1000
const newId = () => Math.random().toString(36).slice(2, 10)
// Repaints are coalesced to one per frame: a burst of inbound ops would otherwise repaint
// the whole document once per message.
let paintQueued = false
const notify = () => {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => {
    paintQueued = false
    for (const f of [...redraws]) {
      try {
        f()
      } catch {
        // one card failing to paint must not stop the others
      }
    }
  })
}

function validEpoch(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** Fold an inbound epoch in. Clears the local document when the peer is newer. */
function adoptEpoch(e: number): 'old' | 'same' | 'new' {
  if (e > maxSeen) maxSeen = e
  if (e < epoch) return 'old'
  if (e > epoch) {
    ops.clear()
    authors.clear()
    epoch = e
    return 'new'
  }
  return 'same'
}

function sanitizeOp(v: unknown): Op | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length < 1 || r.id.length > MAX_ID) return null
  if (typeof r.color !== 'string' || !COLOR_RE.test(r.color)) return null
  if (r.kind === 'stroke') {
    const w = Number(r.width)
    if (!Number.isFinite(w)) return null
    // Over the cap is refused, not truncated: an honest client never sends more, and a
    // truncated copy would differ from what its author sees.
    if (!Array.isArray(r.pts) || r.pts.length < 2 || r.pts.length % 2 !== 0 || r.pts.length > MAX_PTS) return null
    const pts: number[] = []
    for (let i = 0; i < r.pts.length; i++) {
      const c = Number(r.pts[i])
      if (!Number.isFinite(c)) return null
      pts.push(clamp(c, 0, 1))
    }
    return { id: r.id, kind: 'stroke', color: r.color.toLowerCase(), width: clamp(w, MIN_WIDTH, MAX_WIDTH), pts }
  }
  if (r.kind === 'text') {
    const x = Number(r.x)
    const y = Number(r.y)
    const s = Number(r.size)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(s)) return null
    if (typeof r.text !== 'string' || r.text.length < 1 || r.text.length > MAX_TEXT) return null
    return {
      id: r.id,
      kind: 'text',
      color: r.color.toLowerCase(),
      size: clamp(s, MIN_SIZE, MAX_SIZE),
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      text: r.text,
    }
  }
  return null
}

/** Insert an op from a peer, dropping the oldest when the document is full. */
function storeRemote(op: Op, from: string): void {
  if (!ops.has(op.id)) {
    ops.set(op.id, op)
    authors.set(op.id, from)
    while (ops.size > MAX_OPS) {
      const oldest = ops.keys().next().value
      if (oldest === undefined) break
      ops.delete(oldest)
      authors.delete(oldest)
    }
  } else {
    ops.set(op.id, op)
  }
}

const broadcast = (payload: unknown) => {
  for (const s of getAllSessions()) {
    try {
      s.sendGame(payload)
    } catch {
      // a departing session must not break the send to the rest
    }
  }
}

const sendTargeted = (peerId: string, payload: unknown) => {
  for (const s of getAllSessions()) {
    try {
      s.sendGame(payload, peerId)
    } catch {
      // same as above
    }
  }
}

function sendState(target?: string): void {
  // Each op names the device that drew it (`by`, absent for this device's own), so a peer
  // that learns a mark through a third device still lets only its author change it.
  const all = [...ops.values()].map((op) => {
    const a = authors.get(op.id)
    return a && a !== SELF ? { ...op, by: a } : op
  })
  if (!all.length) return
  for (let i = 0; i < all.length; i += STATE_BATCH) {
    const payload = { t: 'board-state', epoch, ops: all.slice(i, i + STATE_BATCH) }
    if (target) sendTargeted(target, payload)
    else broadcast(payload)
  }
}

/** Remove my own most recent op. Returns the removed id, if any. */
function undoOwn(): string | null {
  let last: string | null = null
  for (const [id, a] of authors) if (a === SELF) last = id
  if (!last) return null
  ops.delete(last)
  authors.delete(last)
  broadcast({ t: 'board-del', epoch, id: last })
  notify()
  return last
}

function onGame(payload: unknown, from: string): void {
  try {
    if (!payload || typeof payload !== 'object') return
    const m = payload as Record<string, unknown>
    if (typeof m.t !== 'string' || !m.t.startsWith('board-')) return
    switch (m.t) {
      case 'board-hello': {
        const e = validEpoch(m.epoch)
        if (e === null) return
        // Read only: a hello carries no content, so it must not clear anything here.
        if (e > maxSeen) maxSeen = e
        // The sender is past a clear this device missed: say hello back, and its answer
        // (its state, or the clear repeated) carries the newer epoch here.
        if (e > epoch) {
          sendTargeted(from, { t: 'board-hello', epoch })
          return
        }
        if (ops.size > 0) sendState(from)
        // An empty board after a clear sends no state, so the clear itself is repeated to a
        // peer still holding marks from before it.
        else if (epoch > e) sendTargeted(from, { t: 'board-clear', epoch })
        notify()
        return
      }
      case 'board-state': {
        const e = validEpoch(m.epoch)
        if (e === null || !Array.isArray(m.ops) || m.ops.length > STATE_BATCH) return
        if (adoptEpoch(e) === 'old') {
          // The sender holds marks from before a clear it missed; tell it.
          sendTargeted(from, { t: 'board-clear', epoch })
          return
        }
        for (const raw of m.ops) {
          const o = sanitizeOp(raw)
          if (!o) continue
          const by = (raw as { by?: unknown }).by
          // A relayed author is a peer id; SELF names this device and is never accepted from
          // outside, or a peer could plant marks that this device's Undo treats as its own.
          const author = typeof by === 'string' && by.length > 0 && by.length <= MAX_ID && by !== SELF ? by : from
          // Taken when new; an op already held changes only when its author sends it.
          if (!ops.has(o.id)) {
            ops.set(o.id, o)
            authors.set(o.id, author)
          } else if (authors.get(o.id) === author && author === from) {
            ops.set(o.id, o)
          }
        }
        while (ops.size > MAX_OPS) {
          const oldest = ops.keys().next().value
          if (oldest === undefined) break
          ops.delete(oldest)
          authors.delete(oldest)
        }
        notify()
        return
      }
      case 'board-op': {
        const e = validEpoch(m.epoch)
        if (e === null) return
        if (adoptEpoch(e) === 'old') return
        const o = sanitizeOp(m.op)
        if (!o) return
        const cur = authors.get(o.id)
        if (cur !== undefined && cur !== from) return
        storeRemote(o, from)
        notify()
        return
      }
      case 'board-del': {
        const e = validEpoch(m.epoch)
        if (e === null || typeof m.id !== 'string') return
        if (adoptEpoch(e) === 'old') return
        if (authors.get(m.id) === from) {
          ops.delete(m.id)
          authors.delete(m.id)
          notify()
        }
        return
      }
      case 'board-clear': {
        const e = validEpoch(m.epoch)
        if (e === null) return
        if (e < epoch) return
        if (e > maxSeen) maxSeen = e
        ops.clear()
        authors.clear()
        epoch = e
        notify()
        return
      }
    }
  } catch {
    // inbound payloads are untrusted and must never throw
  }
}

// One subscription per session for the whole page, held while any card is open. Each card
// subscribing on its own registered the same onGame twice, which the fan-out stores once,
// so closing one card unsubscribed the board and left the other card deaf.
const gameSubs = new Map<RoomSession, () => void>()
let openCards = 0
const syncHandlers = () => {
  const live = getAllSessions()
  for (const [s, off] of gameSubs) {
    if (live.includes(s) && openCards > 0) continue
    off()
    gameSubs.delete(s)
  }
  if (openCards > 0) for (const s of live) if (!gameSubs.has(s)) gameSubs.set(s, addGameHandler(s, onGame))
}

const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement) {
    container.replaceChildren()
    let poll = 0
    let mode: 'pen' | 'text' = 'pen'
    let color = COLORS[0].hex
    let sizeKey = 'medium'
    let drawing: { id: string; op: StrokeOp; epoch: number; pointer: number } | null = null
    let lastSent = 0
    let textInput: HTMLInputElement | null = null
    let armed = false
    let armTimer = 0
    const seen = new Set<string>()

    const status = el('div', { class: 'muted small' })
    const penBtn = button('Pen', () => setMode('pen'), '', 'Draw strokes')
    const textBtn = button('Text', () => setMode('text'), '', 'Write text on the board')
    const swatches = COLORS.map((c) => {
      const b = button('', () => setColor(c.hex), 'icon board-swatch', c.name)
      b.style.backgroundColor = c.hex
      return b
    })
    const sizeSel = el('select', { 'aria-label': 'Stroke size' }, [
      el('option', { value: 'thin', text: 'Thin' }),
      el('option', { value: 'medium', text: 'Medium' }),
      el('option', { value: 'thick', text: 'Thick' }),
    ]) as HTMLSelectElement
    sizeSel.value = sizeKey
    const undoBtn = button(
      'Undo',
      () => {
        disarmClear()
        undoOwn()
      },
      '',
      'Undo your last mark',
    )
    const clearBtn = button('Clear board', () => onClear(), '', 'Clear the board for everyone')
    clearBtn.setAttribute('aria-pressed', 'false')
    const saveBtn = button('Save PNG', () => onSave(), '', 'Save the board as a PNG file')
    const tools = el('div', { class: 'board-tools' }, [penBtn, textBtn, ...swatches, sizeSel, undoBtn, clearBtn, saveBtn])
    const canvas = el('canvas', { class: 'board' }) as HTMLCanvasElement
    const wrap = el('div', { class: 'board-wrap' }, [canvas])
    container.append(tools, wrap, status)

    const setMode = (m: 'pen' | 'text') => {
      mode = m
      penBtn.setAttribute('aria-pressed', String(m === 'pen'))
      textBtn.setAttribute('aria-pressed', String(m === 'text'))
    }
    const setColor = (hex: string) => {
      color = hex
      swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(COLORS[i].hex === hex)))
    }
    setMode('pen')
    setColor(color)

    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round((rect.height > 0 ? rect.height : rect.width * 0.625) * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const g = canvas.getContext('2d')
      if (!g) return
      g.fillStyle = BOARD_BG
      g.fillRect(0, 0, canvas.width, canvas.height)
      for (const op of ops.values()) {
        if (op.kind === 'stroke') {
          if (op.pts.length === 2) {
            g.fillStyle = op.color
            g.beginPath()
            g.arc(op.pts[0] * canvas.width, op.pts[1] * canvas.height, Math.max(1, (op.width * canvas.width) / 2), 0, Math.PI * 2)
            g.fill()
          } else if (op.pts.length >= 4) {
            g.strokeStyle = op.color
            g.lineWidth = Math.max(1, op.width * canvas.width)
            g.lineCap = 'round'
            g.lineJoin = 'round'
            g.beginPath()
            g.moveTo(op.pts[0] * canvas.width, op.pts[1] * canvas.height)
            for (let i = 2; i + 1 < op.pts.length; i += 2) g.lineTo(op.pts[i] * canvas.width, op.pts[i + 1] * canvas.height)
            g.stroke()
          }
        } else {
          g.fillStyle = op.color
          const px = Math.max(1, op.size * canvas.height)
          g.font = `${px}px system-ui, sans-serif`
          g.textBaseline = 'middle'
          // Wrapped at the board's right edge on every viewer, so a long line is read in
          // full instead of cut off past the canvas.
          const room = Math.max(px * 4, canvas.width * (1 - op.x) - px * 0.5)
          let line = ''
          let row = 0
          const put = (t: string) => g.fillText(t, op.x * canvas.width, op.y * canvas.height + row++ * px * 1.2)
          for (const word of op.text.split(' ')) {
            const next = line ? `${line} ${word}` : word
            if (line && g.measureText(next).width > room) {
              put(line)
              line = word
            } else line = next
          }
          if (line) put(line)
        }
      }
      canvas.setAttribute('data-ops', String(ops.size))
    }
    redraws.add(draw)

    const peers = (): string[] => {
      const out = new Set<string>()
      for (const s of getAllSessions()) {
        if (s.presenceOnly) continue // the online list carries no board messages
        for (const p of s.roster()) {
          if (!p.ready) continue
          out.add(p.peerId)
        }
      }
      return [...out]
    }

    const refreshStatus = () => {
      const n = peers().length
      status.textContent = n > 0 ? `Shared with ${n} ${n === 1 ? 'device' : 'devices'}` : 'Not connected to anyone yet. Marks you make are shared when someone joins.'
    }

    const tick = () => {
      syncHandlers()
      const now = peers()
      for (const id of now) {
        if (!seen.has(id)) {
          seen.add(id)
          sendTargeted(id, { t: 'board-hello', epoch })
        }
      }
      for (const id of [...seen]) if (!now.includes(id)) seen.delete(id)
      refreshStatus()
    }

    const toLocal = (clientX: number, clientY: number): [number, number] => {
      const r = canvas.getBoundingClientRect()
      const fx = r.width > 0 ? (clientX - r.left) / r.width : 0
      const fy = r.height > 0 ? (clientY - r.top) / r.height : 0
      return [round3(clamp(fx, 0, 1)), round3(clamp(fy, 0, 1))]
    }

    // A stroke is sent under the epoch it started in, so one still being drawn when the
    // board is cleared is dropped everywhere, as it is here, instead of surviving on peers.
    const sendOp = (op: Op, at = epoch) => broadcast({ t: 'board-op', epoch: at, op })

    const commitText = () => {
      const input = textInput
      if (!input) return
      const x = Number(input.dataset.bx)
      const y = Number(input.dataset.by)
      const value = input.value
      textInput = null
      input.remove()
      if (!Number.isFinite(x) || !Number.isFinite(y) || value.length < 1) {
        draw()
        return
      }
      const preset = SIZES[sizeKey] ?? SIZES.medium
      const op: TextOp = {
        id: newId(),
        kind: 'text',
        color,
        size: preset.size,
        x: clamp(x, 0, 1),
        y: clamp(y, 0, 1),
        text: value.slice(0, MAX_TEXT),
      }
      ops.set(op.id, op)
      authors.set(op.id, SELF)
      sendOp(op)
      notify()
    }

    const cancelText = () => {
      if (!textInput) return
      textInput = null
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      wrap.querySelectorAll('.board-text-input').forEach((n) => n.remove())
      draw()
    }

    const openText = (x: number, y: number) => {
      if (textInput) return
      const input = el('input', { class: 'board-text-input', type: 'text', maxlength: String(MAX_TEXT), 'aria-label': 'Board text' }) as HTMLInputElement
      input.dataset.bx = String(x)
      input.dataset.by = String(y)
      input.style.left = `${x * 100}%`
      input.style.top = `${y * 100}%`
      // Right of centre the field opens leftward from the point, so it never runs past the
      // board's edge into the clipped feed. The text is still placed at the point pressed.
      if (x > 0.5) input.classList.add('flip')
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commitText()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelText()
        }
      })
      input.addEventListener('blur', () => {
        if (textInput === input) commitText()
      })
      textInput = input
      wrap.append(input)
      input.focus()
    }

    const disarmClear = () => {
      if (!armed) return
      armed = false
      if (armTimer) window.clearTimeout(armTimer)
      armTimer = 0
      clearBtn.textContent = 'Clear board'
      clearBtn.classList.remove('armed')
      clearBtn.setAttribute('aria-pressed', 'false')
    }

    const onClear = () => {
      if (!armed) {
        armed = true
        clearBtn.textContent = 'Click again to clear'
        clearBtn.classList.add('armed')
        clearBtn.setAttribute('aria-pressed', 'true')
        if (armTimer) window.clearTimeout(armTimer)
        armTimer = window.setTimeout(() => disarmClear(), 3000)
        return
      }
      disarmClear()
      if (epoch > maxSeen) maxSeen = epoch
      epoch = maxSeen + 1
      maxSeen = epoch
      ops.clear()
      authors.clear()
      broadcast({ t: 'board-clear', epoch })
      notify()
    }

    const onSave = () => {
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'whiteboard.png'
        document.body.append(a)
        a.click()
        a.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }, 'image/png')
    }

    const onPointerDown = (e: PointerEvent) => {
      if (armed && e.target !== clearBtn) disarmClear()
      if (mode !== 'pen') return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const [x, y] = toLocal(e.clientX, e.clientY)
      if (drawing) return
      const preset = SIZES[sizeKey] ?? SIZES.medium
      const op: StrokeOp = { id: newId(), kind: 'stroke', color, width: preset.width, pts: [x, y] }
      ops.set(op.id, op)
      authors.set(op.id, SELF)
      drawing = { id: op.id, op, epoch, pointer: e.pointerId }
      lastSent = 0
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // capture is best effort; the stroke still completes on pointerup
      }
      notify()
    }

    // Only the pointer that started the stroke extends or ends it: a resting palm or a
    // second finger would otherwise join the line or cut it short.
    const onPointerMove = (e: PointerEvent) => {
      if (!drawing || e.pointerId !== drawing.pointer) return
      const [x, y] = toLocal(e.clientX, e.clientY)
      if (drawing.op.pts.length < MAX_PTS) drawing.op.pts.push(x, y)
      notify()
      const now = performance.now()
      if (now - lastSent >= SEND_MS) {
        lastSent = now
        sendOp({ ...drawing.op, pts: [...drawing.op.pts] }, drawing.epoch)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!drawing || e.pointerId !== drawing.pointer) return
      const { op, epoch: at } = drawing
      drawing = null
      sendOp({ ...op, pts: [...op.pts] }, at)
      notify()
    }

    // Text placement runs on click, not pointerdown: focusing the input during
    // mousedown loses to the browser default focus pass and the input blurs away
    // empty before it is ever seen.
    const onClick = (e: MouseEvent) => {
      if (armed && e.target !== clearBtn) disarmClear()
      if (mode !== 'text') return
      const [x, y] = toLocal(e.clientX, e.clientY)
      openText(x, y)
    }
    const onSize = () => {
      const v = sizeSel.value
      if (SIZES[v]) sizeKey = v
    }
    const onToolsDown = (e: Event) => {
      if (armed && e.target !== clearBtn) disarmClear()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('click', onClick)
    sizeSel.addEventListener('change', onSize)
    tools.addEventListener('pointerdown', onToolsDown)
    const ro = new ResizeObserver(() => draw())
    ro.observe(canvas)
    // A move to a screen with another pixel ratio changes no layout, so the observer stays
    // quiet; the window's resize event does fire.
    window.addEventListener('resize', draw)

    openCards++
    syncHandlers()
    for (const id of peers()) seen.add(id)
    broadcast({ t: 'board-hello', epoch })
    refreshStatus()
    draw()
    poll = window.setInterval(tick, 1000)

    detachers.set(container, () => {
      window.clearInterval(poll)
      ro.disconnect()
      window.removeEventListener('resize', draw)
      redraws.delete(draw)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('click', onClick)
      sizeSel.removeEventListener('change', onSize)
      tools.removeEventListener('pointerdown', onToolsDown)
      if (armTimer) window.clearTimeout(armTimer)
      if (textInput) {
        textInput = null
        wrap.querySelectorAll('.board-text-input').forEach((n) => n.remove())
      }
      drawing = null
      openCards--
      syncHandlers() // the last card to close drops the subscriptions
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
