# Vendored Tesseract assets

These files are copied verbatim from npm, not built here. They are vendored so the OCR
tool loads its worker and WASM core from this origin, which is what keeps `script-src` at
`'self'` in the production CSP (see `ARCHITECTURE.md`). Language data is not vendored and
still downloads from `tessdata.projectnaptha.com`, which is why that host is in
`connect-src`.

| Files | Package | Version | License |
| --- | --- | --- | --- |
| `worker.min.js` | `tesseract.js` | 7.0.0 | Apache-2.0, see `worker.min.js.LICENSE.txt` |
| `tesseract-core-*-lstm.{js,wasm,wasm.js}` | `tesseract.js-core` | 7.0.0 | Apache-2.0, see `LICENSE-tesseract.js-core.txt` |

`worker-tt.js` belongs to this repository and is not vendored. It installs the Trusted
Types policy in worker scope and then `importScripts` the vendored worker: a worker has its
own Trusted Types context, so the document policy does not reach it.

To refresh, copy from `node_modules/` at the pinned version and copy the two license files
with them. `package.json` pins both exactly, so the versions above are the versions built.
