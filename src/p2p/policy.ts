// Relay only as this page loaded it. The first room joined fixes the ICE policy of every
// connection the page builds (session.ts), so a stored value that differs is not in force
// until a reload, and Settings has to tell the two apart.
let atLoad: boolean | null = null

/** Recorded once, by the console, from the value it read at boot. */
export function noteRelayOnlyAtLoad(on: boolean): void {
  atLoad ??= on
}

/** The value in force on this page, or null before the console has read it. */
export function relayOnlyAtLoad(): boolean | null {
  return atLoad
}
