import type { RoomSession } from '../p2p/session'
import type { Manifest } from '../workshop/manifest'

// A RoomSession holds one tool handler and one game handler, while several cards listen at
// once: two Workshop cards, or a Workshop app's room relay beside Pong. Each session gets a
// single dispatcher here, and a card adds and removes only its own callback, so closing one
// card never deafens another. Tools reach the session handlers only through this module.

function fanOut<A extends unknown[]>(install: (s: RoomSession, dispatch: (...a: A) => void) => void) {
  const subs = new WeakMap<RoomSession, Set<(...a: A) => void>>()
  return (s: RoomSession, cb: (...a: A) => void): (() => void) => {
    let set = subs.get(s)
    if (!set) {
      const all = new Set<(...a: A) => void>()
      install(s, (...a) => {
        for (const f of [...all]) f(...a)
      })
      subs.set(s, all)
      set = all
    }
    set.add(cb)
    return () => void set.delete(cb)
  }
}

/** Receive game payloads from authenticated peers on `s`; returns the unsubscribe. */
export const addGameHandler = fanOut<[payload: unknown, fromPeerId: string]>((s, d) => s.setGameHandler(d))

/** Receive verified tool manifests gossiped on `s`; returns the unsubscribe. */
export const addToolHandler = fanOut<[m: Manifest, fromName: string]>((s, d) => s.setToolHandler(d))
