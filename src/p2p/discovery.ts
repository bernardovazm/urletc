// Nearby discovery + join codes (ARCHITECTURE section 5.4). Web pages cannot mDNS-scan,
// so "nearby" is approximated by shared public IP: a STUN binding request reveals our own
// server-reflexive address, and every device behind the same NAT derives the same room
// name from it, which gives zero-touch discovery on one Wi-Fi. Join codes replace an ID
// allocator: both sides derive the room from a short speakable code, and the code space
// stays sparse.
//
// Privacy trade-off: the nearby room name is H(public IP), so a relay observer who knows
// your IP can link your presence. Content is still E2EE and nearby peers are untrusted
// until verified, so nothing is auto-shared to them.

import { bytesToB64, randomBytes, sha256, toHex } from '../core/crypto'

const enc = new TextEncoder()

async function derivedRoom(tag: string, seed: string): Promise<{ roomId: string; password: string }> {
  const roomId = `wt-${tag}-${toHex(await sha256(enc.encode(`wt|${tag}|room|${seed}`))).slice(0, 24)}`
  const password = bytesToB64(new Uint8Array(await sha256(enc.encode(`wt|${tag}|pw|${seed}`))))
  return { roomId, password }
}

/**
 * Our own public (server-reflexive) IP via a STUN binding request. Resolves null when
 * WebRTC/UDP is blocked; nearby discovery is then skipped. Prefers IPv4 (both
 * devices on one NAT share it); falls back to IPv6 at end of gathering.
 */
export function publicIp(timeoutMs = 4000): Promise<string | null> {
  if (typeof RTCPeerConnection === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
      })
    } catch {
      resolve(null)
      return
    }
    let v6: string | null = null
    let done = false
    const finish = (ip: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      pc.close()
      resolve(ip)
    }
    const timer = setTimeout(() => finish(v6), timeoutMs)
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish(v6) // end of gathering
      const parts = e.candidate.candidate.split(' ')
      const typ = e.candidate.type ?? parts[7]
      if (typ !== 'srflx') return
      const addr = (e.candidate.address ?? parts[4] ?? '').toLowerCase()
      if (!addr) return
      if (addr.includes(':')) v6 = v6 ?? addr
      else finish(addr)
    }
    pc.createDataChannel('probe')
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => finish(null))
  })
}

export function nearbyRoom(ip: string): Promise<{ roomId: string; password: string }> {
  return derivedRoom('nearby', ip)
}

/**
 * The presence room: one fixed room every opted-in device joins, so "who else is online"
 * has an answer without a shared secret, a shared IP or a code.
 *
 * Not sharded and not time-rotated. Sharding needs a rendezvous bucket everyone probes
 * first, and rotating the room name on a wall-clock epoch makes the whole population
 * re-join that one bucket simultaneously. A single room is a full mesh, so it holds while
 * the population is a small team and does not scale past that. The tier carries presence
 * only (`presenceOnly` in session.ts), which keeps the per-peer cost to a handshake.
 */
export function presenceRoom(): Promise<{ roomId: string; password: string }> {
  return derivedRoom('global', 'v1')
}

// No 0/1/o/i/l, so a code is unambiguous read aloud or typed. The room a code names is
// published, hashed, as a topic on public Nostr relays, so anyone watching them can test
// candidate codes offline: 6 characters (2^29.7) behind two fast hashes fell to one core
// in under two hours, or to a lookup table for every room at once. 8 characters (2^39.6)
// behind PBKDF2 at CODE_KDF_ITERATIONS put a table at about a GPU-year.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const CODE_LENGTH = 8
const CODE_KDF_ITERATIONS = 200_000

export function generateJoinCode(): string {
  let code = ''
  while (code.length < CODE_LENGTH) {
    // Rejection sampling: 256 is not a multiple of 31, so b % 31 favoured the first letters.
    for (const b of randomBytes(CODE_LENGTH)) if (b < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  }
  return code
}

export function normalizeJoinCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// One derivation per code per page: every rejoin of the same room would otherwise pay the
// KDF again.
const codeRooms = new Map<string, Promise<{ roomId: string; password: string }>>()

/** The room a join code names, derived slowly on purpose (see CODE_ALPHABET). Codes chosen
 *  by hand, often words, are the weakest, and get the same cost per guess. */
export function codeRoom(code: string): Promise<{ roomId: string; password: string }> {
  const seed = normalizeJoinCode(code)
  let room = codeRooms.get(seed)
  if (!room) {
    room = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(seed), 'PBKDF2', false, ['deriveBits'])
      // One 256-bit block: a second block doubles the cost here and not for an attacker,
      // who needs only the room id to test a guess.
      const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('wt|code|v2'), iterations: CODE_KDF_ITERATIONS }, base, 256))
      return { roomId: `wt-code2-${toHex(bits.slice(0, 12))}`, password: bytesToB64(bits.slice(12)) }
    })()
    room.catch(() => codeRooms.delete(seed))
    codeRooms.set(seed, room)
  }
  return room
}
