/*
 * Trusted Types shim for the Tesseract worker.
 *
 * A worker has its own Trusted Types context. The default policy installed by the page
 * (src/core/trusted-types.ts) does NOT apply inside it, so tesseract's own
 * `importScripts(corePath)` call was blocked with:
 *
 *   Failed to execute 'importScripts' on 'WorkerGlobalScope':
 *   This document requires 'TrustedScriptURL' assignment.
 *
 * which surfaced in the UI as "OCR failed". This file is what `workerPath` points at. It
 * installs the same narrow policy inside the worker scope and only then loads the real
 * worker, so the vendored minified file stays untouched and survives a dependency update.
 *
 * Same restriction as the page policy: script URLs are converted only for our own origin
 * or blob:, and no createHTML or createScript is provided.
 */
;(() => {
  const tt = self.trustedTypes
  if (!tt || !tt.createPolicy || tt.defaultPolicy) return
  try {
    tt.createPolicy('default', {
      createScriptURL: (input) => {
        const url = new URL(input, self.location.href)
        if (url.protocol === 'blob:' || url.origin === self.location.origin) return input
        throw new TypeError('Blocked a cross-origin script URL: ' + url.origin)
      },
    })
  } catch {
    /* a policy already exists; importScripts below will fail loudly if it is too strict */
  }
})()

importScripts('/tesseract/worker.min.js')
