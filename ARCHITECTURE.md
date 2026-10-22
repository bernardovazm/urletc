# urletc: architecture and security design

urletc is a client-only web toolkit: one static bundle, no application backend, and security
constraints chosen at design time rather than retrofitted. This document records the
architecture, the threat model it answers to, and the places where the honest answer is a
limit.

Version and quantitative claims carry a source tag. `[v]` means verified against a primary
source in June 2026. `[~]` means an order-of-magnitude estimate that has not been measured
for this app; treat it as a planning figure and never quote it to users as fact. The source
notes at the end of the file list both sets.

---

## 1. Summary

One static SPA on the Vercel free tier: Vite 8 (Rolldown) with TypeScript in strict mode and
no UI framework `[v]`, a hand-rolled CSS custom-property token sheet, and a vanilla tool
registry that `dynamic-import()`s every tool, built-in and workshop alike, behind a single
`ToolManifest` contract. Heavy capability code (Whisper, Tesseract, Kokoro) lives inside its
tool's import boundary, is fetched only on activation, and is then cached in the Cache API
or OPFS.

Peer discovery and signaling are serverless via Trystero over Nostr relays `[v]`; the
BitTorrent tracker fallback Trystero offers is not built. NAT traversal is STUN first, with a
TURN relay that is configured at runtime (per device in Settings, or per deployment at build
time) and never committed; without one the symmetric-NAT tail does not connect (section
5.2). Identity is a single Ed25519 + X25519 device keypair, non-extractable, in IndexedDB;
the dual public/private model was rejected in favour of room scoping plus
challenge-response admission. The messenger reuses one WebRTC mesh, sized for about 6 video
and 12 data peers with no cap enforced (section 5.2), with app-layer X25519 + AES-GCM E2EE
on every DataChannel. Since the app talks to public-room strangers over untrusted relays, it
also runs a per-session ratchet (HKDF chain) on top of NaCl-box, giving forward secrecy
across a session (sections 6 and 9).

The Workshop gossips Ed25519-signed, SHA-256 content-addressed manifests over the same mesh,
with bodies fetched peer to peer. Executable scripts run only inside a null-origin
`sandbox="allow-scripts"` iframe, behind two explicit gestures. The guest source runs with
`new Function` in the frame's own realm; the QuickJS-WASM interpreter planned for inside the
frame is not built (section 8.1). The property this design guarantees and tests for: the
user sees the source and explicitly chooses to run it, and nothing ever autoruns. The single
security boundary for all untrusted code is one explicitly enumerated postMessage capability
API (section 8.2); the iframe is defence in depth behind it.

Security is cross-cutting: native WebCrypto only, strict CSP plus Trusted Types, COOP/COEP,
encrypted-at-rest IndexedDB. There is no backend you operate in the core product. Three
external dependencies are flagged instead of hidden (Nostr relays, Google and Cloudflare
STUN, and a TURN relay when one is configured), along with one optional Vercel Edge Function
(section 10). The target deployment is a small team, a handful of peers, which is what makes
best-effort free infrastructure an acceptable trade.

```
+----------------------------------------------------------------------------+
| BROWSER TAB (single origin, HTTPS, COOP:same-origin + COEP:credentialless) |
|                                                                            |
|  +------------+   hash-router     +--------------------------------------+ |
|  |   SHELL    |------------------>|      TOOL REGISTRY (Map)             | |
|  | DOM+nano-  |   register()      |  id maps to ()=>import('tools/<id>') | |
|  |  stores    |<------------------|  built-in AND workshop, same contract| |
|  +----+-------+   atoms(peers,    +---------------+----------------------+ |
|       |            clip, session)                 | dynamic import()       |
|   +---v-------------------------------------------v--------------------+   |
|   | CLIENT TOOLS (lazy WASM)        | P2P TOOLS (shared identity)      |   |
|   |  clipboard: OCR/NLP/JSON/URL    |  discovery (Trystero)            |   |
|   |  transcription (Whisper.onnx)   |  messenger chat/file/VoIP        |   |
|   |  TTS (SpeechSynth / Kokoro)     |  workshop gossip + runner        |   |
|   +-----------+---------------------+----------+-----------------------+   |
|               |                                |                           |
|   +-----------v-------------+      +-----------v-----------------------+   |
|   | ENCRYPTED STORE FACADE  |      |  CRYPTO CORE (WebCrypto)          |   |
|   | idb-keyval+AES-GCM      |      |  Ed25519 sign, X25519 ECDH        |   |
|   | OPFS/Cache: model blobs |      |  non-extractable CryptoKey @IDB   |   |
|   +-------------------------+      +-----------------------------------+   |
|                                                                            |
|   +--------------------------------------------------------------------+   |
|   | WORKSHOP SANDBOX  null-origin iframe (allow-scripts), new Function |   |
|   | THE BOUNDARY = enumerated postMessage capability RPC (section 8.2) |   |
|   +--------------------------------------------------------------------+   |
+--------------------------------+-------------------------------------------+
      app-layer AES-GCM + ratchet| over WebRTC DTLS DataChannels/media
        +------------------------+-----------------------------+
        v                        v                             v
  Nostr relays (signaling)   Google STUN (free)         TURN: runtime config only
  no tracker fallback        ~70-90% direct [~]         ~10-30% tail needs it
  *3rd-party, not yours*     *3rd-party*                *see section 5.2*
  NOTE: WebRTC ICE/media traffic is NOT governed by CSP connect-src (sections 2 and 10).
```

Known limits, expanded in section 13: clipboard auto-read on load works on Chromium once the
`clipboard-read` grant exists and costs one gesture on first visit, while Firefox and Safari
have no persistent grant and fall back to paste plus a scan button; live-mic real-time
Whisper is best effort and not guaranteed; "catalog with literally no server" means no server
*you* operate, and even that leans on third-party relays and TURN; sandboxed script
execution is isolated and consent-gated, with no absolute safety claim; automatic discovery is
bounded by the tiers in section 5.4.

---

## 2. Build Stack & Project Structure

| Concern | Pick | Why |
|---|---|---|
| Bundler | Vite 8 (Rolldown) `[v]` (stable Mar 2026) | Native WASM `?init`, fine chunk control for lazy tools, native TS. Requires Node 20.19+/22.12+. Pin in `engines`. |
| Language | TypeScript strict | Enforces `ToolManifest` at authorship; zero runtime cost. Runtime validation (zod) still mandatory for untrusted manifests. |
| UI | Vanilla DOM + nanostores (about 300 B core `[~]`) | No framework. Preact (~3 kB) only if a tool genuinely needs a component model. |
| CSS | Hand-rolled `tokens.css` (~100 lines of custom properties) | Minimal CSS by design; no Tailwind, no runtime JS. Open Props rejected (ships a few kB un-tree-shakeable `[~]`). |
| Routing | ~30-line hash-router | No history-API rewrite rules, framework-free. |
| State | nanostores atoms, one per tool plus shared (`$peers`, `$clipboard`, `$session`) | Tools rarely share state; atoms scope cleanly. |
| Persistence | idb-keyval + AES-GCM envelope via the encrypted-store facade | Native SubtleCrypto; no crypto lib shipped. Key lifecycle in section 9. |
| Large blobs | Cache API / OPFS, not IndexedDB | Model weights bypass IDB quota; OPFS is origin-private. |
| PWA | vite-plugin-pwa (Workbox generateSW) plus a custom fetch handler re-injecting COOP/COEP on cached navigations | Workbox does not forward these headers, a load-bearing gotcha (section 10). |

Two network facts shape everything above.

1. **CSP `connect-src` does not govern WebRTC.** ICE, STUN, TURN, DTLS and SRTP traffic is
   out of CSP scope: `connect-src` only constrains `fetch`, XHR, WebSocket, EventSource and
   `navigator.sendBeacon`. Relay WebSocket URLs (Nostr, BitTorrent, ws-relay) *are*
   constrained by `connect-src`; STUN and TURN endpoints are not. The CSP is therefore not
   the network boundary for the P2P media path, and section 10 states that plainly instead of
   implying that CSP fences WebRTC.
2. **User-supplied relay URLs conflict with a static `connect-src`.** A static header cannot
   admit arbitrary user-entered `wss://` origins. Resolution in section 10: ship a curated
   relay allow-list in `connect-src`. Bring-your-own-relay is offered only through the
   optional WebRTC `@trystero-p2p/ws-relay` and IPFS strategies, which are not
   `connect-src`-bound the same way, or through a documented self-host build where the
   operator edits the CSP. Arbitrary user relays do not work under the shipped CSP and the
   app does not claim they do.

The tree below is the layout this document planned. It is kept as the record of that plan
and has drifted from what was built: several modules named here were never created, and
most of what exists is not listed. Read `src/` for the real layout, and prefer the module
paths cited in the sections below, which are checked against the tree.

```
urletc/
|-- vercel.json                # headers: COOP/COEP/CSP/Trusted-Types, SPA rewrite
|-- package.json               # engines.node ">=20.19", exact-pinned deps (no ^/~)
|-- package-lock.json          # committed (npm)
|-- index.html                 # single entry; zero inline <script>
|-- public/
|   `-- sandbox.html           # null-origin runner page (QuickJS + RPC dispatcher)
|-- src/
|   |-- main.ts                # boot order: crypto core, store facade, router, registry
|   |-- styles/tokens.css
|   |-- shell/
|   |   |-- router.ts          # hash-router
|   |   |-- registry.ts        # ToolManifest map + register()/activate()
|   |   `-- ui.ts              # consent dialog, badge, toast (section 10)
|   |-- core/
|   |   |-- crypto.ts          # WebCrypto: keygen, sign, ECDH to HKDF to AES-GCM
|   |   |-- identity.ts        # device keypair lifecycle, TOFU store, safety numbers
|   |   |-- store.ts           # encrypted idb-keyval facade (key lifecycle, section 9)
|   |   |-- capabilities.ts    # postMessage capability API schema + facade (section 8.2)
|   |   `-- trust.ts           # author pubkey TOFU + trust tiers
|   |-- p2p/
|   |   |-- discovery.ts       # Trystero room + signed heartbeat presence
|   |   |-- channel.ts         # E2EE DataChannel wrapper (X25519 + HKDF ratchet)
|   |   `-- turn.ts            # TURN list parsing and validation, relay check (ICE list: session.ts)
|   |-- automation/
|   |   |-- schema.ts          # declarative rule AST (zod), bounded ops only (section 7)
|   |   `-- interpreter.ts     # safe-by-construction evaluator, ReDoS-guarded (7.1)
|   `-- tools/                 # each is a self-registering dynamic-import chunk
|       |-- clipboard/index.ts
|       |-- transcribe/index.ts
|       |-- tts/index.ts
|       |-- messenger/index.ts
|       `-- workshop/
|           `-- index.ts gossip.ts manifest.ts runner.ts
`-- workers/                   # re-engine.worker.ts is isolated for ReDoS (section 7.1)
    `-- stt.worker.ts  tts.worker.ts  kdf.worker.ts  re-engine.worker.ts
```

