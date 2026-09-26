// Per-peer symmetric HKDF ratchet over an X25519 ECDH shared secret (ARCHITECTURE
// sections 6 and 9). Forward secrecy within a session: each message advances a chain key
// and the previous key is discarded, so a key captured later cannot decrypt earlier
// messages. The exception is a bounded set of keys for counters skipped on the way to a
// later message, held until that message arrives. Full Double-Ratchet / post-compromise
// security is the P4 upgrade.

import { aesKeyFromBytes, b64ToBytes, bytesToB64, hkdfBytes, randomBytes } from '../core/crypto'

const EMPTY = new Uint8Array(0)
const MAX_SKIP = 256 // bound out-of-order/gap key derivation, and the skipped keys held (anti-DoS)

export type SealedMessage = { n: number; iv: string; ct: string }

async function step(chain: Uint8Array<ArrayBuffer>): Promise<{ msgKey: Uint8Array<ArrayBuffer>; next: Uint8Array<ArrayBuffer> }> {
  // HKDF info strings are wire constants: both peers must derive the same key, so
  // changing them breaks decryption between versions.
  const msgKey = await hkdfBytes(chain, EMPTY, 'urletc/msg', 32)
  const next = await hkdfBytes(chain, EMPTY, 'urletc/chain', 32)
  return { msgKey, next }
}

export class SecureChannel {
  private sendChain: Uint8Array<ArrayBuffer>
  private recvChain: Uint8Array<ArrayBuffer>
  private sendCtr = 0
  private recvCtr = 0
  // Message keys for counters skipped on the way to a later message. Trystero interleaves
  // the frames of concurrent sends, so a large sealed message can complete after a small
  // one sealed after it. Each key is deleted once it opens its message, so a replay still
  // fails; the oldest is evicted past MAX_SKIP.
  private skipped = new Map<number, Uint8Array<ArrayBuffer>>()
  // Serializes seal/open so each read-derive-write of chain state is atomic across its
  // await points. Without this, two overlapping (unawaited) calls both read the same
  // chain key, derive duplicate message keys, and permanently desync the ratchet.
  private q: Promise<unknown> = Promise.resolve()

  private constructor(send: Uint8Array<ArrayBuffer>, recv: Uint8Array<ArrayBuffer>) {
    this.sendChain = send
    this.recvChain = recv
  }

  /** Run `body` after all prior segments; keep the queue alive on either outcome. */
  private enqueue<T>(body: () => Promise<T>): Promise<T> {
    const result = this.q.then(body)
    this.q = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Derive the two chains from the shared secret. `initiator` (decided by a stable
   * comparison of the two ephemeral public keys) picks which chain is send vs recv,
   * so the two peers mirror each other.
   */
  static async create(sharedSecret: ArrayBuffer, salt: Uint8Array<ArrayBuffer>, initiator: boolean): Promise<SecureChannel> {
    const root = await hkdfBytes(new Uint8Array(sharedSecret), salt, 'urletc/root', 64)
    const a = root.slice(0, 32)
    const b = root.slice(32, 64)
    return initiator ? new SecureChannel(a, b) : new SecureChannel(b, a)
  }

  seal(plaintext: BufferSource): Promise<SealedMessage> {
    return this.enqueue(async () => {
      const { msgKey, next } = await step(this.sendChain)
      this.sendChain = next // advance + drop the old key (forward secrecy)
      const key = await aesKeyFromBytes(msgKey)
      const iv = randomBytes(12)
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
      return { n: this.sendCtr++, iv: bytesToB64(iv), ct: bytesToB64(ct) }
    })
  }

  open(msg: SealedMessage): Promise<Uint8Array> {
    return this.enqueue(async () => {
      if (msg.n < this.recvCtr) {
        const held = this.skipped.get(msg.n)
        if (!held) throw new Error('stale or replayed message')
        const pt = await decryptWith(held, msg) // a failed open keeps the key for the real message
        this.skipped.delete(msg.n)
        return pt
      }
      const skip = msg.n - this.recvCtr
      if (skip > MAX_SKIP) throw new Error('message gap too large')
      for (let i = 0; i < skip; i++) {
        const { msgKey, next } = await step(this.recvChain)
        this.skipped.set(this.recvCtr, msgKey)
        if (this.skipped.size > MAX_SKIP) this.skipped.delete(this.skipped.keys().next().value as number)
        this.recvChain = next
        this.recvCtr++
      }
      const { msgKey, next } = await step(this.recvChain)
      this.recvChain = next
      this.recvCtr++
      return decryptWith(msgKey, msg)
    })
  }
}

async function decryptWith(msgKey: Uint8Array<ArrayBuffer>, msg: SealedMessage): Promise<Uint8Array> {
  const key = await aesKeyFromBytes(msgKey)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(msg.iv) }, key, b64ToBytes(msg.ct))
  return new Uint8Array(pt)
}
