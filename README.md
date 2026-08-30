# urletc

Client-only TypeScript SPA: more than twenty utility modules plus encrypted
device-to-device chat, file transfer, voice, video and screen sharing over WebRTC. Vite, no
UI framework, no backend.

Live: [utilscript.vercel.app](https://utilscript.vercel.app)

## Features

- **Utilities.** Clipboard router, image to text, speech to text, text to speech, HTML to
  text, URL inspector, URL safety scoring, subtitle conversion and retiming, disposable
  inbox, link shortener, text tools, JSON, Base64, hashing, diff, timestamps, test data
  generators for any country, session uptime, microphone and camera check. Each module is
  lazily loaded and has its own deep link. Everything runs on the device except the
  disposable inbox and the link shortener, which are named as such in the tool list.
- **Discovery.** Same-network peers, a six character code for anyone anywhere, or a
  permanent pairing between your own devices. Opt-in presence list.
- **Transport.** Text and files are end to end encrypted with a per-session HKDF ratchet
  for forward secrecy. Audio, video and screen use the browser's own DTLS-SRTP transport.
- **Stage.** Multi source grid, spotlight and solo layouts, per source fullscreen and
  recording, plus a link usable as an OBS browser source.
- **History.** A peer joining later can be sent what was already in the feed, so a room is
  not empty for whoever arrives second. Paired devices sync by default; a code room shares
  only when you turn it on, because a code travels to whoever it is forwarded to.
- **Workshop.** Ed25519-signed tools shared between peers, verified before display and run
  in a null-origin sandbox behind two separate approvals.

## Develop

```bash
npm ci             # reproducible install from the lockfile
npm run dev        # dev server, isolation headers and a dev CSP
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
