// Work a reload would destroy that nothing on the page shows: a dictation being recorded,
// a file still moving in a hidden tab. A deployed update reloads the tab once it is idle
// (main.ts), and holds off while any probe registered here reports work in progress.

const probes = new Set<() => boolean>()

/** Hold an update's reload for as long as `busy` says so. Returns the unregister. */
export function holdUpdateWhile(busy: () => boolean): () => void {
  probes.add(busy)
  return () => void probes.delete(busy)
}

export function updateHeld(): boolean {
  for (const busy of probes) {
    try {
      if (busy()) return true
    } catch {
      // a probe that throws holds nothing
    }
  }
  return false
}
