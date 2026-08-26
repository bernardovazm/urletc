// P2P room session over Trystero (ARCHITECTURE sections 5 and 6). Serverless discovery via
// Nostr relays; SDP encrypted with the room password; per-peer E2EE on top via an
// authenticated X25519 handshake (ephemeral keys signed by the device Ed25519 key)
// feeding the forward-secret ratchet (ratchet.ts).
//
// Control + chat ride one ordered, ratcheted 'msg' stream (sealed JSON envelopes).
// Bulk file bytes ride a separate 'fdata' stream encrypted with a per-file random
// key that is itself delivered E2EE inside a 'file' envelope, so file chunks are
// encrypted once and broadcast, while the key reaches each peer over their ratchet.
// Media (VoIP / screen) uses Trystero streams (DTLS-SRTP; app-layer media E2EE via
// Insertable Streams is Chromium-only and deferred).
//
// A fourth stream, 'inv', exists only on presenceOnly sessions and carries only a join
// code, sealed over the same per-peer ratchet. It is how a peer you can merely SEE in the
// online list becomes a peer you can message: they hand you a room to join. Receiving one
// never joins anything (see onInvite).

import { getRelaySockets, joinRoom, selfId, type Room } from 'trystero/nostr'
import { aesKeyFromBytes, b64ToBytes, bytesToB64, deriveSharedSecret, randomBytes, safetyNumber, sha256, signEd25519, toHex, verifyEd25519 } from '../core/crypto'
import { loadOrCreateIdentity } from '../core/identity'
import { ManifestSchema, verifyManifest, type Manifest } from '../workshop/manifest'
import { normalizeJoinCode } from './discovery'
import { SecureChannel, type SealedMessage } from './ratchet'

