// Multiplayer Pong, a P2P proof-of-concept (ARCHITECTURE sections 5 and 6). Built-in and
// host-realm (NOT a sandboxed Workshop script: the sandbox has no P2P capability by
// design): it plays over the room `game` channel (session.ts). It enumerates every
// authenticated peer across ALL tiers (personal/nearby/code) into a lobby; you invite
// one and they accept (mutual invites fast-start). The peer with the smaller id is the
// physics host (authoritative for ball + score); the other sends its paddle and renders
// host state with light dead-reckoning. Coordinates are normalized 0..1 in a canonical
// space where the host is the LEFT paddle, so both sides agree at any canvas size. Game
// state is transport-encrypted (room password) like media; it carries no secrets.

import { getAllSessions } from '../p2p/session'
import type { ToolModule } from '../shell/registry'
import { button, el } from '../shell/ui'

const PADDLE_X = 0.04 // paddle distance from its wall
const PADDLE_HALF = 0.11 // paddle half-height
const BALL_R = 0.02
const MAX_SPEED = 1.15
const WIN = 7

type Msg =
  | { t: 'invite' | 'accept' | 'decline' | 'cancel' | 'bye' | 'rematch' }
  | { t: 'paddle'; y: number }
  | { t: 'state'; x: number; y: number; vx: number; vy: number; sh: number; sg: number }
  | { t: 'chat'; text: string }

const QUICK_CHAT = ['👋', 'gg', 'nice!', '😂', '😅', '🔥', 'rematch?']
const CHAT_MAX = 80

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** A canvas paints raw colours and cannot inherit a CSS variable, so the board resolves
 *  the live theme tokens instead of hardcoding one theme's palette (it re-reads them on
 *  the `wt:theme` event). Pure, and safe to share across cards. */
const readPalette = () => {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb
  return {
    bg: v('--bg', '#060707'),
    fg: v('--fg', '#ffffff'),
    line: v('--border-strong', '#2a2d2f'),
    dim: v('--fg-dim', '#c4c4c4'),
  }
}

