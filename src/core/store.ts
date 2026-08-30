// Encrypted-at-rest store facade (ARCHITECTURE section 9, "Key lifecycle"). Two modes:
//
//  - device (default): a non-extractable AES-GCM CryptoKey generated once and kept
//    in IndexedDB. Protects an offline profile copy / other origin / casual IDB dump,
//    but NOT same-origin XSS (an attacker in our origin can use the key). Boots silently.
//
//  - passphrase (opt-in): the wrapping key is DERIVED on unlock via PBKDF2 at 600k
//    iterations from a user passphrase + stored salt and held ONLY in memory, zeroised
//    on lock. This is the mode that actually raises the bar against an offline attacker
//    AND a *later* XSS (a locked vault has no key in memory), at the cost of re-unlocking.
//
// Primary XSS controls remain CSP + Trusted Types + DOMPurify. Encrypted-at-rest is
// secondary and is NOT an XSS control in device mode.

import { createStore, del, get, keys, set } from 'idb-keyval'
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, type AesGcmBlob } from './crypto'
import type { ToolStorage } from '../shell/registry'

const keyStore = createStore('wt-keys', 'kv')
const dataStore = createStore('wt-data', 'kv')
const WRAP_KEY_ID = 'wrap-key:v1'
const MODE_ID = 'mode:v1'
const SALT_ID = 'pp-salt:v1'
const VERIFIER_ID = 'pp-verifier:v1'
const MIGRATION_ID = 'migration:v1' // present only while a mode switch is mid-flight (target mode)
const PBKDF2_ITERS = 600_000
// Plaintext sealed into the vault so a candidate passphrase can be tested. Changing this
// value invalidates every existing passphrase vault, so treat it as frozen from here on.
const VERIFIER_TOKEN = 'urletc-verifier'
// Vaults sealed before the rename hold the old token. A passphrase that unlocks such a
// vault must keep working, so verification accepts either value and the vault is resealed
// with the current one on the next write. Dropping this list would lock people out of
// their own data.
const LEGACY_VERIFIER_TOKENS = ['utilscript-verifier', 'web-toolkit-verifier']
const TOOL_QUOTA_BYTES = 1024 * 1024 // 1 MiB per tool namespace (ARCHITECTURE section 8.2)

export type StoreMode = 'device' | 'passphrase'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let wrapKey: CryptoKey | null = null
let locked = false

/**
 * Boot the store. Returns whether it is locked (passphrase mode, awaiting unlock).
 *
 * A mode switch (enable/disablePassphrase) is not a single atomic write, so a crash
 * mid-switch can leave items under a key the plain `MODE` would not select. The
 * MIGRATION marker makes that state detectable and recoverable instead of silent loss:
 * `MODE` is flipped only AFTER every item is re-wrapped, so `MODE` alone is always
 * trustworthy; the marker tells us to finish (or roll back) any leftover switch.
 */
export async function initStore(): Promise<{ locked: boolean }> {
  const migrating = (await get<string>(MIGRATION_ID, keyStore)) as StoreMode | undefined
  const mode = ((await get<string>(MODE_ID, keyStore)) ?? 'device') as StoreMode

  if (migrating === 'passphrase' && mode !== 'passphrase') {
    // Interrupted switch TO passphrase, not yet committed. If no item was re-wrapped
    // (the salt is written just before the rewrite loop), roll back to device; else
    // stay locked and let unlock() finish it under the passphrase key.
    if (await get(SALT_ID, keyStore)) {
      wrapKey = null
      locked = true
      return { locked: true }
    }
    await del(MIGRATION_ID, keyStore)
    await del(VERIFIER_ID, keyStore)
    await del(SALT_ID, keyStore)
  } else if (migrating === 'device' && mode === 'passphrase') {
    // Interrupted switch TO device, not yet committed, so it needs the passphrase.
    wrapKey = null
    locked = true
    return { locked: true }
  }

  if (mode === 'passphrase') {
    // committed passphrase mode (marker, if any, is a post-commit remnant unlock() clears)
    wrapKey = null
    locked = true
    return { locked: true }
  }

  // Device mode, including a disable that already committed (MODE=device) but had not
  // finished cleaning up: items are already under the device key, so tidy the leftovers.
  let key = await get<CryptoKey>(WRAP_KEY_ID, keyStore)
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await set(WRAP_KEY_ID, key, keyStore)
  }
  wrapKey = key
  locked = false
  if (migrating === 'device') {
    await del(SALT_ID, keyStore)
    await del(VERIFIER_ID, keyStore)
    await del(MIGRATION_ID, keyStore)
  }
  return { locked: false }
}

