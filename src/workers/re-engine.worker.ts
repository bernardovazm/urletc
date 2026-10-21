/// <reference lib="webworker" />
// Isolated regex engine for declarative automations (ARCHITECTURE section 7.1). Runs a
// single user-supplied replace. The caller races it against a wall-clock timeout and
// terminates this worker on overrun, so a catastrophic-backtracking pattern can DoS only
// this throwaway worker and never the main thread. RE2-WASM is the stronger future upgrade;
// the timeout-terminate guard is the current control.

self.onmessage = (e) => {
  const { input, pattern, flags, replacement, max } = e.data
  try {
    const re = new RegExp(pattern, flags)
    // Checked here, before the result is cloned to the main thread: a replace that turns a
    // small input into hundreds of MB would otherwise be copied there to be rejected.
    const result = String(input).replace(re, replacement)
    postMessage(result.length > max ? { ok: false, error: 'regex output too large' } : { ok: true, result })
  } catch (err) {
    postMessage({ ok: false, error: err && err.message ? err.message : String(err) })
  }
}
