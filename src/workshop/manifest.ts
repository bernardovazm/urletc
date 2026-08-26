// Workshop tool manifest: schema, content-addressing, Ed25519 signing/verification,
// and trust tiers (ARCHITECTURE section 7). A manifest is the single contract for a
// shared tool. `type:'automation'` carries a bounded declarative rule list (safe-by-
// construction, section 7.1); `type:'script'` carries JS source that only ever runs in
// the sandbox (section 8, Phase 3b); `type:'html'` carries a self-contained HTML app that runs
// only in the visible, no-deadline variant of the same null-origin sandbox
// (sandbox.ts runHtmlApp). Integrity = SHA-256 content hash; authenticity = Ed25519
// signature over the canonical metadata (which commits to the body via its hash).

import { z } from '../core/zod'
import { b64ToBytes, bytesToB64, hexToBytes, sha256, signEd25519, toHex, verifyEd25519 } from '../core/crypto'
import type { DeviceIdentity } from '../core/identity'
import { StepSchema } from './automation'

const enc = new TextEncoder()

export const PermissionSchema = z.union([
  z.literal('clipboard-read'),
  z.literal('clipboard-write'),
  z.literal('storage'),
  z.literal('notifications'),
  z.literal('p2p-room'), // best-effort room-channel relay with game-channel semantics (section 5.4): scores/state, never secrets
  z.object({ net: z.array(z.string().max(200)).max(8) }),
])
export type Permission = z.infer<typeof PermissionSchema>

export const AutomationBodySchema = z.object({ kind: z.literal('rules'), steps: z.array(StepSchema).max(64) })
export const ScriptBodySchema = z.object({ kind: z.literal('script'), source: z.string().max(512 * 1024) })
export const HtmlBodySchema = z.object({ kind: z.literal('html'), source: z.string().max(512 * 1024) })
export const BodySchema = z.union([AutomationBodySchema, ScriptBodySchema, HtmlBodySchema])
export type Body = z.infer<typeof BodySchema>

export const ManifestSchema = z.object({
  id: z.string().max(80),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(20),
  type: z.enum(['automation', 'script', 'html']),
  author: z.object({ pubkey: z.string().max(140), displayName: z.string().max(40) }),
  createdAt: z.number().int().nonnegative(),
  permissions: z.array(PermissionSchema).max(8),
  contentHash: z.string().max(80),
  body: BodySchema,
  sig: z.string().max(120),
})
export type Manifest = z.infer<typeof ManifestSchema>

export interface DraftManifest {
  name: string
  version: string
  type: 'automation' | 'script' | 'html'
  permissions: Permission[]
  body: Body
}

export type TrustTier = 'self' | 'trusted' | 'unverified' | 'unsigned'

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(',')}}`
}

async function hashOf(value: unknown): Promise<string> {
  return `sha256:${toHex(await sha256(enc.encode(canonicalJSON(value))))}`
}

interface SignedMeta {
  id: string
  name: string
  version: string
  type: 'automation' | 'script' | 'html'
  author: { pubkey: string; displayName: string }
  createdAt: number
  permissions: Permission[]
  contentHash: string
}

function signedMetaOf(m: Manifest): SignedMeta {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    type: m.type,
    author: m.author,
    createdAt: m.createdAt,
    permissions: m.permissions,
    contentHash: m.contentHash,
  }
}

export async function signManifest(id: DeviceIdentity, displayName: string, draft: DraftManifest, createdAt: number): Promise<Manifest> {
  const contentHash = await hashOf(draft.body)
  const author = { pubkey: `ed25519:${id.publicKeyHex}`, displayName: displayName.slice(0, 40) || 'me' }
  const manifestId = await hashOf({
    name: draft.name,
    version: draft.version,
    type: draft.type,
    permissions: draft.permissions,
    contentHash,
  })
  const meta: SignedMeta = { id: manifestId, name: draft.name, version: draft.version, type: draft.type, author, createdAt, permissions: draft.permissions, contentHash }
  const sig = await signEd25519(id.sign.privateKey, enc.encode(canonicalJSON(meta)))
  return { ...meta, body: draft.body, sig: `ed25519:${bytesToB64(sig)}` }
}

/** Validate integrity (hashes) + authenticity (signature) of an untrusted manifest. */
export async function verifyManifest(m: Manifest): Promise<{ ok: boolean; reason?: string }> {
  if ((await hashOf(m.body)) !== m.contentHash) return { ok: false, reason: 'content hash mismatch' }
  const expectId = await hashOf({ name: m.name, version: m.version, type: m.type, permissions: m.permissions, contentHash: m.contentHash })
  if (expectId !== m.id) return { ok: false, reason: 'id / content mismatch' }
  if (!m.author.pubkey.startsWith('ed25519:') || !m.sig.startsWith('ed25519:')) return { ok: false, reason: 'unsigned' }
  try {
    const pub = hexToBytes(m.author.pubkey.slice('ed25519:'.length))
    const sig = b64ToBytes(m.sig.slice('ed25519:'.length))
    const ok = await verifyEd25519(pub, sig, enc.encode(canonicalJSON(signedMetaOf(m))))
    return ok ? { ok: true } : { ok: false, reason: 'bad signature' }
  } catch {
    return { ok: false, reason: 'malformed key/signature' }
  }
}

export function trustTier(m: Manifest, selfPubHex: string, trustedPubkeys: Set<string>, verified: boolean): TrustTier {
  if (!verified) return 'unsigned'
  const pub = m.author.pubkey.replace(/^ed25519:/, '')
  if (pub === selfPubHex) return 'self'
  if (trustedPubkeys.has(pub)) return 'trusted'
  return 'unverified'
}