/**
 * Re-wrap every item from `fromKey` to `toKey`, then commit the target mode and clear the
 * marker. Idempotent and restartable: an item already under `toKey` is left untouched, so
 * a switch interrupted mid-rewrite can be finished by re-running this. `fromKey` may be
 * null only when every remaining item is already under `toKey`.
 */
async function finishSwitch(target: StoreMode, toKey: CryptoKey, fromKey: CryptoKey | null): Promise<void> {
  for (const k of await allKeys()) {
    const blob = await get<AesGcmBlob>(k, dataStore)
    if (!blob) continue
    let pt: Uint8Array<ArrayBuffer>
    try {
      await aesGcmDecrypt(toKey, blob)
      continue // already re-wrapped under the target key
    } catch {
      if (!fromKey) throw new Error('store migration is unrecoverable (missing source key)')
      pt = await aesGcmDecrypt(fromKey, blob)
    }
    await set(k, await aesGcmEncrypt(toKey, pt), dataStore)
  }
  await set(MODE_ID, target, keyStore) // durable commit: MODE now matches every item
  if (target === 'passphrase') {
    await del(WRAP_KEY_ID, keyStore)
  } else {
    await del(SALT_ID, keyStore)
    await del(VERIFIER_ID, keyStore)
  }
  await del(MIGRATION_ID, keyStore)
}

export async function getStoreMode(): Promise<StoreMode> {
  return ((await get<string>(MODE_ID, keyStore)) ?? 'device') as StoreMode
}

export function isLocked(): boolean {
  return locked
}