// Trystero namespace. Every room id derives from it, so changing this value moves the
// whole app to a fresh namespace and older clients can no longer see newer ones.
const APP_ID = 'utilscript'
// Rendezvous relays, chosen by measurement rather than reputation. The previous set
// (relay.damus.io, nos.lol, relay.nostr.band) refused essentially every announce: damus
// answered "rate-limited: you are noting too much", nos.lol demanded 28 bits of
// proof-of-work, and nostr.band's socket returned 503. That is why the console filled
// with one warning per announce per room, and it also meant discovery was dead, not
// merely noisy. These three accepted and fanned out every event of a 75-second run at
// the real announce cadence (5.3s per room, three rooms). One reachable relay is enough
// to find a peer, so three is redundancy.
//
// Trystero keeps ONE socket and ONE batched subscription per relay URL across every
// room, so the tiers (personal / nearby / code / presence) share these three sockets.
// What multiplies per tier is announce traffic, which is why the list stays short.
//
// Changing this list also requires connect-src in vercel.json and vite.config.ts, or the
// CSP blocks the socket. scripts/e2e-console.py asserts the two agree.
const NOSTR_RELAYS = ['wss://relay.mostr.pub', 'wss://bucket.coracle.social', 'wss://strfry.shock.network']
// A relay flapping is an expected, tolerated condition, so it is reported once per page
// as a quiet status line instead of being left to the console. Module-scoped because the
// sockets are shared across tiers: three rooms must not produce three reports.
const RELAY_HEALTH_DELAY = 12_000
const TURN = [
  {
    urls: ['turn:openrelay.metered.ca:80', 'turns:openrelay.metered.ca:443'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]
let relayHealthReported = false

/** Surface degraded rendezvous once, quietly. Silent while every relay is up. */
function reportRelayHealth(ev: SessionEvents): void {
  if (relayHealthReported) return
  relayHealthReported = true
  setTimeout(() => {
    const sockets = getRelaySockets() as Record<string, WebSocket | undefined>
    const urls = Object.keys(sockets)
    if (!urls.length) return
    const up = urls.filter((u) => sockets[u]?.readyState === WebSocket.OPEN).length
    if (up === urls.length) return
    ev.onSystem?.(
      up
        ? `Rendezvous is running on ${up} of ${urls.length} relays, so devices still find each other.`
        : 'No rendezvous relay answered, so other devices cannot be found. Local tools still work.',
    )
  }, RELAY_HEALTH_DELAY)
}

const CHUNK = 64 * 1024
const MAX_FILE_CHUNKS = 32_768 // 64 KiB x 32768 is about a 2 GiB ceiling on a declared file
const MAX_PENDING_FILES = 16 // distinct unresolved fileIds buffered at once
const MAX_PENDING_CHUNKS = 4096 // chunks buffered for a not-yet-announced fileId
const MAX_CHAT_CHARS = 4000 // inbound chat text ceiling (see the 'chat' branch below)
const MAX_NAME_CHARS = 32 // peer display name, inbound
const MAX_FILENAME_CHARS = 80 // received file name, inbound
const MAX_MIME_CHARS = 100 // received file MIME type, inbound
const MAX_INCOMING_FILES = 16 // concurrent in-flight receives
const MAX_CODE_CHARS = 20 // inbound join code ceiling (the Connect field's own maxlength)
const MIN_CODE_CHARS = 4 // shorter than this is not a room, it is a typo

// --- Uplink adaptation ----------------------------------------------------------------
// Transport tuning only. It reads this room's own senders and never changes who receives
// what, so the tier rules in the console still decide routing on their own.
//
// The browser default is the source of the slideshow: for a screen share the spec asks for
// 'maintain-resolution', so the encoder keeps every pixel and spends frame rate instead.
// These profiles pick a preference per source kind, and the loop below adds the floor no
// preference value can express on its own.
//
//   cam    A face is motion. It stays readable at half resolution and stops being watchable
//          the moment it stutters, so resolution is the first thing to spend, and the fps
//          floor sits high.
//   screen Mostly static text is the opposite case: downscaling it makes it unreadable,
//          which is worse than a slower cadence. 'balanced' keeps a detail bias while still
//          letting the encoder shed pixels, and the low fps floor means the loop only
//          intervenes once the share has genuinely become a slideshow rather than merely
//          idling on an unchanged screen.
const ADAPT_PROFILES: Record<'cam' | 'screen', { degradation: RTCDegradationPreference; minFps: number }> = {
  cam: { degradation: 'maintain-framerate', minFps: 18 },
  screen: { degradation: 'balanced', minFps: 8 },
}
const ADAPT_INTERVAL = 3000 // stats poll cadence
const ADAPT_STEP = 1.5 // multiplicative move on scaleResolutionDownBy
const ADAPT_MAX_SCALE = 4 // ratio floor: never below a quarter of each dimension
const ADAPT_MIN_WIDTH = 320 // absolute floor, so a small source is not scaled into uselessness
const ADAPT_DOWN_STRIKES = 2 // about 6s of trouble before shedding resolution
const ADAPT_UP_STRIKES = 5 // about 15s of health before taking any back: recovery is deliberately slower than shedding
const ADAPT_COOLDOWN = 9_000 // ms of quiet after any change, so one step cannot chase the next
const ADAPT_RECOVER_BPS = 600_000 // estimator headroom required before spending bits on pixels again

/** Control state for one outbound video sender, meaning one peer and one track. */
interface AdaptEntry {
  scale: number // current scaleResolutionDownBy
  bad: number // consecutive polls that were encoder-limited AND under the fps floor
  good: number // consecutive polls the encoder reported unlimited
  until: number // no further change before this timestamp
}

/** The one field of the opaque per-stream metadata that transport tuning needs. */
function metaKind(meta: unknown): 'cam' | 'screen' | 'mic' | null {
  const k = (meta as { kind?: unknown } | null | undefined)?.kind
  return k === 'cam' || k === 'screen' || k === 'mic' ? k : null
}

export interface RosterPeer {
  peerId: string
  deviceId: string
  name: string
  pubKeyHex: string
  ready: boolean
  safety: string // safety number for OOB verification (empty until ready)
}

export interface ChatMessage {
  peerId: string
  deviceId: string
  name: string
  text: string
  ts: number
  mine: boolean
}

export interface ReceivedFile {
  name: string
  ftype: string
  url: string
  size: number
  /** deviceId of the sender. Attributed here because a file arriving with no author is
   *  a file the app cannot filter, e.g. when the user has dropped that peer. */
  from: string
}

/**
 * One signal on the presence tier's invite channel. `offer` carries a validated join
 * code the peer is asking you to join; `withdraw` retracts their offer; `decline`
 * refuses one of yours. The peer is named by deviceId (a hash of their identity key,
 * which they cannot choose) as well as by the display name they claim.
 */
export interface InviteSignal {
  kind: 'offer' | 'withdraw' | 'decline'
  peerId: string
  deviceId: string
  name: string
  pubKeyHex: string
  code: string // validated 4..20 char code for `offer`, empty otherwise
}

export interface SessionEvents {
  onRoster?: (peers: RosterPeer[]) => void
  onChat?: (m: ChatMessage) => void
  onSystem?: (text: string) => void
  onFileProgress?: (fileId: string, name: string, done: number, total: number, outgoing: boolean) => void
  onFileReceived?: (f: ReceivedFile) => void
  onPeerStream?: (peerId: string, stream: MediaStream, meta?: unknown) => void
  onPeerLeave?: (peerId: string) => void
  /**
   * A peer on the presence tier signalled on the invite channel. An `offer` is a
   * REQUEST, never an instruction: the handler must present it and wait for a click.
   * Auto-joining here would let anyone in the online list pull the user into a room
   * they control, which is the vulnerability the chat-code path was already fixed for.
   */
  onInvite?: (sig: InviteSignal) => void
}

export interface RoomSession {
  selfId: string
  selfDeviceId: string
  peerCount(): number
  roster(): RosterPeer[]
  /**
   * Send to every authenticated peer except those whose pubKeyHex is in `skipKeys`.
   * Returns the pubKeyHex of the peers actually sent to. The console accumulates
   * these across tiers (personal/nearby/code) so a device present in two rooms
   * receives each message exactly once. No local echo: the caller renders its own.
   */
  sendChat(text: string, skipKeys?: ReadonlySet<string>): Promise<string[]>
  sendFile(file: File, skipKeys?: ReadonlySet<string>): Promise<string[]>
  /** Rename this device live: connected peers get a ratcheted announce; future
   *  handshakes carry the new name. (Names travel only in the handshake otherwise,
   *  so without this a rename was invisible until reconnect.) */
  setName(name: string): Promise<void>
  /** Publish a stream to the room. `meta` (e.g. {kind,label}) rides Trystero's per-stream
   *  metadata so recipients can label the source (webcam vs screen vs mic). */
  addMedia(stream: MediaStream, meta?: unknown): Promise<void>
  removeMedia(stream: MediaStream): void
  /** Gossip a signed tool manifest to room peers (Workshop, ARCHITECTURE section 7). */
  publishTool(m: Manifest): Promise<void>
  /** Register (or clear) the handler for tools received from peers. */
  setToolHandler(cb: ((m: Manifest, fromName: string) => void) | null): void
  /**
   * Send a small real-time payload (e.g. game state) to one authenticated peer, or to
   * all when `targetPeerId` is omitted. Best-effort and UNORDERED by design: it does
   * NOT ride the forward-secret ratchet (which enforces ordering and would stall on the
   * UDP loss that real-time state tolerates). Transport-encrypted by the room password
   * only, like media (ARCHITECTURE section 5.4). Carry coordinates/scores, nothing sensitive.
   */
  sendGame(payload: unknown, targetPeerId?: string): void
  /** Register (or clear) the handler for game payloads from authenticated peers. */
  setGameHandler(cb: ((payload: unknown, fromPeerId: string) => void) | null): void
  /**
   * Ask one authenticated presence peer to join `code`. Presence-only sessions and
   * handshake-authenticated peers only; returns false when either does not hold. The
   * code is sealed over the peer's ratchet, not merely transport-encrypted, because a
   * join code is a room credential and the presence room's password is a constant every
   * client derives.
   */
  sendInvite(peerId: string, code: string): Promise<boolean>
  /** Retract an invite you sent, so their prompt disappears. */
  withdrawInvite(peerId: string): Promise<boolean>
  /** Refuse an invite they sent, so their pending state clears. */
  declineInvite(peerId: string): Promise<boolean>
  leave(): Promise<void>
}

// Several sessions can be alive at once (personal / nearby / code tiers). Tools that
// need "a mesh" without caring which (Workshop) get the primary one: the personal
// room when joined, else whichever came first.
let active: RoomSession | null = null
export function getActiveSession(): RoomSession | null {
  return active
}

// Every joined session across tiers (personal/nearby/code). Lets a P2P tool (e.g. Pong)
// enumerate all reachable peers, not just the primary one.
const liveSessions = new Set<RoomSession>()
export function getAllSessions(): RoomSession[] {
  return [...liveSessions]
}

type HsPayload = { eph: string; idPub: string; sig: string; name: string }
type FileChunk = { fileId: string; i: number; iv: string; ct: string }
type Envelope = { t: 'chat'; text: string } | { t: 'name'; name: string } | { t: 'file'; fileId: string; name: string; ftype: string; size: number; total: number; key: string }
type InviteEnvelope = { t: 'offer'; code: string } | { t: 'withdraw' } | { t: 'decline' }

interface PeerState {
  eph: CryptoKeyPair
  ephPubB64: string
  channel: SecureChannel | null
  info: RosterPeer
}

interface Incoming {
  from: string // deviceId of the sender, carried through to ReceivedFile
  name: string
  ftype: string
  size: number
  total: number
  key: CryptoKey
  chunks: Array<Uint8Array<ArrayBuffer> | undefined>
  received: number
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export async function joinRoomSession(opts: {
  roomId: string
  password: string
  displayName: string
  relayOnly: boolean
  /** Claim the getActiveSession() slot even if another session holds it. */
  primary?: boolean
  /**
   * Presence-only: the session performs the authenticated handshake and maintains a
   * roster, and carries no content. Inbound chat / files / tool gossip / game frames
   * are dropped before they reach the app, and the corresponding send methods are
   * no-ops. Such a session also stays out of getAllSessions()/getActiveSession(), so a
   * P2P tool enumerating "every reachable peer" cannot reach these peers either.
   *
   * The single exception is the 'inv' channel, which exists ONLY on these sessions and
   * carries ONLY a join code: it is the upgrade path from visible to reachable. It adds
   * no content path, because acting on an invite means joining a normal code room where
   * the usual tier rules apply.
   *
   * This is enforced HERE rather than in the console so that a tier which is only meant
   * to answer "who is online" cannot become a message path by someone later adding a
   * tier to a list somewhere else.
   */
  presenceOnly?: boolean
  events: SessionEvents
}): Promise<RoomSession> {
  const ev = opts.events
  let displayName = opts.displayName
  const id = await loadOrCreateIdentity()
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const roomSalt = enc.encode(opts.roomId)
  const idPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', id.sign.publicKey))

  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password: opts.password,
      relayConfig: { urls: NOSTR_RELAYS },
      turnConfig: TURN,
      rtcConfig: { iceTransportPolicy: opts.relayOnly ? 'relay' : 'all' },
    },
    opts.roomId,
  )
  reportRelayHealth(ev)

  const peers = new Map<string, PeerState>()
  const incoming = new Map<string, Incoming>()
  const pendingChunks = new Map<string, FileChunk[]>()
  const activeStreams = new Map<MediaStream, unknown>() // stream to its metadata, kept for re-send on handshake
  const receivedUrls = new Set<string>()

  const hs = room.makeAction<HsPayload>('hs')
  const msg = room.makeAction<SealedMessage>('msg')
  const fdata = room.makeAction<FileChunk>('fdata')
  const wshop = room.makeAction('wshop')
  const gameAction = room.makeAction('game')
  // Its own action rather than another Envelope case on 'msg', so the unconditional
  // presenceOnly drop in msg.onMessage stays unconditional. Both streams seal against
  // the same per-peer channel, which is safe because each SealedMessage carries its own
  // counter `n`, so a message dropped on one stream cannot desync the other.
  const inv = room.makeAction<SealedMessage>('inv')
  let toolHandler: ((m: Manifest, fromName: string) => void) | null = null
  let gameHandler: ((payload: unknown, fromPeerId: string) => void) | null = null

  const emitRoster = () => ev.onRoster?.([...peers.values()].map((p) => p.info))

  async function newPeerState(peerId: string): Promise<PeerState> {
    const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
    return {
      eph: kp,
      ephPubB64: bytesToB64(ephPubRaw),
      channel: null,
      info: { peerId, deviceId: '', name: '...', pubKeyHex: '', ready: false, safety: '' },
    }
  }

  async function sendHandshake(peerId: string, st: PeerState) {
    const ephRaw = b64ToBytes(st.ephPubB64)
    const sig = await signEd25519(id.sign.privateKey, concat(ephRaw, roomSalt))
    await hs.send({ eph: st.ephPubB64, idPub: bytesToB64(idPubRaw), sig: bytesToB64(sig), name: displayName }, { target: peerId })
  }

  room.onPeerJoin = async (peerId: string) => {
    if (peers.has(peerId)) return
    const st = await newPeerState(peerId)
    peers.set(peerId, st)
    emitRoster()
    // No card for the attempt. Every peer used to cost two feed cards, one for joining and
    // one for the handshake completing, which is process narration. Only the result speaks.
    await sendHandshake(peerId, st)
  }

  room.onPeerLeave = (peerId: string) => {
    const st = peers.get(peerId)
    peers.delete(peerId)
    emitRoster()
    ev.onPeerLeave?.(peerId)
    if (st?.info.ready) ev.onSystem?.(`${st.info.name} left.`)
  }

  hs.onMessage = async (data, ctx) => {
    const peerId = ctx.peerId
    let st = peers.get(peerId)
    if (!st) {
      st = await newPeerState(peerId)
      peers.set(peerId, st)
      await sendHandshake(peerId, st)
    }
    if (st.channel) return

    const theirEph = b64ToBytes(data.eph)
    const theirIdPub = b64ToBytes(data.idPub)
    const ok = await verifyEd25519(theirIdPub, b64ToBytes(data.sig), concat(theirEph, roomSalt))
    if (!ok) {
      ev.onSystem?.('⚠ Rejected a peer with an invalid signature.')
      peers.delete(peerId)
      emitRoster()
      return
    }

    const shared = await deriveSharedSecret(st.eph.privateKey, theirEph)
    const initiator = st.ephPubB64 < data.eph
    st.channel = await SecureChannel.create(shared, roomSalt, initiator)
    const theirPubHex = toHex(theirIdPub)
    st.info = {
      peerId,
      deviceId: toHex(await sha256(theirIdPub)),
      // The handshake is the PRIMARY inbound name path; the {t:'name'} rename envelope
      // below is the secondary one. Both are capped: an uncapped one lets a peer seat an
      // unbounded string in the roster, every chat author line and the system feed.
      name:
        String(data.name ?? '')
          .trim()
          .slice(0, MAX_NAME_CHARS) || 'anon',
      pubKeyHex: theirPubHex,
      ready: true,
      safety: await safetyNumber(id.publicKeyHex, theirPubHex),
    }
    emitRoster()
    ev.onSystem?.(`🔒 Secure channel established with ${st.info.name}.`)
    // Offer active local media only now that the peer is authenticated (also avoids
    // the join-time race where a stream lands before the handshake completes).
    // meta is always a {kind,label} object (or undefined), a valid JSON value for Trystero.
    for (const [stream, meta] of activeStreams) room.addStream(stream, { target: peerId, metadata: meta as Record<string, string> | undefined })
    runAdaptTick() // the new peer's senders start on the browser default until this asserts the profile
  }

  async function handleChunk(fileId: string, chunk: FileChunk) {
    const inc = incoming.get(fileId)
    if (!inc) return
    if (!Number.isInteger(chunk.i) || chunk.i < 0 || chunk.i >= inc.total) return // reject out-of-range index
    try {
      // Bind (fileId, index) as AEAD additional data so chunks can't be transposed/substituted.
      const aad = enc.encode(`${fileId}:${chunk.i}`)
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(chunk.iv), additionalData: aad }, inc.key, b64ToBytes(chunk.ct)))
      if (!inc.chunks[chunk.i]) inc.received++
      inc.chunks[chunk.i] = pt
      ev.onFileProgress?.(fileId, inc.name, inc.received, inc.total, false)
      if (inc.received >= inc.total) {
        const blob = new Blob(
          inc.chunks.filter((c): c is Uint8Array<ArrayBuffer> => !!c),
          { type: inc.ftype },
        )
        incoming.delete(fileId)
        const url = URL.createObjectURL(blob)
        receivedUrls.add(url)
        ev.onFileReceived?.({ name: inc.name, ftype: inc.ftype, url, size: inc.size, from: inc.from })
      }
    } catch {
      ev.onSystem?.('⚠ Failed to decrypt a file chunk.')
    }
  }

  msg.onMessage = async (data, ctx) => {
    if (opts.presenceOnly) return // presence tiers neither send nor receive messages
    const st = peers.get(ctx.peerId)
    if (!st?.channel) return
    let env: Envelope
    try {
      env = JSON.parse(dec.decode(await st.channel.open(data))) as Envelope
    } catch {
      ev.onSystem?.('⚠ Failed to decrypt a message (out of order or tampered).')
      return
    }
    if (env.t === 'chat') {
      // Cap inbound text like the display name below it: rendering is textContent so this
      // is not an XSS control, but without it a peer can push an unbounded string into
      // the feed.
      const text = String(env.text ?? '').slice(0, MAX_CHAT_CHARS)
      if (!text) return
      ev.onChat?.({ peerId: ctx.peerId, deviceId: st.info.deviceId, name: st.info.name, text, ts: Date.now(), mine: false })
    } else if (env.t === 'name') {
      const name = String(env.name).trim().slice(0, MAX_NAME_CHARS) || 'anon'
      if (st.info.name !== name) {
        st.info = { ...st.info, name }
        emitRoster()
      }
    } else if (env.t === 'file') {
      if (!Number.isInteger(env.total) || env.total < 1 || env.total > MAX_FILE_CHUNKS) {
        ev.onSystem?.('⚠ Rejected an oversized or malformed file offer.')
        return
      }
      // Without this cap one authenticated peer can announce unlimited files, each
      // allocating a 32768-slot backing array. MAX_PENDING_FILES gates `pendingChunks`,
      // which is a different map and does not bound this one.
      if (incoming.size >= MAX_INCOMING_FILES) {
        ev.onSystem?.('⚠ Too many files in flight from peers. Rejected one.')
        return
      }
      // Name/MIME/size are peer-controlled and reach the feed, the download attribute
      // and the Blob type, so they are bounded here rather than at each render site.
      const fname =
        String(env.name ?? '')
          .trim()
          .slice(0, MAX_FILENAME_CHARS) || 'file'
      const ftype = String(env.ftype ?? '').slice(0, MAX_MIME_CHARS)
      const fsize = Number.isFinite(env.size) && env.size >= 0 ? env.size : 0
      const key = await aesKeyFromBytes(b64ToBytes(env.key))
      incoming.set(env.fileId, { from: st.info.deviceId, name: fname, ftype, size: fsize, total: env.total, key, chunks: new Array(env.total), received: 0 })
      ev.onSystem?.(`Incoming file "${fname}" (${Math.round(fsize / 1024)} KB)...`)
      const pend = pendingChunks.get(env.fileId)
      if (pend) {
        pendingChunks.delete(env.fileId)
        for (const c of pend) await handleChunk(env.fileId, c)
      }
    }
  }

  fdata.onMessage = async (data, ctx) => {
    if (opts.presenceOnly) return
    // Only handshake-authenticated peers may send file data (the per-file key was
    // delivered over their ratchet anyway). This + the caps below bound the buffer.
    if (!peers.get(ctx.peerId)?.channel) return
    if (!incoming.has(data.fileId)) {
      if (pendingChunks.size >= MAX_PENDING_FILES) return
      const arr = pendingChunks.get(data.fileId) ?? []
      if (arr.length >= MAX_PENDING_CHUNKS) return
      arr.push(data)
      pendingChunks.set(data.fileId, arr)
      return
    }
    await handleChunk(data.fileId, data)
  }

  // Workshop tool gossip: verify integrity + signature BEFORE surfacing (section 7).
  wshop.onMessage = async (data, ctx) => {
    if (opts.presenceOnly) return
    if (!peers.get(ctx.peerId)?.channel) return // only authenticated peers may gossip tools
    try {
      const m = ManifestSchema.parse(data)
      const v = await verifyManifest(m)
      if (!v.ok) {
        ev.onSystem?.(`⚠ Rejected a shared tool (${v.reason}).`)
        return
      }
      const st = peers.get(ctx.peerId)
      ev.onSystem?.(`📦 ${st?.info.name ?? 'A peer'} shared a tool: "${m.name}".`)
      toolHandler?.(m, st?.info.name ?? 'peer')
    } catch {
      ev.onSystem?.('⚠ Rejected a malformed shared tool.')
    }
  }

  // Real-time game/state payloads. Authenticated peers only (same gate as chat/gossip);
  // the payload is handed opaque to the registered handler (e.g. the Pong tool).
  gameAction.onMessage = (data, ctx) => {
    if (!peers.get(ctx.peerId)?.channel) return
    gameHandler?.(data, ctx.peerId)
  }

  // Invite channel (presence tier only). Everything here is one join code and nothing
  // else, and it NEVER acts: it hands the signal to the app, which must ask the user.
  inv.onMessage = async (data, ctx) => {
    if (!opts.presenceOnly) return // the channel does not exist on content-carrying tiers
    const st = peers.get(ctx.peerId)
    if (!st?.channel) return // handshake-authenticated peers only
    let env: InviteEnvelope
    try {
      // Sealed, so this also rejects a replayed invite: the ratchet refuses a counter
      // it has already consumed.
      env = JSON.parse(dec.decode(await st.channel.open(data))) as InviteEnvelope
    } catch {
      return // a malformed or replayed invite is dropped in silence, not reported
    }
    const who = { peerId: ctx.peerId, deviceId: st.info.deviceId, name: st.info.name, pubKeyHex: st.info.pubKeyHex }
    if (env.t === 'offer') {
      // Bounded and normalised here, at the trust boundary, exactly like every other
      // inbound string. Anything that is not a plausible code is not surfaced at all.
      const code = normalizeJoinCode(String(env.code ?? '')).slice(0, MAX_CODE_CHARS)
      if (code.length < MIN_CODE_CHARS) return
      ev.onInvite?.({ ...who, kind: 'offer', code })
    } else if (env.t === 'withdraw' || env.t === 'decline') {
      ev.onInvite?.({ ...who, kind: env.t, code: '' })
    }
  }

  /** Seal one invite signal to one authenticated peer. False when that is not possible. */
  async function sendInviteEnvelope(peerId: string, env: InviteEnvelope): Promise<boolean> {
    if (!opts.presenceOnly) return false
    const st = peers.get(peerId)
    if (!st?.channel) return false
    await inv.send(await st.channel.seal(enc.encode(JSON.stringify(env))), { target: peerId })
    return true
  }

  room.onPeerStream = (stream, peerId, metadata) => {
    if (opts.presenceOnly) return
    ev.onPeerStream?.(peerId, stream, metadata)
  }

  // --- Uplink adaptation loop, one per session --------------------------------------
  // One timer for the whole session rather than one per publish, so teardown is a single
  // clearInterval and a publish cannot leak one. It re-derives the sender list from
  // room.getPeers() on every tick, which is also how senders created later, by a peer
  // joining or by renegotiation, get picked up without any extra wiring.
  const adaptState = new Map<string, AdaptEntry>() // `${peerId}|${trackId}` to its control state
  let adaptTimer: ReturnType<typeof setInterval> | null = null
  let adapting = false

  /** Which profile governs a sender's track, or null when it is not this session's to tune. */
  function profileFor(track: MediaStreamTrack): (typeof ADAPT_PROFILES)['cam'] | null {
    for (const [stream, meta] of activeStreams) {
      if (!stream.getVideoTracks().some((t) => t.id === track.id)) continue
      const k = metaKind(meta)
      // An unlabelled video source is treated as a camera. That is the assumption that
      // fails safe: a mislabelled screen share only loses pixels, never cadence.
      return k === 'mic' ? null : ADAPT_PROFILES[k === 'screen' ? 'screen' : 'cam']
    }
    return null // a sender for a stream this session no longer publishes
  }

  /**
   * Write encoding parameters back. setParameters() rejects unless it is handed the very
   * object getParameters() returned, encodings can be empty while a renegotiation is in
   * flight, and the promise rejects benignly when the transaction has gone stale. All three
   * are non-events, so all three are swallowed: a rejection here must neither kill the loop
   * nor reach the console.
   */
  async function applyEncoding(sender: RTCRtpSender, scale: number, degradation: RTCDegradationPreference): Promise<void> {
    let params: RTCRtpSendParameters
    try {
      params = sender.getParameters()
    } catch {
      return
    }
    if (!params.encodings?.length) return
    if (params.degradationPreference === degradation && params.encodings.every((e) => (e.scaleResolutionDownBy ?? 1) === scale)) return
    params.degradationPreference = degradation
    for (const e of params.encodings) e.scaleResolutionDownBy = scale
    try {
      await sender.setParameters(params)
    } catch {
      // Stale transaction or mid-renegotiation. The next tick re-reads and retries.
    }
  }

  /** outbound-rtp for one sender plus the active pair's estimate, reduced to plain numbers. */
  async function readOutbound(sender: RTCRtpSender): Promise<{ limited: boolean; fps?: number; width?: number; bps?: number } | null> {
    let report: RTCStatsReport
    try {
      report = await sender.getStats()
    } catch {
      return null
    }
    const outs: RTCOutboundRtpStreamStats[] = []
    let bps: number | undefined
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') outs.push(s as RTCOutboundRtpStreamStats)
      else if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && typeof s.availableOutgoingBitrate === 'number') bps = s.availableOutgoingBitrate
    })
    if (!outs.length) return null
    // With simulcast there is one report per layer, and the widest is the layer whose
    // resolution scaleResolutionDownBy actually moves.
    const best = outs.reduce((a, b) => ((b.frameWidth ?? 0) > (a.frameWidth ?? 0) ? b : a))
    const reason = best.qualityLimitationReason
    return { limited: reason === 'bandwidth' || reason === 'cpu', fps: best.framesPerSecond, width: best.frameWidth, bps }
  }

  /** One pass: assert the profile on every outbound video sender, then act on its stats. */
  async function adaptTick(): Promise<void> {
    let conns: Record<string, RTCPeerConnection>
    try {
      conns = room.getPeers()
    } catch {
      return
    }
    const live = new Set<string>()
    const now = Date.now()
    for (const [peerId, pc] of Object.entries(conns)) {
      let senders: RTCRtpSender[]
      try {
        senders = pc.getSenders()
      } catch {
        continue // connection closed under us
      }
      for (const sender of senders) {
        const track = sender.track
        if (!track || track.kind !== 'video' || track.readyState !== 'live') continue
        const profile = profileFor(track)
        if (!profile) continue
        const key = `${peerId}|${track.id}`
        live.add(key)
        let st = adaptState.get(key)
        if (!st) {
          st = { scale: 1, bad: 0, good: 0, until: 0 }
          adaptState.set(key, st)
        }
        // Re-asserted every tick, and idempotent, so a sender recreated by renegotiation
        // cannot silently fall back to the browser default.
        await applyEncoding(sender, st.scale, profile.degradation)
        const s = await readOutbound(sender)
        if (!s) continue
        const slow = s.fps !== undefined && s.fps < profile.minFps
        if (s.limited && slow) {
          st.bad++
          st.good = 0
        } else if (!s.limited) {
          // Health is judged by the encoder, not by the frame rate: a static screen share
          // legitimately emits almost no frames while reporting no limitation at all, and
          // reading that as distress would scale a readable document into mush.
          st.good++
          st.bad = 0
        } else {
          st.bad = 0
          st.good = 0 // limited but still fast enough: hold where we are
        }
        if (now < st.until) continue
        // Only scaleResolutionDownBy moves. maxBitrate is deliberately left alone: fewer
        // pixels is what buys frames back, while capping the rate merely fights the
        // bandwidth estimator, which already reads the link far more often than a 3s poll.
        const roomToShrink = st.scale < ADAPT_MAX_SCALE && (s.width === undefined || s.width / ADAPT_STEP >= ADAPT_MIN_WIDTH)
        if (st.bad >= ADAPT_DOWN_STRIKES && roomToShrink) {
          st.scale = Math.min(ADAPT_MAX_SCALE, st.scale * ADAPT_STEP)
          st.bad = 0
          st.until = now + ADAPT_COOLDOWN
          await applyEncoding(sender, st.scale, profile.degradation)
        } else if (st.good >= ADAPT_UP_STRIKES && st.scale > 1 && (s.bps === undefined || s.bps >= ADAPT_RECOVER_BPS)) {
          // Taking pixels back costs bits, so it waits for the estimator to show headroom.
          // Without that gate the loop walks up onto a link with no room and immediately
          // walks back down, which is the oscillation this is built to avoid.
          st.scale = Math.max(1, st.scale / ADAPT_STEP)
          st.good = 0
          st.until = now + ADAPT_COOLDOWN
          await applyEncoding(sender, st.scale, profile.degradation)
        }
      }
    }
    for (const key of adaptState.keys()) if (!live.has(key)) adaptState.delete(key)
  }

  function runAdaptTick(): void {
    if (adapting) return // a slow getStats() must not let ticks pile up on each other
    adapting = true
    void adaptTick()
      .catch(() => {})
      .finally(() => {
        adapting = false
      })
  }

  function stopAdaptLoop(): void {
    if (adaptTimer !== null) clearInterval(adaptTimer)
    adaptTimer = null
    adaptState.clear()
  }

  /** Run the loop exactly while this session publishes video, and not one publish longer. */
  function syncAdaptLoop(): void {
    const wanted = !opts.presenceOnly && [...activeStreams.keys()].some((s) => s.getVideoTracks().length > 0)
    if (wanted === (adaptTimer !== null)) return
    if (!wanted) return stopAdaptLoop()
    adaptTimer = setInterval(runAdaptTick, ADAPT_INTERVAL)
    runAdaptTick() // do not leave the first interval on the browser default
  }

  const api: RoomSession = {
    selfId,
    selfDeviceId: id.deviceId,
    peerCount: () => peers.size,
    roster: () => [...peers.values()].map((p) => p.info),

    publishTool(m: Manifest) {
      if (opts.presenceOnly) return Promise.resolve()
      // Cast through JSON so the structured payload is plain JsonValue for Trystero.
      return wshop.send(JSON.parse(JSON.stringify(m)))
    },
    setToolHandler(cb) {
      toolHandler = cb
    },

    sendGame(payload: unknown, targetPeerId?: string) {
      if (opts.presenceOnly) return
      const authed = [...peers.entries()].filter(([, st]) => st.channel).map(([peerId]) => peerId)
      const targets = targetPeerId ? authed.filter((p) => p === targetPeerId) : authed
      if (!targets.length) return
      // Cast through JSON so the payload is a plain JsonValue for Trystero.
      void gameAction.send(JSON.parse(JSON.stringify(payload)), { target: targets })
    },
    setGameHandler(cb) {
      gameHandler = cb
    },

    sendInvite(peerId: string, code: string) {
      const clean = normalizeJoinCode(code).slice(0, MAX_CODE_CHARS)
      if (clean.length < MIN_CODE_CHARS) return Promise.resolve(false)
      return sendInviteEnvelope(peerId, { t: 'offer', code: clean })
    },
    withdrawInvite(peerId: string) {
      return sendInviteEnvelope(peerId, { t: 'withdraw' })
    },
    declineInvite(peerId: string) {
      return sendInviteEnvelope(peerId, { t: 'decline' })
    },

    async sendChat(text: string, skipKeys?: ReadonlySet<string>) {
      if (opts.presenceOnly) return []
      const sent: string[] = []
      for (const [peerId, st] of peers) {
        if (!st.channel || skipKeys?.has(st.info.pubKeyHex)) continue
        await msg.send(await st.channel.seal(enc.encode(JSON.stringify({ t: 'chat', text } satisfies Envelope))), { target: peerId })
        sent.push(st.info.pubKeyHex)
      }
      return sent
    },

    async setName(name: string) {
      displayName = name.trim().slice(0, 32) || displayName
      // A presence peer DROPS {t:'name'} (msg.onMessage returns early there), so
      // announcing a rename to them is traffic nobody reads. Skipping it also leaves the
      // presence ratchet to the invite stream alone. Presence names refresh on handshake.
      if (opts.presenceOnly) return
      await Promise.all(
        [...peers.entries()]
          .filter(([, st]) => st.channel)
          .map(async ([peerId, st]) => msg.send(await st.channel!.seal(enc.encode(JSON.stringify({ t: 'name', name: displayName } satisfies Envelope))), { target: peerId })),
      )
    },

    async sendFile(file: File, skipKeys?: ReadonlySet<string>) {
      if (opts.presenceOnly) return []
      const ready = [...peers.entries()].filter(([, st]) => st.channel && !skipKeys?.has(st.info.pubKeyHex))
      if (!ready.length) return []
      const fileId = crypto.randomUUID()
      const total = Math.max(1, Math.ceil(file.size / CHUNK))
      const keyBytes = randomBytes(32)
      const aesKey = await aesKeyFromBytes(keyBytes)

      // Deliver the per-file key to each recipient over their ratchet.
      for (const [peerId, st] of ready) {
        const env: Envelope = { t: 'file', fileId, name: file.name, ftype: file.type || 'application/octet-stream', size: file.size, total, key: bytesToB64(keyBytes) }
        await msg.send(await st.channel!.seal(enc.encode(JSON.stringify(env))), { target: peerId })
      }
      // Chunks are encrypted once with the per-file key and targeted at the recipients
      // only. Peers we skipped (already reached via another tier) get nothing.
      const targets = ready.map(([peerId]) => peerId)
      for (let i = 0; i < total; i++) {
        const buf = new Uint8Array(await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer())
        const iv = randomBytes(12)
        const aad = enc.encode(`${fileId}:${i}`)
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, buf))
        await fdata.send({ fileId, i, iv: bytesToB64(iv), ct: bytesToB64(ct) }, { target: targets })
        ev.onFileProgress?.(fileId, file.name, i + 1, total, true)
      }
      return ready.map(([, st]) => st.info.pubKeyHex)
    },

    async addMedia(stream: MediaStream, meta?: unknown) {
      if (opts.presenceOnly) return
      activeStreams.set(stream, meta)
      await Promise.all(room.addStream(stream, { metadata: meta as Record<string, string> | undefined }))
      syncAdaptLoop()
    },

    removeMedia(stream: MediaStream) {
      activeStreams.delete(stream)
      room.removeStream(stream)
      syncAdaptLoop() // stops the loop on the last video stream, not merely on leave()
    },

    async leave() {
      stopAdaptLoop()
      for (const s of activeStreams.keys()) room.removeStream(s)
      activeStreams.clear()
      for (const u of receivedUrls) URL.revokeObjectURL(u)
      receivedUrls.clear()
      await room.leave()
      peers.clear()
      incoming.clear()
      pendingChunks.clear()
      toolHandler = null
      gameHandler = null
      liveSessions.delete(api)
      if (active === api) active = null
    },
  }
  if (!opts.presenceOnly) {
    if (opts.primary || !active) active = api
    liveSessions.add(api)
  }
  return api
}
