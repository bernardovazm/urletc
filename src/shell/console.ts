// The console is the single composer-centric surface (monochrome, ChatGPT-like). On
// entry it auto-pilots: scans the clipboard and surfaces type-appropriate actions,
// joins your personal room (paired devices), and turns on nearby discovery (devices
// behind the same public IP meet in a derived room; see ARCHITECTURE section 5.4). It never
// auto-loads peer-authored scripts. Chat, clipboard cards, tool outputs, and files are
// collapsible cards in one feed; live media tiles and captions sit in their own
// collapsible strips above the composer; attachments + a "/" tool launcher live in the
// composer; the right panel (collapsed by default) lists devices/people by tier with
// mute/volume/verify controls.
//
// Four rendezvous tiers can be live at once, deduped by peerId:
//   personal: your own devices (pair link, persistent, gets media + auto-share)
//   nearby:   same public IP, zero-touch (untrusted: NO auto-share, NO local media)
//   code:     short speakable join code, ephemeral (gets media)
//   presence: opt-in "who is online", VISIBLE but not REACHABLE (carries no content)
//
// Visible and reachable are different states and the roster says which one each row is
// in, because a list that looks like a connection list and is not one is the single
// thing users misread here. A presence row carries a 🔗 that invites that peer into the
// code room, which is the only way a visible peer becomes a reachable one.

import type { CryptoCaps } from '../core/crypto'
import { detectItems, detectText, kindLabel, type Detected } from '../core/clipboard'
import { CryptoUnsupportedError } from '../core/identity'
import { getItem, removeItem, setItem } from '../core/store'
import { codeRoom, generateJoinCode, nearbyRoom, normalizeJoinCode, publicIp } from '../p2p/discovery'
import { ensurePersonalSecret, pairLink, personalRoom, resetPersonalSecret } from '../p2p/personal'
import type { ChatMessage, HistoryRecord, InviteSignal, ReceivedFile, RoomSession, RosterPeer, SessionEvents } from '../p2p/session'
import { createContext } from './context'
import { registry, type ToolManifest, type ToolModule } from './registry'
import { Router } from './router'
import { setStudio, type SourceKind, type StageLayout, type StreamMeta, type StudioController, type StudioSource } from './studio'
import { currentTheme, toggleTheme } from './theme'
import { button, copyText, el, toast } from './ui'

type Tier = 'personal' | 'nearby' | 'code' | 'presence'
/** `presence` is LAST so mergedPeers()'s first-tier-wins dedupe always renders a device
 *  you can also reach privately under its trusted tier, never as an anonymous stranger. */
const TIER_ORDER: Tier[] = ['personal', 'nearby', 'code', 'presence']
/** Tiers that carry composer traffic (chat + files). `presence` answers "who is online"
 *  and nothing else, so it is excluded here as well as from MEDIA_TIERS; the session it
 *  opens is additionally `presenceOnly`, which enforces the same thing one layer down. */
const BROADCAST_TIERS: Tier[] = ['personal', 'nearby', 'code']
/** Tiers allowed to receive LOCAL camera/mic/screen. This is deliberately an allow-list:
 *  as a deny-list (`t !== 'nearby'`) every tier added later was silently opted IN to
 *  publishing the user's camera to it, which is the wrong default to fail towards. */
const MEDIA_TIERS: Tier[] = ['personal', 'code']
/** Tiers whose sessions may replay what was said before a peer arrived. An allow-list for
 *  the same reason MEDIA_TIERS is one: `nearby` is strangers who happen to share a public
 *  IP and `presence` is every stranger running the app, so as a deny-list each new tier
 *  would be silently opted IN to the worst leak this app could produce. joinRoomSession
 *  refuses it a second time, in the session layer, per ARCHITECTURE section 9.1. */
const HISTORY_TIERS: Tier[] = ['personal', 'code']
const HISTORY_KEY = 'history:v1'
const HISTORY_MAX = 500 // records kept on this device
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const HISTORY_MAX_BYTES = 256 * 1024 // serialized backstop: 500 x 4000 chars would be 2 MB
const HISTORY_BATCH_MS = 800 // quiet time before a peer's chunks render as one card
const MAX_HISTORY_PROMPTS = 8 // simultaneous "they asked for earlier messages" cards
const MAX_PENDING_STREAMS = 16
const INVITE_TIMEOUT = 90_000 // an invite nobody answers stops claiming to be pending
const MAX_INBOUND_INVITES = 8 // prompts on screen at once, so a peer cannot paper the feed

