// Nearby discovery + join codes (ARCHITECTURE section 5.4). Web pages cannot mDNS-scan,
// so "nearby" is approximated by shared public IP: a STUN binding request reveals our own
// server-reflexive address, and every device behind the same NAT derives the same room
// name from it, giving zero-touch discovery on the same Wi-Fi. Join codes are the serverless
// replacement for "incremental IDs": both sides derive the room from a short speakable
// code, so no ID allocator is needed and the code space stays sparse.
//
// Privacy trade-off: the nearby room name is H(public IP), so a
// relay observer who knows your IP can link your presence. Content is still E2EE and
// nearby peers are untrusted until verified, so nothing is auto-shared to them.

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
 * Deliberately NOT sharded or time-rotated. Sharding needs a rendezvous bucket everyone
 * probes first, and rotating the room name on a wall-clock epoch makes the whole
 * population re-join that one bucket simultaneously, which is worse than the problem it
 * solves. A single room is correct while the population is a small team; it is a full
 * mesh, so it does not stay correct at large scale. The tier carries presence ONLY
 * (`presenceOnly` in session.ts), which is what keeps the per-peer cost to a handshake.
 */
export function presenceRoom(): Promise<{ roomId: string; password: string }> {
  return derivedRoom('global', 'v1')
}

// No 0/1/o/i/l, so a code is unambiguous to read aloud or type. 6 chars give about
// 2^29 combinations: sparse enough for an ephemeral rendezvous with a tiny user base, and
// the content layer is protected by the authenticated E2EE handshake regardless.
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export function generateJoinCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return code
}

export function normalizeJoinCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function codeRoom(code: string): Promise<{ roomId: string; password: string }> {
  return derivedRoom('code', normalizeJoinCode(code))
}