function requireKey(): CryptoKey {
  if (locked || !wrapKey) throw new Error('store is locked')
  return wrapKey
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Unlock a passphrase-mode store. Returns false on wrong passphrase. */
export async function unlock(passphrase: string): Promise<boolean> {
  const salt = await get<Uint8Array<ArrayBuffer>>(SALT_ID, keyStore)
  const verifier = await get<AesGcmBlob>(VERIFIER_ID, keyStore)
  if (!salt || !verifier) throw new Error('no passphrase configured')
  const ppKey = await deriveKey(passphrase, salt)
  try {
    // Accept the current token or any pre-rename one. The passphrase is what proves the
    // user; the token only proves the key decrypts, so refusing an older constant would
    // lock someone out of a vault their passphrase still opens.
    const seen = decoder.decode(await aesGcmDecrypt(ppKey, verifier))
    if (seen !== VERIFIER_TOKEN && !LEGACY_VERIFIER_TOKENS.includes(seen)) return false
    if (seen !== VERIFIER_TOKEN) await set(VERIFIER_ID, await aesGcmEncrypt(ppKey, encoder.encode(VERIFIER_TOKEN)), keyStore)
  } catch {
    return false
  }

  // Finish a switch that was interrupted before commit (both keys are in hand here).
  const migrating = (await get<string>(MIGRATION_ID, keyStore)) as StoreMode | undefined
  if (migrating === 'device') {
    let deviceKey = await get<CryptoKey>(WRAP_KEY_ID, keyStore)
    if (!deviceKey) {
      deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await set(WRAP_KEY_ID, deviceKey, keyStore)
    }
    await finishSwitch('device', deviceKey, ppKey)
    wrapKey = deviceKey
    locked = false
    return true
  }
  if (migrating === 'passphrase') {
    const deviceKey = (await get<CryptoKey>(WRAP_KEY_ID, keyStore)) ?? null
    await finishSwitch('passphrase', ppKey, deviceKey)
  }

  wrapKey = ppKey
  locked = false
  return true
}

/**
 * Forget the in-memory key; subsequent access requires unlock(). Only meaningful in
 * passphrase mode (in device mode the key is reloaded from IDB on the next initStore),
 * so the UI exposes "Lock" only when the store is in passphrase mode.
 */
export function lock(): void {
  wrapKey = null
  locked = true
}

/**
 * Switch to passphrase mode: re-wrap every stored item under a passphrase-derived key.
 * Guarded by the MIGRATION marker so an interruption is finished (or rolled back) on the
 * next boot/unlock rather than stranding items under the unselected key. `MODE` flips only
 * after the whole rewrite, and the old device key is dropped only after the commit.
 */
export async function enablePassphrase(passphrase: string): Promise<void> {
  const deviceKey = requireKey()
  const salt = randomBytes(16)
  const ppKey = await deriveKey(passphrase, salt)

  await set(MIGRATION_ID, 'passphrase', keyStore) // mark in-flight (device key still selectable)
  await set(VERIFIER_ID, await aesGcmEncrypt(ppKey, encoder.encode(VERIFIER_TOKEN)), keyStore)
  await set(SALT_ID, salt, keyStore) // a stored salt means "committed to going forward" (see initStore)
  await finishSwitch('passphrase', ppKey, deviceKey)
  wrapKey = ppKey
  locked = false
}

/**
 * Switch back to device mode (must be unlocked): re-wrap items under a fresh device key.
 * The new device key is persisted before the rewrite so an interrupted switch can be
 * finished without the passphrase once `MODE` has committed.
 */
export async function disablePassphrase(): Promise<void> {
  const ppKey = requireKey()
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

  await set(MIGRATION_ID, 'device', keyStore)
  await set(WRAP_KEY_ID, deviceKey, keyStore) // persist target key before any item is re-wrapped
  await finishSwitch('device', deviceKey, ppKey)
  wrapKey = deviceKey
  locked = false
}

export async function setItem(key: string, value: unknown): Promise<void> {
  const blob = await aesGcmEncrypt(requireKey(), encoder.encode(JSON.stringify(value)))
  await set(key, blob, dataStore)
}

export async function getItem<T = unknown>(key: string): Promise<T | undefined> {
  const blob = await get<AesGcmBlob>(key, dataStore)
  if (!blob) return undefined
  const pt = await aesGcmDecrypt(requireKey(), blob)
  return JSON.parse(decoder.decode(pt)) as T
}

export async function removeItem(key: string): Promise<void> {
  await del(key, dataStore)
}

export async function allKeys(): Promise<string[]> {
  return (await keys(dataStore)).map(String)
}

/** Sum the ciphertext bytes already stored under a namespace (no decryption). */
async function namespaceBytes(ns: string): Promise<number> {
  let total = 0
  for (const k of await allKeys()) {
    if (!k.startsWith(ns)) continue
    const blob = await get<AesGcmBlob>(k, dataStore)
    if (blob) total += blob.ct.length + blob.iv.length
  }
  return total
}

/** Per-tool, key-prefix-isolated storage handed to a tool via its ToolContext. */
export function toolStorage(toolId: string): ToolStorage {
  const ns = `tool:${toolId}:`
  return {
    get: <T = unknown>(k: string) => getItem<T>(ns + k),
    set: async (k: string, v: unknown) => {
      // Bound a tool's footprint so a `storage`-granted tool can't exhaust origin IDB.
      const incoming = encoder.encode(JSON.stringify(v)).length + 28 // ~AES-GCM overhead
      if ((await namespaceBytes(ns)) + incoming > TOOL_QUOTA_BYTES) {
        throw new Error('tool storage quota exceeded (1 MiB)')
      }
      await setItem(ns + k, v)
    },
    remove: (k: string) => removeItem(ns + k),
    keys: async () => (await allKeys()).filter((x) => x.startsWith(ns)).map((x) => x.slice(ns.length)),
  }
}