Where a planned module was never created, the sections below name what exists instead: the
capability dispatcher and iframe runner live in `src/workshop/sandbox.ts` with the permission
shapes in `src/workshop/manifest.ts` (there is no `src/core/capabilities.ts` and no QuickJS
runner), and the guest documents are `public/sandbox/script.html` and
`public/sandbox/app.html`, served with their own CSP header (section 8.3); TTS runs in
`src/tools/tts.ts` (no `tts.worker.ts` was split out); the workers that do exist are
`src/workers/stt.worker.ts` and `src/workers/re-engine.worker.ts`; and `kdf.worker.ts` was
never built, so the proof-of-work in section 5.5 is a specification with no implementation,
while the PBKDF2 passphrase wrapping that does exist runs in `src/core/store.ts`.

---

## 3. The Pluggable Tool Model

One contract covers everything. Built-in and Workshop tools are indistinguishable to the
shell except for trust level and load source.

```ts
// shell/registry.ts
export interface ToolManifest {
  id: string;                 // built-in: slug; workshop: SHA-256 content id
  name: string;
  category: 'clipboard' | 'media' | 'p2p' | 'workshop' | 'util';
  version: string;            // semver
  icon?: string;              // emoji or inline data: URI
  permissions: Permission[];  // declared up front, rendered in consent UI
  source: 'builtin' | 'workshop';
  load: () => Promise<ToolModule>;   // dynamic import boundary
}
export interface ToolModule {
  activate(container: HTMLElement, ctx: ToolContext): void | Promise<void>;
  deactivate?(): void;
}
export type Permission =
  | 'clipboard-read' | 'clipboard-write'
  | 'storage'                 // key-prefix-isolated IDB slice (ctx.storage, section 8.2)
  | { net: string[] }         // explicit origin allow-list; ALL traffic proxied via host fetch
  | 'notifications';
```

- Built-in tools call `registry.register(manifest)` at module-eval; Vite code-splits each
  chunk; `load` is `() => import('../tools/<id>')`. Built-ins run in the host realm and are
  trusted, being part of the audited bundle.
- Workshop tools are stored in IndexedDB as signed manifest plus body. Their `load` resolves
  to a controlled loader that re-verifies signature and content hash, validates the manifest
  with zod, renders the consent dialog, and only then hands the body to the sandbox runner. A
  Workshop tool's `activate` never runs in the host realm; it mounts the runner iframe. A
  script returns a value from a hidden frame and an HTML app draws its own UI inside a
  visible one; either reaches host state only over the postMessage capability API.
- `ToolContext` is the capability facade and the security boundary. For host-realm built-ins
  it is a direct object; for sandboxed tools it is the postMessage RPC surface enumerated in
  section 8.2. Either way it exposes only declared and consented capabilities, with the
  per-method checks listed in 8.2.

---

## 4. Per-Capability Picks

### 4.1 Clipboard detection + routing
On Chromium, `navigator.clipboard.read()` succeeds on page load without a fresh gesture once
the `clipboard-read` permission is granted: the tab is focused on navigation, which satisfies
the focus requirement. For a returning Chrome user the experience is exactly "open the site
and it reads the clipboard and offers actions", measured in production. The design is
therefore progressive enhancement rather than one-tap-only:

- On load, attempt `navigator.clipboard.read()` behind a `document.hasFocus()` check, and
  optionally `navigator.permissions.query({name:'clipboard-read'})` to predict `granted`
  against `prompt`. If the grant already exists, auto-detect immediately. Wrap in try/catch
  for `NotAllowedError` and "Document is not focused."
- First visit, before the grant exists: a "Scan clipboard" button calls the read *inside* its
  click handler, the gesture that lets Chrome surface the grant prompt. After the user clicks
  Allow, subsequent loads auto-read.
- Firefox and Safari have no persistent `clipboard-read` grant model. Fallback is an
  always-registered document-level `paste` listener (Ctrl/Cmd+V, zero prompt, all browsers,
  exposing `clipboardData` types and contents) plus the scan button. Safari surfaces native
  paste UI; Firefox gates `clipboard.read` behind a gesture.
- All paths funnel into one `clipboardRouter(items)`. Route by `ClipboardItem.types` first;
  text heuristics apply only to `text/plain`, ordered `new URL()`, then `JSON.parse()`, then
  an HTML-tag regex, capped at the first 10 KB.
- Each action is toggleable and on by default. Continuous "watch clipboard" mode (re-read on
  `focus` or poll) stays off by default and is disclosed.
- Detected URLs are never auto-fetched, which would leak the clipboard to a third party;
  preview is a manual button. `text/html` is parsed via `DOMParser` and only `textContent` is read back.
  Never `innerHTML`. `DOMParser.parseFromString` is itself a TrustedHTML sink and needs a
  named policy (section 9.1).

### 4.2 OCR: Tesseract.js v7 `[v]`
v7's relaxed-SIMD LSTM build (15-35% faster than v6 `[v]`) runs in a Web Worker, lazy-loaded
on first image detection. Core and worker are self-hosted under `public/tesseract/` so
`script-src` stays `'self'`; only the `eng` traineddata is fetched from the tessdata CDN
(allowed in `connect-src`), and the library caches it in IndexedDB. The WASM core plus Brotli
`eng` traineddata is roughly a single-digit-MB download `[~]`. Do not quote an exact MB to
users: measure at build time and surface the real number in the download dialog. No
SharedArrayBuffer is needed (worker-per-scheduler), so OCR works even on pages without
cross-origin isolation, which matters for the COEP interaction in sections 4.3 and 10.

The worker is a refcounted singleton, reached from both the OCR tool's cards and the
clipboard/feed inline OCR. `inFlight` blocks teardown while a recognition is running, and
`liveCards` frees the WASM heap only when the last card closes, since the heap cannot shrink
in place. The Trusted Types worker shim `public/tesseract/worker-tt.js` plus
`workerBlobURL: false` are both load-bearing and are described in section 9.1. The public
surface is `recognizeImage(blob)`, returning plain text; Tesseract's word, line and symbol
boxes are available from the library but nothing in the app consumes them today.

Preprocessing and page segmentation were measured. A dotted hostname was read back without
its dot. Every step below was scored as character accuracy against a fixture set: a composite
reproducing the reported case, 1080p and 4K versions of it, a light-on-dark terminal, a light
document, a dense body-copy block, and the canvas-rendered images the e2e suite generates.
The fixtures are generated rather than committed, because the reported screenshot was of a
real session and carried a personal address. On the reported screenshot, through the real
browser path, mean character accuracy went from 0.54 to 1.00.

- **Integer upscale before recognition** (`src/tools/ocr/preprocess.ts`), targeting 12 MP of
  output, at least 2x, at most 4x, with a 36 MP hard cap that also bounds an oversized
  source. This is what restores the dots. A 4K screenshot left at native size lost both
  dotted hostnames in the fixture set and recovered both at 2x. Grayscale runs in horizontal
  bands so the extra allocation stays a few MB at any input size.
- **Luma grayscale.** A clear win on the screenshot, neutral elsewhere.
- **No binarisation.** Global and local adaptive thresholding both lost accuracy. Screenshots
  are mixed polarity, light text on dark browser chrome above and dark text on a light page
  below, so one threshold destroys whichever region it was not fitted to; adaptive
  thresholding cost the light-on-dark fixture both of its hostnames. Leptonica already
  thresholds per region inside Tesseract, so doing it here only discards information. No
  contrast stretch either: measured neutral to negative.
- **`PSM.SPARSE_TEXT` (11) over the default `AUTO` (3).** Segmentation mode was worth more
  than any pixel filter. `AUTO` runs full page-layout analysis and scored worst of every mode
  on a screenshot, which is chrome plus page plus toast plus button rather than one page flow.
  `SINGLE_BLOCK` (6) scores marginally higher character accuracy on that image but still
  drops the period; sparse mode is the only one that keeps it, and it scores 1.000 on the
  dense body-copy fixture, the case sparse mode is supposed to be bad at, so nothing is
  traded away.
- **`user_defined_dpi` and `preserve_interword_spaces` are unset.** Both were tried and
  changed no output on any fixture.

TrOCR and transformers.js OCR are rejected: tens of MB minimum, incompatible with the
minimalist constraint `[~]`.

### 4.3 STT: transformers.js Whisper
Files and video are solid; live mic is best effort. The pipeline runs in a dedicated
`src/workers/stt.worker.ts`.

- Default whisper-base for multilingual, with whisper-tiny as a fallback gated by
  `navigator.deviceMemory` (iOS WKWebView OOM risk). Download sizes are tens of MB for base
  and smaller for tiny. Surface the build-measured byte count in the download dialog instead
  of a hardcoded figure, and never auto-fetch.
- Files and video decode chain: what ships is `decodeAudioData` resampled to 16 kHz mono
  through the Web Audio API (`src/tools/stt/index.ts`). The WebCodecs `AudioDecoder` and
  ffmpeg.wasm fallbacks are not built, so a container `decodeAudioData` cannot read, video
  included, fails. Chunk `chunk_length_s=30, stride_length_s=5` with sliding-window
  stitching. Slow WASM is acceptable here. COEP caveat for the ffmpeg plan: ffmpeg.wasm's
  multithread core requires SharedArrayBuffer and therefore COOP+COEP `[v]`, while its
  singlethread core does not `[v]`. The plan is to ship the singlethread core so
  transcription works even where COEP must be relaxed, and to treat the multithread core as
  a faster path only when `crossOriginIsolated === true`, which keeps STT out of the global
  COEP decision (section 10).
