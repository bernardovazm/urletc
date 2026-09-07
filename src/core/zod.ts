import { z } from 'zod'

// Zod 4 compiles object schemas with `new Function()` for speed. The CSP has no
// `unsafe-eval` and sets `require-trusted-types-for 'script'`, so that probe is blocked
// twice over and logs on every schema construction:
//
//   This document requires 'TrustedScript' assignment and no 'default' policy for
//   'TrustedScript' has been defined.
//
// Zod falls back to its interpreted path, so validation was always correct, but the noise
// is indistinguishable from a real violation and the e2e suite fails the run on that
// string.
//
// `jitless` short-circuits the check (`fastEnabled = jit && allowsEval.value`), so the
// eval probe is never attempted. A `createScript` policy would make the JIT work at the
// price of an eval sink across the whole app, to speed up schema parsing of small
// manifests, so it is not added.
//
// Import `z` from this module rather than from 'zod' directly, so the configuration runs
// before any schema in the bundle is constructed.
z.config({ jitless: true })

export { z }