export async function mountConsole(app: HTMLElement, caps: CryptoCaps): Promise<void> {
  app.replaceChildren()
  const p2pReady = caps.ed25519 && caps.x25519

  const sessions = new Map<Tier, RoomSession>()
  const rosters = new Map<Tier, RosterPeer[]>()
  let codeLabel = ''
  let nearbyState: 'searching' | 'on' | 'unavailable' | 'off' = p2pReady ? 'searching' : 'off'
  // No baked-in "me": a neutral random handle by default, renameable under Connect.
  let displayName = (await getItem<string>('display-name')) ?? ''
  if (!displayName) {
    displayName = `peer-${100 + Math.floor(Math.random() * 900)}`
    void setItem('display-name', displayName)
  }
  let autoShare = (await getItem<boolean>('auto-share')) ?? false
  const verified = new Set<string>((await getItem<string[]>('verified')) ?? [])

  // ---------- replayable feed history ----------
  // Local, encrypted at rest, capped by count AND age AND serialized size. Two extra
  // fields on top of the wire record decide what may ever leave this device:
  //   tier      where the entry came from. A nearby stranger's message is kept (it is
  //             your feed) but is never replayed to anyone, because their words are not
  //             yours to hand on.
  //   replayed  set on anything a PEER handed us. Those are never re-served, so history
  //             cannot launder through a chain of peers and one holder's opt-out cannot
  //             be undone by the next holder along. You only ever share what you saw live.
  type StoredRecord = HistoryRecord & { tier: Tier | 'me'; replayed?: boolean }
  let transcript: StoredRecord[] = []
  try {
    const raw = await getItem<StoredRecord[]>(HISTORY_KEY)
    if (Array.isArray(raw)) transcript = raw.filter((r) => !!r && typeof r.id === 'string' && typeof r.ts === 'number' && typeof r.text === 'string')
  } catch {
    /* an unreadable store starts empty rather than refusing to boot */
  }
  const seenIds = new Set<string>(transcript.map((r) => r.id))
  // Sending and receiving are separate decisions with separate defaults. Paired devices
  // are your own machines, so ON. A code room is not: a six character code travels, and
  // whoever it was forwarded to would otherwise get everything said before they arrived.
  let shareToDevices = (await getItem<boolean>('history-share-devices')) ?? true
  let shareToCode = (await getItem<boolean>('history-share-code')) ?? false
  let askOnJoin = (await getItem<boolean>('history-ask')) ?? true
  // Peers dropped with a row's 🗑, keyed by deviceId (a hash of their identity key: they
  // cannot choose it, and it is on both a roster entry and a chat/file author). The drop
  // is local and lasts for this page: the row goes, their media is torn down, and their
  // chat, files and invites are ignored. It is not a persisted block, and it is not a
  // disconnect, because a Trystero room is joined rather than peered.
  const dropped = new Set<string>()
  // Invites we SENT, keyed by the target's pubKeyHex, so a row can show pending state and
  // offer a cancel. Cleared when they become reachable, decline, or the timeout fires.
  const pendingInvites = new Map<string, { peerId: string; code: string; timer: number }>()
  // Inbound invite prompts still on screen, keyed by peerId: at most one per peer.
  const inboundInvites = new Map<string, HTMLElement>()
  // Declared here rather than beside startPresence() because syncCodeUrl() reads it, and
  // syncCodeUrl runs from the deep-link router, which dispatches long before the presence
  // bootstrap further down would have initialised it.
  let presenceWanted = false
  const peerMedia = new Map<string, HTMLMediaElement[]>()
  const pendingStreams = new Map<string, Array<[MediaStream, unknown]>>()
  const localStreams = new Map<MediaStream, StreamMeta>() // own published streams and their metadata

  // Chromeless stage view for OBS/scenes: #/stage/<code> renders ONLY the video stage,
  // joins just that code room, and publishes nothing (pure viewer). Detected at mount so
  // the auto-pilot can skip the personal/nearby tiers.
  // A shared #/join link can carry "?p=1", meaning the sender has the online list on.
  // Read before anything rewrites the hash. It is only ever a question: see offerPresence.
  const invitedToPresence = /^#\/join\/[A-Za-z0-9-]{2,64}\?p=1$/.test(location.hash)
  const stageRoute = /^#\/stage\/([A-Za-z0-9-]{2,64})$/.exec(location.hash)
  const stageViewCode = stageRoute ? stageRoute[1] : null
  const stageView = !!stageViewCode

  // ---------- merged view over all tiers ----------
  const mergedPeers = (): Array<{ tier: Tier; peer: RosterPeer }> => {
    const seen = new Set<string>()
    const out: Array<{ tier: Tier; peer: RosterPeer }> = []
    for (const tier of TIER_ORDER) {
      for (const p of rosters.get(tier) ?? []) {
        if (seen.has(p.peerId)) continue // same device reachable via two tiers
        if (dropped.has(p.deviceId)) continue // dropped locally, see dropPeer()
        seen.add(p.peerId)
        out.push({ tier, peer: p })
      }
    }
    return out
  }
  const connectedCount = () => mergedPeers().filter((x) => x.peer.ready).length
  /** Peers a message can actually REACH. Distinct from connectedCount(), which includes
   *  the presence tier: someone visible in the online list is not somewhere to send to,
   *  so composing while only they are online must still queue to the outbox. */
  const reachableCount = () => mergedPeers().filter((x) => x.peer.ready && BROADCAST_TIERS.includes(x.tier)).length
  const isPresent = (peerId: string) => mergedPeers().some((x) => x.peer.peerId === peerId)
  /** True when this peerId is a device the user dropped. Reads the RAW tier rosters,
   *  because mergedPeers() has already filtered dropped devices out. */
  const isDropped = (peerId: string) => [...rosters.values()].some((list) => list.some((p) => p.peerId === peerId && dropped.has(p.deviceId)))

  /** Send to every connected device exactly once, across all tiers. Returns count. */
  /** One id per message, minted once and reused across tiers, so a device reachable on
   *  two tiers stores one record and a later replay dedupes against it. */
  async function sendChatAll(text: string, id: string): Promise<number> {
    const sent = new Set<string>()
    for (const tier of BROADCAST_TIERS) {
      const s = sessions.get(tier)
      if (s) for (const k of await s.sendChat(text, sent, id)) sent.add(k)
    }
    return sent.size
  }
  async function sendFileAll(file: File): Promise<number> {
    const sent = new Set<string>()
    for (const tier of BROADCAST_TIERS) {
      const s = sessions.get(tier)
      if (s) for (const k of await s.sendFile(file, sent)) sent.add(k)
    }
    return sent.size
  }

  // Messages typed while no one is connected are queued and delivered as soon as a
  // device joins. The composer never refuses to send.
  const outbox: Array<{ text: string; id: string }> = []
  let flushingOutbox = false
  async function flushOutbox() {
    if (flushingOutbox || !outbox.length || reachableCount() === 0) return
    flushingOutbox = true
    let delivered = 0
    try {
      while (outbox.length && reachableCount() > 0) {
        const n = await sendChatAll(outbox[0].text, outbox[0].id)
        if (!n) break
        outbox.shift()
        delivered++
      }
    } finally {
      flushingOutbox = false
    }
    if (delivered) sys(`Delivered ${delivered} queued message${delivered > 1 ? 's' : ''}.`)
  }

  // A bare alphanumeric token in chat may be a join code ("k4mn2x"): auto-join when it
  // carries a digit (plain words like "thanks" must stay chat); digit-less tokens that
  // fit the 6-char generated-code alphabet get an explicit Join button instead.
  const chatCodeCandidate = (text: string): { code: string; auto: boolean } | null => {
    const t = text.trim().toLowerCase()
    if (!/^[a-z0-9]{4,20}$/.test(t)) return null
    if (/\d/.test(t)) return { code: t, auto: t.length >= 5 }
    return /^[2-9a-hj-km-np-z]{6}$/.test(t) ? { code: t, auto: false } : null
  }

  // ---------- feed ----------
  const feedInner = el('div', { class: 'feed-inner' })
  const feed = el('div', { class: 'feed' }, [feedInner])
  const empty = el('div', { class: 'empty' }, [
    el('div', { class: 'big', text: 'urletc' }),
    el('div', { text: p2pReady ? 'Paste, drop or attach. Type / for tools. Nearby devices connect automatically.' : 'Paste, drop or attach. Type / for tools.' }),
  ])
  feedInner.append(empty)
  // Every feed item (card, message, even system lines) can be removed with the
  // hover delete button; `onRemove` lets tool cards deactivate cleanly first.
  const removers = new WeakMap<Element, () => void>()
  const addCard = (node: HTMLElement, onRemove?: () => void, place: 'top' | 'bottom' = 'bottom') => {
    empty.remove()
    const wrap = el('div', { class: 'feed-item' })
    if (onRemove) removers.set(wrap, onRemove)
    wrap.append(
      node,
      button(
        '🗑',
        () => {
          try {
            onRemove?.()
          } catch {
            /* ignore */
          }
          wrap.remove()
        },
        'icon sm del',
        'Remove from feed',
      ),
    )
    // Replayed history goes to the TOP: every entry in it is older than everything the
    // feed already holds, and appending it under live messages would misdate the room.
    if (place === 'top') {
      feedInner.prepend(wrap)
      return
    }
    feedInner.append(wrap)
    feed.scrollTop = feed.scrollHeight
  }
  const sys = (t: string) => addCard(el('div', { class: 'sys', text: t }))

  /** Remove every feed item, running each card's own teardown first so tool cards
   *  deactivate exactly as they would if you deleted them one at a time. */
  const clearFeed = () => {
    const items = [...feedInner.querySelectorAll('.feed-item')]
    if (!items.length) return
    for (const item of items) {
      try {
        removers.get(item)?.()
      } catch {
        /* a card that fails to tear down must not block the rest */
      }
      item.remove()
    }
    feedInner.append(empty)
    toast(`Cleared ${items.length} ${items.length === 1 ? 'item' : 'items'}`)
    // The feed is a view; the transcript behind it is a file on this device. Clearing one
    // silently while the other survives is a lie the next reload exposes, so the delete is
    // offered here, where it is relevant, instead of turning a one-click control into a
    // dialog for everyone who only wanted a clean screen.
    if (!transcript.length) return
    const del = button(
      'Delete stored history',
      () => {
        void forgetHistory().then(() => del.replaceWith(el('span', { class: 'muted small', text: 'Deleted.' })))
      },
      'ghost small',
      'Erase the stored messages on this device. They stop being replayed to anyone.',
    )
    addCard(
      el('div', { class: 'sys' }, [
        el('span', { text: `${transcript.length} earlier ${transcript.length === 1 ? 'message is' : 'messages are'} still stored on this device. ` }),
        del,
      ]),
    )
  }

  /** Feed card as a native <details> so any output can be collapsed out of the way. */
  const collapsibleCard = (head: (Node | string)[], open = true): { card: HTMLElement; body: HTMLElement } => {
    const summary = el('summary', {}, [el('span', { class: 'chev', text: '>' }), ...head])
    // Buttons/links/inputs in the summary act without toggling the card.
    summary.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) e.preventDefault()
    })
    const body = el('div', { class: 'card-body' })
    const card = el('details', { class: 'card' }, [summary, body]) as HTMLDetailsElement
    card.open = open
    return { card, body }
  }

  // ---------- history: keep, share, replay ----------
  /** deviceId of this device, once any session exists. Used to attribute our own records
   *  so a peer replaying them can tell who spoke, the same way a live message does. */
  const selfDeviceId = () => sessions.get('personal')?.selfDeviceId ?? [...sessions.values()][0]?.selfDeviceId ?? ''

  let historySaveTimer = 0
  /** Enforce every cap, oldest first, newest last. Count and age are the stated policy;
   *  the byte ceiling is the backstop, since 500 messages at the 4000-character inbound
   *  limit would be 2 MB in one encrypted value. */
  const pruneHistory = () => {
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS
    transcript = transcript.filter((r) => r.ts >= cutoff).sort((a, b) => a.ts - b.ts)
    if (transcript.length > HISTORY_MAX) transcript = transcript.slice(-HISTORY_MAX)
    while (transcript.length > 1 && JSON.stringify(transcript).length > HISTORY_MAX_BYTES) transcript = transcript.slice(Math.ceil(transcript.length / 10))
  }
  /** Debounced, because a burst of backfill chunks must not re-encrypt the whole store
   *  once per chunk. Failures are swallowed: a message that reached the feed is not lost
   *  work worth interrupting the user over. */
  const saveHistory = () => {
    window.clearTimeout(historySaveTimer)
    historySaveTimer = window.setTimeout(() => {
      pruneHistory()
      void setItem(HISTORY_KEY, transcript).catch(() => {})
    }, 600)
  }
  /** Keep one entry. Dedupe is by the SENDER's id, which is what lets a peer with two
   *  history sources hold one copy instead of two. Returns whether it was new. */
  const remember = (rec: StoredRecord): boolean => {
    if (!rec.text || seenIds.has(rec.id)) return false
    seenIds.add(rec.id)
    transcript.push(rec)
    saveHistory()
    return true
  }
  const forgetHistory = async () => {
    window.clearTimeout(historySaveTimer)
    transcript = []
    seenIds.clear()
    await removeItem(HISTORY_KEY).catch(() => {})
    applyHistory() // providers immediately answer with nothing
  }

  /** What this device is willing to hand over: entries it witnessed live (never ones a
   *  peer replayed to it) whose origin tier may be replayed at all. */
  const shareableHistory = (): HistoryRecord[] =>
    transcript
      .filter((r) => !r.replayed && (r.tier === 'me' || HISTORY_TIERS.includes(r.tier)))
      .map(({ id, deviceId, name, text, ts, kind, size }) => ({ id, deviceId, name, text, ts, kind, size }))

  /** Whether we ANSWER history requests in this tier. Two switches, two defaults. */
  const sharesTo = (tier: Tier) => (tier === 'personal' ? shareToDevices : tier === 'code' ? shareToCode : false)

  /** Push the current settings into every live session, so a switch moved now takes
   *  effect in the rooms already open instead of only on the next join. */
  function applyHistory(): void {
    for (const tier of HISTORY_TIERS) {
      const s = sessions.get(tier)
      if (!s) continue
      s.setHistory({
        provide: sharesTo(tier) ? shareableHistory : null,
        request: askOnJoin,
        onRecords: (recs, fromPeerId) => queueBackfill(recs, fromPeerId, tier),
      })
    }
  }

  // A backfill arrives as N chunks. Buffer them per peer and render once, so 200 replayed
  // messages are one card and not eight.
  const backfillBuf = new Map<string, { recs: HistoryRecord[]; timer: number }>()
  function queueBackfill(recs: HistoryRecord[], fromPeerId: string, tier: Tier): void {
    const fresh = recs.filter((r) => remember({ ...r, tier, replayed: true }))
    if (!fresh.length) return
    const hit = backfillBuf.get(fromPeerId)
    if (hit) {
      hit.recs.push(...fresh)
      window.clearTimeout(hit.timer)
      hit.timer = window.setTimeout(() => flushBackfill(fromPeerId), HISTORY_BATCH_MS)
      return
    }
    backfillBuf.set(fromPeerId, { recs: fresh, timer: window.setTimeout(() => flushBackfill(fromPeerId), HISTORY_BATCH_MS) })
  }
  function flushBackfill(fromPeerId: string): void {
    const hit = backfillBuf.get(fromPeerId)
    if (!hit) return
    backfillBuf.delete(fromPeerId)
    const who = mergedPeers().find((x) => x.peer.peerId === fromPeerId)?.peer.name ?? 'a device'
    addCard(historyCard(hit.recs, `replayed from ${who}`), undefined, 'top')
    sys(`Replayed ${hit.recs.length} earlier message${hit.recs.length === 1 ? '' : 's'} from ${who}.`)
  }

  // A peer asked and we said nothing, because sharing into this tier is off. Rather than
  // leave the switch to be discovered in a modal (which is what made the feature look
  // broken: you share a link, they join, nothing happens and nothing explains why), ask
  // here, once per peer, at the only moment the question means anything. The default
  // stays off, so a code forwarded on to a stranger still replays nothing on its own:
  // what changes is that a person is now present to decide, instead of silence.
  const historyPrompts = new Map<string, { card: HTMLElement; tier: Tier }>()
  /** Retire every open question for a tier. Used when the answer stops being per-person:
   *  saying "always" answers everyone still waiting, so their cards must not sit there
   *  asking something that is already decided. */
  const dropHistoryPrompts = (tier: Tier) => {
    for (const [peerId, p] of [...historyPrompts]) {
      if (p.tier !== tier) continue
      historyPrompts.delete(peerId)
      p.card.remove()
    }
  }
  function askToShareHistory(peerId: string, tier: Tier): void {
    if (historyPrompts.has(peerId) || historyPrompts.size >= MAX_HISTORY_PROMPTS) return
    const records = shareableHistory()
    if (!records.length) return // nothing to offer: never nag about an empty store
    const who = mergedPeers().find((x) => x.peer.peerId === peerId)?.peer.name ?? 'a device'
    const n = records.length
    const drop = () => {
      const p = historyPrompts.get(peerId)
      historyPrompts.delete(peerId)
      p?.card.remove()
    }
    const card = el('div', { class: 'sys' })
    const send = button(
      'Send them',
      () => {
        drop()
        // Records are re-read here, not captured above: what is sent is what is stored
        // at the moment of consent, not at the moment the question was asked.
        void sessions
          .get(tier)
          ?.answerHistory(peerId, shareableHistory())
          .then((ok) => sys(ok ? `Sent ${n} earlier message${n === 1 ? '' : 's'} to ${who}.` : `Could not send earlier messages to ${who}.`))
      },
      'ghost small',
      'Send this person the messages from before they arrived. Only them, only this once',
    )
    const always = button(
      'Always in code rooms',
      () => {
        dropHistoryPrompts(tier)
        shareToCode = true
        void setItem('history-share-code', shareToCode)
        applyHistory() // installs the provider, which answers everyone still waiting
        sys('Earlier messages will be sent to people who join by code. Change it under Connect, "Earlier messages".')
      },
      'ghost small',
      'Answer everyone who joins by code from now on, including this person',
    )
    const no = button('No', drop, 'ghost small', 'Keep them to yourself. They are told nothing')
    card.append(el('span', { text: `${who} joined and asked for the ${n} earlier message${n === 1 ? '' : 's'} stored here. ` }), send, always, no)
    historyPrompts.set(peerId, { card, tier })
    addCard(card, () => historyPrompts.delete(peerId))
  }

  /** Replayed entries render as ONE collapsed card, never as loose bubbles, so what was
   *  said before you arrived is never mistaken for what just arrived. Each line also
   *  carries its own date, which a live message keeps in a hover title. */
  const historyCard = (recs: HistoryRecord[], from: string): HTMLElement => {
    const items = [...recs].sort((a, b) => a.ts - b.ts)
    const { card, body } = collapsibleCard([el('strong', { text: `Earlier messages (${items.length})` }), el('span', { class: 'card-from', text: from })], false)
    for (const r of items) {
      body.append(
        el('div', { class: 'msg' }, [
          el('div', { class: 'who' }, [el('span', { text: r.name }), el('span', { class: 'muted small', text: `  ${new Date(r.ts).toLocaleString()}` })]),
          el('div', { class: 'bubble', text: r.kind === 'file' ? `file: ${r.text} (${Math.round((r.size ?? 0) / 1024)} KB)` : r.text }),
        ]),
      )
    }
    return card
  }

  // ---------- media tiles + hidden audio sink ----------
  const tiles = el('div', { class: 'tiles' })
  const sink = el('div', { class: 'hidden' })
  // Wrap the live video tiles in a collapsible region (R2.15). Collapsing hides the
  // grid but leaves streams running (audio still plays via `sink`). The region hides
  // itself entirely when there are no tiles (CSS :has), so it costs nothing when idle.
  const tilesCollapseBtn = button(
    '🔽',
    () => {
      const c = tilesRegion.classList.toggle('tiles-collapsed')
      tilesCollapseBtn.textContent = c ? '🔼' : '🔽'
    },
    'icon sm',
    'Collapse / expand the video tiles (streams keep running)',
  )
  const stageCount = el('span', { class: 'muted small', text: 'Streams' })
  const tilesHead = el('div', { class: 'tiles-head' }, [stageCount, el('span', { class: 'spacer' }), tilesCollapseBtn])
  const tilesRegion = el('div', { class: 'tiles-region' }, [tilesHead, tiles])

  // ---------- roster ----------
  const peersBox = el('div', { class: 'peers' })
  const statusChip = el('span', { class: 'badge' })
  const updateStatus = () => {
    // Say something only when there is something to say. Searching/idle states
    // ("looking for devices...") added noise without information, so the chip hides.
    // Connected and visible are counted apart: one number covering both is what made
    // people think the online list was a set of connections.
    const n = reachableCount()
    const seen = connectedCount() - n
    const label = n ? `${n} connected${seen ? `, ${seen} visible` : ''}` : seen ? `${seen} visible only` : !p2pReady ? 'tools-only' : ''
    statusChip.textContent = label
    statusChip.classList.toggle('hidden', !label)
  }
  updateStatus()

  const verifyPeer = (p: RosterPeer) => {
    if (!confirm(`Safety number with ${p.name}:\n\n${p.safety}\n\nCompare out-of-band (call / in person). Match on both devices?`)) return
    verified.add(p.pubKeyHex)
    void setItem('verified', [...verified])
    renderRoster()
  }

  const TIER_LABELS: Record<Tier, () => string> = {
    personal: () => 'My devices',
    nearby: () => 'Nearby',
    code: () => (codeLabel ? `Code ${codeLabel.toUpperCase()}` : 'By code'),
    presence: () => 'Online now',
  }
  const TIER_EMPTY: Record<Tier, string> = {
    personal: 'None yet. Open Connect to pair a device.',
    nearby: 'No one else on this network.',
    code: 'Waiting for someone with the code...',
    presence: 'No one else online right now.',
  }
  /** A line under a group summary saying what the group IS, where the rows alone do not
   *  say it. Presence is the case that needed saying: it reads like a list of connections
   *  and is a list of strangers you may ask to connect. */
  const TIER_NOTE: Partial<Record<Tier, string>> = {
    presence: 'Everyone running urletc now. Visible only: press 🔗 on a row to connect before you can message.',
  }

  /** How a peer is addressed in a control's accessible name. Every row renders the same
   *  icons, so an unqualified label reads as N identical controls to a screen reader.
   *  Presence peers are addressed by key fingerprint, since their name is self-asserted. */
  const peerLabel = (p: RosterPeer, tier: Tier) => (tier === 'presence' && !verified.has(p.pubKeyHex) ? `device ${p.deviceId.slice(0, 6)}` : p.name || 'peer')

  /** Who a received file came from, resolved from the deviceId it carries. Goes through
   *  the same peerLabel() the roster uses so one convention decides how a peer is named,
   *  and falls back to the short key fingerprint whenever there is no name to trust: the
   *  sender has left the roster, or claims none. A display name is self-asserted, so an
   *  unnamed or unresolvable sender must never be attributed to a bare word. */
  const senderLabel = (deviceId: string): string => {
    if (!deviceId) return 'an unknown device'
    const hit = mergedPeers().find((x) => x.peer.deviceId === deviceId)
    const label = hit ? peerLabel(hit.peer, hit.tier) : ''
    return label && label !== 'peer' ? label : `device ${deviceId.slice(0, 6)}`
  }

  const peerRow = (p: RosterPeer, tier: Tier) => {
    const media = peerMedia.get(p.peerId) ?? []
    const who = peerLabel(p, tier)
    const isVerified = verified.has(p.pubKeyHex)
    const ctl = el('div', { class: 'ctl' })
    if (media.length) {
      const muteBtn = button(
        '🔊',
        () => {
          const muted = !media[0].muted
          for (const m of media) m.muted = muted
          muteBtn.textContent = muted ? '🔇' : '🔊'
          muteBtn.title = muted ? `Unmute ${who}` : `Mute ${who}`
          muteBtn.setAttribute('aria-label', muteBtn.title)
        },
        'icon sm',
        `Mute ${who}`,
      )
      const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', title: `Volume for ${who}`, 'aria-label': `Volume for ${who}` }) as HTMLInputElement
      vol.addEventListener('input', () => {
        for (const m of media) m.volume = Number(vol.value)
      })
      ctl.append(muteBtn, vol)
    }
    // The 🔗 that answers "do I have to connect to these, and how". A presence peer is
    // already WebRTC-connected and authenticated, which is how the fingerprint next to
    // it is known; what it lacks is a room that carries traffic. This hands them one.
    const pending = pendingInvites.has(p.pubKeyHex)
    if (tier === 'presence' && p.ready) {
      ctl.append(
        pending
          ? button('⏹', () => void cancelInvite(p), 'icon sm', `Cancel the invite to ${who}`)
          : button('🔗', () => void invitePeer(p), 'icon sm', `Connect to ${who}: send them your room code so you can message`),
      )
    }
    if (p.ready && p.pubKeyHex && !isVerified) ctl.append(button('🔒', () => verifyPeer(p), 'icon sm', `Verify ${who} by comparing safety numbers`))
    if (p.deviceId) ctl.append(button('🗑', () => dropPeer(p, tier), 'icon sm', `Remove ${who} from this list and stop their audio and video`))
    // State in words, not in a colour: reachable now, visible only, or still shaking
    // hands. This is the distinction the whole presence tier turned on.
    const reachable = p.ready && BROADCAST_TIERS.includes(tier)
    const state = el('span', { class: `badge peer-state${reachable ? ' ok' : ''}`, text: pending ? 'inviting' : reachable ? 'connected' : p.ready ? 'visible' : 'connecting' })
    // In the presence list a peer is a stranger, and `name` is whatever they typed, so
    // a stranger could otherwise copy a paired device's name and its avatar initial and
    // sit one group below it looking identical. There, lead with the short fingerprint
    // of their identity key (which they cannot choose) and demote the claimed name.
    const anon = tier === 'presence' && !isVerified
    return el('div', { class: 'peer' }, [
      el('span', { class: `dot ${p.ready ? 'on' : ''}` }),
      el('div', { class: 'avatar', text: anon ? '?' : (p.name.trim()[0] || '?').toUpperCase() }),
      anon
        ? el('span', { class: 'name' }, [el('span', { class: 'fp', text: p.deviceId.slice(0, 6) }), el('span', { class: 'claimed', text: ` ${p.name.slice(0, 24)}` })])
        : el('span', { class: 'name', text: p.name + (isVerified ? ' (verified)' : '') }),
      state,
      ctl,
    ])
  }

  // presence starts open: seeing who is online is the entire point of that group
  const groupOpen: Record<Tier, boolean> = { personal: true, nearby: true, code: true, presence: true }
  const renderRoster = () => {
    peersBox.replaceChildren()
    if (!sessions.size) {
      peersBox.append(el('div', { class: 'muted small', text: p2pReady ? 'Connecting...' : 'P2P needs a newer browser.' }))
      return
    }
    const merged = mergedPeers()
    for (const tier of TIER_ORDER) {
      if (!sessions.has(tier)) continue
      const rows = merged.filter((x) => x.tier === tier)
      const group = el('details', { class: 'pgroup' }) as HTMLDetailsElement
      group.open = groupOpen[tier]
      group.addEventListener('toggle', () => {
        groupOpen[tier] = group.open
      })
      group.append(el('summary', { class: 'group-label', text: `${TIER_LABELS[tier]()}${rows.length ? ` (${rows.length})` : ''}` }))
      const note = TIER_NOTE[tier]
      if (note && rows.length) group.append(el('div', { class: 'muted small pad-x', text: note }))
      if (!rows.length) group.append(el('div', { class: 'muted small pad-x', text: TIER_EMPTY[tier] }))
      for (const { peer } of rows) group.append(peerRow(peer, tier))
      peersBox.append(group)
    }
  }
  renderRoster()

  // ---------- cards ----------
  const chatCard = (m: ChatMessage) =>
    // Hovering a message reveals when it was sent (native tooltip, no extra chrome).
    el('div', { class: `msg ${m.mine ? 'me' : ''}`, title: new Date(m.ts).toLocaleString() }, [
      el('div', { class: 'who', text: m.name }),
      el('div', { class: 'bubble', text: m.text }),
    ])

  const fileCard = (f: ReceivedFile) => {
    const who = senderLabel(f.from)
    // A file with no author is a file you cannot judge, and images arrive with nothing
    // else identifying on them. The sender sits in the summary rather than the body so
    // it survives collapsing, and reads like the author line over a chat bubble.
    const { card, body } = collapsibleCard([
      el('strong', { text: f.name }),
      el('span', { class: 'muted small', text: `${Math.round(f.size / 1024)} KB` }),
      el('span', { class: 'card-from', text: `from ${who}` }),
    ])
    if (f.ftype.startsWith('image/')) {
      const img = el('img', { class: 'preview', alt: `${f.name}, from ${who}` }) as HTMLImageElement
      img.src = f.url
      body.append(img)
    }
    body.append(el('a', { href: f.url, download: f.name, class: 'small', text: '💾 Download' }))
    return card
  }

  const copyBtn = (get: () => string) => button('Copy', () => void copyText(get()), 'ghost')

  // Always offered, not only while someone is connected. Cards used to snapshot
  // connectivity at render time, so a card made before a peer joined could never send.
  const sendTextBtn = (get: () => string) =>
    p2pReady
      ? button(
          'Send to devices',
          () => {
            void sendChatAll(get(), crypto.randomUUID()).then((n) => toast(n ? `Sent to ${n}` : 'No one connected'))
          },
          'ghost',
        )
      : null

  const sendFileBtn = (file: () => File) =>
    p2pReady
      ? button(
          'Send to devices',
          () => {
            const f = file()
            void sendFileAll(f).then((n) => {
              toast(n ? `Sending to ${n}...` : 'No one connected')
              // A reference only. Bytes are never persisted: a blob URL does not survive
              // a reload, and re-sending megabytes to every late joiner is not history.
              if (n) remember({ id: crypto.randomUUID(), deviceId: selfDeviceId(), name: displayName, text: f.name, ts: Date.now(), kind: 'file', size: f.size, tier: 'me' })
            })
          },
          'ghost',
        )
      : null

  // Images that land in the feed are usually here for their text (screenshots of
  // errors, receipts, slides), so OCR runs proactively and, by default, the result
  // is already on the clipboard. Settings ⚙ tunes it: copy / show / off.
  const ocrMode = async (): Promise<'off' | 'show' | 'copy'> => {
    const v = await getItem<string>('image-ocr')
    return v === 'off' || v === 'show' ? v : 'copy'
  }
  async function runOcrInto(blob: Blob, out: HTMLElement, copyAfter: boolean): Promise<void> {
    out.classList.remove('hidden')
    out.textContent = 'Reading text (OCR)...'
    try {
      const { recognizeImage } = await import('../tools/ocr')
      const { text } = await recognizeImage(blob, (p) => {
        out.textContent = `Recognizing... ${Math.round(p * 100)}%`
      })
      const clean = text.trim()
      out.textContent = clean || '(no text found)'
      if (clean && copyAfter) {
        try {
          await navigator.clipboard.writeText(clean)
          toast('Image text copied')
        } catch {
          /* clipboard blocked; the text is on the card anyway */
        }
      }
    } catch (e) {
      out.textContent = `OCR failed: ${(e as Error).message}`
    }
  }
  const ocrButton = (blob: () => Blob, out: HTMLElement) => button('Run OCR', () => void runOcrInto(blob(), out, false), 'ghost')

  async function clipboardCard(d: Detected): Promise<HTMLElement> {
    const { card, body } = collapsibleCard([el('span', { class: 'badge', text: kindLabel(d.kind) })])
    const actions = el('div', { class: 'row' })

    if (d.kind === 'image') {
      const img = el('img', { class: 'preview', alt: 'Pasted image' }) as HTMLImageElement
      if (d.blob) {
        const u = URL.createObjectURL(d.blob)
        img.src = u
        img.onload = () => URL.revokeObjectURL(u)
        img.onerror = () => URL.revokeObjectURL(u) // revoke even if the image fails to decode
      }
      const out = el('pre', { class: 'muted hidden' })
      const mode = d.blob ? await ocrMode() : 'off'
      if (mode === 'off') actions.append(ocrButton(() => d.blob as Blob, out))
      else {
        void runOcrInto(d.blob as Blob, out, mode === 'copy')
        actions.append(copyBtn(() => out.textContent ?? ''))
      }
      const sf = sendFileBtn(() => new File([d.blob as Blob], 'clipboard-image.png', { type: (d.blob as Blob).type || 'image/png' }))
      if (sf) actions.append(sf)
      body.append(img, actions, out)
    } else if (d.kind === 'html') {
      const { stripHtml } = await import('../tools/html-strip')
      const out = el('pre', { text: stripHtml(d.text ?? '') })
      actions.append(copyBtn(() => out.textContent ?? ''))
      const st = sendTextBtn(() => out.textContent ?? '')
      if (st) actions.append(st)
      body.append(el('div', { class: 'muted small', text: 'Stripped to text' }), out, actions)
    } else if (d.kind === 'json') {
      let formatted = d.text ?? ''
      try {
        formatted = JSON.stringify(JSON.parse(d.text ?? ''), null, 2)
      } catch {
        /* leave */
      }
      const out = el('pre', { text: formatted })
      actions.append(copyBtn(() => out.textContent ?? ''))
      const st = sendTextBtn(() => d.text ?? '')
      if (st) actions.append(st)
      body.append(out, actions)
    } else if (d.kind === 'url') {
      const { parseUrl } = await import('../tools/url-info')
      const parts = parseUrl(d.text ?? '')
      const box = el('div', { class: 'stack' })
      if (parts) for (const p of parts) box.append(el('div', { class: 'row' }, [el('span', { class: 'muted small', text: `${p.label}:` }), el('span', { text: p.value })]))
      actions.append(copyBtn(() => d.text ?? ''))
      // Proactive URL Check, mirroring auto-OCR for images: the structural verdict paints
      // immediately and the blocklist answer fills in when it lands, so the paste is never
      // blocked on the network. The tool card carries the off switch.
      const verdict = el('div', { class: 'stack url-check-card' })
      body.append(el('div', { class: 'muted small', text: 'Parsed (never auto-fetched)' }), box, verdict, actions)
      void import('../tools/url-safety').then((m) => m.renderPasteVerdict(d.text ?? '', verdict))
    } else {
      const { textStats } = await import('../tools/text-utils')
      const s = textStats(d.text ?? '')
      const out = el('pre', { text: d.text ?? '' })
      actions.append(copyBtn(() => d.text ?? ''))
      const st = sendTextBtn(() => d.text ?? '')
      if (st) actions.append(st)
      body.append(el('div', { class: 'muted small', text: `${s.words} words, ${s.chars} chars` }), out, actions)
    }

    // Auto-share goes to YOUR paired devices only, never to nearby/code peers.
    const personal = sessions.get('personal')
    if (autoShare && personal && personal.peerCount() > 0) {
      if (d.kind === 'image' && d.blob) void personal.sendFile(new File([d.blob], 'clipboard-image.png', { type: d.blob.type || 'image/png' }))
      else if (d.text) void personal.sendChat(d.text)
    }
    return card
  }

  // ---------- media / stage (VDO.ninja-style multi-source A/V) ----------
  // The console is the single owner of live streams (security-critical routing). The
  // "stage" is a shared multi-source view: the composer buttons AND the Studio tool both
  // publish through here, and the Studio tool drives layout + per-source controls via the
  // exported controller (see setStudio at the end). A "source" is one published stream,
  // local or remote, labelled by kind (cam/screen/mic) carried in the stream metadata.
  interface StageTile {
    id: string
    peerId: string | null // null = a local (own) source
    kind: SourceKind
    label: string
    hasVideo: boolean
    stream: MediaStream
    media: HTMLMediaElement
    wrap: HTMLElement // the .stage-tile (video) or the bare <audio> (audio-only, in sink)
    recorder: MediaRecorder | null
    fsBtn: HTMLElement | null
    recUrl: string
  }
  const stageTiles: StageTile[] = []
  let stageLayout: StageLayout = 'grid'
  let spotId: string | null = null
  const stageSubs = new Set<() => void>()
  const notifyStage = () => {
    renderStage()
    updateStageHead()
    for (const f of stageSubs) f()
  }

  // Nothing listened for fullscreenchange, so the button glyph and its aria-label kept saying
  // "Fullscreen" while already fullscreen, and Esc dropped you back into a grid with the
  // source you had been watching un-pinned.
  document.addEventListener('fullscreenchange', () => {
    const fsEl = document.fullscreenElement
    for (const t of stageTiles) {
      if (!t.fsBtn) continue
      const on = fsEl === t.wrap
      t.fsBtn.textContent = on ? '🔲' : '🔳'
      const title = on ? `Exit fullscreen of ${t.label}` : `Fullscreen ${t.label}`
      t.fsBtn.title = title
      t.fsBtn.setAttribute('aria-label', title)
      // Pin what you chose to watch, so leaving fullscreen lands on it instead of a grid.
      if (on && spotId !== t.id) toggleSpot(t.id)
    }
  })

  const labelIcon = (k: SourceKind) => (k === 'screen' ? '🖥' : k === 'mic' ? '🎤' : '🎥')
  /** Validate untrusted peer stream metadata into {kind,label}, with the label capped. */
  const asMeta = (m: unknown): StreamMeta | null => {
    if (!m || typeof m !== 'object') return null
    const k = (m as Record<string, unknown>).kind
    const l = (m as Record<string, unknown>).label
    if ((k === 'cam' || k === 'screen' || k === 'mic') && typeof l === 'string') return { kind: k, label: l.slice(0, 40) }
    return null
  }

  /** The tile that actually holds focus: the pinned spotlight, or (in spotlight/solo)
   *  the first video tile. Normalizes a stale `spotId` (pinned source gone) to null.
   *  Read by both renderStage (DOM) and the studio controller's sources() (state). */
  function effectiveSpot(): string | null {
    const vids = stageTiles.filter((t) => t.hasVideo)
    if (spotId && !vids.some((t) => t.id === spotId)) spotId = null
    return spotId ?? (stageLayout !== 'grid' ? (vids[0]?.id ?? null) : null)
  }

  /** Pin or unpin a source as the spotlight. Pinning promotes a grid to spotlight. */
  function toggleSpot(id: string) {
    spotId = spotId === id ? null : id
    if (spotId && stageLayout === 'grid') stageLayout = 'spotlight'
    notifyStage()
  }

  // The row above the stage held one static word and a chevron while the controls that
  // steer the stage lived in a Studio card rendered BELOW the feed, so you scrolled
  // away from the thing you were adjusting. It now carries layout, expand and a count;
  // Studio keeps devices/resolution/recording/the OBS link.
  const setStageLayout = (l: StageLayout) => {
    stageLayout = l
    notifyStage()
  }
  // These used to run together as the single word "GridFocusSolo" because button.icon.sm
  // was a fixed 28px square with a 1.6px gap. That was the real defect and it is fixed in
  // tokens.css, where the icon ladder is now a min-width floor with padding and a real gap.
  //
  // The labels stay as words rather than becoming pictograms. Emoji has no glyph that
  // reads as grid against focus against solo: the literal candidates (a brick wall, a
  // flashlight, a television) are bright red, cyan and teal, which is the opposite of the
  // flat faceless set the rest of the app uses, and the neutral alternatives are all
  // variations of a square and are indistinguishable at 28px. Three short words are
  // unambiguous, they match the Tools and Connect buttons beside them, and they cost one
  // extra glyph of width each.
  const layoutBtns: Array<{ l: StageLayout; g: string; n: string; t: string }> = [
    { l: 'grid', g: 'Grid', n: 'Grid', t: 'Grid: every source the same size' },
    { l: 'spotlight', g: 'Focus', n: 'Focus', t: 'Focus: one source large, the others as thumbnails' },
    { l: 'solo', g: 'Solo', n: 'Solo', t: 'Solo: only the spotlighted source' },
  ]
  const layoutEls = layoutBtns.map((b) => {
    const el0 = button(b.g, () => setStageLayout(b.l), 'icon sm', b.t)
    return { ...b, el: el0 }
  })
  // Expanded stage: the same class-driven mechanism as the chromeless #/stage route, but
  // in-document, so you keep publishing, keep the composer and keep the roster. The
  // stage is otherwise capped at the 760px feed column and 46vh, which turns a shared
  // 4K screen into a strip on a wide display.
  const expandBtn = button(
    '🔳',
    () => {
      const on = document.documentElement.classList.toggle('stage-max')
      expandBtn.textContent = on ? '🔲' : '🔳'
      const t = on ? 'Shrink the stage back into the feed' : 'Expand the stage to fill the window'
      expandBtn.title = t
      expandBtn.setAttribute('aria-label', t)
    },
    'icon sm',
    'Expand the stage to fill the window',
  )
  tilesHead.insertBefore(el('span', { class: 'row tight' }, [...layoutEls.map((x) => x.el), expandBtn]), tilesCollapseBtn)

  /** Reflect source count and the active layout in the head. */
  function updateStageHead(): void {
    const n = stageTiles.filter((t) => t.hasVideo).length
    stageCount.textContent = n ? `${n} ${n === 1 ? 'source' : 'sources'}` : 'Streams'
    // .on is the visible pressed state; aria-pressed is the same fact for a screen
    // reader, which cannot see a background change and now has no word to read either.
    for (const x of layoutEls) {
      const on = stageLayout === x.l
      x.el.classList.toggle('on', on)
      x.el.setAttribute('aria-pressed', String(on))
    }
  }

  /** Apply the current layout + spotlight to the stage (pure DOM class toggles). */
  function renderStage() {
    const effSpot = effectiveSpot()
    tiles.className = `tiles stage layout-${stageLayout}`
    for (const t of stageTiles) {
      if (!t.hasVideo) continue
      t.wrap.classList.toggle('spot', t.id === effSpot)
    }
  }

  function removeStageTile(tile: StageTile) {
    // Stop an in-progress recording first. Splicing the tile out otherwise orphans the
    // MediaRecorder (its onstop still fires and revokes/creates URLs against a dead tile).
    if (tile.recorder && tile.recorder.state !== 'inactive') {
      tile.recorder.stop()
      tile.recorder = null
    }
    // A PiP window outlives the element it came from, so a tile removed while floating
    // (peer left, source stopped, 🚫 pressed) would leave a window with no way back.
    if (document.pictureInPictureElement === tile.media) void document.exitPictureInPicture().catch(() => {})
    ;(tile.wrap.closest('.stage-tile') ?? tile.wrap).remove()
    if (tile.media.parentElement === sink) tile.media.remove()
    const i = stageTiles.indexOf(tile)
    if (i >= 0) stageTiles.splice(i, 1)
    if (tile.recUrl) URL.revokeObjectURL(tile.recUrl)
    if (tile.peerId) {
      const rest = (peerMedia.get(tile.peerId) ?? []).filter((x) => x !== tile.media)
      if (rest.length) peerMedia.set(tile.peerId, rest)
      else peerMedia.delete(tile.peerId)
    }
    notifyStage()
    renderRoster()
  }

  /** Build a source tile. Video becomes a .stage-tile with a nameplate and overlay
   *  controls; audio-only becomes a bare <audio> parked in the hidden sink. */
  function addStageTile(opts: { peerId: string | null; kind: SourceKind; label: string; stream: MediaStream; localMuted?: boolean }): StageTile {
    const hasVideo = opts.stream.getVideoTracks().length > 0
    const media = (hasVideo ? el('video', { class: 'tile', autoplay: '', playsinline: '' }) : el('audio', { autoplay: '' })) as HTMLMediaElement
    media.srcObject = opts.stream
    if (opts.localMuted) media.muted = true // never monitor your own mic (echo)
    const tile: StageTile = {
      id: `${opts.peerId ?? 'local'}:${opts.stream.id}`,
      peerId: opts.peerId,
      kind: opts.kind,
      label: opts.label,
      hasVideo,
      stream: opts.stream,
      media,
      wrap: media,
      recorder: null,
      recUrl: '',
      fsBtn: null,
    }
    if (hasVideo) {
      // Fullscreen targets the WRAPPER, not the <video>: fullscreening the media element
      // alone drops the nameplate and the overlay controls out of the fullscreen layer.
      const wrap = el('div', { class: `stage-tile kind-${opts.kind}`, tabindex: '0' })
      const toggleFs = () => {
        if (document.fullscreenElement === wrap) void document.exitFullscreen?.()
        else void wrap.requestFullscreen?.().catch(() => {})
      }
      const ctl = el('div', { class: 'tile-ctl' })
      // Every tile renders the same four buttons, so an unqualified label reads as N
      // identical controls to a screen reader. The label is already validated and
      // 40-char capped by asMeta, so naming them costs no extra injection surface.
      const fsBtn = button('🔳', toggleFs, 'icon sm', `Fullscreen ${opts.label}`)
      tile.fsBtn = fsBtn
      ctl.append(
        button('📌', () => toggleSpot(tile.id), 'icon sm', `Spotlight ${opts.label}`),
        fsBtn,
      )
      // Windowed mode: PiP floats this source above other applications, which is the one
      // thing fullscreen cannot do. It is absent in some browsers and can be turned off
      // per element, so the control is only built when it would actually work rather
      // than being rendered and left to throw on click. The glyph keeps its state in the class
      // instead of a second glyph, because every square glyph already means fullscreen.
      const vid = media as HTMLVideoElement
      if (document.pictureInPictureEnabled && !vid.disablePictureInPicture) {
        const pipBtn = button(
          '🗔',
          () => {
            if (document.pictureInPictureElement === vid) void document.exitPictureInPicture().catch(() => {})
            else void vid.requestPictureInPicture().catch(() => toast('Windowed mode was refused'))
          },
          'icon sm',
          `Windowed mode for ${opts.label}: float it above other applications`,
        )
        // The browser also leaves PiP on its own (the floating window's close button, a
        // second video taking the slot), so the glyph follows the element, not the click.
        const syncPip = () => {
          const on = document.pictureInPictureElement === vid
          pipBtn.classList.toggle('on', on)
          pipBtn.setAttribute('aria-pressed', String(on))
          const t = on ? `Close the floating window for ${opts.label}` : `Windowed mode for ${opts.label}: float it above other applications`
          pipBtn.title = t
          pipBtn.setAttribute('aria-label', t)
        }
        vid.addEventListener('enterpictureinpicture', syncPip)
        vid.addEventListener('leavepictureinpicture', syncPip)
        syncPip()
        ctl.append(pipBtn)
      }
      if (opts.stream.getAudioTracks().length && opts.peerId) {
        const mb = button(
          '🔊',
          () => {
            media.muted = !media.muted
            mb.textContent = media.muted ? '🔇' : '🔊'
            mb.title = media.muted ? `Unmute ${opts.label}` : `Mute ${opts.label}`
            mb.setAttribute('aria-label', mb.title)
          },
          'icon sm',
          `Mute ${opts.label}`,
        )
        ctl.append(mb)
      }
      if (opts.peerId === null) {
        // unpublish() was correct but only ever reachable through "stop everything";
        // sharing cam + screen and wanting to drop just the screen was impossible.
        ctl.append(button('⏹', () => unpublish(opts.stream), 'icon sm', `Stop sharing ${opts.label}`))
      } else {
        ctl.append(button('🚫', () => removeStageTile(tile), 'icon sm', `Remove ${opts.label} from the stage (they keep sending; re-appears if they restart)`))
      }
      // Double-click anywhere on the tile is the affordance people actually reach for;
      // the overlay button is invisible until hover and absent entirely on touch.
      wrap.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button')) return
        toggleFs()
      })
      wrap.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== 'f') return
        if ((e.target as HTMLElement).closest('button')) return
        e.preventDefault()
        toggleFs()
      })
      wrap.append(media, el('div', { class: 'tile-name', text: `${labelIcon(opts.kind)} ${opts.label}` }), ctl)
      tile.wrap = wrap
      tiles.append(wrap)
    } else {
      sink.append(media)
    }
    stageTiles.push(tile)
    return tile
  }

  function attachPeerStream(peerId: string, stream: MediaStream, meta?: unknown) {
    const m = asMeta(meta)
    const peerName = mergedPeers().find((x) => x.peer.peerId === peerId)?.peer.name ?? 'peer'
    const kind: SourceKind = m?.kind ?? (stream.getVideoTracks().length ? 'cam' : 'mic')
    const label = m?.label ?? peerName
    const tile = addStageTile({ peerId, kind, label, stream })
    // A peer starting a screen share is the one event that should re-aim the stage,
    // but only when nothing is pinned, so a spotlight the user chose is never stolen.
    if (kind === 'screen' && !spotId) toggleSpot(tile.id)
    // Keep peerMedia so the roster's per-peer mute/volume control still works.
    const arr = peerMedia.get(peerId) ?? []
    arr.push(tile.media)
    peerMedia.set(peerId, arr)
    // Drop the tile once the sender stops. Otherwise a stopped screen-share froze on its
    // last frame forever.
    const gone = () => {
      if (stream.getTracks().some((t) => t.readyState === 'live' && !t.muted)) return
      if (stageTiles.includes(tile)) removeStageTile(tile)
    }
    const watchTrack = (t: MediaStreamTrack) => {
      t.addEventListener('ended', gone)
      t.addEventListener('mute', () => window.setTimeout(gone, 3000)) // transient mutes shouldn't tear it down
    }
    stream.getTracks().forEach(watchTrack)
    stream.addEventListener('addtrack', (e) => watchTrack(e.track))
    stream.addEventListener('removetrack', () => window.setTimeout(gone, 0))
    notifyStage()
    renderRoster()
  }

  /** Only render streams from handshake-authenticated peers; buffer the race window.
   *  Metadata (kind/label) rides alongside so it survives the buffering. */
  function maybeAttachStream(peerId: string, stream: MediaStream, meta?: unknown) {
    if (isDropped(peerId)) return // else it would occupy a pendingStreams slot for good
    if (mergedPeers().some((x) => x.peer.peerId === peerId && x.peer.ready)) {
      attachPeerStream(peerId, stream, meta)
      return
    }
    if (pendingStreams.size >= MAX_PENDING_STREAMS) return
    const arr = pendingStreams.get(peerId) ?? []
    arr.push([stream, meta])
    pendingStreams.set(peerId, arr)
  }
  function flushPendingStreams() {
    for (const [peerId, streams] of pendingStreams) {
      if (!mergedPeers().some((x) => x.peer.peerId === peerId && x.peer.ready)) continue
      pendingStreams.delete(peerId)
      for (const [s, meta] of streams) attachPeerStream(peerId, s, meta)
    }
  }
  function dropPeerMedia(peerId: string) {
    for (const t of stageTiles.filter((t) => t.peerId === peerId)) removeStageTile(t)
    peerMedia.delete(peerId)
    pendingStreams.delete(peerId)
  }

  /** Local cam/mic/screen go to trusted tiers (personal + code), never to nearby. */
  const mediaTiers = () => MEDIA_TIERS.map((t) => sessions.get(t)).filter((s): s is RoomSession => !!s)

  // ---------- live captions, on-device Whisper (ARCHITECTURE section 4.3) ----------
  // Proactive: once enabled (below or in Settings ⚙) every mic/cam share is
  // transcribed locally from then on. The first share offers it exactly once.
  let captionsStop: (() => void) | null = null
  let captionsDispose: (() => void) | null = null
  let captionsOffered = false
  let capIdle = 0
  let capLines: string[] = []
  const capText = el('span', { class: 'cap-text' })
  // Minimize collapses to just the CC pill but keeps transcribing. Delete turns
  // captions off for this share (and free the Whisper worker).
  const capMinBtn = button(
    '🔽',
    () => {
      const min = captionsEl.classList.toggle('cap-min')
      capMinBtn.textContent = min ? '🔼' : '🔽'
    },
    'icon sm',
    'Minimize captions (keeps transcribing)',
  )
  const captionsEl = el('div', { class: 'captions hidden', role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'badge', text: 'CC' }),
    capText,
    capMinBtn,
    button('🗑', () => endCaptions(), 'icon sm', 'Turn captions off for this share'),
  ])
  const showCaption = (t: string, status = false) => {
    captionsEl.classList.remove('hidden')
    capText.classList.toggle('muted', status)
    if (status) capText.textContent = t
    else {
      capLines = [...capLines, t].slice(-2)
      capText.textContent = capLines.join(' ')
    }
    window.clearTimeout(capIdle)
    capIdle = window.setTimeout(() => captionsEl.classList.add('hidden'), 12000)
  }
  function stopCaptions() {
    captionsStop?.()
    captionsStop = null
    capLines = []
    captionsEl.classList.add('hidden')
    captionsEl.classList.remove('cap-min')
    capMinBtn.textContent = '🔽'
  }
  // Stop AND free the Whisper worker/decoder. Used when the user turns captions off or
  // stops sharing, so the model doesn't stay resident for the page's life.
  function endCaptions() {
    stopCaptions()
    captionsDispose?.()
    captionsDispose = null
  }
  async function beginCaptions(stream: MediaStream) {
    stopCaptions()
    try {
      const cap = await import('./captions')
      captionsStop = cap.startCaptions(
        stream,
        (line) => showCaption(line),
        (s) => showCaption(s, true),
      ).stop
      captionsDispose = cap.disposeCaptions
      showCaption('Live captions on. Your speech is transcribed on this device only.', true)
    } catch (e) {
      showCaption(`Captions failed: ${(e as Error).message}`, true)
    }
  }
  async function maybeOfferCaptions(stream: MediaStream) {
    if ((await getItem<boolean>('live-captions')) ?? false) {
      void beginCaptions(stream)
      return
    }
    if (captionsOffered) return
    captionsOffered = true
    const enable = button(
      'Turn on live captions',
      () => {
        void setItem('live-captions', true)
        void beginCaptions(stream)
        enable.replaceWith(el('span', { class: 'muted small', text: 'Captions on. They auto-start with your mic from now on (Settings ⚙ turns them off).' }))
      },
      'ghost small',
      'Transcribe your mic on this device (a small model downloads once); auto-on for future shares',
    )
    addCard(el('div', { class: 'sys' }, [el('span', { text: 'Mic is live. Want on-device captions of what you say? ' }), enable]))
  }

  const kindLabelSelf = (k: SourceKind) => (k === 'screen' ? 'Your screen' : k === 'mic' ? 'Your mic' : 'Your camera')

  // Mute/blank toggles. They only appear once you actually publish a track of that kind,
  // so the bar stays empty until there is something to mute.
  const micToggle = button('🎤', () => setLocalEnabled('audio', !localTracksOf('audio').some((t) => t.enabled)), 'icon', 'Mute your microphone')
  const camToggle = button('🎥', () => setLocalEnabled('video', !localTracksOf('video').some((t) => t.enabled)), 'icon', 'Turn your camera off')
  /** Reflect real track state in the bar: the buttons are a view of the tracks. */
  function syncMediaButtons(): void {
    const a = localTracksOf('audio')
    const v = localTracksOf('video')
    const aOn = a.some((t) => t.enabled)
    const vOn = v.some((t) => t.enabled)
    micToggle.classList.toggle('hidden', !a.length)
    camToggle.classList.toggle('hidden', !v.length)
    micToggle.textContent = aOn ? '🎤' : '🔇'
    camToggle.textContent = vOn ? '🎥' : '🚫'
    micToggle.title = aOn ? 'Mute your microphone' : 'Unmute your microphone'
    camToggle.title = vOn ? 'Turn your camera off' : 'Turn your camera on'
    micToggle.setAttribute('aria-label', micToggle.title)
    camToggle.setAttribute('aria-label', camToggle.title)
    micToggle.setAttribute('aria-pressed', String(!aOn))
    camToggle.setAttribute('aria-pressed', String(!vOn))
  }

  /** Publish one local source (camera / screen / mic) to the trusted tiers (personal +
   *  code, NEVER nearby), tagging it with {kind,label} metadata and adding a stage tile.
   *  This is the single publish path for both the composer buttons and the Studio tool. */
  async function publishLocal(kind: SourceKind, constraints: MediaStreamConstraints): Promise<void> {
    if (stageView) return // a chromeless stage viewer never publishes
    const stream = kind === 'screen' ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) : await navigator.mediaDevices.getUserMedia(constraints)
    const meta: StreamMeta = { kind, label: kindLabelSelf(kind) }
    localStreams.set(stream, meta)
    const targets = mediaTiers()
    for (const s of targets) await s.addMedia(stream, meta)
    addStageTile({ peerId: null, kind, label: meta.label, stream, localMuted: true })
    notifyStage()
    syncMediaButtons()
    if (!targets.length) sys('Started locally. Pair a device or share a code to stream it.')
    else if (sessions.has('nearby')) sys('Streaming to paired/code devices only; nearby peers never get your media automatically.')
    if (kind !== 'screen' && stream.getAudioTracks().length) void maybeOfferCaptions(stream)
  }

  async function startMedia(mode: 'audio' | 'video' | 'screen') {
    const kind: SourceKind = mode === 'screen' ? 'screen' : mode === 'video' ? 'cam' : 'mic'
    const constraints: MediaStreamConstraints = mode === 'screen' ? {} : { audio: true, video: mode === 'video' }
    try {
      await publishLocal(kind, constraints)
    } catch {
      toast('Camera/mic/screen denied or unavailable')
    }
  }
  /** Every local track of one kind, across all published streams. */
  const localTracksOf = (k: 'audio' | 'video') => [...localStreams.keys()].flatMap((st) => (k === 'audio' ? st.getAudioTracks() : st.getVideoTracks()))

  /** Mute the mic / blank the camera by flipping `track.enabled`. This is deliberately
   *  NOT the same as stopping the track: stopping tears the source down, removes it from
   *  every session and forces a fresh getUserMedia with a NEW stream id on resume, so
   *  peers watch you disappear and come back. Flipping `enabled` keeps the transport and
   *  the id; you just go quiet/black. Returns the new on-state. */
  function setLocalEnabled(k: 'audio' | 'video', on: boolean): void {
    for (const t of localTracksOf(k)) t.enabled = on
    syncMediaButtons()
  }

  /** Stop one own stream (leave others running). */
  function unpublish(stream: MediaStream) {
    for (const sess of mediaTiers()) sess.removeMedia(stream)
    stream.getTracks().forEach((t) => t.stop())
    localStreams.delete(stream)
    for (const t of stageTiles.filter((t) => t.peerId === null && t.stream === stream)) removeStageTile(t)
    syncMediaButtons()
  }
  function stopMedia() {
    for (const s of [...localStreams.keys()]) unpublish(s)
    endCaptions() // sharing ended, so also free the caption worker
  }

  // ---------- tool launcher (anchored panel: hover to open, drag to reorder) ----------
  let toolOrder: string[] = (await getItem<string[]>('tool-order')) ?? []
  const orderedTools = () => {
    const all = registry.list()
    const pos = (id: string) => {
      const i = toolOrder.indexOf(id)
      return i === -1 ? toolOrder.length + all.findIndex((m) => m.id === id) : i
    }
    return all.slice().sort((a, b) => pos(a.id) - pos(b.id))
  }

  let launcher: HTMLElement | null = null
  let launcherCloseTimer = 0
  // Hover preview: a values flyout for the Generators launcher item (declared here so
  // closeLauncher can dismiss it in the same gesture).
  let genFlyout: HTMLElement | null = null
  let genCloseTimer = 0
  const closeGenFlyout = () => {
    genFlyout?.remove()
    genFlyout = null
  }
  // Generous grace so the pointer can travel from the launcher item to the flyout
  // (crossing sibling items and the gap) without the list vanishing underway.
  const scheduleGenClose = () => {
    window.clearTimeout(genCloseTimer)
    genCloseTimer = window.setTimeout(closeGenFlyout, 450)
  }
  const closeLauncher = () => {
    launcher?.remove()
    launcher = null
    closeGenFlyout()
  }
  const scheduleLauncherClose = () => {
    window.clearTimeout(launcherCloseTimer)
    launcherCloseTimer = window.setTimeout(closeLauncher, 450)
  }

  /** Position a floating menu below an anchor (flipping above in the lower half of the
   *  viewport). Per-property CSSOM only: no inline style attribute, so it stays within
   *  CSP style-src 'self'. */
  const placeMenu = (menu: HTMLElement, r: DOMRect) => {
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`
    if (r.top > window.innerHeight / 2) menu.style.bottom = `${window.innerHeight - r.top + 6}px`
    else menu.style.top = `${r.bottom + 6}px`
  }

  /** Place a submenu beside the open launcher (left if it fits, else right), vertically
   *  aligned to the hovered item, never over the launcher, so its items stay clickable. */
  const placeSideMenu = (menu: HTMLElement, itemRect: DOMRect) => {
    const lr = launcher?.getBoundingClientRect()
    const w = menu.offsetWidth
    let left = lr ? lr.left - w - 8 : itemRect.right + 8
    if (left < 8) left = lr ? lr.right + 8 : itemRect.right + 8
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(itemRect.top, window.innerHeight - menu.offsetHeight - 8))}px`
  }

  // Hovering the Generators launcher item opens a scrollable, region-aware list of freshly
  // generated values; click any value to copy (no need to open the full tool).
  async function openGenValues(item: HTMLElement) {
    closeGenFlyout()
    window.clearTimeout(genCloseTimer)
    const head = el('div', { class: 'gen-fly-head' }, [el('strong', { text: '🎲 Quick copy' })])
    const listEl = el('div', { class: 'gen-fly-list', text: 'Loading...' })
    const menu = el('div', { class: 'gen-flyout' }, [head, listEl])
    menu.addEventListener('mouseenter', () => {
      window.clearTimeout(genCloseTimer)
      window.clearTimeout(launcherCloseTimer)
    })
    menu.addEventListener('mouseleave', scheduleGenClose)
    document.body.append(menu)
    placeSideMenu(menu, item.getBoundingClientRect())
    genFlyout = menu
    try {
      const gen = await import('../tools/generators')
      if (genFlyout !== menu) return // hover moved on while the chunk loaded
      await gen.mountQuickCopy(listEl, () => placeSideMenu(menu, item.getBoundingClientRect()))
      if (genFlyout !== menu) return
      placeSideMenu(menu, item.getBoundingClientRect()) // re-place now that the height is known
    } catch (e) {
      listEl.textContent = `Could not load: ${(e as Error).message}`
    }
  }

  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as Node
      if (!genFlyout?.contains(t) && !launcher?.contains(t)) {
        closeLauncher()
        closeGenFlyout()
      }
    },
    true,
  )

  function openTools(filter = '', anchor?: HTMLElement) {
    closeLauncher()
    window.clearTimeout(launcherCloseTimer)
    const menu = el('div', { class: 'menu tool-grid' })
    let dragId: string | null = null
    const renderItems = () => {
      menu.replaceChildren()
      const list = orderedTools().filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()))
      for (const m of list) {
        const b = button(
          `${m.icon ?? '🔧'} ${m.name}`,
          () => {
            closeLauncher()
            void launchTool(m)
          },
          'ghost',
          `${m.description} (drag to reorder)`,
        )
        b.draggable = true
        b.addEventListener('dragstart', () => {
          dragId = m.id
        })
        b.addEventListener('dragover', (e) => e.preventDefault())
        b.addEventListener('drop', (e) => {
          e.preventDefault()
          if (!dragId || dragId === m.id) return
          const order = orderedTools()
            .map((t) => t.id)
            .filter((id) => id !== dragId)
          order.splice(order.indexOf(m.id), 0, dragId)
          toolOrder = order
          void setItem('tool-order', toolOrder)
          renderItems()
        })
        // Generators shows a live value list on hover (click a value to copy); other
        // items *schedule* its dismissal. Never instant, or the flyout would vanish
        // while the mouse crosses siblings on its way over to the values.
        if (m.id === 'generators') {
          b.addEventListener('mouseenter', () => void openGenValues(b))
          b.addEventListener('mouseleave', scheduleGenClose)
        } else {
          b.addEventListener('mouseenter', scheduleGenClose)
        }
        menu.append(b)
      }
      if (!list.length) menu.append(el('div', { class: 'muted small', text: 'No tool matches.' }))
    }
    renderItems()
    menu.addEventListener('mouseenter', () => window.clearTimeout(launcherCloseTimer))
    menu.addEventListener('mouseleave', scheduleLauncherClose)
    document.body.append(menu)
    placeMenu(menu, (anchor ?? topbar).getBoundingClientRect())
    launcher = menu
  }
  /** Give a button hover-open behavior for the launcher. */
  const hoverTools = (b: HTMLElement) => {
    b.addEventListener('mouseenter', () => openTools('', b))
    b.addEventListener('mouseleave', scheduleLauncherClose)
    return b
  }

  async function launchTool(m: ToolManifest) {
    let mod: ToolModule | null = null
    const container = el('div')
    const { card, body } = collapsibleCard([
      el('strong', { text: `${m.icon ?? '🔧'} ${m.name}` }),
      el('span', { class: 'spacer' }),
      button('🔗', () => void copyText(`${location.origin}${location.pathname}#/t/${m.id}`), 'icon sm', 'Copy a direct link to this tool'),
    ])
    body.append(container)
    addCard(card, () => mod?.deactivate?.(container))
    try {
      const loaded = await m.load()
      mod = 'default' in loaded ? loaded.default : loaded
      await mod.activate(container, createContext(m))
    } catch (e) {
      container.append(el('pre', { text: `Failed: ${(e as Error).message}` }))
    }
  }

  // ---------- composer ----------
  const ta = el('textarea', { rows: '1', placeholder: p2pReady ? 'Message your devices, or type / for tools' : 'Type, or / for tools' }) as HTMLTextAreaElement
  const autosize = () => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.38)}px`
  }
  const fileInput = el('input', { type: 'file', class: 'hidden' }) as HTMLInputElement
  const imgInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden' }) as HTMLInputElement

  const send = () => {
    const text = ta.value.trim()
    if (!text) return
    if (text.startsWith('/')) {
      openTools(text.slice(1).trim(), slashBtn)
      ta.value = ''
      autosize()
      return
    }
    // The placeholder invites typing a join code right here: digit-bearing codes
    // auto-join; 6-letter code-alphabet words get a Join button (could be a word).
    const id = crypto.randomUUID()
    const ts = Date.now()
    const node = chatCard({ id, peerId: 'self', deviceId: selfDeviceId(), name: `${displayName} (you)`, text, ts, mine: true })
    remember({ id, deviceId: selfDeviceId(), name: displayName, text, ts, kind: 'chat', tier: 'me' })
    const c = p2pReady ? chatCodeCandidate(text) : null
    if (c && c.code !== codeLabel) {
      const join = () =>
        void setCode(c.code).then((ok) => {
          if (ok) toast(`Joined code ${c.code.toUpperCase()}`)
        })
      if (c.auto) {
        sys(`"${c.code}" is a join code. Connecting...`)
        join()
      } else {
        node.append(button(`Join code ${c.code.toUpperCase()}`, join, 'ghost small', 'Connect using this as a join code'))
      }
    }
    addCard(node)
    if (reachableCount() > 0) {
      void sendChatAll(text, id)
    } else if (!c?.auto) {
      outbox.push({ text, id })
      toast('No one connected. Message queued; sends when a device joins')
    }
    ta.value = ''
    autosize()
  }
  ta.addEventListener('input', autosize)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })

  async function handleAttach(file: File | null | undefined) {
    if (!file) return
    const { card, body } = collapsibleCard([el('strong', { text: file.name }), el('span', { class: 'muted small', text: `${Math.round(file.size / 1024)} KB` })])
    const actions = el('div', { class: 'row' })
    if (file.type.startsWith('image/')) {
      const u = URL.createObjectURL(file)
      const img = el('img', { class: 'preview', alt: file.name }) as HTMLImageElement
      img.src = u
      img.onload = () => URL.revokeObjectURL(u)
      img.onerror = () => URL.revokeObjectURL(u) // revoke even if the image fails to decode
      body.append(img)
      const out = el('pre', { class: 'muted hidden' })
      const mode = await ocrMode()
      if (mode === 'off') actions.append(ocrButton(() => file, out))
      else {
        void runOcrInto(file, out, mode === 'copy')
        actions.append(copyBtn(() => out.textContent ?? ''))
      }
      const sf = sendFileBtn(() => file)
      if (sf) actions.append(sf)
      body.append(actions, out)
    } else {
      const sf = sendFileBtn(() => file)
      if (sf) actions.append(sf)
      body.append(actions)
    }
    addCard(card)
  }
  fileInput.addEventListener('change', () => void handleAttach(fileInput.files?.[0]))
  imgInput.addEventListener('change', () => void handleAttach(imgInput.files?.[0]))

  const slashBtn = hoverTools(button('/', () => openTools('', slashBtn), 'icon', 'Tools (hover to open, drag to reorder)'))
  const composer = el('div', { class: 'composer' }, [
    ta,
    el('div', { class: 'bar' }, [
      button('📎', () => fileInput.click(), 'icon', 'Attach a file'),
      button('🖼', () => imgInput.click(), 'icon', 'Attach an image'),
      button('🎤', () => void startMedia('audio'), 'icon', 'Share your microphone (paired/code devices only; can live-caption you on-device)'),
      button('🎥', () => void startMedia('video'), 'icon', 'Share your camera (paired/code devices only)'),
      button('🖥', () => void startMedia('screen'), 'icon', 'Share your screen (paired/code devices only)'),
      micToggle,
      camToggle,
      button('⏹', stopMedia, 'icon', 'Stop sharing cam/mic/screen'),
      slashBtn,
      el('span', { class: 'spacer' }),
      button('Send', send, 'primary', 'Send to every connected device (Enter)'),
    ]),
  ])
  const composerWrap = el('div', { class: 'composer-wrap' }, [composer, fileInput, imgInput])
  syncMediaButtons() // nothing is published yet, so the mute/blank toggles start hidden

  // ---------- sessions ----------
  const makeEvents = (tier: Tier): SessionEvents => ({
    onRoster: (list) => {
      if (!sessions.has(tier)) return // late event from a session we already left
      rosters.set(tier, list)
      flushPendingStreams()
      settleInvites()
      renderRoster()
      updateStatus()
      void flushOutbox()
    },
    onChat: (m) => {
      if (dropped.has(m.deviceId)) return
      remember({ id: m.id, deviceId: m.deviceId, name: m.name, text: m.text, ts: m.ts, kind: 'chat', tier })
      const node = chatCard(m)
      // A code that arrives in a PEER's message always requires an explicit click,
      // never the auto-join branch the composer uses for text you typed yourself.
      // Auto-joining on inbound text let any peer who can chat you (including an
      // untrusted `nearby` stranger) send one digit-bearing word to pull you out of
      // your current code room and into one they control; because `code` is a media
      // tier, joinTier would then republish your live camera/mic/screen into it.
      // Switching rooms is a user decision, so it takes a user gesture.
      const c = m.mine ? null : chatCodeCandidate(m.text)
      if (c && c.code !== codeLabel) {
        const join = () =>
          void setCode(c.code).then((ok) => {
            if (ok) toast(`Joined code ${c.code.toUpperCase()}`)
          })
        node.append(button(`Join code ${c.code.toUpperCase()}`, join, 'ghost small', 'Use this message as a join code'))
      }
      addCard(node)
    },
    onSystem: (t) => sys(t),
    onFileReceived: (f) => {
      if (dropped.has(f.from)) return
      remember({ id: f.id, deviceId: f.from, name: senderLabel(f.from), text: f.name, ts: Date.now(), kind: 'file', size: f.size, tier })
      addCard(fileCard(f))
    },
    onHistoryRequest: (peerId) => {
      if (isDropped(peerId)) return // `dropped` is keyed by deviceId, so ask through the peerId helper
      askToShareHistory(peerId, tier)
    },
    onPeerStream: (peerId, stream, meta) => maybeAttachStream(peerId, stream, meta),
    onPeerLeave: (peerId) => {
      if (!isPresent(peerId)) dropPeerMedia(peerId)
      renderRoster()
    },
    // The presence tier's one channel. `offer` is presented and waits for a click;
    // nothing here joins a room.
    onInvite: (sig: InviteSignal) => {
      if (dropped.has(sig.deviceId)) return
      if (sig.kind === 'withdraw') {
        dismissInvite(sig.peerId)
        return
      }
      if (sig.kind === 'decline') {
        const pend = pendingInvites.get(sig.pubKeyHex)
        if (!pend) return
        window.clearTimeout(pend.timer)
        pendingInvites.delete(sig.pubKeyHex)
        renderRoster()
        sys(`device ${sig.deviceId.slice(0, 6)} declined your invite.`)
        return
      }
      if (sig.code === codeLabel) return // already in the room they are offering
      showInvite(sig)
    },
  })

  async function joinTier(tier: Tier, room: { roomId: string; password: string }): Promise<RoomSession | null> {
    const existing = sessions.get(tier)
    if (existing) return existing
    try {
      // Lazy-load the P2P engine (Trystero/zod/manifest) so it stays out of the
      // initial bundle. The UI has already painted; rooms connect a moment later.
      const { joinRoomSession } = await import('../p2p/session')
      const s = await joinRoomSession({
        ...room,
        displayName,
        relayOnly: false,
        primary: tier === 'personal',
        presenceOnly: tier === 'presence',
        allowHistory: HISTORY_TIERS.includes(tier),
        events: makeEvents(tier),
      })
      sessions.set(tier, s)
      rosters.set(tier, [])
      applyHistory() // before any handshake completes, so the first peer is already governed
      if (MEDIA_TIERS.includes(tier)) for (const [ls, meta] of localStreams) await s.addMedia(ls, meta)
      renderRoster()
      updateStatus()
      return s
    } catch (e) {
      sys(e instanceof CryptoUnsupportedError ? 'P2P unavailable on this browser. Local tools still work.' : `Could not connect (${tier}): ${(e as Error).message}`)
      return null
    }
  }

  async function leaveTier(tier: Tier) {
    const s = sessions.get(tier)
    if (!s) return
    sessions.delete(tier)
    rosters.delete(tier)
    if (tier === 'code') codeLabel = ''
    renderRoster()
    updateStatus()
    await s.leave()
  }

  /** Put the active code in the address bar as #/join/<code>, so copying the URL out of
   *  the address bar is already an invite: no button, no explanation. replaceState leaves
   *  no history entry and fires no hashchange, so the router never re-dispatches.
   *  Only a hash we own is written: nothing, root, or a #/join/... A #/t/<tool> deep link
   *  and the view-only #/stage/<code> route are left exactly as the visitor typed them,
   *  and since nothing in the app navigates by hash, "own" is decided per write.
   *
   *  The optional `?p=1` suffix rides along when WE are on the online list, so copying the
   *  address bar propagates that opt-in as a question. It is written from our own state,
   *  which is what makes declining an inbound flag stick: the next write drops it. */
  const syncCodeUrl = () => {
    if (stageView) return
    const h = location.hash
    if (h && h !== '#' && h !== '#/' && !/^#\/join\/[A-Za-z0-9-]{2,64}(\?p=1)?$/.test(h)) return
    const base = `${location.pathname}${location.search}`
    const next = codeLabel ? `${base}#/join/${codeLabel}${presenceWanted ? '?p=1' : ''}` : base
    if (`${base}${h}` !== next) history.replaceState(null, '', next)
  }

  /** The link that IS the invite: it opens urletc already joined to our code room. */
  const inviteLink = (code: string) => `${location.origin}${location.pathname}#/join/${code}${presenceWanted ? '?p=1' : ''}`

  /** Switch the code room: null = just leave; a code = leave current + join that one.
   *  The active code is persisted so it survives a reload: same code next visit,
   *  whether it was auto-generated, self-chosen, or one you joined. */
  async function setCode(code: string | null): Promise<boolean> {
    await leaveTier('code')
    if (code) {
      codeLabel = code
      if (!(await joinTier('code', await codeRoom(code)))) codeLabel = ''
    }
    await (codeLabel ? setItem('join-code', codeLabel) : removeItem('join-code'))
    updateCodeChip()
    syncCodeUrl()
    return !!codeLabel
  }

  // ---------- visible to reachable: invites on the presence tier ----------
  /** Ask a presence peer to join our code room. We join nothing new (a code room is
   *  already open) and send them nothing but the code, over the invite channel. */
  async function invitePeer(p: RosterPeer): Promise<void> {
    const presence = sessions.get('presence')
    if (!presence) return
    const who = peerLabel(p, 'presence')
    if (!codeLabel && !(await setCode(generateJoinCode()))) {
      toast('Could not open a room to invite them to')
      return
    }
    const code = codeLabel
    if (!(await presence.sendInvite(p.peerId, code))) {
      toast(`Could not reach ${who}`)
      return
    }
    const timer = window.setTimeout(() => {
      if (!pendingInvites.delete(p.pubKeyHex)) return
      renderRoster()
      sys(`${who} did not answer your invite. Nothing was shared.`)
    }, INVITE_TIMEOUT)
    pendingInvites.set(p.pubKeyHex, { peerId: p.peerId, code, timer })
    renderRoster()
    sys(`Invited ${who} to code ${code.toUpperCase()}. Waiting for them to accept.`)
  }

  /** Withdraw an invite: their prompt disappears and we stay where we are. */
  async function cancelInvite(p: RosterPeer): Promise<void> {
    const pend = pendingInvites.get(p.pubKeyHex)
    if (!pend) return
    window.clearTimeout(pend.timer)
    pendingInvites.delete(p.pubKeyHex)
    renderRoster()
    await sessions.get('presence')?.withdrawInvite(pend.peerId)
    toast('Invite cancelled')
  }

  /** An invite lands when the peer turns up in a tier that actually carries traffic, so
   *  "accepted" is read off the roster rather than trusted from a message saying so. */
  function settleInvites(): void {
    if (!pendingInvites.size) return
    let changed = false
    for (const [key, pend] of pendingInvites) {
      const hit = mergedPeers().find((x) => x.peer.pubKeyHex === key && x.peer.ready && BROADCAST_TIERS.includes(x.tier))
      if (!hit) continue
      window.clearTimeout(pend.timer)
      pendingInvites.delete(key)
      changed = true
      sys(`device ${hit.peer.deviceId.slice(0, 6)} accepted. You can message each other now.`)
    }
    if (changed) renderRoster()
  }

  /** Take an inbound invite prompt off screen. */
  function dismissInvite(peerId: string): void {
    const card = inboundInvites.get(peerId)
    inboundInvites.delete(peerId)
    card?.closest('.feed-item')?.remove()
  }

  /**
   * Render an inbound invite. It NEVER joins on its own. An invite is a request, and any
   * peer who can see the online list can send one, so acting on it without a click would
   * let a stranger move this device into a room they control (and `code` is a media tier).
   * The prompt names them by key fingerprint, which they cannot spoof, and demotes the
   * name they claim.
   */
  function showInvite(sig: InviteSignal): void {
    dismissInvite(sig.peerId)
    if (inboundInvites.size >= MAX_INBOUND_INVITES) return
    const who = `device ${sig.deviceId.slice(0, 6)}`
    const card = el('div', { class: 'sys' })
    const join = button(
      `Connect to ${sig.code.toUpperCase()}`,
      () => {
        dismissInvite(sig.peerId)
        void setCode(sig.code).then((ok) => {
          if (ok) sys(`Joined ${sig.code.toUpperCase()}. You and ${who} can message each other now.`)
        })
      },
      'ghost small',
      'Join their room. Your camera, mic and screen stay off until you start them',
    )
    const no = button(
      'Ignore',
      () => {
        dismissInvite(sig.peerId)
        void sessions.get('presence')?.declineInvite(sig.peerId)
      },
      'ghost small',
      'Refuse this invite and tell them so',
    )
    card.append(el('span', { text: `${who}, calling itself "${sig.name.slice(0, 24)}", wants to connect. ` }), join, no)
    inboundInvites.set(sig.peerId, card)
    addCard(card, () => inboundInvites.delete(sig.peerId))
  }

  /** Drop a peer locally: the row goes, their media is torn down through the same path
   *  the stage uses (so peerMedia and the row's mute/volume controls stay consistent),
   *  and anything they send from now on is ignored. */
  function dropPeer(p: RosterPeer, tier: Tier): void {
    if (p.deviceId) dropped.add(p.deviceId)
    const pend = pendingInvites.get(p.pubKeyHex)
    if (pend) {
      window.clearTimeout(pend.timer)
      pendingInvites.delete(p.pubKeyHex)
    }
    dismissInvite(p.peerId)
    dropPeerMedia(p.peerId)
    renderRoster()
    updateStatus()
    toast(`Removed ${peerLabel(p, tier)}`)
  }

  // ---------- this device's name ----------
  // Shown in the roster as well as in Connect: the sidebar is where you look at who you
  // are among, so it is where you change how you appear. Every field stays in sync.
  const nameFields = new Set<HTMLInputElement>()
  const setDisplayName = (raw: string): void => {
    const v = raw.trim().slice(0, 32)
    if (!v || v === displayName) {
      for (const f of nameFields) f.value = displayName
      return
    }
    displayName = v
    void setItem('display-name', v)
    for (const s of sessions.values()) void s.setName(v)
    for (const f of [...nameFields]) {
      if (f.isConnected) f.value = v
      else nameFields.delete(f) // the Connect modal re-renders, so its old field goes stale
    }
    toast(`You now appear as "${v}"`)
  }
  const nameField = (): HTMLInputElement => {
    const f = el('input', {
      type: 'text',
      class: 'full',
      value: displayName,
      maxlength: '32',
      placeholder: 'Device name',
      title: 'The name other devices see',
      'aria-label': 'This device name',
    }) as HTMLInputElement
    f.addEventListener('change', () => setDisplayName(f.value))
    nameFields.add(f)
    return f
  }

  // ---------- connect modal ----------
  async function openConnect() {
    const prevFocus = document.activeElement as HTMLElement | null
    const back = el('div', { class: 'modal-back' })
    const close = () => {
      back.remove()
      document.removeEventListener('keydown', onKey)
      prevFocus?.focus?.()
    }
    // Escape cancels; Tab is trapped inside the dialog (mirrors consent() in ui.ts) so
    // focus can't wander to the page behind an aria-modal overlay.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (e.key !== 'Tab') return
      const f = content.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    back.addEventListener('click', (e) => {
      if (e.target === back) close()
    })
    const content = el('div', { class: 'modal stack', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Connect' })
    back.append(content)
    document.body.append(back)

    const render = async () => {
      content.replaceChildren(el('h4', { text: 'Connect' }))

      // "This device" is the name peers see. Renames propagate live to connected peers.
      // The same field is in the roster, so both are built by nameField().
      content.append(el('div', { class: 'group-label', text: 'This device' }), nameField())

      // Code is the fast path to reach anyone. Joining someone comes first (it is the
      // #1 ask: "I got a code, now what?"); sharing yours follows. All routes go
      // through setCode(), so either side's code becomes the room for both.
      content.append(
        el('div', { class: 'group-label', text: 'Join someone with their code' }),
        el('div', { class: 'muted small', text: 'Ask them for the code in their topbar (or send yours below). Same code = same room. Typing it in the message box also works.' }),
      )
      const codeInput = el('input', {
        type: 'text',
        class: 'full mono-input',
        placeholder: 'Code from the other device, e.g. k4mn2x',
        maxlength: '20',
        'aria-label': 'Join code',
      }) as HTMLInputElement
      const use = async () => {
        const code = normalizeJoinCode(codeInput.value)
        if (code.length < 4) {
          toast('Use at least 4 letters or digits')
          return
        }
        if (await setCode(code)) sys(`Your join code is now ${code.toUpperCase()}.`)
        void render()
      }
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void use()
      })
      content.append(el('div', { class: 'row' }, [codeInput, button('Join', () => void use(), 'primary', 'Connect with whoever uses this code; it becomes your code too')]))

      content.append(el('div', { class: 'group-label', text: codeLabel ? 'Or have them join you' : 'Or create a code to share' }))
      if (codeLabel) {
        // The invite link spares the other person any typing: it opens urletc
        // already joined to this room (#/join/<code>, see the router).
        const invite = inviteLink(codeLabel)
        content.append(
          el('div', { class: 'code-big', text: codeLabel }),
          el('div', { class: 'row' }, [
            button('Copy code', () => void copyText(codeLabel), 'ghost', 'Send it over any channel, then they type it on their device'),
            button('Copy invite link', () => void copyText(invite), 'ghost', 'Zero typing for them: the link opens urletc already joined to your room'),
            button(
              'New random code',
              async () => {
                const code = generateJoinCode()
                if (await setCode(code)) sys(`New join code: ${code.toUpperCase()}.`)
                void render()
              },
              'ghost',
              'Generate a fresh code (the old one stops working)',
            ),
            button(
              'Stop code room',
              () => {
                void setCode(null).then(render)
              },
              'ghost',
              'Close the code room. No one can join by code until you set a new one',
            ),
          ]),
        )
      } else {
        content.append(
          el('div', { class: 'row' }, [
            button(
              'Create a code',
              async () => {
                const code = generateJoinCode()
                if (await setCode(code)) sys(`New join code: ${code.toUpperCase()}.`)
                void render()
              },
              'ghost',
              'Generate a random join code to share',
            ),
          ]),
        )
      }

      // History sits directly under the code section because that is the setting it
      // qualifies: a code room is where sharing it would actually cost something.
      // Sending and receiving are two checkboxes, not one, and the one that can leak is
      // the one that starts off.
      content.append(el('div', { class: 'group-label', text: 'Earlier messages' }))
      const chk = (on: boolean) => {
        const c = el('input', { type: 'checkbox' }) as HTMLInputElement
        c.checked = on
        return c
      }
      const devChk = chk(shareToDevices)
      const codeChk = chk(shareToCode)
      const askChk = chk(askOnJoin)
      devChk.addEventListener('change', () => {
        shareToDevices = devChk.checked
        void setItem('history-share-devices', shareToDevices)
        applyHistory()
      })
      codeChk.addEventListener('change', () => {
        shareToCode = codeChk.checked
        void setItem('history-share-code', shareToCode)
        applyHistory()
      })
      askChk.addEventListener('change', () => {
        askOnJoin = askChk.checked
        void setItem('history-ask', askOnJoin)
        applyHistory()
      })
      const oldest = transcript.length ? new Date(transcript[0].ts).toLocaleDateString() : ''
      content.append(
        el('div', {
          class: 'muted small',
          text: transcript.length
            ? `${transcript.length} kept on this device, encrypted, back to ${oldest}. Capped at ${HISTORY_MAX} messages and 30 days; file names are kept, file contents never are.`
            : `Nothing stored yet. Messages are kept on this device, encrypted, capped at ${HISTORY_MAX} and 30 days; file names are kept, file contents never are.`,
        }),
        el('label', { class: 'row small' }, [devChk, el('span', { text: 'Send them to my own paired devices when they join' })]),
        el('label', { class: 'row small' }, [codeChk, el('span', { text: 'Send them to people who join by code' })]),
        el('div', {
          class: 'muted small',
          text: 'Off by default: anyone holding the code, including whoever it was forwarded to, would receive everything said in the room before they arrived.',
        }),
        el('label', { class: 'row small' }, [askChk, el('span', { text: 'Ask for earlier messages when I join a room' })]),
        el('div', { class: 'row' }, [
          button(
            'Show what is stored',
            () => {
              if (!transcript.length) {
                toast('Nothing stored')
                return
              }
              close()
              addCard(historyCard(transcript, 'stored on this device'), undefined, 'top')
            },
            'ghost',
            'Open the stored messages in the feed',
          ),
          button(
            'Delete stored history',
            () => {
              if (!transcript.length) {
                toast('Nothing stored')
                return
              }
              if (!confirm(`Delete ${transcript.length} stored message${transcript.length === 1 ? '' : 's'} from this device? They stop being replayed to anyone.`)) return
              void forgetHistory().then(() => {
                toast('Stored history deleted')
                void render()
              })
            },
            'ghost',
            'Erase the stored messages on this device',
          ),
        ]),
      )

      // Personal pairs your own devices for good (cross-network). Auto-share lives
      // here because it only ever targets these paired devices.
      content.append(el('div', { class: 'group-label', text: 'My devices (pair once)' }))
      try {
        const link = pairLink(await ensurePersonalSecret())
        const field = el('input', { type: 'text', class: 'full', value: link, readonly: '', 'aria-label': 'Pairing link' }) as HTMLInputElement
        const autoChk = el('input', { type: 'checkbox' }) as HTMLInputElement
        autoChk.checked = autoShare
        autoChk.addEventListener('change', () => {
          autoShare = autoChk.checked
          void setItem('auto-share', autoShare)
        })
        content.append(
          el('div', { class: 'muted small', text: 'Open this link on your other device. Both auto-join your private room from then on, on any network.' }),
          field,
          el('div', { class: 'row' }, [
            button('Copy link', () => void copyText(link), 'ghost', 'Copy the pairing link'),
            button(
              'Reset link',
              async () => {
                if (!confirm('Reset the pairing link? Devices paired with the old link disconnect until you pair them with the new one.')) return
                const secret = await resetPersonalSecret()
                await leaveTier('personal')
                await joinTier('personal', await personalRoom(secret))
                toast('New pairing link ready')
                void render()
              },
              'ghost',
              'Rotate the secret; old links stop working',
            ),
          ]),
          el('label', { class: 'row small' }, [autoChk, el('span', { text: 'Auto-share my clipboard with these paired devices' })]),
        )
      } catch {
        content.append(el('div', { class: 'muted small', text: 'Pairing needs a newer browser (crypto).' }))
      }

      // Nearby is automatic; just report state.
      const nearbyText =
        nearbyState === 'on'
          ? `On: anyone on this network running urletc appears under "Nearby". They stay untrusted until you verify them.`
          : nearbyState === 'searching'
            ? 'Checking this network...'
            : nearbyState === 'off'
              ? 'Off. Turn on Nearby discovery in Settings to find devices on this network.'
              : 'Unavailable on this network (WebRTC/UDP blocked).'
      content.append(el('div', { class: 'group-label', text: 'Nearby (automatic)' }), el('div', { class: 'muted small', text: nearbyText }))

      // Pre-call gear check: one click into the Device Check tool.
      content.append(
        el('div', { class: 'group-label', text: 'Before a call' }),
        el('div', { class: 'row' }, [
          button(
            '🎛 Test mic & camera',
            () => {
              close()
              const man = registry.get('device-check')
              if (man) void launchTool(man)
            },
            'ghost',
            'Preview your camera, meter your mic and record a test clip, all on-device',
          ),
        ]),
      )

      content.append(el('div', { class: 'row' }, [el('span', { class: 'spacer' }), button('Close', close, 'ghost')]))
    }
    await render()
    content.querySelector<HTMLElement>('input, button, select, textarea')?.focus() // land focus inside the dialog
  }

  // ---------- topbar + sidebar ----------
  const themeBtn = button(
    currentTheme() === 'dark' ? '☀' : '🌙',
    () => {
      themeBtn.textContent = toggleTheme() === 'dark' ? '☀' : '🌙'
    },
    'icon',
    'Switch between black and white theme',
  )
  const clearBtn = button('🗑', () => clearFeed(), 'icon', 'Clear everything in the feed')
  const codeChip = button(
    '',
    () => {
      if (!codeLabel) return
      void navigator.clipboard
        .writeText(codeLabel)
        .then(() => toast('Code copied'))
        .catch(() => toast('Copy blocked'))
    },
    'code-chip hidden',
    'Your join code. Anyone who types it under Connect reaches you. Click to copy.',
  )
  const updateCodeChip = () => {
    codeChip.textContent = codeLabel ? codeLabel.toUpperCase() : ''
    codeChip.classList.toggle('hidden', !codeLabel)
  }
  /** The room link, minted on demand. A code is created if there is not one yet, so the
   *  button always has something to hand over instead of being disabled on a fresh load. */
  const shareBtn = button(
    '🔗',
    () => {
      void (async () => {
        let code = codeLabel
        if (!code) {
          code = generateJoinCode()
          if (!(await setCode(code))) {
            toast('Could not open a room')
            return
          }
        }
        await copyText(inviteLink(code))
        toast('Room link copied')
      })()
    },
    'icon',
    'Copy the room link to share',
  )
  const toolsBtn = hoverTools(button('Tools', () => openTools('', toolsBtn), 'ghost', 'All tools. Hover to open, drag to reorder'))

  // The two controls that belong next to the roster rather than three clicks away: whether
  // you are on the online list at all, and the name the list shows for you. The switch
  // mirrors the one in Settings through the shared wt:presence event, so whichever you
  // touch, the console applies it and the other reads the stored value.
  const presenceChk = el('input', { type: 'checkbox' }) as HTMLInputElement
  presenceChk.checked = (await getItem<boolean>('presence-on')) ?? false
  presenceChk.addEventListener('change', () => {
    void setItem('presence-on', presenceChk.checked)
    window.dispatchEvent(new CustomEvent('wt:presence', { detail: presenceChk.checked }))
  })
  const sideTools = el('div', { class: 'stack pad-x' }, [
    nameField(),
    el('label', { class: 'row small' }, [presenceChk, el('span', { text: 'Go online: appear in the online list' })]),
  ])

  // Sidebar is collapsible (and an overlay drawer on small screens). Auto-share stays in
  // the Connect modal because it only concerns paired devices; the sidebar carries the
  // roster plus the two controls above it, collapsed by default everywhere (👥 opens it).
  let sidebarOpen = (await getItem<boolean>('sidebar-open')) ?? false
  const setSidebarOpen = (v: boolean) => {
    sidebarOpen = v
    void setItem('sidebar-open', v)
    applySidebar()
  }
  const sidebar = el('div', { class: 'sidebar' }, [
    el('div', { class: 'side-head' }, [
      el('h4', { text: 'Devices & people' }),
      el('span', { class: 'spacer' }),
      button('👥', () => setSidebarOpen(false), 'icon sm', 'Hide this panel'),
    ]),
    sideTools,
    peersBox,
  ])
  const bodyEl = el('div', { class: 'body' }, [el('div', { class: 'center' }, [tilesRegion, feed, captionsEl, composerWrap]), sidebar])
  const peersBtn = button('👥', () => setSidebarOpen(!sidebarOpen), 'icon roster-toggle', 'Show / hide devices & people')
  const applySidebar = () => {
    sidebar.classList.toggle('open', sidebarOpen)
    bodyEl.classList.toggle('side-collapsed', !sidebarOpen)
  }
  applySidebar()

  const topbar = el('div', { class: 'topbar' }, [
    el('span', { class: 'brand', text: 'urletc' }),
    statusChip,
    codeChip,
    el('span', { class: 'spacer' }),
    // Text buttons first, then every glyph button in one run. Splitting the four emoji
    // controls around Tools and Connect made two of them read as part of the text group.
    toolsBtn,
    button('Connect', () => void openConnect(), 'ghost', 'Join a code, pair devices, test mic & cam, device name'),
    shareBtn,
    clearBtn,
    peersBtn,
    themeBtn,
  ])

  app.append(sink, el('div', { class: 'app-shell' }, [topbar, bodyEl]))
  if (stageView) document.documentElement.classList.add('stage-view') // chromeless: CSS shows only the stage
  // What this device already holds, restored on load, so closing the tab is not the same
  // as losing the thread. Collapsed and at the top, exactly like a peer's backfill.
  if (!stageView && transcript.length) addCard(historyCard(transcript, 'stored on this device'), undefined, 'top')

  // ---------- Studio controller ----------
  // Implements the seam declared in studio.ts so the Studio tool (a lazy module) can drive
  // the shared stage. All media routing stays here; the tool only asks.
  const studioController: StudioController = {
    isStageView: () => stageView,
    hasLocal: () => localStreams.size > 0,
    async listDevices() {
      let cameras: { deviceId: string; label: string }[] = []
      let mics: { deviceId: string; label: string }[] = []
      try {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const map = (kind: MediaDeviceKind, word: string) => devs.filter((d) => d.kind === kind).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${word} ${i + 1}` }))
        cameras = map('videoinput', 'Camera')
        mics = map('audioinput', 'Microphone')
      } catch {
        /* enumeration blocked until a permission is granted */
      }
      return { cameras, mics }
    },
    async publish(opts) {
      if (opts.kind === 'screen') return publishLocal('screen', {})
      if (opts.kind === 'mic') return publishLocal('mic', { audio: opts.micId ? { deviceId: { exact: opts.micId } } : true, video: false })
      const video: MediaTrackConstraints = {}
      if (opts.cameraId) video.deviceId = { exact: opts.cameraId }
      if (opts.width) video.width = { ideal: opts.width }
      return publishLocal('cam', { audio: opts.micId ? { deviceId: { exact: opts.micId } } : true, video })
    },
    unpublishAll: () => stopMedia(),
    sources() {
      const effSpot = effectiveSpot()
      return stageTiles.map(
        (t): StudioSource => ({ id: t.id, kind: t.kind, label: t.label, local: t.peerId === null, hasVideo: t.hasVideo, spotlighted: t.id === effSpot, recording: !!t.recorder }),
      )
    },
    layout: () => stageLayout,
    setLayout(l) {
      stageLayout = l
      notifyStage()
    },
    spotlight(id) {
      toggleSpot(id)
    },
    toggleRecord(id) {
      const tile = stageTiles.find((t) => t.id === id)
      if (!tile) return
      if (tile.recorder && tile.recorder.state !== 'inactive') {
        tile.recorder.stop()
        return
      }
      const chunks: Blob[] = []
      const rec = new MediaRecorder(tile.stream)
      tile.recorder = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      rec.onstop = () => {
        tile.recorder = null
        const blob = new Blob(chunks, { type: chunks[0]?.type || (tile.hasVideo ? 'video/webm' : 'audio/webm') })
        if (tile.recUrl) URL.revokeObjectURL(tile.recUrl)
        tile.recUrl = URL.createObjectURL(blob)
        const a = el('a', { href: tile.recUrl, download: `studio-${tile.kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm` }) as HTMLAnchorElement
        a.click()
        notifyStage()
      }
      rec.start()
      notifyStage()
    },
    stageLink: () => (codeLabel ? `${location.origin}${location.pathname}#/stage/${codeLabel}` : null),
    onChange(cb) {
      stageSubs.add(cb)
      return () => stageSubs.delete(cb)
    },
  }
  setStudio(studioController)

  // ---------- deep-link router ----------
  // #/t/<tool-id> opens that tool, so a tool is bookmarkable/shareable. Runs before
  // the P2P auto-pilot's tools-only early return, so links work without crypto too.
  // (#/pair is consumed in main.ts before mount and never reaches here.)
  new Router((path) => {
    const m = /^\/t\/([A-Za-z0-9_-]+)$/.exec(path)
    if (m) {
      const man = registry.get(m[1])
      if (man) void launchTool(man)
      return
    }
    // #/join/<code> is the "Copy invite link" target: the recipient lands already
    // connected to the sender's code room, zero typing. A trailing "?p=1" says the sender
    // is on the online list; it is captured at mount (invitedToPresence) and asked about,
    // never applied here.
    const j = /^\/join\/([A-Za-z0-9-]{2,64})(?:\?p=1)?$/.exec(path)
    if (j && p2pReady) {
      const code = normalizeJoinCode(j[1])
      if (code.length >= 4) {
        void setCode(code).then((ok) => {
          if (ok) sys(`Joined code ${code.toUpperCase()} from your invite link. You're in the same room as whoever sent it.`)
        })
      }
    }
  }).start()

  // Escape dismisses the tool launcher.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLauncher()
  })

  // ---------- global paste (image capture; text routed when not typing) ----------
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData
    if (!dt) return
    // Never hijack a paste aimed at another text field (the Connect modal's inputs,
    // a tool's textarea...). Those pastes are the browser's business, not the feed's.
    const ae = document.activeElement as HTMLElement | null
    const editingElsewhere = !!ae && ae !== ta && (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || ae.isContentEditable)
    if (editingElsewhere) return
    // Images can arrive via .files or only via .items depending on the source app.
    const files: File[] = [...dt.files]
    for (const it of dt.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    const img = files.find((f) => f.type.startsWith('image/'))
    if (img) {
      e.preventDefault()
      void handleAttach(img)
      return
    }
    if (document.activeElement !== ta) {
      const text = dt.getData('text/plain')
      if (text) {
        e.preventDefault()
        for (const d of detectText(text)) void clipboardCard(d).then(addCard)
      }
    }
  })

  // ---------- AUTO-PILOT ----------
  // Chromeless stage view (#/stage/<code>, e.g. an OBS browser source): join ONLY that
  // code room, as a pure viewer (publishes nothing), and skip clipboard/personal/nearby.
  if (stageView && p2pReady) {
    void setCode(normalizeJoinCode(stageViewCode!))
    return
  }

  // 1) clipboard: works on Chromium once granted; otherwise the paste listener covers it.
  try {
    if (navigator.clipboard?.read) {
      for (const d of await detectItems(await navigator.clipboard.read())) addCard(await clipboardCard(d))
    }
  } catch {
    /* blocked; paste to detect */
  }
  if (!p2pReady) return

  // 2) personal room: your paired devices connect anywhere (never auto-runs peer scripts).
  void (async () => {
    try {
      const room = await personalRoom(await ensurePersonalSecret())
      if (await joinTier('personal', room)) sys('Your room is open.')
    } catch (e) {
      sys(e instanceof CryptoUnsupportedError ? 'P2P unavailable on this browser. Local tools still work.' : `Could not open your room: ${(e as Error).message}`)
    }
  })()

  // 3) nearby: same-public-IP rendezvous. Open the app on two devices on one Wi-Fi
  //    and they find each other (section 5.4). Nearby peers are untrusted by default,
  //    and the whole tier can be switched off in Settings (it is the one tier that
  //    announces you to strangers). `nearbyWanted` re-checks after each await so a
  //    quick opt-out can't race the slow join (publicIp alone may take seconds).
  let nearbyWanted = true
  /** `announce` is off for the boot pass: a fresh load already says the room is open, and
   *  three more cards about tiers nobody asked for is noise. A later Settings toggle does
   *  announce, so turning it back on is acknowledged the same way turning it off is. */
  const startNearby = async (announce = true) => {
    nearbyState = 'searching'
    const ip = await publicIp()
    if (!nearbyWanted) {
      nearbyState = 'off'
      return
    }
    if (!ip) {
      nearbyState = 'unavailable'
      return
    }
    if (await joinTier('nearby', await nearbyRoom(ip))) {
      if (!nearbyWanted) {
        nearbyState = 'off'
        void leaveTier('nearby')
        return
      }
      nearbyState = 'on'
      if (announce) sys('Nearby discovery on. Devices on this network appear automatically.')
    } else {
      nearbyState = 'unavailable'
    }
  }
  void (async () => {
    nearbyWanted = (await getItem<boolean>('nearby-on')) ?? true
    if (nearbyWanted) await startNearby(false)
    else nearbyState = 'off'
  })()

  // Presence tier: one fixed room, opt-in and OFF by default because joining it
  // announces that you are online to everyone else running the app. `presenceWanted`
  // (declared with the other console state, since syncCodeUrl reads it) is re-checked
  // after the await so a fast opt-out cannot race the join.
  const startPresence = async () => {
    const { presenceRoom } = await import('../p2p/discovery')
    const room = await presenceRoom()
    if (!presenceWanted) return
    if (await joinTier('presence', room)) {
      if (!presenceWanted) {
        void leaveTier('presence')
        return
      }
      sys('Online list on: you can see who else is online, and they can see you. No messages, files or media cross this list.')
    }
  }
  /**
   * A link carrying ?p=1 propagates the sender's opt-in, and stops at a question. Being on
   * the online list makes you visible to every stranger running the app, so flipping it
   * from a URL somebody else authored would be spending the recipient's privacy on their
   * behalf. Carrying the flag still removes the work: one click instead of a hunt through
   * Settings. Declining costs nothing and leaves no trace, because syncCodeUrl writes the
   * flag from our own state, so the link we hand on drops it.
   */
  const offerPresence = () => {
    const enable = button(
      'Turn it on',
      () => {
        presenceChk.checked = true
        void setItem('presence-on', true)
        window.dispatchEvent(new CustomEvent('wt:presence', { detail: true }))
        enable.replaceWith(el('span', { class: 'muted small', text: 'Online list on.' }))
      },
      'ghost small',
      'Join the online list, so other users can see you and invite you to connect',
    )
    addCard(el('div', { class: 'sys' }, [el('span', { text: 'Whoever sent this link is on the online list. Join it too? ' }), enable]))
  }
  void (async () => {
    presenceWanted = (await getItem<boolean>('presence-on')) ?? false
    if (presenceWanted) await startPresence()
    else if (invitedToPresence) offerPresence()
  })()
  window.addEventListener('wt:presence', (e) => {
    presenceWanted = !!(e as CustomEvent).detail
    presenceChk.checked = presenceWanted // the sidebar switch and Settings never disagree
    syncCodeUrl() // the address bar is the invite, so it carries the current opt-in
    const has = sessions.get('presence')
    if (presenceWanted && !has) void startPresence()
    else if (!presenceWanted && has) {
      for (const [key, pend] of pendingInvites) {
        window.clearTimeout(pend.timer)
        pendingInvites.delete(key)
      }
      for (const peerId of [...inboundInvites.keys()]) dismissInvite(peerId)
      void leaveTier('presence').then(() => sys('Online list off, so you no longer appear to other users.'))
    }
  })
  window.addEventListener('wt:nearby', (e) => {
    nearbyWanted = !!(e as CustomEvent).detail
    const has = sessions.get('nearby')
    if (nearbyWanted && !has) void startNearby()
    else if (!nearbyWanted && has) {
      nearbyState = 'off'
      void leaveTier('nearby').then(() => sys('Nearby discovery off. You are invisible outside your rooms.'))
    }
  })

  // 4) join code: ready the moment you enter, so "let me give you my code" needs
  //    zero clicks. Reuse the code from last visit if there is one; only mint a fresh
  //    one for a first-timer. It announces nothing: setCode() puts it in the topbar chip
  //    and in the address bar, which is the whole message.
  void (async () => {
    if (codeLabel) return // an invite link (#/join/...) already claimed the code room
    const saved = normalizeJoinCode((await getItem<string>('join-code')) ?? '')
    if (codeLabel) return
    await setCode(saved.length >= 4 ? saved : generateJoinCode())
  })()
}