- Live mic uses `@ricky0123/vad-web` (Silero) to gate roughly 30 s segments before Whisper.
  Near-real-time on capable hardware, with no guarantee of low-latency streaming.
- Do not hardcode WebGPU as the fast path. Benchmark WASM against WebGPU at runtime on a
  short clip and pick the winner; WASM frequently wins on Apple Silicon and q8.
- Cache weights in OPFS after an explicit, size-disclosed, user-triggered download. Verify
  the weight SHA-256 against a pinned digest before loading (supply-chain control, section 9).
  Neither the OPFS cache nor the digest check is built: `src/workers/stt.worker.ts` passes
  no `revision`, so transformers.js fetches the model repo's main branch from Hugging Face
  and caches the files itself, unverified.
- The Web Speech API is offered only as an opt-in, persistently-warned, never-default cloud
  fast path, since it ships audio to Google or Apple, which rules it out as a default. No
  diarization in v1.

### 4.4 TTS: Web Speech API by default, Kokoro as opt-in HQ `[v]`
- Default `speechSynthesis`, filtered to `localService:true` voices only, because cloud voices
  silently POST text off-device. Sentence-chunk to dodge Chrome's ~200-char cutoff `[~]`.
  Linux local voices may be espeak-only and robotic, so Kokoro is the real option there.
- HQ path: kokoro-js (Kokoro-82M-v1.0-ONNX, Apache-2.0) `[v]`, living in `src/tools/tts.ts`
  since no dedicated TTS worker was split out. The fp32 export is about 80 MB `[~]`, smaller
  quants (q8/q4) are available, and weights are IDB/OPFS-cached. kokoro-js runs on WASM by
  default with a WebGPU device option `[v]`; do not assume WebGPU, and gate it behind the same
  runtime benchmark as STT. Gate the download behind an explicit gesture plus measured-size
  disclosure, and pin the version. SpeechT5 is rejected (hundreds of MB, no advantage `[~]`).
  Piper is a viable WASM-only alternative if multilingual-without-WebGPU becomes a priority.

---

## 5. P2P Layer: Discovery, Signaling, NAT, Identity

Signaling and discovery are genuinely serverless from this project's side. Reliable
connectivity for every peer is not: the symmetric-NAT tail needs TURN, which is a third-party
dependency.

### 5.1 Discovery and signaling via Trystero over Nostr `[v]`
Trystero v0.25.2 (June 2026) `[v]` is actively maintained and ships scoped `@trystero-p2p/*`
packages including a self-hostable `ws-relay` `[v]`. The app joins through `trystero/nostr`
alone, on the three relays in `NOSTR_RELAYS` (`src/p2p/session.ts`). The BitTorrent tracker
fallback is not built, and no tracker origin is in `connect-src`. Implement establishment
retry and timeout, since relay latency can stall SDP.

SDP-encryption nuance: Trystero encrypts SDP with a key derived from app ID plus room ID by
default, which a relay operator can reverse-engineer from the public room and app IDs. Hiding
SDP from relays requires passing a custom per-room password `[v]`. The app always supplies
its own room password and never relies on the default derivation, but the password comes
from the same seed as the room name, so it hides SDP only as well as that seed is secret
(`src/p2p/discovery.ts`, `src/p2p/personal.ts`): a 32-byte secret for personal rooms
(SHA-256), the join code for code rooms (the same PBKDF2 output as the room id, about 2^39.6
codes), the public IPv4 for nearby, which a relay typically sees as the client's own
address, and a constant for presence. A relay can therefore read nearby and presence SDP.
The `hs` exchange runs only after SDP has been exchanged, so it cannot feed the password;
what stops a relay MITM is the DTLS-bound `hs` signature (5.3), not SDP encryption. This is
independent of, and additional to, the app-layer payload E2EE in section 6.

### 5.2 NAT traversal: the fallback chain
Target scale is a small team, a handful of peers, which is what makes best-effort free
infrastructure acceptable here.

1. `iceTransportPolicy:'all'` plus Google STUN (`stun.l.google.com:19302` and 2-3 more)
   covers the majority. Residential STUN success is around 70-90% `[~]`; the
   symmetric-NAT, CGNAT and enterprise tail of roughly 10-30% needs TURN `[~]`. These are
   industry order-of-magnitude figures, not measured for this app; see section 13.
2. TURN is configured at runtime and nothing is committed. Two sources, the first winning
   while it is set:
   - Per device: an iceServers list pasted into Settings (JSON, or the JavaScript snippet a
     Metered or Cloudflare dashboard hands out, read without evaluating it). The normalized
     list goes into the encrypted store under `turn-servers` and is never sent to peers.
   - Per deployment: `VITE_TURN_SERVERS`, a JSON iceServers array set in the hosting
     provider's build environment. Vite compiles it into the public bundle, so anyone who
     reads the bundle can extract the credentials and spend that relay's quota. That is the
     trade for having no backend; short-lived credentials would need the vending function
     below.

   `src/p2p/turn.ts` parses and validates both with one parser: at most three TURN URLs, one
   per transport where possible (UDP, TCP, TLS on 443), and STUN entries dropped. With a
   relay set, the app's STUN shrinks to one server so the ICE list stays at four URLs or
   fewer. `ICE_SERVERS` in `src/p2p/session.ts` is one array rewritten in place, and
   Trystero reads it each time it builds a connection, so a change applies to rooms already
   joined. Relay through one side is enough for a pair, since a TURN permission is per peer
   IP, so one device with a relay fixes that device's links.

   A relay that never answers is worse than none: the retired Metered OpenRelay credentials
   answered an Allocate with `400 TURN allocate error`, gathering zero relay candidates while
   costing every connection 11 to 20 seconds of ICE gathering. Settings' Check relay asks
   for an allocation over a relay-only connection and reports one of: answered, refused the
   username or password (401), or no answer from this network. Without any relay, peers
   behind symmetric or carrier-grade NAT cannot connect, the failure report says so, and
   `relayOnly` in `joinRoomSession` refuses to pretend otherwise (no setting turns it on;
   section 6).
3. Self-hosted coturn on Oracle Always Free ARM remains the planned fallback, not built.
   One box, and an operated dependency, flagged in sections 10 and 13.

Relay bandwidth is the scarce part. Metered's free plan allows 500 MB of relayed traffic a
month, counting each relayed byte in and out, so roughly 15 to 30 minutes of screen
sharing at 1 to 2 Mbps, and a provider exposes no client API for the remaining quota. The
roster marks a link that runs through a relay: for each connected peer of a
content-carrying session (never the presence tier), the session reads `getStats()` at most
every 10 s and shows a `relay` badge beside `connected` when the selected candidate pair
has a `relay` candidate on either side. A local byte estimate (`bytesSent`/`bytesReceived`
on that pair) and a default cap on video over a relay are not built. STUN-first stays the
default either way.

Scale guard: the mesh degrades past roughly 20-30 peers `[~]` (Chromium PeerConnection
ceiling, Firefox and Safari mesh lag). Enforce app-level room caps around 12-15 data peers
and hub-and-spoke beyond that. Neither is built: `src/p2p/session.ts` admits every peer that
completes the `hs`, in every tier, so each member of the opt-in presence room holds one
connection and one handshake per other member, however many join.

### 5.3 Identity model: single keypair, dual identity rejected
One Ed25519 (signing) and one X25519 (ECDH) non-extractable keypair per device on first load,
in IndexedDB; the device ID is the hex SHA-256 of the Ed25519 public key. Dual public/private
peers add state and linkability risk without proportional gain once challenge-response
admission exists.

- Public discovery is joining a well-known or topic room; presence is a signed heartbeat
  (`{pubKey, displayName, capabilities, ts, sig}`, every 15-30 s, pruned at 2x the interval).
  That is a fully client-side live roster with no server.
- Private connection is an opaque `crypto.randomUUID()` room id shared out of band by QR or
  copy-paste only, never broadcast.
- Admission gate: Trystero `onPeerJoin` triggers the `hs` exchange. Each side signs its fresh
  X25519 ephemeral key, the room, and the DTLS certificate fingerprints of the connection it
  is sent on (its own first), verified against the claimed pubkey before the peer is
  app-visible. The certificates tie the signature to that one connection: a member who
  keeps another member's `hs` and presents it from a second peer names certificates that
  connection does not carry, since the far end of a DTLS connection cannot present a
  certificate it holds no key for. An `hs` with any `v` other than 3 (`HS_VERSION`) is
  turned away: before v2 the signature covered less than that, and a v2 peer would
  handshake and then fail every file, since v3 sends file chunks as binary.
  The `hs` carries no timestamp (`HsPayload` in `src/p2p/session.ts`) and there is no
  per-window rate limit, so neither spam defense is built; what exists is that a peer whose
  sealed frames fail to open 8 times (`MAX_OPEN_FAILURES`) is dropped for the life of the
  connection. On proof of work, see section 5.5; it is a speed-bump and no part of the Sybil
  answer.
- Key backup is not built. The plan is a user-downloaded JSON file: public key plus private
  key wrapped with a PBKDF2 (>=600k) derived AES-256-GCM key, which needs keypairs generated
  extractable, and `src/core/identity.ts` generates them non-extractable. No cloud backup;
  passphrase loss is unrecoverable by design.

### 5.4 Four serverless rendezvous tiers
LAN and mDNS auto-discovery are unavailable to web pages: there is no web API for mDNS
service discovery, and browsers use mDNS only internally to mask host candidates.
"Incremental IDs with regional prefixes" were rejected because a dense sequential ID space
needs a central allocator, a backend counter and exactly what this project excludes, and
because it makes every user enumerable by strangers. Practicality comes instead from four
tiers that all derive the room name client-side (implemented in `src/p2p/discovery.ts` plus
`src/p2p/personal.ts`, all live concurrently in the console, roster deduped by peerId):

1. **Nearby (zero-touch).** This is what answers "send this image to my phone". A STUN
   binding request reveals the device's own public server-reflexive IP; every device behind
   the same NAT derives the same room, `H(publicIP)`, and meets there. Open the app on two
   devices on one Wi-Fi and they appear to each other with no user action. Prefers the IPv4
   srflx candidate, shared by all devices on one NAT; skipped silently when UDP or WebRTC is
   blocked.
   - *Privacy cost, accepted and documented:* relays see `H(publicIP)`, so an observer who
     knows or guesses your IP can link presence. Content stays E2EE behind the authenticated
     handshake.
   - *Trust cost, mitigated:* CGNAT and café networks put strangers in your nearby room. They
     render as unverified peers and get no auto-shared clipboard and no local media, ever;
     explicit sends and verification remain available.
