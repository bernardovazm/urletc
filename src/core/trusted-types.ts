// The CSP sets `require-trusted-types-for 'script'`, which makes the Worker constructor a
// TrustedScriptURL sink. With no policy installed, every `new Worker(...)` throws "This
// document requires 'TrustedScriptURL' assignment", whether the argument is a string, a
// URL object or a blob: URL. That disabled OCR, speech to text, live captions and the
// Workshop regex engine.
//
// Bundled code could be reworked to avoid the sink; third-party libraries cannot, since
// tesseract.js and transformers.js build their own workers internally. A default policy is
// the only mechanism that covers them, because it is what the browser consults when an
// unpatched call site hands a plain string to a sink.
//
// Kept as narrow as it can be:
//
//   * Only createScriptURL is implemented. createHTML and createScript are left
//     undefined, so assigning a string to innerHTML or reaching eval still throws, which
//     keeps the "no innerHTML from strings" invariant intact.
//   * createScriptURL accepts only same-origin and blob: URLs. `script-src 'self'` plus
//     `worker-src 'self' blob:` reject a cross-origin script URL again at the CSP layer,
//     so this is defence in depth and not a replacement for it.

// Minimal local shape: the Trusted Types lib types are not in this TS target's lib.dom,
// and only these two members are used.
interface TrustedTypesShim {
  defaultPolicy?: unknown
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): unknown
}

/** Install the default Trusted Types policy. Must run before any worker is constructed. */
export function installTrustedTypes(): void {
  const tt = (globalThis as { trustedTypes?: TrustedTypesShim }).trustedTypes
  // Firefox has no Trusted Types, and there the CSP directive is simply inert.
  if (!tt?.createPolicy) return
  // A second createPolicy('default') throws; a duplicate call is a no-op, not an error.
  if (tt.defaultPolicy) return
  try {
    tt.createPolicy('default', {
      createScriptURL: (input: string): string => {
        const url = new URL(input, location.href)
        if (url.protocol === 'blob:' || url.origin === location.origin) return input
        throw new TypeError(`Blocked a cross-origin script URL: ${url.origin}`)
      },
    })
  } catch {
    // Another policy already claimed the name. Workers then fail loudly, which beats a
    // silent downgrade.
  }
}
