// The single tool contract. Built-in tools AND Workshop tools implement the same
// ToolManifest/ToolModule (ARCHITECTURE section 3). The shell distinguishes them only by
// `source`/trust level and load path. Heavy code lives behind `load()` (a dynamic
// import) so it is fetched only on activation.

export type TrustTier = 'builtin' | 'trusted' | 'self' | 'unverified' | 'unsigned'

export type Permission = 'clipboard-read' | 'clipboard-write' | 'storage' | 'notifications' | { net: string[] } // explicit origin allow-list; ALL traffic proxied via the host (section 8.2)

export interface ToolManifest {
  id: string // built-in: slug; workshop: SHA-256 content id
  name: string
  description?: string
  category: 'clipboard' | 'media' | 'p2p' | 'workshop' | 'util'
  version: string // semver
  icon?: string // emoji or inline data: URI
  permissions: Permission[]
  source: 'builtin' | 'workshop'
  load: () => Promise<ToolModule | { default: ToolModule }>
}

export interface ToolModule {
  activate(container: HTMLElement, ctx: ToolContext): void | Promise<void>
  // Receives the same container passed to activate. A tool's `load()` resolves to the
  // cached ES-module singleton, so several open cards share one ToolModule object; a
  // tool that owns per-card resources MUST key them by `container` (not module scope)
  // so this tears down the exact instance being removed. (Older no-arg impls stay valid.)
  deactivate?(container: HTMLElement): void
}

export interface ToolStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface ClipboardCaps {
  /** Rich read (ClipboardItems), gated by 'clipboard-read'. */
  read(): Promise<ClipboardItem[]>
  /** Plain-text read, gated by 'clipboard-read'. */
  readText(): Promise<string>
  /** Plain-text write, gated by 'clipboard-write'. */
  write(text: string): Promise<void>
}

/**
 * The capability facade is the security boundary. For built-in (host-realm) tools
 * it is a direct object; for sandboxed Workshop tools it will be the postMessage
 * RPC surface (section 8.2). Either way it exposes ONLY declared + consented capabilities.
 */
export interface ToolContext {
  manifest: ToolManifest
  storage: ToolStorage
  clipboard: ClipboardCaps
  toast(message: string): void
}

class Registry {
  private tools = new Map<string, ToolManifest>()

  register(manifest: ToolManifest): void {
    // Enforce the storage-namespace invariant: ids must be delimiter-free so
    // `tool:<id>:<key>` prefixes can never collide across tools (store.ts).
    if (!/^[A-Za-z0-9_-]+$/.test(manifest.id)) {
      throw new Error(`invalid tool id (allowed: A-Z a-z 0-9 _ -): ${manifest.id}`)
    }
    if (this.tools.has(manifest.id)) {
      throw new Error(`duplicate tool id: ${manifest.id}`)
    }
    this.tools.set(manifest.id, manifest)
  }

  get(id: string): ToolManifest | undefined {
    return this.tools.get(id)
  }

  list(): ToolManifest[] {
    return [...this.tools.values()]
  }
}

export const registry = new Registry()