2. **Join code (a short ID with no allocator).** An 8-char code from an unambiguous 31-letter
   alphabet (about 2^39.6); both sides derive the room with PBKDF2-SHA256 at 200k iterations.
   The room id is published, hashed, as a topic on public Nostr relays, so codes face offline
   guessing from anyone watching them, and the slow derivation is what makes that costly
   (a full table is about a GPU-year; 6 chars behind two fast hashes took one CPU core under
   two hours). Speak it aloud, the other
   person types it: the same effort as a TeamViewer-style ID, zero servers, sparse instead of
   enumerable. Ephemeral; leaving discards it.
3. **Personal room (pair once, works cross-network).** A 32-byte secret shared via a one-time
   link or QR; all your devices derive `H(secret)` and auto-join forever. The only tier that
   receives clipboard auto-share, and with code rooms, local media. Anyone can send a
   `#/pair` link, so one that would replace a secret the device already holds asks first;
   a fresh install takes it without a question.
4. **Presence list ("Online now"), which shows who is online and nothing else.** One fixed
   room, `H("global|v1")`, that every opted-in device joins (`presenceRoom()`). It answers
   "who else is using this right now" without a shared secret, a shared IP or a code.
   - *Presence-only, enforced at the session layer:* the session is created with
     `presenceOnly`, so inbound chat, files, tool-gossip and media are dropped before
     reaching the app, the corresponding send methods are no-ops, and the session stays out
     of `getAllSessions()` and `getActiveSession()`, so a P2P tool enumerating "every
     reachable peer" cannot reach these peers either. The console independently excludes the
     tier from `BROADCAST_TIERS` and `MEDIA_TIERS`. Presence is the only thing that crosses
     it, in either direction.
   - *Opt-in, default off* (`presence-on`, `wt:presence`). Unlike nearby, which is scoped to
     your own NAT, this announces you to everyone running the app, so the app does not turn
     it on for you. An invite link may carry `?p=1`, meaning the sender is on the list; it
     only raises the question. The pending question is stored (`presence-invite`, a count of
     the offers still owed, 0 meaning closed) because the address bar is rewritten from this
     device's own state and loses the flag. The count is never re-armed while it exists, so
     reloading or reopening the link cannot ask forever, and both answers close it.
   - *Roster:* a stranger's row leads with the first 6 hex of their identity-key fingerprint,
     which they cannot choose, and demotes the self-asserted name, so a stranger cannot copy
     a paired device's display name and pass for it. Ordered last in `TIER_ORDER`, so
     first-tier-wins dedupe always renders a device you can also reach privately under its
     trusted tier.
   - *Scale, stated honestly:* one room is a full mesh, so this is sized for a small team and
     not a public population. It is deliberately not sharded or epoch-rotated: sharding needs
     a rendezvous bucket everyone probes first, and rotating the room name on a wall-clock
     epoch makes the entire population re-join that one bucket simultaneously, a worse
     problem than the one it solves. If the population ever outgrows one mesh, the fix is a
     real bound and not a rehash.

Rooms are a named object across tiers 2 and 3: user-set name, description
and settings, created in one action, shared by link or QR, and E2EE within the room.

mDNS-grade LAN scanning is out of reach for a web page. The claim that holds: devices on the
same network find each other automatically, and anyone else is one spoken code away.

### 5.5 Sybil and proof of work, bounded honestly
Client-side proof of work does not stop a motivated or GPU-equipped attacker, since the
asymmetry favours the attacker. PoW is therefore specified as a thin anti-flood speed-bump
and nothing more. It is a specification only: `kdf.worker.ts` was never built, so no PoW
ships today.

- PoW spec: to post a heartbeat or a gossip announce, a peer attaches
  `H(pubkey || roomEpoch || nonce)` with a leading-zero-bits target tuned so an honest laptop
  spends roughly 100-300 ms `[~]`; receivers reject stale-epoch or under-difficulty proofs. It
  belongs off the main thread in a worker. This only raises the cost of trivial flooding from
  a single tab.
- The real Sybil defense is the trust graph. Workshop vouches count only from your manually
  trusted peers (section 7), and admission gates verify signatures rather than work. The app
  tells the user outright that public-room rosters can be Sybil-flooded and should not be
  treated as authenticated identity.

---

## 6. Messenger: Chat, File, VoIP, Screen-share

- **Transport:** one E2EE WebRTC mesh. PeerJS 1.5.x is acceptable for 1:1 and small-group
  connection lifecycle, but raw `RTCDataChannel` is mandatory for file transfer, because
  PeerJS reassembles in RAM and large files OOM. `simple-peer` is rejected as unmaintained.
- **Chat and control:** one ratcheted `msg` Trystero action. File transfer: 64 KiB chunks on
  a separate `fdata` action, each sealed with AES-GCM under a per-file random key (delivered
  over the ratchet in the `file` envelope), with a fresh IV and `fileId:index` as AAD, and
  Trystero's own backpressure. A receive silent for 20 s asks the sender for its missing
  indices with `fneed`, at most 3 rounds of 256, then is abandoned out loud. Chunks are
  reassembled in memory into a `Blob`, bounded at 2 GiB per file and 2 GiB across all
  receives in flight (`MAX_INCOMING_BYTES` in `src/p2p/session.ts`); streaming to OPFS and a
  whole-file SHA-256 are not built, so integrity is the per-chunk AEAD. Chat typed while no
  peer is reachable waits in an in-memory outbox (`src/shell/console.ts`) and is sent when
  one connects; a reload drops it. There is no store-and-forward guarantee, since there is
  no server to hold them.
- **VoIP and screen-share:** `getUserMedia` and `getDisplayMedia` (HTTPS is satisfied;
  `getDisplayMedia` is unavailable on iOS Safari, so degrade gracefully). Lazy-acquire tracks
  and call `track.stop()` on call end.
- **Studio (VDO.ninja-style, no backend):** a control-panel tool over the same media mesh.
  The console remains the single owner of streams (`src/shell/studio.ts` is the seam; the tool
  issues commands and never touches tracks). Publishing selects devices and resolution and
  tags each stream with `{kind,label}` via Trystero per-stream metadata, so recipients render
  a labelled multi-source stage (grid, spotlight, solo, with per-source spotlight, mute, hide,
  fullscreen and record). A screen share, incoming or local, pins itself and expands the stage
  over the feed while nothing else is pinned, since the stage is otherwise capped at the feed
  column; that expansion is released when the share ends, unless the expand control has been
  pressed in between, which hands the state to the user. A chromeless `#/stage/<code>` route renders only the stage for use
  as an OBS Browser source or a second screen. It is view-only: it authenticates like any peer
  but publishes nothing, and it joins only that code room, never personal or nearby. Local
  media still honours section 5.4: trusted tiers only, never nearby. Deferred and not built:
  virtual-camera output, per-source bitrate and codec control, and directed one-way push/pull
  tokens, since all peers here authenticate and view-only is a role rather than a token.
- **E2EE and forward secrecy:** WebRTC DTLS is transport-only and a relay sees metadata, so
  the app adds app-layer AES-256-GCM keyed by ephemeral-X25519 ECDH into HKDF per connection.
  Because the app does talk to public-room strangers over untrusted relays, the
  "trusted-group, no FS needed" rationale does not hold. v1 ships per-session forward secrecy
  via a symmetric HKDF ratchet: the ECDH session key seeds a sending and a receiving chain,
  each message advances the chain (`k_{n+1}=HKDF(k_n)`), and old keys are zeroised. That gives
  forward secrecy across the session, so a key captured later cannot decrypt earlier messages,
  at trivial cost. Full Double-Ratchet, meaning post-compromise security and out-of-order DH
  steps, remains a Phase 4 upgrade (section 12), but the no-FS-at-all gap is closed now rather
  than deferred. Media-layer E2EE (Insertable Streams) is Chromium-only, so advertise only the
  DTLS baseline for media on Firefox and Safari and do not over-claim.
- **Group-size limits:** hard cap 6 video (CPU and bandwidth cliff) `[~]` and about 12
  data-only `[~]`. No SFU: no free SFU fits, and an SFU terminates DTLS, leaving plaintext
  unless SFrame is used. Warn past the cap. Neither cap nor warning is built: every
  authenticated peer is admitted and, in a tier that carries local media, offered every
  active local stream (5.2).
- **IP-leak hygiene:** mDNS hides LAN candidates on Chromium, less uniformly on Firefox and
  Safari. A relay-only privacy toggle (`iceTransportPolicy:'relay'`) is the only complete
  public-IP mitigation. `joinRoomSession` supports it as `relayOnly`, but no setting exposes
  it: `src/shell/console.ts` always passes `relayOnly: false`, so every peer, nearby and
  presence included, receives this device's server-reflexive candidates.

---

## 7. Workshop: Distributed Tool/Snippet Sharing

Integrity, author trust and sandboxing are all achievable client-side. "Catalog with
literally no server" is bounded to "no server *you* operate", with availability degrading to
online-peer overlap.

### Architecture
Custom gossip over the existing WebRTC mesh, on a labelled `workshop-gossip` DataChannel.
IPFS/Helia is rejected on bundle weight, libp2p GossipSub on bundle weight and browser
production readiness, GunDB on its relay dependency. Nostr relays may be used as an
opportunistic discovery aid only, never a source of truth, since free relays increasingly
gate writes and reject custom kinds. The source of truth is peer gossip plus a local IDB pin
of installed tools.

- **Content addressing:** `id = SHA-256(canonicalJSON(name+version+type+permissions+contentHash))`.
  A peer serving a manifest whose id is not the content hash is session-blacklisted.
- **Gossip mechanics:** exchange catalog digests on connect, request missing or newer
  entries, and keep a seen-set (ids from the last 60 s) with fanout 3-5 to prevent
  amplification. Version resolution is higher version, then higher `createdAt`, then
  lexicographically greater signature, which is deterministic. Re-verify signature and hash
  before relaying.
- **Bodies:** peer to peer over DataChannel, 16 KiB chunked.

### Body-size cap against real tools
A flat 512 KiB cap cannot hold useful JS and is irrelevant to multi-MB WASM tools, so the cap
is split by type:

