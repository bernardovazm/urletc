// Crypto core, native WebCrypto only (ARCHITECTURE section 9). No JS-crypto polyfill:
// on a browser lacking native Ed25519/X25519 we hard-fail the crypto-dependent
// features (P2P + Workshop) rather than ship a weaker, larger attack surface.
// Single-user tools (clipboard/OCR/STT/TTS) do not depend on these curves.

export interface CryptoCaps {
  subtle: boolean
  ed25519: boolean
  x25519: boolean
}

let capsPromise: Promise<CryptoCaps> | null = null

/** Probe for the curve algorithms we require for P2P. Memoized, so it probes once per page. */
export function probeCrypto(): Promise<CryptoCaps> {
  capsPromise ??= runProbe()
  return capsPromise
}

async function runProbe(): Promise<CryptoCaps> {
  const subtle = typeof globalThis.crypto?.subtle?.generateKey === 'function'
  let ed25519 = false
  let x25519 = false
  if (subtle) {
    // A capability probe must be total: any failure means "unsupported here".
    try {
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      ed25519 = true
    } catch {
      /* unsupported */
    }
    try {
      await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
      x25519 = true
    } catch {
      /* unsupported */
    }
  }
  return { subtle, ed25519, x25519 }
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return a
}

export async function sha256(data: BufferSource): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', data)
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export interface AesGcmBlob {
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
}

export async function aesGcmEncrypt(key: CryptoKey, plaintext: BufferSource): Promise<AesGcmBlob> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  return { iv, ct }
}

export async function aesGcmDecrypt(key: CryptoKey, blob: AesGcmBlob): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, blob.ct)
  return new Uint8Array(pt)
}

// --- Asymmetric + KDF helpers for P2P E2EE (ARCHITECTURE sections 5 and 6) ---

export async function signEd25519(privateKey: CryptoKey, data: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, data))
}

export async function verifyEd25519(publicKeyRaw: BufferSource, signature: BufferSource, data: BufferSource): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', publicKeyRaw, { name: 'Ed25519' }, false, ['verify'])
  return crypto.subtle.verify('Ed25519', key, signature, data)
}

/** X25519 ECDH to a 32-byte shared secret. */
export async function deriveSharedSecret(privateKey: CryptoKey, peerPublicRaw: BufferSource): Promise<ArrayBuffer> {
  const peerPub = await crypto.subtle.importKey('raw', peerPublicRaw, { name: 'X25519' }, false, [])
  return crypto.subtle.deriveBits({ name: 'X25519', public: peerPub }, privateKey, 256)
}

export async function hkdfBytes(ikm: BufferSource, salt: BufferSource, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const out = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) }, base, bytes * 8)
  return new Uint8Array(out)
}

export async function aesKeyFromBytes(raw: BufferSource): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 ? `0${hex}` : hex
  const a = new Uint8Array(clean.length / 2)
  for (let i = 0; i < a.length; i++) a[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return a
}

/**
 * Signal-style safety number for two device public keys (ARCHITECTURE section 9). Both
 * peers derive the identical code (inputs are sorted), so they can compare it
 * out-of-band to detect a man-in-the-middle on the TOFU key exchange.
 */
export async function safetyNumber(aHex: string, bHex: string): Promise<string> {
  const [lo, hi] = aHex < bHex ? [aHex, bHex] : [bHex, aHex]
  const digest = toHex(await sha256(new TextEncoder().encode(lo + hi)))
  return (digest.slice(0, 20).match(/.{1,4}/g) ?? []).join('-')
}
