// Device identity (ARCHITECTURE sections 5.3 and 9): a single Ed25519 (signing) +
// X25519 (ECDH) non-extractable keypair per device, persisted in IndexedDB.
// deviceId = hex( SHA-256( raw Ed25519 public key ) ).
//
// Private keys are non-extractable; public keys are always exportable, so we can
// derive the fingerprint without weakening the private material. If the browser
// lacks the native curves we throw CryptoUnsupportedError. The caller falls back
// to tools-only mode, where the local tools still work.

import { createStore, get, set } from 'idb-keyval'
import { probeCrypto, sha256, toHex } from './crypto'

const keyStore = createStore('wt-keys', 'kv')
const SIGN_ID = 'identity:sign:v1'
const ECDH_ID = 'identity:ecdh:v1'

export interface DeviceIdentity {
  sign: CryptoKeyPair // Ed25519
  ecdh: CryptoKeyPair // X25519
  deviceId: string // hex sha256 of the Ed25519 public key
  publicKeyHex: string // raw Ed25519 public key, hex
}

export class CryptoUnsupportedError extends Error {
  constructor() {
    super('This browser lacks native Ed25519/X25519 WebCrypto. P2P & Workshop features are disabled; please update your browser. Local tools still work.')
    this.name = 'CryptoUnsupportedError'
  }
}

let cached: DeviceIdentity | null = null

export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  if (cached) return cached

  const caps = await probeCrypto()
  if (!caps.ed25519 || !caps.x25519) throw new CryptoUnsupportedError()

  let sign = await get<CryptoKeyPair>(SIGN_ID, keyStore)
  if (!sign) {
    sign = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
    await set(SIGN_ID, sign, keyStore)
  }

  let ecdh = await get<CryptoKeyPair>(ECDH_ID, keyStore)
  if (!ecdh) {
    ecdh = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    await set(ECDH_ID, ecdh, keyStore)
  }

  const pubRaw = await crypto.subtle.exportKey('raw', sign.publicKey)
  cached = {
    sign,
    ecdh,
    publicKeyHex: toHex(pubRaw),
    deviceId: toHex(await sha256(pubRaw)),
  }
  return cached
}
