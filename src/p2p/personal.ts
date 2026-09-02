// "Personal room": the client-side stand-in for LAN device discovery (ARCHITECTURE
// section 5.4: web pages cannot mDNS-scan). A 32-byte secret is generated once per
// identity and shared to your other devices via a one-time pairing link/QR. Every device
// that holds the secret auto-joins the SAME private room; WebRTC ICE then connects them
// directly over the LAN when they are on the same network. So "send an image to my
// phone" means both devices auto-join the personal room and ICE goes LAN-direct.

import { b64ToBytes, bytesToB64, randomBytes, sha256, toHex } from '../core/crypto'
import { getItem, setItem } from '../core/store'

const SECRET_KEY = 'personal-secret:v1'
const enc = new TextEncoder()

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export async function getPersonalSecret(): Promise<Uint8Array<ArrayBuffer> | null> {
  const b64 = await getItem<string>(SECRET_KEY)
  return b64 ? b64ToBytes(b64) : null
}

export async function ensurePersonalSecret(): Promise<Uint8Array<ArrayBuffer>> {
  const existing = await getPersonalSecret()
  if (existing) return existing
  const secret = randomBytes(32)
  await setItem(SECRET_KEY, bytesToB64(secret))
  return secret
}

/** Rotate the pairing secret. Other devices are unpaired until they use the new link. */
export async function resetPersonalSecret(): Promise<Uint8Array<ArrayBuffer>> {
  const secret = randomBytes(32)
  await setItem(SECRET_KEY, bytesToB64(secret))
  return secret
}

export async function importPersonalSecret(b64: string): Promise<void> {
  if (b64ToBytes(b64).length !== 32) throw new Error('invalid pairing code')
  await setItem(SECRET_KEY, b64)
}

export async function personalRoom(secret: Uint8Array): Promise<{ roomId: string; password: string }> {
  const roomId = `wt-personal-${toHex(await sha256(concat(secret, enc.encode('room')))).slice(0, 24)}`
  const password = bytesToB64(new Uint8Array(await sha256(concat(secret, enc.encode('pw')))))
  return { roomId, password }
}

export function pairLink(secret: Uint8Array): string {
  return `${location.origin}${location.pathname}#/pair?s=${encodeURIComponent(bytesToB64(secret))}`
}
