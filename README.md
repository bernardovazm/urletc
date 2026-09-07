# urletc

Client-only TypeScript SPA: more than twenty utility modules plus encrypted
device-to-device chat, file transfer, voice, video and screen sharing over WebRTC. Vite, no
UI framework, no backend.

Live: [urletc.vercel.app](https://urletc.vercel.app)

## Features

- Each tool is lazily loaded and has its own deep link: clipboard router, image to text,
  speech to text, text to speech, HTML to text, URL check (blocklist feeds plus a
  structural read), subtitle conversion and retiming, disposable inbox, link shortener,
  text tools, JSON, Base64, hashing, diff, timestamps, regional test data generators,
  session uptime, microphone and camera check, and a two-player game over the peer
  channel. Everything runs on the device except the disposable inbox and the link
  shortener, which are labelled as such in the tool list; model weights and blocklist
  feeds download from their sources and never carry anything you typed.
- Discovery works over same-network peers, a six character code for anyone anywhere, or a
  permanent pairing between your own devices. The presence list is opt-in.
- Text and files are end to end encrypted with a per-session HKDF ratchet for forward
  secrecy. Audio, video and screen use the browser's own DTLS-SRTP transport.
- The stage has multi source grid, spotlight and solo layouts, per source fullscreen and
  recording, plus a link usable as an OBS browser source.
- A peer joining later can be sent what was already in the feed. Paired devices sync by
  default; a code room shares only when you turn it on, because a code travels to whoever
  it is forwarded to.
- Workshop tools are Ed25519-signed, shared between peers, verified before display, and
  run in a null-origin sandbox behind two separate approvals.
- Installable, with the service worker in `src/sw.ts` precaching the app shell and
  re-applying the isolation headers on cached navigations, so the local tools keep working
  with no network.
- Local data is encrypted in IndexedDB under a non-extractable device key, or under a
  passphrase you set in Settings, which also holds the proactivity switches.

## Develop

```bash
npm ci             # reproducible install from the lockfile
npm run dev        # dev server, isolation headers only (HMR needs inline scripts)
npm run build      # production build into dist/
npm run preview    # serve dist/ under the full production CSP
```

## Test and lint

```bash
npm run typecheck    # the build does not type check
npm run lint         # ESLint, including the machine-enforced security invariants
npm run format:check # Prettier
npm run e2e          # build, preview, Playwright console suite
```

CI runs these plus the build on every push and pull request.

## Deploy

Static files on Vercel. `vercel.json` carries the COOP and COEP isolation headers, the
Content Security Policy and the single page rewrite; `npm run preview` applies the same
policy locally.

## Reference

- [`ARCHITECTURE.md`](./ARCHITECTURE.md): design study, threat model, security invariants,
  roadmap.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): prerequisites, pre-pull-request checks,
  conventions.
- [`SECURITY.md`](./SECURITY.md): private vulnerability reporting.

## License

[MIT](./LICENSE)

Third-party code is vendored under `public/tesseract/` so the OCR worker and its WASM core
load from this origin rather than a CDN. Both are Apache-2.0 and ship with their license
text; see [`public/tesseract/README.md`](./public/tesseract/README.md) for versions.