- `type:"automation"` (declarative): hard cap 64 KiB. These are small rule trees by nature.
- `type:"script"` (JS source): cap 512 KiB of source, which is plenty for hand-written tools.
- WASM and large assets are not shipped in the manifest body. A script tool that needs a big
  WASM dependency declares it as a `permissions:{net:[...]}` fetch of a content-hashed, pinned
  asset that the host fetches, verifies against the manifest's declared digest, and injects.
  It is never gossiped as a 512 KiB blob. That keeps gossip light and makes large assets
  cacheable and CDN-able under the user's consent.
- **Availability and single point of loss:** there is no guaranteed persistence. A pinned tool
  survives only while some online peer holds it, and swarm re-seeding is best effort. What
  ships as mitigation: every installer pins locally, so you never lose an installed tool;
  export and import of a signed tool as a file gives out-of-band durability; and an optional
  opportunistic Nostr mirror. At team scale, durable-until-the-cache-is-cleared is the
  accepted bound. Section 13 states that durable hosting needs a relay or KV you accept as a
  dependency, because browsers have no DHT.

### Manifest schema
```json
{
  "id": "b3f1c2a0e7...",
  "name": "JSON Key Sorter",
  "version": "1.2.0",
  "type": "automation",
  "author": { "pubkey": "ed25519:9a4c7f...", "displayName": "alice" },
  "createdAt": 1750500000,
  "permissions": ["clipboard-read", "clipboard-write"],
  "contentHash": "sha256:7d8e2b...",
  "body": {
    "kind": "rules",
    "rules": [
      { "op": "json.parse", "from": "clipboard" },
      { "op": "json.sortKeys", "recursive": true },
      { "op": "json.stringify", "indent": 2, "to": "clipboard" }
    ]
  },
  "sig": "ed25519:base64sig-over( SHA-256(canonicalJSON(body)) || canonicalMeta )"
}
```
A `type:"script"` manifest is identical except that `"body"` is a JS source string and the
consent UI shows the full source plus its SHA-256.

### Trust and consent
- **Author signing:** verify the Ed25519 signature before any display, not only before a run.
  Updates must be signed by the same key, and downgrades are rejected unless the user
  overrides. A tool is matched across versions by name and type, since its id is a content
  hash that every version changes: a newer version from the same key replaces the installed
  one and inherits its stored data, and the same name under another key asks before it is
  installed beside the original.
- **Trust tiers and badges:** unsigned (red), self-signed and unverified (yellow),
  peer-vouched (green), where vouches count only from your manually trusted peers, the real
  Sybil defense from section 5.5. TOFU on first sight of an author key, with a loud
  full-screen warning on key change.
- **Install and consent UX:** two distinct gestures. Install stores the signed manifest, then
  Run asks for per-invocation consent showing the full source or rules, the SHA-256 and the
  declared capabilities. There is no remember-or-auto-approve path. Hash and signature are
  re-verified on every run.
- **Declarative `type:"automation"` is the primary format.** Most use cases (clipboard cleanup,
  JSON formatting, text utils) need no Turing-complete code and avoid the JS sandbox. The
  interpreter is itself an attack surface; see 7.1.

### 7.1 The declarative interpreter is an attack surface
Routing automations to a trusted interpreter on the main thread with a lower consent barrier
is only defensible if the interpreter is safe by construction. Threat analysis and controls:

- **ReDoS:** any `regex.replace` op is the classic main-thread DoS. Controls: run all
  user-supplied regex in `src/workers/re-engine.worker.ts` with a hard wall-clock timeout,
  terminating the worker on overrun; compile with a linear-time engine where feasible
  (RE2-WASM) rather than the native backtracking engine; and reject patterns exceeding a
  length or complexity budget at install time.
- **Resource exhaustion:** cap input size (reusing the 10 KB clipboard cap, with an explicit
  larger opt-in), cap rule-tree depth and node count, cap total ops per run, and stay
  single-pass. The AST has no loop or recursion node, only bounded `map` and `forEach` over
  already-materialised arrays.
- **No host escape:** the interpreter has a fixed op-code whitelist (`json.*`, `text.*`,
  `regex.*`, `format.*`). There is no `eval`, no function constructor, no property access into
  host objects and no dynamic op dispatch by string into JS. It reads and writes only the
  explicitly passed input and the declared clipboard or storage capability. The lower consent
  barrier is justified because the op-set is provably non-Turing-complete and
  side-effect-bounded, and the UI says exactly that instead of implying that declarative
  means safe.

---

## 8. Sandboxing & Safe Execution

Execution here is isolated and consent-gated. Nothing below makes it safe in an absolute
sense. Browser sandbox escapes are exploited in the wild: CVE-2025-2783 (Mojo, in-the-wild,
fixed 134.0.6998.177) and CVE-2025-4609 (ipcz handle leak, $250k bounty, fixed
136.0.7103.113) `[v]`. The iframe is one defence-in-depth layer; the postMessage capability
API in 8.2 is the boundary.

### 8.1 Layered model keyed to trust tier
One layer set is built, and it applies to every Workshop `type:"script"` and `type:"html"`
tool whatever its trust tier (`src/workshop/sandbox.ts`):

- A null-origin iframe, `sandbox="allow-scripts"` without `allow-same-origin`, loading the
  static guest `public/sandbox/script.html` or `public/sandbox/app.html`. The untrusted
  source arrives by postMessage after the guest's `ready` and is never interpolated into
  the markup.
- The guest runs in the frame's own JS realm with no interpreter in between: a script
  through `new Function` in strict mode, an app's HTML mounted with `DOMParser` and its
  `<script>` nodes re-created so they execute.
- CSP from a `/sandbox/` response header (`vercel.json`, `vite.config.ts`) plus a meta tag
  in each guest: `default-src 'none'`, `connect-src 'none'`,
  `script-src 'unsafe-inline' 'unsafe-eval'`, images, media and fonts from `data:`/`blob:`
  only.
- Before any untrusted code runs, the bootstrap poisons the WebRTC constructors and starts
  stripping child frames (section 13), since `connect-src` governs neither ICE nor a child
  realm.
- Lifetime: a script's frame is removed by a host `setTimeout` after 30 s; an app has no
  deadline and runs until the user closes it or the tool deactivates. Neither is preemptive
  or memory-bounded: where the browser keeps the null-origin frame in the host's renderer
  process, a guest that never yields stalls the host's event loop, that timer included.

The tiers below are the plan. Rows and layers marked not built do not exist.

| Trust tier | Layers |
|---|---|
| Untrusted (unknown peer, JS) | the built layer set above. Not built: a QuickJS-WASM interpreter inside the frame, with a `setInterruptHandler` deadline, `setMemoryLimit` and no time source |
| Community-vetted (manually trusted peer) | not built: null-origin iframe plus SES Compartment (intrinsics frozen) plus `connect-src 'none'`; runs under the built layer set today |
| Self-authored | not built: null-origin iframe plus Web Worker (no DOM); runs under the built layer set today |
| Declarative automation | safe-by-construction interpreter, ReDoS-guarded worker (7.1); no JS sandbox needed |

### 8.2 The postMessage capability API, fully enumerated
This is the most security-critical artifact in the codebase. The guest holds no host object
and no working network handle; whatever reaches the host goes through this message schema. The
host acts on a message only when `event.source` is the guest frame's window and
`event.origin === 'null'`, and treats it as a capability call only with a numeric `id` and
a string `method`. No schema library sits on this path (zod validates manifests, not
messages): arguments are coerced with `String()` and checked per method below. The host
never reflects host objects.

```ts
// src/workshop/sandbox.ts: the methods the host dispatches; anything else gets an error.
// (permission shapes live in src/workshop/manifest.ts)
// Guest to Host call: { k: 'cap'; id: number; method: string; args: unknown[] }
//   'clipboard.read'                  gated by 'clipboard-read'
//   'clipboard.write'  [text]         gated by 'clipboard-write'; no length cap
//   'storage.get'      [key]          gated by 'storage'; keys prefixed with the tool id
//   'storage.set'      [key, value]   gated by 'storage'; key <= 256 chars; 1 MiB Workshop quota
//   'net.fetch'        [url, init?]   gated by {net:[origin]}; host-mediated, see below
//   'room.send'        [data]         html apps, gated by 'p2p-room'; >= 15 ms apart, <= 16384 JSON chars
//   'room.peers'                      html apps, gated by 'p2p-room'
// Guest to Host, no reply: { k: 'ready' } (honoured once), { k: 'log'; msg } (cut to 2000
//   chars), and for scripts { k: 'done'; value } or { k: 'error'; error }, which end the run.
// Host to Guest: { k: 'exec'; source } once after 'ready';
//   { k: 'cap-result'; id; ok: true; value } | { k: 'cap-result'; id; ok: false; error };
//   { k: 'room'; from; data } for apps, relayed from authenticated room peers running the
//   same content hash over the best-effort `game` channel.
```

The manifest schema also accepts a `notifications` permission, which no method reads. There
are no `ui.*` methods: an app draws its own UI inside its frame (8.1).

Hard properties of the boundary:

- Nothing from the host realm is injected into the guest, but the guest realm keeps its own
  ordinary globals: `Date`, `performance.now`, `crypto`, `eval` and `Function`, timers, and
  `parent.postMessage`, through which it can send any message, not only those the `host`
  facade builds. Time is therefore not withheld: the timing side channels that motivated
  withholding it, which COOP/COEP coarsens without eliminating Spectre, are open to guest
  code. Withholding time and `eval` belongs to the QuickJS-WASM plan (8.1).
  `fetch`, XHR and WebSocket exist in the guest and fail on `connect-src 'none'`, the WebRTC
  constructors are poisoned and child frames are stripped, so the guest holds no working
  network handle.
- `net.fetch` is host-mediated (`hostFetch`): the host refuses an origin the manifest did
  not declare and the app's own origin, fetches with `credentials: 'omit'`,
  `redirect: 'error'` and no referrer, reads at most 2 MB of body, and runs at most 4 calls
  per guest at once, all aborted on teardown. Method, body and headers are the guest's. The
  origin must also be in the host's `connect-src`, or the host fetch fails.
- Every method is permission-gated by the manifest's declared `Permission[]`, mapped once
  per run, and every run follows the per-run consent dialog. The check is the first step of
  each method's handler.