// Per-card teardown, keyed by container: launchTool shares one cached module across all
// open cards, so RAF/interval handles and the teardown closure must be per-activation.
// A module-level handle would let a second card clobber the first's and leak its loop.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement) {
    container.replaceChildren()
    let raf = 0
    let poll = 0

    const status = el('div', { class: 'muted small' })
    const lobbyEl = el('div', { class: 'pong-lobby stack' })
    const scoreEl = el('div', { class: 'pong-score' })
    const canvas = el('canvas', { class: 'pong', width: '640', height: '400' }) as HTMLCanvasElement
    const leaveBtn = button('Leave game', () => leaveGame(), 'ghost', 'Return to the opponent list')
    const rematchBtn = button('Rematch', () => rematch(), 'primary', 'Reset the score and serve again')
    const chatLog = el('div', { class: 'pong-chat-log' })
    const chatInput = el('input', { type: 'text', class: 'full', placeholder: 'Quick message', maxlength: String(CHAT_MAX) }) as HTMLInputElement
    const quickRow = el(
      'div',
      { class: 'row pong-quick' },
      QUICK_CHAT.map((q) => button(q, () => sendChat(q), 'ghost', `Send "${q}"`)),
    )
    const gameEl = el('div', { class: 'stack hidden' }, [
      scoreEl,
      canvas,
      el('div', { class: 'row' }, [leaveBtn, rematchBtn]),
      el('div', { class: 'muted small', text: 'Move with the mouse or a touch on the board, or the arrow keys and W/S once it is focused. First to 7.' }),
      el('div', { class: 'group-label', text: 'Quick chat' }),
      chatLog,
      quickRow,
      chatInput,
    ])
    chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      sendChat(chatInput.value)
      chatInput.value = ''
    })
    container.append(status, lobbyEl, gameEl)

    const g = canvas.getContext('2d')
    if (!g) return

    // --- match state (canonical: host = left paddle) ---
    let opp: string | null = null // opponent peerId while inviting-accepted / playing / over
    let oppName = ''
    let host = false
    let playing = false
    let over = false
    let pendingOut: string | null = null // an invite we sent, awaiting accept
    const incoming = new Map<string, string>() // peerId to name, for invites we received
    let myY = 0.5
    let oppY = 0.5
    const ball = { x: 0.5, y: 0.5, vx: 0, vy: 0 }
    let sh = 0 // host score
    let sg = 0 // guest score

    // --- peer discovery across all tiers ---
    const mySelf = () => getAllSessions()[0]?.selfId ?? ''
    const allPeers = (): Array<{ peerId: string; name: string }> => {
      const seen = new Set<string>()
      const out: Array<{ peerId: string; name: string }> = []
      for (const s of getAllSessions()) {
        for (const p of s.roster()) {
          if (!p.ready || p.peerId === mySelf() || seen.has(p.peerId)) continue
          seen.add(p.peerId)
          out.push({ peerId: p.peerId, name: p.name || 'peer' })
        }
      }
      return out
    }
    const nameOf = (peerId: string) => allPeers().find((p) => p.peerId === peerId)?.name ?? incoming.get(peerId) ?? 'peer'
    const sessionFor = (peerId: string) => getAllSessions().find((s) => s.roster().some((p) => p.peerId === peerId && p.ready)) ?? null
    const sendTo = (peerId: string, m: Msg) => sessionFor(peerId)?.sendGame(m, peerId)
    const setStatus = (t: string) => {
      status.textContent = t
    }

    // In-match quick chat over the same `game` channel (opponent-scoped, ephemeral).
    // Peer text is rendered with textContent only (never innerHTML) and length-capped.
    const addChat = (who: string, text: string) => {
      chatLog.append(el('div', { class: 'pong-chat-line' }, [el('span', { class: 'muted', text: `${who}: ` }), el('span', { text })]))
      while (chatLog.childElementCount > 6) chatLog.firstElementChild?.remove()
      chatLog.scrollTop = chatLog.scrollHeight
    }
    const sendChat = (raw: string) => {
      const text = raw.trim().slice(0, CHAT_MAX)
      if (!text || !opp) return
      sendTo(opp, { t: 'chat', text })
      addChat('You', text)
    }

    // --- views ---
    const showView = () => {
      const inGame = !!opp
      gameEl.classList.toggle('hidden', !inGame)
      lobbyEl.classList.toggle('hidden', inGame)
      rematchBtn.classList.toggle('hidden', !inGame)
      if (!inGame) renderLobby()
    }
    const renderLobby = () => {
      const peers = allPeers()
      const rows: HTMLElement[] = [el('div', { class: 'group-label', text: 'Choose an opponent' })]
      if (!peers.length) {
        rows.push(el('div', { class: 'muted small', text: 'No one connected yet. Open Connect to share a code or pair a device, then invite them here.' }))
      }
      for (const p of peers) {
        rows.push(
          el('div', { class: 'row' }, [
            el('span', { class: 'dot on' }),
            el('span', { text: p.name }),
            el('span', { class: 'spacer' }),
            pendingOut === p.peerId
              ? button('Cancel', () => cancelOutgoing(), 'ghost', 'Cancel the invite')
              : button('Invite', () => invite(p.peerId), 'primary', 'Challenge this peer to Pong'),
          ]),
        )
      }
      if (incoming.size) {
        rows.push(el('div', { class: 'group-label', text: 'Invites' }))
        for (const [id, name] of incoming) {
          rows.push(
            el('div', { class: 'row' }, [
              el('span', { text: `${name} invited you` }),
              el('span', { class: 'spacer' }),
              button('Accept', () => acceptIncoming(id), 'primary'),
              button('Decline', () => declineIncoming(id), 'ghost'),
            ]),
          )
        }
      }
      lobbyEl.replaceChildren(...rows)
    }

    // --- lobby actions ---
    const invite = (peerId: string) => {
      if (opp) return
      pendingOut = peerId
      sendTo(peerId, { t: 'invite' })
      setStatus(`Waiting for ${nameOf(peerId)} to accept...`)
      renderLobby()
    }
    const cancelOutgoing = () => {
      if (!pendingOut) return
      sendTo(pendingOut, { t: 'cancel' })
      pendingOut = null
      setStatus('')
      renderLobby()
    }
    const acceptIncoming = (peerId: string) => {
      if (pendingOut) {
        sendTo(pendingOut, { t: 'cancel' })
        pendingOut = null
      }
      for (const id of incoming.keys()) if (id !== peerId) sendTo(id, { t: 'decline' })
      sendTo(peerId, { t: 'accept' })
      startGame(peerId, mySelf() < peerId)
    }
    const declineIncoming = (peerId: string) => {
      sendTo(peerId, { t: 'decline' })
      incoming.delete(peerId)
      renderLobby()
    }

    // --- match lifecycle ---
    const serve = (towardHost: boolean) => {
      ball.x = 0.5
      ball.y = 0.5
      const a = (Math.random() - 0.5) * 0.7
      ball.vx = (towardHost ? -1 : 1) * 0.62 * Math.cos(a)
      ball.vy = 0.62 * Math.sin(a)
    }
    const setScore = () => {
      const me = host ? sh : sg
      const them = host ? sg : sh
      const tag = over ? (me > them ? ', you win 🏓' : ', you lose') : ''
      scoreEl.textContent = opp ? `You ${me}, ${oppName} ${them}${tag}` : ''
    }
    const startGame = (peerId: string, asHost: boolean) => {
      opp = peerId
      oppName = nameOf(peerId)
      host = asHost
      pendingOut = null
      incoming.clear()
      chatLog.replaceChildren()
      sh = 0
      sg = 0
      over = false
      playing = true
      myY = 0.5
      oppY = 0.5
      if (host) serve(Math.random() < 0.5)
      setStatus(`Playing vs ${oppName}. You are the ${host ? 'left (host)' : 'right'} paddle.`)
      setScore()
      showView()
    }
    const resetMatch = () => {
      sh = 0
      sg = 0
      over = false
      playing = true
      chatLog.replaceChildren()
      if (host) serve(Math.random() < 0.5)
      setScore()
      showView()
    }
    const rematch = () => {
      if (!opp) return
      sendTo(opp, { t: 'rematch' })
      resetMatch()
    }
    const leaveGame = () => {
      if (opp) sendTo(opp, { t: 'bye' })
      endGame('')
    }
    const endGame = (msg: string) => {
      opp = null
      oppName = ''
      playing = false
      over = false
      setStatus(msg)
      showView()
    }

    // --- physics (host) + dead-reckoning (guest) ---
    const wallBounce = () => {
      if (ball.y < BALL_R) {
        ball.y = BALL_R
        ball.vy = Math.abs(ball.vy)
      } else if (ball.y > 1 - BALL_R) {
        ball.y = 1 - BALL_R
        ball.vy = -Math.abs(ball.vy)
      }
    }
    const bounce = (center: number, dir: 1 | -1) => {
      const off = clamp((ball.y - center) / PADDLE_HALF, -1, 1)
      const speed = Math.min(MAX_SPEED, Math.hypot(ball.vx, ball.vy) * 1.06)
      const angle = off * 1.1
      ball.vx = dir * Math.abs(speed * Math.cos(angle))
      ball.vy = speed * Math.sin(angle)
    }
    const afterScore = (towardHost: boolean) => {
      if (sh >= WIN || sg >= WIN) {
        over = true
        playing = false
        showView()
      } else {
        serve(towardHost)
      }
      setScore()
    }
    const stepHost = (dt: number) => {
      ball.x += ball.vx * dt
      ball.y += ball.vy * dt
      wallBounce()
      if (ball.vx < 0 && ball.x < PADDLE_X + BALL_R) {
        if (Math.abs(ball.y - myY) < PADDLE_HALF + BALL_R) {
          ball.x = PADDLE_X + BALL_R
          bounce(myY, 1)
        } else if (ball.x < -0.06) {
          sg += 1
          afterScore(true)
        }
      } else if (ball.vx > 0 && ball.x > 1 - PADDLE_X - BALL_R) {
        if (Math.abs(ball.y - oppY) < PADDLE_HALF + BALL_R) {
          ball.x = 1 - PADDLE_X - BALL_R
          bounce(oppY, -1)
        } else if (ball.x > 1.06) {
          sh += 1
          afterScore(false)
        }
      }
    }
    const reckon = (dt: number) => {
      ball.x += ball.vx * dt
      ball.y += ball.vy * dt
      wallBounce()
    }

    let palette = readPalette()
    const draw = () => {
      const W = canvas.width
      const H = canvas.height
      g.fillStyle = palette.bg
      g.fillRect(0, 0, W, H)
      g.strokeStyle = palette.line
      g.setLineDash([6, 10])
      g.beginPath()
      g.moveTo(W / 2, 0)
      g.lineTo(W / 2, H)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = palette.fg
      const leftY = host ? myY : oppY
      const rightY = host ? oppY : myY
      const pw = 10
      const ph = PADDLE_HALF * 2 * H
      g.fillRect(PADDLE_X * W - pw / 2, leftY * H - ph / 2, pw, ph)
      g.fillRect((1 - PADDLE_X) * W - pw / 2, rightY * H - ph / 2, pw, ph)
      g.beginPath()
      g.arc(ball.x * W, ball.y * H, BALL_R * H, 0, Math.PI * 2)
      g.fill()
      if (over) {
        g.fillStyle = palette.dim
        g.font = '600 20px system-ui, sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText((host ? sh : sg) > (host ? sg : sh) ? 'You win 🏓' : 'You lose', W / 2, H / 2)
        g.textAlign = 'start'
        g.textBaseline = 'alphabetic'
      }
    }

    // --- incoming game messages (all sessions route here) ---
    const onGame = (payload: unknown, from: string) => {
      const m = payload as Msg
      if (!m || typeof m !== 'object' || typeof (m as { t?: unknown }).t !== 'string') return
      switch (m.t) {
        case 'invite':
          if (pendingOut === from) {
            // mutual invite: start immediately
            sendTo(from, { t: 'accept' })
            startGame(from, mySelf() < from)
          } else if (opp) {
            sendTo(from, { t: 'decline' }) // busy in a match
          } else {
            incoming.set(from, nameOf(from))
            renderLobby()
          }
          return
        case 'cancel':
          incoming.delete(from)
          if (!opp) renderLobby()
          return
        case 'accept':
          if (pendingOut === from) startGame(from, mySelf() < from)
          return
        case 'decline':
          if (pendingOut === from) {
            pendingOut = null
            setStatus(`${nameOf(from)} declined.`)
            renderLobby()
          }
          return
        case 'paddle':
          if (opp === from && playing) oppY = clamp(m.y, PADDLE_HALF, 1 - PADDLE_HALF)
          return
        case 'state':
          if (opp === from && !host) {
            if (!playing || over) {
              over = false
              playing = true
              showView()
            }
            ball.x = m.x
            ball.y = m.y
            ball.vx = m.vx
            ball.vy = m.vy
            sh = m.sh
            sg = m.sg
            if (sh >= WIN || sg >= WIN) {
              over = true
              playing = false
              showView()
            }
            setScore()
          }
          return
        case 'rematch':
          if (opp === from) resetMatch()
          return
        case 'chat':
          if (opp === from && typeof m.text === 'string') addChat(oppName, m.text.slice(0, CHAT_MAX))
          return
        case 'bye':
          if (opp === from) endGame(`${oppName} left the game.`)
          return
      }
    }
    // Set the handler on every current session; the poll re-syncs sessions that join later.
    const syncHandlers = () => {
      for (const s of getAllSessions()) s.setGameHandler(onGame)
    }

    // --- controls: pointer on the board, or the arrow keys and W/S when focused ---
    const pointerY = (clientY: number) => {
      const r = canvas.getBoundingClientRect()
      return clamp((clientY - r.top) / r.height, PADDLE_HALF, 1 - PADDLE_HALF)
    }
    const onPointer = (e: PointerEvent) => {
      myY = pointerY(e.clientY)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'w') myY = clamp(myY - 0.07, PADDLE_HALF, 1 - PADDLE_HALF)
      else if (e.key === 'ArrowDown' || e.key === 's') myY = clamp(myY + 0.07, PADDLE_HALF, 1 - PADDLE_HALF)
      else return
      e.preventDefault()
    }
    canvas.tabIndex = 0
    canvas.addEventListener('pointermove', onPointer)
    canvas.addEventListener('keydown', onKey)
    const onTheme = () => {
      palette = readPalette()
    }
    window.addEventListener('wt:theme', onTheme)

    // --- loop ---
    let last = performance.now()
    let netAcc = 0
    let sentY = -1
    const loop = (now: number) => {
      const dt = Math.min(0.045, (now - last) / 1000)
      last = now
      if (opp) {
        if (playing && !over) {
          if (host) stepHost(dt)
          else reckon(dt)
        }
        draw()
        netAcc += dt
        if (playing && netAcc >= 0.045) {
          netAcc = 0
          if (myY !== sentY) {
            sendTo(opp, { t: 'paddle', y: myY })
            sentY = myY
          }
          if (host) sendTo(opp, { t: 'state', x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, sh, sg })
        }
      }
      raf = requestAnimationFrame(loop)
    }

    // --- periodic re-sync of sessions + lobby + disconnect detection ---
    const tick = () => {
      syncHandlers()
      const peers = allPeers()
      if (opp && !peers.some((p) => p.peerId === opp)) {
        endGame(`${oppName} disconnected.`)
        return
      }
      if (pendingOut && !peers.some((p) => p.peerId === pendingOut)) {
        pendingOut = null
        setStatus('')
      }
      for (const id of [...incoming.keys()]) if (!peers.some((p) => p.peerId === id)) incoming.delete(id)
      if (!opp) renderLobby()
    }

    syncHandlers()
    renderLobby()
    showView()
    raf = requestAnimationFrame(loop)
    poll = window.setInterval(tick, 1000)

    detachers.set(container, () => {
      cancelAnimationFrame(raf)
      window.clearInterval(poll)
      canvas.removeEventListener('pointermove', onPointer)
      canvas.removeEventListener('keydown', onKey)
      window.removeEventListener('wt:theme', onTheme)
      if (opp) sendTo(opp, { t: 'bye' })
      else if (pendingOut) sendTo(pendingOut, { t: 'cancel' })
      for (const s of getAllSessions()) s.setGameHandler(null)
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
