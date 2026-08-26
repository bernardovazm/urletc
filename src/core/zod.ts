import { z } from 'zod'

// Zod 4 compiles object schemas with `new Function()` for speed. Our CSP has no
// `unsafe-eval` and sets `require-trusted-types-for 'script'`, so that probe is blocked
// twice over and logs on every schema construction:
//
//   This document requires 'TrustedScript' assignment and no 'default' policy for
//   'TrustedScript' has been defined.
//
// Zod does fall back to its interpreted path, so validation was always correct, but the
// noise is indistinguishable from a real violation in the console and the e2e suite now
// fails the run on exactly that string.
//
// `jitless` short-circuits the check (`fastEnabled = jit && allowsEval.value`), so the
// eval probe is never even attempted. We deliberately do NOT add a `createScript` policy
// to make the JIT work: that would re-open an eval sink across the whole app to speed up
// schema parsing of small manifests, which is a bad trade.
//
// Import `z` from this module rather than from 'zod' directly, so the configuration is
// guaranteed to run before any schema in the bundle is constructed.
z.config({ jitless: true })

export { z }