- Limits as built are the ones in the block above. There is no per-method rate limit beyond
  the `room.send` interval and the `net.fetch` concurrency gate, and no size cap on a
  `clipboard.write` text or a `storage.set` value other than the storage quota.
- The method set is fixed per release. Adding a method is a reviewed security change.

### 8.3 Hard rules
Footguns do not become safety properties by being documented, so these are absolute.

- Never combine `allow-scripts` with `allow-same-origin`; the frame can strip its own sandbox.
- The iframe alone does not block network. `connect-src 'none'` comes from the `/sandbox/`
  response header (`vercel.json`, `vite.config.ts`) and is repeated in a `<meta>` CSP in
  each guest document. The guests are real URLs under `public/sandbox/`, not `blob:` or
  `srcdoc` documents, because those inherit the host policy, whose `script-src` and Trusted
  Types refuse the guest's inline bootstrap and its `eval`. `fetch` exists in the guest and
  fails on that directive; WebRTC is poisoned separately (section 13).
- Never inject any credential-bearing capability into guests.
- The `postMessage` handler checks `event.source` against the guest frame and
  `event.origin === 'null'`, and type-checks `id` and `method` (8.2).
- Never autorun. Two gestures and a new iframe per run. A script's frame is removed after
  30 s by a host timer, which is not preemption (8.1); an app has no deadline and is
  removed when closed or when the tool deactivates.
- ShadowRealm (TC39) is not shippable in mid-2026; design so it can slot in as a future tier.
- Surface a stale or embedded Chromium banner, since in-the-wild escapes hit unpatched and
  embedded builds per the CVEs above. Ship a Trusted Types polyfill for Firefox. Neither is
  built: there is no banner, and where the browser has no Trusted Types,
  `src/core/trusted-types.ts` installs nothing and the CSP directive is inert.

---

## 9. Security Model

### Threat model
| Adversary | Capability | Primary control |
|---|---|---|
| Signaling relay / TURN operator | sees SDP, peer IPs, traffic metadata; can MITM signaling | DTLS-bound `hs` signature against MITM (5.3) plus app-layer X25519+AES-GCM plus per-session HKDF ratchet for FS; custom-password SDP encryption (5.1) hides SDP for personal and code rooms only, not nearby or presence; opaque room ids; relay-only mode exists in the session layer but no setting exposes it (6) |
| Network MITM at first key exchange | substitute keys (no prior pin) | out-of-band safety-number comparison in a confirm dialog, offered and not forced (section 10); no QR and no key-change warning (Peer auth below) |
| Malicious Workshop author | ship signed-but-harmful code | null-origin iframe running the source with `new Function`, no network (`connect-src 'none'`, WebRTC poisoned, no child frames), the enumerated postMessage API (8.2) plus mandatory source review; no preemption and no memory bound, QuickJS-WASM not built (8.1); declarative interpreter safe by construction (7.1) |
| Sybil / gossip poisoner | flood or fake-vouch | challenge-response (signature) admission, trusted-peers-only vouching, re-verify before relay; PoW is an anti-flood speed-bump only, no part of the Sybil answer (5.5) |
| XSS into host origin | read IDB, use in-realm keys, exfiltrate | strict CSP (no eval, no inline) plus Trusted Types plus the DOMParser strip as the primary control; encrypted IDB is secondary (see the key-lifecycle caveat below) |
| Offline disk-image attacker | copy browser profile | passphrase-lock mode (PBKDF2>=600k into AES-GCM) for the vault. Device mode does not cover this: its wrap key record sits in the same profile as the ciphertext. The identity keypairs (`wt-keys`) are outside the vault in both modes, so a profile copy can sign handshakes as this device (Key lifecycle below) |
| Supply chain | tampered dep or model | exact-pinned deps plus lockfile, bundle rather than CDN, SRI where applicable; model-weight hash verification is not built (`src/workers/stt.worker.ts` loads the Hugging Face model unpinned and unverified, 4.3) |

### Identity, key and E2EE design
- All crypto is native WebCrypto: Ed25519 (sign), X25519 (ECDH), AES-256-GCM, HKDF-SHA-256
  derivation plus ratchet, and PBKDF2 (>=600k, off-thread) for passphrase wrapping.
- Browser support is recent, so feature-detect and hard-fail rather than downgrade. Native
  WebCrypto Ed25519 and X25519 landed across engines only recently: Firefox 129 (Aug 2024),
  Safari 17, Chrome 137 (May 2025) `[v]`. Igalia and W3C note it will take into roughly 2027
  for these versions to saturate the install base `[v]`. On a browser without native Ed25519
  or X25519 the app hard-fails the crypto-dependent features with a clear "browser too old,
  update to use P2P and Workshop" message rather than silently shipping a JS crypto polyfill,
  since polyfilled curve crypto in-page is a weaker and larger attack surface. Single-user
  tools (clipboard, OCR, STT, TTS) still work without the curves.
- Keys are non-extractable, stored as `CryptoKey` records in IndexedDB. Non-extractable
  restricts the JS API, not the storage: Chromium and Firefox serialize the key bytes into
  the profile's IndexedDB files, and only WebKit wraps stored keys under a keychain-held
  master key, so elsewhere a copied profile opened in a browser can use them. Mobile
  WebView is weaker still, which is documented.
- Message and file E2EE: per-connection ephemeral X25519 into HKDF into AES-256-GCM, plus the
  per-session HKDF ratchet for forward secrecy (section 6). 64 KiB file chunks with a fresh
  nonce and index each. Double-Ratchet, for post-compromise security, is the Phase 4 upgrade
  (section 12).
- Peer auth: safety numbers compared by hand: an 80-bit fingerprint per key
  (`SHA-256("urletc/safety-number|" || pk)`), the two sorted and shown as 40 hex digits in
  10x4 groups. Verify opens a confirm dialog with the number, and a match adds the peer's
  public key to the `verified` set in the encrypted store (`src/shell/console.ts`). Trust is
  keyed by public key alone: no name or device is pinned to a key on first sight, so a new
  key is just another unverified row and raises no key-change warning, and there is no QR
  exchange. In code rooms a peer can therefore show a verified peer's display name, only
  without the verified mark; the presence roster leads with the key fingerprint instead
  (5.4). Per key, so a MITM needs a second preimage for each side; one digest over both keys
  fell to a ~2^40 collision search between two keys the MITM chooses.

### Key lifecycle for encrypted-at-rest IDB
Encrypting IDB does not defend against an in-page XSS attacker who can use the
non-extractable key in place. What each mode buys:

