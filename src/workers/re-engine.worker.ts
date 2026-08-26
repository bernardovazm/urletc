/// <reference lib="webworker" />
// Isolated regex engine for declarative automations (ARCHITECTURE section 7.1). Runs a
// single user-supplied replace; the caller races it against a wall-clock timeout
// and terminates this worker on overrun, so a catastrophic-backtracking pattern
// can DoS only this throwaway worker, never the main thread. (RE2-WASM is the
// stronger future upgrade; this timeout-terminate guard is the current control.)

self.onmessage = (e) => {
  const { input, pattern, flags, replacement } = e.data
  try {
    const re = new RegExp(pattern, flags)
    postMessage({ ok: true, result: String(input).replace(re, replacement) })
  } catch (err) {
    postMessage({ ok: false, error: err && err.message ? err.message : String(err) })
  }
}
