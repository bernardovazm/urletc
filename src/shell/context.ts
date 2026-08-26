// Builds the ToolContext capability facade for a built-in (host-realm) tool: exposes
// ONLY the capabilities the manifest declares (clipboard gated; storage gated to a
// denied facade if undeclared). Shared by the console's tool launcher and direct
// tool routes so the gating logic lives in one place.

import { toolStorage } from '../core/store'
import { toast } from './ui'
import type { ToolContext, ToolManifest, ToolStorage } from './registry'

function deniedStorage(id: string): ToolStorage {
  const fail = (): never => {
    throw new Error(`'storage' not declared by tool '${id}'`)
  }
  return { get: async () => fail(), set: async () => fail(), remove: async () => fail(), keys: async () => fail() }
}

export function createContext(m: ToolManifest): ToolContext {
  const can = (p: 'clipboard-read' | 'clipboard-write') => m.permissions.includes(p)
  const deny = (p: string): never => {
    throw new Error(`'${p}' not declared by tool '${m.id}'`)
  }
  return {
    manifest: m,
    storage: m.permissions.includes('storage') ? toolStorage(m.id) : deniedStorage(m.id),
    toast,
    clipboard: {
      read: async () => (can('clipboard-read') ? navigator.clipboard.read() : deny('clipboard-read')),
      readText: async () => (can('clipboard-read') ? navigator.clipboard.readText() : deny('clipboard-read')),
      write: async (text: string) => (can('clipboard-write') ? navigator.clipboard.writeText(text) : deny('clipboard-write')),
    },
  }
}