- MVP at-rest mode, no passphrase: the AES-GCM wrapping key is a non-extractable `CryptoKey`
  generated once and stored in IDB (`src/core/store.ts`). It protects against another origin
  and a casual IDB dump. It does not protect against an offline profile copy, since the key
  record sits in the same profile as the ciphertext and a browser opening the copy can use
  it (WebKit's keychain wrapping aside), nor against same-origin XSS, which can call the key.
  The primary XSS control is therefore CSP plus Trusted Types plus the DOMParser strip, and
  the threat-model table reflects that ordering. Encrypted IDB is not claimed to stop XSS.
- Phase 4 passphrase-lock mode: the wrapping key is derived on unlock via PBKDF2>=600k from a
  user passphrase and held only in memory, zeroised on lock, which reaches every open tab
  (there is no idle timeout yet). This is the mode that raises the bar against both offline
  attackers and a later XSS, since a locked vault holds no key in memory. It is opt-in
  because it trades convenience, meaning re-unlock, for that protection.
- Either mode covers the vault (`wt-data`) only. The device identity keypairs
  (`src/core/identity.ts`) sit unwrapped in `wt-keys` in both modes, so a profile copy, or
  an XSS while the vault is locked, can sign handshakes as this device, including to peers
  that verified its key.

### Controls by phase
Phase 0 and 1 (MVP):
- Native WebCrypto only; non-extractable keys in IDB; hard-fail on missing Ed25519/X25519,
  with no JS-crypto fallback.
- Strict CSP (`default-src 'none'`, no `unsafe-eval`, no `unsafe-inline`) plus
  `require-trusted-types-for 'script'`.
- COOP `same-origin` plus COEP via `vercel.json`; service worker re-injects on cached
  navigations; singlethread ffmpeg so STT survives COEP relaxation, not built since no
  ffmpeg ships (4.3; OCR needs no SharedArrayBuffer, 4.2).
- Encrypted-at-rest IDB facade, documented as not an XSS control; exact-pinned deps plus
  lockfile; bundle rather than CDN; `npm audit` in CI, not built
  (`.github/workflows/ci.yml` runs typecheck, lint, format check, build and e2e).

Phase 2 (P2P):
- Custom-password SDP encryption, effective for personal and code rooms only (5.1);
  app-layer AES-GCM plus per-session HKDF ratchet on every channel; opaque room ids;
  relay-only toggle, present in the session layer and not exposed by any setting (6).
- Challenge-response (signature) admission; trusted-peers vouching; PoW anti-flood speed-bump
  if it is ever built (5.5).
- Safety-number verification offered rather than forced (section 10); the TOFU key pin and
  the key-change warning are not built (Peer auth above).

Phase 3 (Workshop):
- Null-origin iframe plus `connect-src 'none'`, WebRTC poisoning and child-frame stripping,
  with the guest run by `new Function` (QuickJS-WASM not built, 8.1); enumerated
  postMessage capability API with the per-method checks in 8.2.
- Declarative interpreter safe by construction: op-whitelist, no eval, ReDoS worker plus
  RE2-WASM, depth and op caps.
- Ed25519 author signing; verify before display; same-key updates; no auto-approve; two-gesture
  consent plus per-run re-verify plus a 30 s teardown for scripts (apps run until closed).

Phase 4 (Hardening):
- Stale-Chromium banner; Trusted Types polyfill for Firefox; passphrase-lock mode, the real
  at-rest and post-XSS control for the vault. Passphrase-lock is built; the banner and the
  polyfill are not.

---

## 9.1 Security invariants (do not regress these)

Partly enforced by ESLint, partly by review. The rationale for each is above; this is the
short list to check a change against.

- **No `innerHTML` or `outerHTML` from strings.** Build DOM with `el()` and `textContent`.
  Peer-controlled and clipboard-controlled strings are always `textContent`, and are
  length-capped at the session boundary rather than at each render site.
  (ESLint: `no-unsanitized`.)
- **No inline styles.** No `el(..., { style })`, no `.style.cssText` from a string. Use a
  class in `src/styles/tokens.css`, because CSP is `style-src 'self'`. Per-property CSSOM
  setters such as `node.style.left = ...` are fine. (ESLint: `no-restricted-syntax`.)
- **A Trusted Types default policy must exist.** CSP sets `require-trusted-types-for
  'script'`, which makes the Worker constructor a TrustedScriptURL sink. Without the policy
  in `src/core/trusted-types.ts`, every worker throws and OCR, speech to text, captions and
  the regex engine die silently while the UI still looks healthy. The policy implements
  only `createScriptURL`, and only for same-origin and `blob:` URLs, so `innerHTML` and
  `eval` stay blocked. The e2e suite asserts the policy and fails on any Trusted Types or
  CSP console error.
- **`DOMParser.parseFromString` is a TrustedHTML sink.** It sits in the same sink list as
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and
  `Range.createContextualFragment`. HTML stripping used it with a plain string on the
  assumption that avoiding `innerHTML` avoided the sink list, so `stripHtml()` threw
  "This document requires 'TrustedHTML' assignment" and the tool silently did nothing in
  production. It is now fed by a dedicated named policy (`html-strip`) created in
  `src/tools/html-strip.ts`. A named policy is reachable only through the policy object its
  own module holds, so the rest of the app gains no HTML sink; adding `createHTML` to the
  *default* policy would have reopened `innerHTML` for the whole bundle to fix one tool.
  Pass-through is acceptable there because the parsed document is inert (no browsing
  context, so scripts never run), is never attached to the live DOM, and only `textContent`
  is read out of it. Any new use of an HTML sink needs the same treatment: its own named
  policy plus a written argument for why the output cannot execute.
- **Never autorun shared or executable tools.** Install and run are separate explicit
  gestures, and verification (hash plus signature) gates both display and execution.
- **Sandbox boundary.** Guest code runs in a null-origin iframe loaded from
  `public/sandbox/`, with `allow-scripts` and never `allow-same-origin`, behind an
  enumerated postMessage capability API. Keep the guests at real URLs with their own CSP
  header: a `blob:` or `srcdoc` guest inherits the host policy, which refuses the inline
  bootstrap that poisons WebRTC and strips child frames. The iframe is defence in depth; the
  API is the boundary.
- **Local media routing is an allow-list.** `MEDIA_TIERS` names the tiers that may receive
  camera, microphone and screen. As a deny-list, every tier added later was silently opted in.
- **Never join a room because a peer asked you to.** Inbound peer text renders a Join
  button and waits for the click. Auto-joining on a code found in a received message let
  any peer pull your live media into a room they control.
- **The nearby and presence tiers are untrusted.** No clipboard auto-share and no local
  media, ever. The presence tier additionally carries no chat, files or gossip in either
  direction, enforced in the session layer and not only in the console.
- **Feed history is a tier capability, pulled and never pushed.** It is an allow-list of
  personal and code, never nearby and never presence, and a presenceOnly session is
  structurally incapable of carrying it. Sending into a code room is opt in and off by
  default, because a code reaches whoever it was forwarded to. Records are
  only ever accepted from a peer this device asked, so nobody can seed another device's feed, and a
  record replayed to you is never re-served, so one holder's opt-out cannot be laundered
  through the next peer along.
- **Crypto.** Native WebCrypto only, never a JS-crypto polyfill, keys non-extractable.
  Encrypted-at-rest is not an XSS control; CSP and Trusted Types are.
- **Dependencies** are exact-pinned with a committed lockfile. Self-host assets where that
  keeps `script-src 'self'`, and add a `connect-src` origin only for a genuinely consented
  download, with a note saying why.

## 10. Free Deployment on Vercel

Static deploy with generous free bandwidth, since P2P data flows browser to browser rather
than through Vercel.

Response headers and the SPA rewrite live in `vercel.json` at the repo root: COOP
`same-origin`, COEP `credentialless`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, and the CSP. Read that file for the current directive values. An inline
copy in this document drifts out of date, which is what happened to the previous one.

- `wasm-unsafe-eval` in `script-src` is required for the Whisper, Tesseract and Kokoro
  WASM. No nonces: a static site takes Vite-generated hashes, and a clean build has zero
  inline scripts.
- `connect-src` is a curated allow-list, and it is not the WebRTC boundary. It lists the
  Nostr relay WebSockets plus the origins of the consented downloads (such as the tessdata
  and model hosts). STUN and TURN are deliberately absent because ICE traffic
  is out of CSP scope (section 2); listing them would be cargo-cult. The conflict with
  user-supplied relays resolves this way: a static `connect-src` cannot admit arbitrary user
  `wss://` origins, so the shipped app uses the curated list only, and bring-your-own-relay is
  available either through WebRTC-strategy relays that `connect-src` does not bind, or in a
  documented self-host fork where the operator edits this header. The hosted build does not
  advertise arbitrary user relays. A BitTorrent tracker fallback, not built, would need its
  tracker origins in this list too, kept curated and small.
- COEP is `credentialless` rather than `require-corp`, precisely because `require-corp` breaks
  any cross-origin resource lacking CORP, including URL-preview embeds and third-party media.
  `credentialless` still grants `crossOriginIsolated`, and with it SharedArrayBuffer for
  multithread WASM, while letting no-CORP subresources load credential-free. OCR runs
  without SharedArrayBuffer (4.2) and the ffmpeg core that would need it is not built
  (4.3), so the core tools keep working even if a future tool forces COEP off entirely.
  Disable the Vercel toolbar in production, a known COEP conflict.
- The service worker must re-inject COOP/COEP on cached navigation responses, which Workbox
  does not do, or `crossOriginIsolated` breaks on reload.

Backends and external dependencies, stated explicitly: no backend you operate is required
for the core product, but client-only and free does not mean nothing third-party is involved.
The app depends on third-party Nostr relays for signaling (free, unreliable, no SLA, may
gate writes) and on Google and Cloudflare STUN. A TURN relay is used only when a
device or the deployment configures one (per 5.2); without one the symmetric-NAT tail simply
fails rather than falling back. Self-hosted coturn on Oracle Always Free would be a server
you operate, one box, if relay reliability matters later. None of these is your application
backend, but each dents a naive "fully serverless, depends on nothing" reading, so they are
named here.

One optional Vercel concession: a stateless TURN-credential vending Edge Function holding a
free-tier Metered or Cloudflare API key server-side and returning short-lived rotating TURN
credentials (sub-second, no state, within the Hobby timeout). It keeps the secret out of
client code and isolates bandwidth from a shared public-credential pool. Nothing like it
ships today: the shipped path is a static credential pasted per device or set per deployment
(5.2), whose deployment form is readable in the public bundle. Self-hosted coturn is the
alternative that keeps everything off Vercel.

### Minimal UI against security ceremony
The security-first posture risks overloading the UI. Ceremony is therefore progressive rather
than upfront. Primitives live in `src/shell/ui.ts`:

```
+- Tool consent dialog, only on Run ---------------------------------+
|  ! JSON Key Sorter  v1.2.0     badge: [self-signed, unverified]    |
|  by alice (ed25519:9a4c...)      SHA-256: 7d8e...   [copy]         |
|  Capabilities requested:  [ ] read clipboard  [ ] write clipboard  |
|  Source  [ Expand full source ]                                    |
|            [ Cancel ]                        [ Run once ]          |
+--------------------------------------------------------------------+
Roster row:  alice (verified)  |  bob (unverified)  [ Verify ]
```

- Safety-number verification is offered, not forced. First contact works immediately, and an
  unobtrusive Verify control on an unverified roster row invites a one-time number check in
  a confirm dialog when the user cares (QR exchange is not built). That avoids a mandatory
  ceremony during onboarding while keeping the control available for the threat that needs
  it.
- Per-run consent is the deliberate single point of friction for executable tools, with no
  remember-or-auto-approve. Everything else, including size disclosure and badges, is inline
  rather than a separate dialog.

---

## 11. Phased Build Roadmap

Phase 0: Foundation. Vite 8 plus TS skeleton, `tokens.css`, hash-router, registry contract,
crypto core plus encrypted-store facade plus key-lifecycle modes, PWA shell, `vercel.json`
headers, `src/shell/ui.ts` primitives.
- Security gate: CSP/COOP/COEP live and verified (`crossOriginIsolated===true`, cached-nav
  headers correct); non-extractable keypair round-trips through IDB; hard-fail path verified
  on a browser lacking Ed25519; zero inline scripts; lockfile committed.

Phase 1: MVP, single-user tools. Clipboard hybrid one-tap plus router plus sub-tools (OCR via
Tesseract v7, NLP via compromise, JSON, URL, HTML via the DOMParser strip); transcription (files first
via singlethread ffmpeg, then VAD live); TTS (SpeechSynthesis plus Kokoro opt-in). All
lazy-loaded and Cache/OPFS-cached.
- Security gate: no clipboard data ever leaves the device; no auto-URL-fetch;
  `localService:true` enforced; model-weight SHA-256 verified against a pinned digest before
  load; OOM and `deviceMemory` gating verified on a low-RAM device; STT and OCR confirmed
  working with COEP both on and off.

Phase 2: P2P messenger. Trystero discovery plus signed-heartbeat roster with custom-password
SDP encryption; E2EE DataChannel wrapper with per-session HKDF ratchet; chat; raw-DataChannel
file transfer into OPFS; VoIP and screen-share with caps; relay-only toggle (in the session
layer, not exposed by any setting, 6); local `getStats()` relay-bandwidth estimate.
- Security gate: app-layer AES-GCM plus ratchet on every channel (ciphertext and key-advance
  verified on the wire, old key zeroised); challenge-response signature admission; PoW
  anti-flood verified not to block honest peers; safety-number verification flow works
  (offered, not forced); room caps enforced (not built: no per-room cap exists, 5.2);
  default-relay SDP shown encrypted to a simulated relay observer.

Phase 3: Workshop and sandboxed scripts. Gossip catalog plus IDB pinning plus signed file
export and import; manifest schema plus zod plus Ed25519 sign and verify; trust tiers and
badges; declarative automations first (safe-by-construction interpreter plus ReDoS worker),
then the iframe runner for `type:"script"`, built with `new Function` in the frame (the
QuickJS-WASM interpreter inside it is not built, 8.1); two-gesture consent.
- Security gate: `allow-same-origin` provably absent; in-doc `connect-src 'none'`; postMessage
  capability API audited as if the iframe is fully escaped (every method permission-gated,
  validated, rate-limited); interpreter op-whitelist has no eval or
  host-access path; ReDoS worker terminates on a known catastrophic pattern; verify before
  display plus per-run re-verify; 30 s kill-timeout; no auto-approve path exists.

Phase 4: Hardening. Passphrase-lock mode (the real at-rest and post-XSS control);
stale-Chromium banner; Trusted Types polyfill; optional TURN-vending Edge Function or
self-hosted coturn; Double-Ratchet upgrade if the threat model escalates.

---

## 12. Design decisions and trade-offs

| # | Decision | Options | Choice | Trade-off |
|---|---|---|---|---|
| 1 | Signaling and discovery backend | (a) Trystero on free public Nostr/BitTorrent infra; (b) self-host `@trystero-p2p/ws-relay` on an Oracle/Fly free tier; (c) keep PeerJS cloud | (a) for v1, with a curated relay allow-list rather than arbitrary user relays (section 10) | (a) zero ops, no SLA and write-gating risk; (b) reliable but a box you run; (c) ~50-conn cap, "not production." |
| 2 | TURN strategy | (a) a static credential, either the retired public one or your own provider account's; (b) Vercel cred-vending Edge Function plus a provider key; (c) self-host coturn (Oracle Always Free) | (a) with your own account, configured at runtime and never committed: pasted per device in Settings or set per deployment in `VITE_TURN_SERVERS` (5.2). The retired public credential left dead ICE candidates and was removed; (c) is the fallback if relay reliability starts to matter | (a) a deployment credential is readable in the public bundle and its quota (Metered free: 500 MB a month) can be spent by anyone who extracts it, while a device credential stays on that device; (b) one tiny backend touchpoint; (c) zero cost plus your own box, best reliability. |
| 3 | Identity model | (a) single keypair plus room-scoping plus challenge-response; (b) dual public/private peer | (a) | (b) adds state and linkability risk for no gain once signature admission exists. |
| 4 | Executable-script sharing | (a) declarative automations only; (b) declarative plus QuickJS-sandboxed JS; (c) full JS | (b): declarative primary, sandboxed JS as an opt-in tier behind 8.2 | (a) safest, limited; (b) covers most needs with bounded risk and an honest "isolated, not safe" framing; (c) unacceptable. |
| 5 | Forward secrecy depth | (a) per-session HKDF ratchet, in scope for v1 (section 6); (b) full Double-Ratchet now | (a) now, (b) at Phase 4 | v1 already gives session FS; (b) adds post-compromise security at X3DH, prekey and state cost. Deferred; it matters only for contact with high-risk strangers. |
| 6 | COEP mode | (a) `credentialless`; (b) `require-corp`; (c) no COEP | (a) | (a) keeps `crossOriginIsolated` and loads no-CORP embeds credential-free; (b) breaks third-party embeds; (c) loses SharedArrayBuffer fast paths, though the singlethread cores still work (section 4). |

---

## 13. Hard Constraints & Reality Checks

- **Clipboard auto-read on load works on Chromium** after a one-time `clipboard-read` grant,
  since tab focus satisfies the focus requirement. This was measured in production, so
  returning users get "open and it reads." A first visit needs one gesture to surface the
  grant prompt. Firefox and Safari have no persistent grant and fall back to the paste
  listener plus scan button. Continuous "watch clipboard" stays default-off.
- **No-backend signaling is real from your side; no-backend reliable connectivity is not**,
  and even signaling leans on third parties. STUN covers ~70-90% residential `[~]`; the
  ~10-30% symmetric-NAT and CGNAT tail `[~]` needs TURN. Free TURN is best-effort and
  shared-pool, and you cannot read the remaining pool quota, only a local `getStats()`
  estimate. Nostr relays are third-party, unreliable, and may gate writes.
- **In-browser Whisper:** files are solid, and video only where `decodeAudioData` reads the
  container, since no ffmpeg ships (4.3); live-mic real time is best effort and device and
  browser dependent, degrading to VAD-chunked near real time. Accuracy is capped at
  base/small, below cloud large-v3. Do not trust WebGPU to be faster; benchmark at runtime.
  Download is tens of MB and never auto-fetched. It is not hash-verified: the model loads
  unpinned from Hugging Face (4.3).
- **"Catalog with literally no server" is false.** It is "no server *you* operate", with
  persistence degrading to online-peer overlap, and no durable hosting without accepting a
  relay or KV dependency, because browsers have no DHT. Installed tools survive locally and
  via signed file export; swarm re-seeding is best effort.
- **Script execution is isolated and consent-gated.** Sandbox escapes are
  exploited in the wild on unpatched and embedded Chromium (CVE-2025-2783, CVE-2025-4609
  `[v]`); the enumerated postMessage capability API (8.2) is the real boundary, with the
  iframe behind it; and consent fatigue and social engineering are irreducible by technical
  means. Declarative tools are safer only because the interpreter is provably
  non-Turing-complete and side-effect-bounded (7.1), and the product copy says so rather
  than claiming safety.
- **`connect-src 'none'` does not block WebRTC inside the guest.** A guest script can
  exfiltrate over `RTCPeerConnection` ICE/STUN/TURN, or over DNS, despite the inner CSP,
  because CSP `connect-src` never governs ICE. Same root fact as
  sections 2 and 10, applied to the *guest*. Fixed: the guest bootstrap poisons
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `mozRTCPeerConnection` and `RTCDataChannel`,
  which is browser-enforced and CSP-independent, before any untrusted source runs
  (`public/sandbox/script.html`, `app.html`). Poisoning reaches one realm only, and a child
  frame is a realm of its own: an `<iframe srcdoc>` the guest inserts gets a working
  `RTCPeerConnection`, and CSP stops neither srcdoc nor `about:`/`javascript:` navigations
  (Chromium also ignores the CSP3 `webrtc` directive). So the guest gets no frames: a
  `MutationObserver` detaches any inserted `iframe`/`frame`/`object`/`embed` before its
  navigation can commit, using DOM methods captured before untrusted code runs. Every
  shadow root `attachShadow` creates is watched the same way, so web components keep
  working; `setHTMLUnsafe`, `parseHTMLUnsafe` (declarative shadow roots) and
  `document.open/write` are refused because they would place an insertion where the
  observer does not look. Apps lose `<object>`/`<embed>` with it.
  Tool storage is also quota-capped at 1 MiB per tool namespace (`toolStorage` in
  `src/core/store.ts`), counting key bytes, with writes serialised per namespace, so a
  `storage`-granted tool cannot exhaust origin storage. Every Workshop tool shares one
  namespace, `tool:workshop:`, with the installed list and its sources (up to 512 KiB
  each), so that 1 MiB covers all of them together: one tool filling it, or two near-maximum
  sources, makes later installs fail with `tool storage quota exceeded`.
- **COEP interaction is real.** `require-corp` breaks cross-origin embeds, so the default is
  `credentialless`. ffmpeg.wasm multithread needs cross-origin isolation, so the plan is its
  singlethread core `[v]`; no ffmpeg ships yet (4.3), and OCR needs no SharedArrayBuffer
  (4.2). Where the browser has no Trusted Types, `src/core/trusted-types.ts` installs
  nothing and the CSP directive is inert; the planned Firefox polyfill is not built.
  Workbox will not forward COOP/COEP on cached navigations, so a custom service-worker
  handler is required.
- **Native WebCrypto Ed25519/X25519 is recent:** Firefox 129, Safari 17, Chrome 137 `[v]`,
  saturating around 2027 `[v]`. Crypto-dependent features hard-fail on older browsers instead
  of shipping a weaker JS-crypto polyfill. Single-user tools still work.
- **Encrypted-at-rest IDB does nothing against XSS (see section 9).** A same-origin attacker can use the
  non-extractable key in place. CSP plus Trusted Types plus the DOMParser strip are the primary XSS
  controls, and passphrase-lock mode (Phase 4) is the only mode that protects the vault
  against a later compromise; the identity keys stay outside it (section 9).
- **Mesh ceiling is roughly 20-30 peers `[~]`, video roughly 6 `[~]`.** No free SFU exists, so
  scope groups small.

---

### Source notes
`[v]` verified June 2026 against primary sources:
- Vite 8 stable (Rolldown) released Mar 2026. vite.dev/blog/announcing-vite8.
- Trystero v0.25.2 (11 Jun 2026), scoped `@trystero-p2p/*` incl. `ws-relay`, default SDP key
  derived from app+room ID (reverse-engineerable by relay; custom password recommended).
  github.com/dmotz/trystero.
- WebCrypto Ed25519/X25519: Firefox 129 (Aug 2024), Safari 17, Chrome 137 (May 2025); ~2027
  saturation. Igalia/blogs.igalia.com, chromestatus 4913922408710144.
- Tesseract.js v7 relaxed-SIMD, 15-35% faster than v6. github.com/naptha/tesseract.js/releases.
- kokoro-js (Kokoro-82M-v1.0-ONNX, Apache-2.0), WASM default + WebGPU device option, ~80 MB
  fp32. npmjs.com/package/kokoro-js, huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX.
- ffmpeg.wasm multithread requires SharedArrayBuffer/COOP+COEP; singlethread does not.
  github.com/ffmpegwasm/ffmpeg.wasm issues #234/#353.
- CVE-2025-2783 (Chrome Mojo sandbox escape, in-the-wild, fixed 134.0.6998.177) and
  CVE-2025-4609 (ipcz handle leak, fixed 136.0.7103.113). nvd.nist.gov, ox.security.

`[~]` unverified order-of-magnitude estimate. Treat as planning figures and measure before quoting to users:
- STUN ~70-90% / TURN ~10-30% (industry ranges, vary by population; cellular and enterprise
  skew higher TURN).
- Mesh ceiling ~20-30 peers, video ~6 (Chromium PeerConnection practical limits).
- Relay budget hours, model and library byte sizes, nanostores and Open Props sizes, PoW
  ~100-300 ms: all depend on build flags, quantization and hardware; surface build-measured
  values in the UI rather than these placeholders.
