# utilscript: Architecture & Security Study

> Lead Architect study. Client-only, free-to-host, security-first all-in-one web toolkit.
> Decisions are opinionated and bound to the feasibility verdicts. Where the feasibility pass
> refuted or qualified a requirement, the compromise is stated inline. Version/quantitative
> claims carry a source tag `[v]` (verified, June 2026) or `[~]` (best estimate, unverified;
> treat as an order-of-magnitude figure, not a guarantee). See section 13 for the source notes.

---

## 0. Decisions Locked (2026-06-21)

All seven open decisions (section 12) are confirmed by the user, with two refinements:

- **D1 Signaling:** Trystero on free public Nostr/BT, curated relay allow-list. ✅
- **D2 TURN:** OpenRelay public to start; coturn / Edge-fn later only if needed. Scale is **a small team (a handful of peers)**, so best-effort free infra is acceptable. ✅
- **D3 Identity:** single keypair + **rooms** (reject dual-identity). Rooms are first-class: user-set **name + description + settings**, easy create + **share via link/QR**, and **E2EE within the room**. ✅
- **D4 Scripts:** declarative-automations primary + QuickJS-sandboxed JS opt-in. ✅
- **D5 Core guarantee:** the user always **sees the source** and explicitly chooses to run; **never autorun**. That is the property to guarantee and test for. ✅
- **D6 Forward secrecy:** per-session HKDF ratchet in v1; Double-Ratchet at P4. ✅
- **D7 COEP:** `credentialless`. ✅
- **Refinement A (Clipboard):** auto-read on load **does work on Chromium** after a one-time `clipboard-read` grant (verified in the user's prior project). section 4.1 revised from "impossible" to progressive enhancement (auto on Chromium, paste/scan fallback elsewhere).
- **Refinement B (Durability):** "durable until the cache is cleared" (local IDB pin + signed file export) is good enough at team scale; no DHT / heavy hosting needed.

---

## 1. Executive Summary

Ship a single static SPA on Vercel free-tier: **Vite 8 (Rolldown) + TypeScript (strict), zero UI framework** `[v]`, a hand-rolled CSS custom-property token sheet, and a **vanilla tool registry that `dynamic-import()`s every tool** (built-in *and* workshop) behind a single `ToolManifest` contract. All heavy capability code (Whisper, Tesseract, Kokoro, QuickJS) lives inside its tool's import boundary, fetched only on activation, then Cache-API/OPFS-cached. **Peer discovery + signaling is serverless via Trystero (Nostr primary, BitTorrent fallback)** `[v]`; NAT traversal uses free Google STUN with **Metered OpenRelay TURN as relay-of-last-resort**. Identity is a **single Ed25519 + X25519 device keypair** (non-extractable, in IndexedDB). The dual public/private model is rejected in favour of room-scoping + challenge-response admission. The **messenger** reuses one WebRTC mesh (cap 6 video / ~12 data peers) with app-layer X25519+AES-GCM E2EE on every DataChannel. Because forward secrecy matters once we talk to strangers, it adds a **lightweight per-session ratchet (HKDF chain) on top of NaCl-box** (sections 6 and 9). The **Workshop** gossips Ed25519-signed, SHA-256-content-addressed manifests over the same mesh, bodies fetched P2P; executable scripts run **only** inside a null-origin `sandbox="allow-scripts"` iframe wrapping **QuickJS-WASM**, behind two explicit gestures, **never autorun**. The **single security boundary for all untrusted code is one explicitly-enumerated postMessage capability API** (section 8.2); the iframe is defence-in-depth, not the boundary. Security is cross-cutting: native WebCrypto only, strict CSP + Trusted Types, COOP/COEP, encrypted-at-rest IndexedDB. There is **no backend you operate** in the core product; three external dependencies are honestly flagged (Nostr/BT relays, OpenRelay TURN, optional coturn) and one optional Vercel Edge Function (section 10).

```
+----------------------------------------------------------------------------+
|  BROWSER TAB  (single origin, HTTPS, COOP:same-origin + COEP:require-corp) |
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
|   | WORKSHOP SANDBOX  null-origin iframe (allow-scripts only), QuickJS |   |
|   | THE BOUNDARY = enumerated postMessage capability RPC (section 8.2) |   |
|   +--------------------------------------------------------------------+   |
+--------------------------------+-------------------------------------------+
      app-layer AES-GCM + ratchet| over WebRTC DTLS DataChannels/media
        +------------------------+-----------------------------+
        v                        v                             v
  Nostr relays (signaling)   Google STUN (free)         OpenRelay TURN (free tier,
  BitTorrent trackers (FB)   ~70-90% direct [~]         relay last-resort, ~10-30% [~])
  *3rd-party, not yours*     *3rd-party*                *3rd-party; opt coturn/Edge fn*
  NOTE: WebRTC ICE/media traffic is NOT governed by CSP connect-src (sections 2 and 10).
```

**Honesty notes (expanded in section 13):** clipboard auto-read on load is **impossible** (one-tap minimum); live-mic real-time Whisper is **best-effort**, not guaranteed; "catalog with literally no server" is "no server *you* operate," and even that leans on third-party relays/TURN; sandboxed script execution is "isolated + consent-gated," never "safe" in the absolute; "automatic" discovery is bounded (see section 5.4).

---

## 2. Build Stack & Project Structure

| Concern | Pick | Why |
|---|---|---|
| Bundler | **Vite 8 (Rolldown)** `[v]` (stable Mar 2026) | Native WASM `?init`, fine chunk control for lazy tools, native TS. Requires Node 20.19+/22.12+. Pin in `engines`. |
| Language | **TypeScript strict** | Enforces `ToolManifest` at authorship; zero runtime cost. Runtime validation (zod) still mandatory for untrusted manifests. |
| UI | **Vanilla DOM + nanostores** (about 300 B core `[~]`) | No framework. Preact (~3 kB) only if a tool genuinely needs a component model. |
| CSS | **Hand-rolled `tokens.css`** (~100 lines custom properties) | Honours "minimal CSS"; no Tailwind, no runtime JS. Open Props rejected (ships a few kB un-tree-shakeable `[~]`). |
| Routing | **~30-line hash-router** | No history-API rewrite rules, framework-free. |
| State | **nanostores atoms**, one per tool + shared (`$peers`, `$clipboard`, `$session`) | Tools rarely share state; atoms scope cleanly. |
| Persistence | **idb-keyval + AES-GCM envelope** via encrypted-store facade | Native SubtleCrypto; no crypto lib shipped. Key lifecycle in section 9. |
| Large blobs | **Cache API / OPFS** (NOT IndexedDB) | Model weights bypass IDB quota; OPFS is origin-private. |
| PWA | **vite-plugin-pwa (Workbox generateSW)** + **custom fetch handler re-injecting COOP/COEP on cached navigations** | Workbox does not forward these headers, a load-bearing gotcha (section 10). |

**Two stack-level network realities:**

1. **CSP `connect-src` does NOT govern WebRTC.** ICE/STUN/TURN/DTLS/SRTP traffic is out of CSP scope: `connect-src` only constrains `fetch`/XHR/WebSocket/EventSource/`navigator.sendBeacon`. So the relay WebSocket URLs (Nostr/BT/ws-relay) *are* constrained by `connect-src`; the STUN/TURN endpoints are *not*. The CSP is therefore **not** the network boundary for the P2P media path. We say this plainly in section 10 rather than implying CSP fences WebRTC.
2. **User-supplied relay URLs vs static CSP `connect-src` is a genuine conflict**. A static header cannot allow arbitrary user-entered `wss://` origins. Resolution in section 10: ship a **curated relay allow-list** in `connect-src`; "bring-your-own-relay" is offered only via the optional **WebRTC `@trystero-p2p/ws-relay`/IPFS strategies** (not `connect-src`-bound the same way) or is gated behind a documented self-host build where the user edits the CSP. We do **not** pretend arbitrary user relays work under the shipped CSP.

```
utilscript/
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
|   |   `-- ice.ts             # STUN list, TURN config, relay-only toggle, getStats meter
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

---

## 3. The Pluggable Tool Model

One contract for **everything**: built-in and Workshop tools are indistinguishable to the shell except for **trust level** and **load source**.

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

- **Built-in tools** call `registry.register(manifest)` at module-eval; Vite code-splits each chunk; `load` = `() => import('../tools/<id>')`. Built-ins run in the host realm and are trusted (they are part of the audited bundle).
- **Workshop tools** are stored in IndexedDB as signed manifest + body. Their `load` resolves to a controlled loader that (1) re-verifies signature + content hash, (2) validates the manifest with **zod**, (3) renders the consent dialog, (4) only then hands the body to the sandbox runner. A Workshop tool's `activate` **never runs in the host realm**. It mounts the runner iframe and proxies UI/state via the postMessage capability API.
- **`ToolContext` is the capability facade and the security boundary.** For host-realm built-ins it is a direct object; for sandboxed tools it is the postMessage RPC surface enumerated in **section 8.2**. Either way it exposes **only** declared+consented capabilities, input-validated and rate-limited.

---

## 4. Per-Capability Picks

### 4.1 Clipboard detection + routing
On Chromium, `navigator.clipboard.read()` succeeds **on page load without a fresh gesture once the `clipboard-read` permission is granted**: the tab is focused on navigation, which satisfies the focus requirement. So for a returning Chrome user the experience is exactly "open the site and it reads the clipboard and offers actions" (confirmed in production by the user's prior project). The design is therefore **progressive enhancement, not one-tap-only**:
- **On load, attempt `navigator.clipboard.read()`** behind a `document.hasFocus()` check (and optionally `navigator.permissions.query({name:'clipboard-read'})` to predict `granted` vs `prompt`). If the grant already exists, auto-detect immediately. Wrap in try/catch for `NotAllowedError` / "Document is not focused."
- **First visit / not yet granted:** a **"Scan clipboard" button** calls the read *inside* its click handler, the gesture that lets Chrome surface the grant prompt. After the user clicks *Allow*, subsequent loads auto-read.
- **Firefox/Safari fallback** (no persistent `clipboard-read` grant model): an always-registered document-level **`paste` listener** (Ctrl/Cmd+V, zero prompt, all browsers; exposes `clipboardData` types/contents) plus the scan button. Safari surfaces native paste UI; Firefox gates `clipboard.read` behind a gesture.
- All paths funnel into one `clipboardRouter(items)`. Route by **`ClipboardItem.types`** first; text heuristics only for `text/plain`, ordered `new URL()`, then `JSON.parse()`, then HTML-tag regex, **capped at first 10 KB**.
- Each action toggleable, **ON by default**; continuous **"watch clipboard"** mode (re-read on `focus`/poll) stays **DEFAULT OFF** and disclosed.
- Never auto-fetch detected URLs (leaks clipboard to third party); preview is a manual button. `text/html` parsed via `DOMParser` + **DOMPurify** (bundled). Never `innerHTML`; `DOMParser.parseFromString` is itself a TrustedHTML sink and needs a named policy (section 9.1).

### 4.2 OCR: **Tesseract.js v7** (primary) `[v]`
v7's relaxed-SIMD LSTM build (15-35% faster than v6 `[v]`), in a Web Worker, lazy-loaded on first image detection. WASM core + Brotli `eng` traineddata is roughly a **single-digit-MB** download `[~]` (do not quote an exact MB to users; measure at build time and surface the real number in the download dialog). Library auto-caches traineddata in IndexedDB. **No SharedArrayBuffer needed** (worker-per-scheduler), so OCR works even on pages *without* cross-origin isolation, relevant to the COEP interaction in sections 4.3 and 10. Canvas preprocessing (grayscale, adaptive threshold, 2x upscale for sub-300 DPI). Cap input ~4 MP; `worker.terminate()` after each session (WASM heap can't shrink). Returns words/lines/symbols + bboxes. **Secondary opt-in** `ppu-paddle-ocr` (PP-OCRv5 mobile) behind a toggle. **Reject TrOCR/transformers.js OCR**: tens of MB minimum, incompatible with the minimalist constraint `[~]`.

### 4.3 STT: **transformers.js Whisper**. **FEASIBILITY: confirmed (files), best-effort (live)**
- Pipeline in a dedicated **`stt.worker.ts`**. Default **whisper-base** for multilingual; **whisper-tiny** fallback gated by `navigator.deviceMemory` (iOS WKWebView OOM risk). Download sizes are tens of MB (base) and smaller (tiny). **Surface the build-measured byte count in the download dialog rather than a hardcoded figure**; do not auto-fetch.
- **Files/video:** decode chain: `decodeAudioData`, then `WebCodecs AudioDecoder`, then **ffmpeg.wasm** fallback to 16 kHz mono. Chunk `chunk_length_s=30, stride_length_s=5` with sliding-window stitching. Slow WASM acceptable. **COEP caveat:** ffmpeg.wasm's *multithread* core requires SharedArrayBuffer, so COOP+COEP `[v]`; its *singlethread* core does not `[v]`. Decision: ship the **singlethread ffmpeg core** so transcription works even where COEP must be relaxed, and treat the multithread core as a faster path *only* when `crossOriginIsolated === true`. This decouples OCR/STT from the global-COEP decision (section 10).
- **Live mic:** **`@ricky0123/vad-web`** (Silero) gates ~30 s segments before Whisper. **Near-real-time on capable hardware, not guaranteed low-latency streaming.**
- **Do NOT hardcode WebGPU as the fast path.** Benchmark WASM vs WebGPU at runtime on a short clip and pick the winner (WASM frequently wins on Apple Silicon / q8).
- Cache weights in **OPFS** after an explicit, size-disclosed, user-triggered download. **Verify weight SHA-256 against a pinned digest before loading** (supply-chain control, section 9).
- **Web Speech API** offered only as an **opt-in, persistently-warned, never-default** cloud fast-path (ships audio to Google/Apple, which is incompatible with default-on). No diarization in v1.

### 4.4 TTS: **Web Speech API (default) + Kokoro (opt-in HQ)** `[v]`
- Default `speechSynthesis`, **filtered to `localService:true` voices only** (cloud voices silently POST text off-device). Sentence-chunk to dodge Chrome's ~200-char cutoff `[~]`. Linux local voices may be espeak-only/robotic, so Kokoro is the real option there.
- HQ path: **kokoro-js (Kokoro-82M-v1.0-ONNX, Apache-2.0)** `[v]` in **`tts.worker.ts`**; fp32 export about 80 MB `[~]`, smaller quants (q8/q4) available, IDB/OPFS-cached. **kokoro-js runs on WASM by default with a WebGPU device option** `[v]`. Do **not** assume WebGPU; gate it behind the same runtime benchmark as STT. Gate behind explicit gesture + measured-size disclosure; pin the version. **Reject SpeechT5** (hundreds of MB, no advantage `[~]`). Piper is a viable WASM-only alternative if multilingual-without-WebGPU becomes a priority.

---

## 5. P2P Layer: Discovery, Signaling, NAT, Identity

**FEASIBILITY: confirmed-with-caveats.** Signaling/discovery is genuinely serverless (from *your* side); reliable connectivity for *everyone* needs TURN, which is a third-party dependency.

### 5.1 Discovery + signaling via **Trystero, Nostr primary, BitTorrent fallback** `[v]`
Trystero **v0.25.2 (June 2026)** `[v]` is actively maintained and ships scoped `@trystero-p2p/*` packages including a self-hostable **`ws-relay`** `[v]`. Configure **3-5 Nostr relays + tracker fallback**; implement establishment **retry/timeout** (relay latency can stall SDP).

> **SDP-encryption nuance:** Trystero encrypts SDP with a key derived from **app ID + room ID by default**, which a *relay operator can reverse-engineer* from the (public) room/app IDs. To actually hide SDP from relays you **must pass a custom per-room password** `[v]`. **Decision:** always supply a high-entropy room password derived from our own X25519 handshake material, never rely on the default derivation. This is independent of, and additional to, our app-layer payload E2EE (section 6).

### 5.2 NAT traversal: the FALLBACK CHAIN
1. **`iceTransportPolicy:'all'` + Google STUN** (`stun.l.google.com:19302` + 2-3 more) covers the majority. *Residential STUN success ~70-90% `[~]`; symmetric-NAT/CGNAT/enterprise tail ~10-30% needs TURN `[~]`.* (These are industry order-of-magnitude figures, not measured for this app; see section 13.)
2. **Metered OpenRelay TURN** (free tier, public credential) as relay-of-last-resort for the symmetric-NAT tail.
3. **Self-hosted coturn on Oracle Always Free ARM** as a higher-reliability $0 fallback (one box; an *operated dependency*, honestly flagged in section 10 and section 13).
4. **Bias Safari + likely-CGNAT-mobile toward relay early** to maximise success.
- **Relay-bandwidth budget:** the app **cannot read remaining shared-pool quota** from Metered (no client API). What we *can* do is **estimate locally with `RTCPeerConnection.getStats()`** (`bytesSent`/`bytesReceived` on `transport`/`candidate-pair` where `relay` candidate is selected) and surface a *local session estimate*, plus a hard local cap that **disables video-over-relay by default**. We do **not** claim to show "remaining pool budget"; that was infeasible. **Default STUN-first** so the majority never touch relay at all.
- **Scale guard:** mesh degrades past ~20-30 peers `[~]` (Chromium PeerConnection ceiling, FF/Safari mesh lag). Enforce app-level room caps (~12-15 data peers) and hub-and-spoke beyond that.

### 5.3 Identity model, RESOLVED: **single keypair, reject dual-identity**
One **Ed25519 (signing) + one X25519 (ECDH)** non-extractable keypair per device on first load, in IndexedDB; device ID = hex SHA-256 of the Ed25519 public key. Dual public/private peers add state + linkability risk without proportional gain once challenge-response admission exists.
- **Public discovery** = joining a well-known/topic room; presence is a **signed heartbeat** (`{pubKey, displayName, capabilities, ts, sig}`, every 15-30 s, prune at 2x interval). This is a fully client-side live roster, no server.
- **Private connection** = an opaque `crypto.randomUUID()` room id shared **out-of-band via QR/copy-paste only**, never broadcast.
- **Admission gate:** Trystero `onPeerJoin` triggers a **challenge-response**. The peer signs a fresh nonce; we verify against the claimed pubkey before the peer is app-visible. Timestamp-freshness + per-window rate-limit as spam defenses. **On PoW: see section 5.5. It is NOT relied on as a Sybil cure.**
- Key backup = user-downloaded JSON: public key + private key wrapped with a PBKDF2(>=600k)-derived AES-256-GCM key. No cloud backup; passphrase loss = unrecoverable by design.

### 5.4 How "automatic" is discovery, really? Four serverless rendezvous tiers
**LAN/mDNS auto-discovery is NOT available to web pages** (no web API for mDNS service discovery; browsers only use mDNS internally to mask host candidates), and "incremental IDs with regional prefixes" were **rejected** because a dense sequential ID space needs a central allocator (a backend counter, exactly what this project excludes) and makes every user enumerable by strangers. Instead, practicality is delivered by four tiers that all derive the room name client-side (implemented in `src/p2p/discovery.ts` + `personal.ts`, all live concurrently in the console, roster deduped by peerId):

1. **Nearby (zero-touch, the default answer to "send this image to my phone"):** a STUN binding request reveals our *own* public (server-reflexive) IP; every device behind the same NAT derives the same room, `H(publicIP)`, and meets there. Open the app on two devices on one Wi-Fi and they appear to each other with **no user action**. Prefers the IPv4 srflx candidate (shared by all devices on one NAT); skipped silently when UDP/WebRTC is blocked.
   - *Privacy cost (accepted, documented):* relays see `H(publicIP)`, so an observer who knows/guesses your IP can link presence. Content stays E2EE behind the authenticated handshake.
   - *Trust cost (mitigated):* CGNAT/café networks put strangers in your nearby room. They render as **unverified** peers and get **no auto-shared clipboard and no local media, ever**; explicit sends and verification remain available.
2. **Join code (the "short ID" UX, no allocator):** a 6-char code from an unambiguous 31-letter alphabet (~2^29); both sides derive the room as `H(code)`. Speak it aloud, the other person types it: same effort as a TeamViewer-style ID, zero servers, sparse instead of enumerable. Ephemeral; leave discards it.
3. **Personal room (pair once, works cross-network):** a 32-byte secret shared via one-time link/QR; all your devices derive `H(secret)` and auto-join forever. The only tier that receives clipboard auto-share, and (with code rooms) local media.

4. **Presence list ("Online now"), which shows who is online and nothing else:** one fixed room, `H("global|v1")`, that every opted-in device joins (`presenceRoom()`). It answers "who else is using this right now" without a shared secret, a shared IP or a code.
   - *Presence-only, enforced at the session layer:* the session is created with `presenceOnly`, so inbound chat/files/tool-gossip/media are dropped before reaching the app, the corresponding send methods are no-ops, and the session stays out of `getAllSessions()`/`getActiveSession()` so a P2P tool enumerating "every reachable peer" cannot reach these peers either. The console independently excludes the tier from `BROADCAST_TIERS` and `MEDIA_TIERS`. Presence is the only thing that crosses it, in either direction.
   - *Opt-in, default OFF* (`presence-on`, `wt:presence`). Unlike nearby, which is scoped to your own NAT, this announces you to everyone running the app, so it is not a default we set for the user.
   - *Roster:* a stranger's row leads with the first 6 hex of their identity-key fingerprint (which they cannot choose) and demotes the self-asserted name, so a stranger cannot copy a paired device's display name and pass for it. Ordered LAST in `TIER_ORDER`, so first-tier-wins dedupe always renders a device you can also reach privately under its trusted tier.
   - *Scale, stated honestly:* one room is a full mesh, so this is sized for a small team, not a public population. It is deliberately **not** sharded or epoch-rotated: sharding needs a rendezvous bucket everyone probes first, and rotating the room name on a wall-clock epoch makes the entire population re-join that one bucket simultaneously, a worse problem than the one it solves. If the population ever outgrows one mesh, the fix is a real bound, not a rehash.

We still do **not** claim mDNS-grade LAN scanning; we claim, truthfully, "devices on the same network find each other automatically; anyone else is one spoken code away."

### 5.5 Sybil/PoW: specified and honestly bounded
Client-side **proof-of-work does NOT stop a motivated/GPU attacker** (the asymmetry favours the attacker). We therefore **demote PoW to a thin anti-flood speed-bump, not a Sybil cure**, and state so:
- **PoW spec:** to *post a heartbeat or a gossip announce*, a peer attaches `H(pubkey || roomEpoch || nonce)` with a leading-zero-bits target tuned so an honest laptop spends ~100-300 ms `[~]`; receivers reject stale-epoch or under-difficulty proofs. Runs in `kdf.worker.ts` off the main thread. This only raises the cost of trivial flooding from a single tab.
- **The real Sybil defense is trust-graph, not PoW:** Workshop vouches count **only from your manually-trusted peers** (section 7); admission gates verify *signatures*, not work. We explicitly tell the user that public-room rosters can be Sybil-flooded and should not be treated as authenticated identity.

---

## 6. Messenger: Chat, File, VoIP, Screen-share

- **Transport:** one E2EE WebRTC mesh. **PeerJS 1.5.x** acceptable for 1:1/small-group connection lifecycle, **but raw `RTCDataChannel` is mandatory for file transfer** (PeerJS reassembles in RAM, so large files OOM). `simple-peer` **rejected** (unmaintained).
- **Chat + control:** one DataChannel; **file transfer:** a second DataChannel, **16 KiB chunks**, `bufferedAmountLowThreshold` backpressure, write incoming chunks **incrementally to OPFS** (fallback Dexie/IDB). Per-chunk + whole-file SHA-256 integrity. Offline messages: best-effort outbound queue in encrypted IDB, replay on reconnect. There is **no store-and-forward guarantee** (no server to hold them).
- **VoIP / screen-share:** `getUserMedia` / `getDisplayMedia` (HTTPS satisfied; **`getDisplayMedia` unavailable on iOS Safari**, so degrade gracefully). Lazy-acquire tracks; `track.stop()` on call end.
- **Studio (VDO.ninja-style, no backend):** a control-panel tool over the same media mesh. The console remains the single owner of streams (`src/shell/studio.ts` is the seam; the tool issues commands, never touches tracks); publishing selects devices/resolution and tags each stream with `{kind,label}` via Trystero per-stream **metadata**, so recipients render a labelled multi-source **stage** (grid / spotlight / solo, with per-source spotlight/mute/hide/fullscreen/record). A chromeless **`#/stage/<code>`** route renders only the stage for use as an **OBS Browser source** or a second screen; it is **view-only**: it authenticates like any peer but publishes nothing, and it joins **only** that code room (no personal/nearby). Local media still honours section 5.4: trusted tiers only, never nearby. Not built (deferred): virtual-camera output, per-source bitrate/codec control, and directed one-way push/pull tokens (our peers all authenticate; "view-only" is a role, not a token).
- **E2EE + forward secrecy:** WebRTC DTLS is transport-only and a relay sees metadata, so we add **app-layer AES-256-GCM** keyed by ephemeral-X25519 ECDH into HKDF per connection. Because the app **does** talk to public-room strangers over untrusted relays, the "trusted-group, no FS needed" rationale was wrong. **v1 ships per-session forward secrecy via a symmetric HKDF ratchet:** the ECDH session key seeds a sending/receiving chain; each message advances the chain (`k_{n+1}=HKDF(k_n)`), old keys are zeroised. This gives **forward secrecy across the session** (a key captured later cannot decrypt earlier messages) at trivial cost. **Full Double-Ratchet (post-compromise security / out-of-order DH steps) remains a P4 upgrade** (section 12). But the "no FS at all" gap is closed now, not deferred. Media-layer E2EE (Insertable Streams) is **Chromium-only**, so advertise only the DTLS baseline for media on FF/Safari; do not over-claim.
- **Group-size limits:** hard-cap **6 video** (CPU/bandwidth cliff) `[~]`, ~**12 data-only** `[~]`. **No SFU** (no free SFU fits; an SFU terminates DTLS, leaving plaintext unless SFrame). Warn past the cap.
- **IP-leak hygiene:** mDNS hides LAN candidates on Chromium (not uniformly FF/Safari); a **relay-only privacy toggle** (`iceTransportPolicy:'relay'`) is the only complete public-IP mitigation.

---

## 7. Workshop: Distributed Tool/Snippet Sharing

**FEASIBILITY: confirmed-with-caveats.** Integrity + author-trust + sandboxing are real client-side; "catalog with literally no server" is bounded to "no server *you* operate," availability degrading to online-peer overlap.

### Architecture
**Custom gossip over the existing WebRTC mesh** (a labelled `workshop-gossip` DataChannel). **Reject IPFS/Helia (bundle weight), libp2p GossipSub (bundle, not browser-production-ready), GunDB (relay dependency).** Optionally use Nostr relays as **opportunistic-only** discovery aid, *not* a source of truth (free relays increasingly gate writes / reject custom kinds). Source of truth = peer-gossip + local IDB pin of installed tools.

- **Content addressing:** `id = SHA-256(canonicalJSON(name+version+type+permissions+contentHash))`. A peer serving a manifest whose id is not the content hash is session-blacklisted.
- **Gossip mechanics:** exchange catalog digests on connect; request missing/newer; **seen-set** (ids last 60 s) + **fanout 3-5** to prevent amplification. Version resolution: higher version, then higher `createdAt`, then lexicographically-greater sig (deterministic). **Re-verify signature + hash before relaying.**
- **Bodies:** P2P over DataChannel, **16 KiB chunked**.

### Body-size cap vs. real tools
A flat 512 KiB cap cannot hold useful JS *and* is irrelevant to the multi-MB WASM tools. Reframed:
- **`type:"automation"` (declarative):** hard cap **64 KiB**; these are small rule trees by nature.
- **`type:"script"` (JS source):** cap **512 KiB** of *source*; this is plenty for hand-written tools.
- **WASM/large assets are NOT shipped in the manifest body.** A script tool that needs a big WASM dependency must declare it as a `permissions:{net:[...]}` fetch of a **content-hashed, pinned** asset that the host fetches, verifies against the manifest's declared digest, and injects. It is *not* gossiped as a 512 KiB blob. This keeps gossip light and makes large assets cacheable/CDN-able under the user's consent.
- **Availability / single-point-of-loss:** there is **no guaranteed persistence**. A pinned tool survives only while *some* online peer holds it; "swarm re-seeding" is best-effort, not a guarantee. Mitigations we actually ship: (1) every installer **pins locally** (so *you* never lose an installed tool); (2) **export/import a signed tool as a file** (out-of-band durability); (3) optional opportunistic Nostr mirror. We state in section 13 that durable hosting needs a relay/KV you accept as a dependency; browsers have no DHT.

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
A `type:"script"` manifest is identical except `"body"` is a JS source **string** and the consent UI shows the full source + SHA-256.

### Trust & consent
- **Author signing:** verify Ed25519 signature **before any display**, not just before run. Updates **must** be signed by the same key; downgrades rejected unless user overrides.
- **Trust tiers / badges:** **Unsigned (red)**, **Self-signed, unverified (yellow)**, **Peer-vouched (green)** where vouches count **only from your manually-trusted peers** (the real Sybil defense, section 5.5). TOFU on first sight of an author key; loud full-screen warning on key change.
- **Install/consent UX:** **two distinct gestures**: *Install* (stores signed manifest) then *Run* (per-invocation consent showing full source/rules, SHA-256, declared capabilities). **No "remember/auto-approve."** Re-verify hash + signature on every run.
- **Declarative `type:"automation"` is the primary format.** Most use cases (clipboard cleanup, JSON format, text utils) need no Turing-complete code and avoid the JS sandbox. **But the interpreter is itself an attack surface; see section 7.1.**

### 7.1 The declarative interpreter is a real attack surface
Routing automations to a "trusted interpreter on the main thread with a lower consent barrier" is only safe if the interpreter is **safe-by-construction**. Threat analysis + controls:
- **ReDoS:** any `regex.replace` op is the classic main-thread DoS. Controls: **(a)** run all user-supplied regex in **`re-engine.worker.ts`** with a **hard wall-clock timeout** (terminate worker on overrun); **(b)** compile with a **linear-time engine** where feasible (RE2-WASM) rather than the native backtracking engine; **(c)** reject patterns exceeding a length/complexity budget at install time.
- **Resource exhaustion:** cap input size (reuse the 10 KB clipboard cap / explicit larger opt-in), cap rule-tree depth and node count, cap total ops per run, single pass (no unbounded loops in the AST: it has **no loop/recursion node**, only bounded `map`/`forEach` over already-materialised arrays).
- **No host escape:** the interpreter has a **fixed op-code whitelist** (`json.*`, `text.*`, `regex.*`, `format.*`). There is **no `eval`, no function constructor, no property access into host objects, no dynamic op dispatch by string into JS**. It reads/writes only the explicitly-passed input and the declared clipboard/storage capability. A "lower consent barrier" is justified *because* the op-set is provably non-Turing-complete and side-effect-bounded, and we say exactly that to the user, rather than waving "it's declarative so it's safe."

---

## 8. Sandboxing & Safe Execution

**FEASIBILITY: confirmed-with-caveats. It is "isolated + consent-gated," never "safe."** Browser sandbox escapes are exploited in the wild: **CVE-2025-2783 (Mojo, in-the-wild, fixed 134.0.6998.177) and CVE-2025-4609 (ipcz handle leak, $250k bounty, fixed 136.0.7103.113)** `[v]`. The iframe is one defence-in-depth layer; **the postMessage capability API (section 8.2) is the true boundary.**

### 8.1 Layered model keyed to trust tier
| Trust tier | Layers |
|---|---|
| **Untrusted** (unknown peer, JS) | null-origin iframe `sandbox="allow-scripts"` (no `allow-same-origin`), then **QuickJS-WASM** interpreter inside, then in-doc meta-CSP `default-src 'none'; connect-src 'none'`, then `setInterruptHandler` deadline + `setMemoryLimit` |
| **Community-vetted** (manually-trusted peer) | null-origin iframe + **SES Compartment** (intrinsics frozen) + `connect-src 'none'` |
| **Self-authored** | null-origin iframe + **Web Worker** (no DOM) |
| **Declarative automation** | safe-by-construction interpreter, ReDoS-guarded worker (section 7.1); no JS sandbox needed |

### 8.2 The postMessage capability API is the boundary, fully enumerated
The single most security-critical artifact. The guest realm has **no ambient authority**; everything goes through this message schema. The host validates `event.origin === 'null'`, validates against a zod schema, rate-limits per method, and never reflects host objects.

```ts
// core/capabilities.ts: the ONLY surface a sandboxed tool can reach.
// Guest to Host request:
type Req =
  | { id: number; m: 'ui.render';      dom: SanitizedVDom }          // host DOMPurifies + paints into the tool's container
  | { id: number; m: 'ui.on';          event: 'click'|'input'|'submit'; ref: string }
  | { id: number; m: 'clipboard.read' }                              // gated by 'clipboard-read' perm + per-run consent
  | { id: number; m: 'clipboard.write'; text: string }               // gated by 'clipboard-write'
  | { id: number; m: 'storage.get';    key: string }                 // namespaced to tool id; gated by 'storage'
  | { id: number; m: 'storage.set';    key: string; value: Json }    // quota-capped (e.g. 1 MiB/tool)
  | { id: number; m: 'net.fetch';      url: string; init?: SafeInit } // ONLY if {net:[origin]} declared+consented; host fetches, strips cookies/credentials, enforces origin allow-list, size cap, no redirects off-list
  | { id: number; m: 'notify';         text: string };               // gated by 'notifications', rate-limited
// Host to Guest response:
type Res = { id: number; ok: true; value: Json } | { id: number; ok: false; error: string };
// Host to Guest events (only for refs the guest registered): { evt: 'ui'; ref: string; payload: Json }
```
**Hard properties of the boundary:**
- **No raw `fetch`, no `Date.now`/`performance.now`, no `crypto`, no `postMessage` passthrough, no `eval`** is ever injected into the guest. Time is withheld (timing side-channels; COOP/COEP coarsens but does not eliminate Spectre). `net.fetch` is a **host-mediated** capability: the host performs the fetch with credentials stripped, enforces the declared origin allow-list, caps response size, and forbids off-list redirects. The guest never holds a network handle.
- **Every method is permission-gated** by the manifest's declared `Permission[]` *and* per-run consent; a method the manifest didn't declare is rejected before reaching the handler.
- **Validation-first:** unknown `m`, malformed args, or oversize payloads are dropped; the handler is the rate-limiter.
- This schema is **versioned and frozen per release**; adding a method is a reviewed security change.

### 8.3 Hard rules (footguns are not safety properties)
- **Never** combine `allow-scripts` + `allow-same-origin` (frame can strip its own sandbox).
- The iframe alone does **not** block network. Set `connect-src 'none'` via a `<meta>` CSP inside `sandbox.html`/`srcdoc`. (And the guest has no `fetch` anyway, section 8.2.)
- **Never inject any credential-bearing capability** into guests.
- `postMessage` handler: strict `event.origin === 'null'` check; validate every message.
- **Never autorun.** Two gestures. **30 s execution kill-timeout**, unconditional iframe teardown, new iframe per run.
- ShadowRealm (TC39) is **not shippable** mid-2026; design so it can slot in as a future tier.
- Surface a **stale/embedded-Chromium banner** (in-the-wild escapes hit unpatched/embedded builds, per section 8 CVEs). Ship a Trusted Types polyfill for Firefox.

---

## 9. Security Model

### Threat model
| Adversary | Capability | Primary control |
|---|---|---|
| Signaling relay / TURN operator | sees SDP, peer IPs, traffic metadata; can MITM signaling | custom-password SDP encryption (section 5.1) + app-layer X25519+AES-GCM + **per-session HKDF ratchet** (FS); opaque room ids; relay-only toggle |
| Network MITM at first key exchange | substitute keys (TOFU window) | out-of-band safety-number / QR verification (offered, not forced; see section 10) |
| Malicious Workshop author | ship signed-but-harmful code | null-origin iframe + QuickJS + **enumerated postMessage API (section 8.2)** + mandatory source review; declarative interpreter safe-by-construction (section 7.1) |
| Sybil / gossip poisoner | flood/fake-vouch | challenge-response (signature) admission, trusted-peers-only vouching, re-verify-before-relay; **PoW only as anti-flood speed-bump, not a Sybil cure (section 5.5)** |
| XSS into host origin | read IDB, **use in-realm keys**, exfiltrate | strict CSP (no eval/inline) + Trusted Types + DOMPurify as the *primary* control; encrypted-IDB is secondary (see key-lifecycle caveat below) |
| Offline disk-image attacker | copy browser profile | non-extractable CryptoKeys + passphrase-lock mode (PBKDF2>=600k into AES-GCM) |
| Supply chain | tampered dep / model | exact-pinned deps + lockfile, bundle-not-CDN, SRI where applicable, model-weight hash verify |

### Identity / key + E2EE design
- **All crypto = native WebCrypto:** Ed25519 (sign) + X25519 (ECDH) + AES-256-GCM; HKDF-SHA-256 derivation + ratchet; PBKDF2 (>=600k, off-thread) for passphrase wrapping.
- **Browser support is recent. Feature-detect and hard-fail, do not downgrade.** Native WebCrypto **Ed25519/X25519** landed across engines only recently: **Firefox 129 (Aug 2024), Safari 17, Chrome 137 (May 2025)** `[v]`. Igalia/W3C note it will take into ~2027 for these versions to saturate the install base `[v]`. **Implication:** on a browser without native Ed25519/X25519 we **hard-fail with a clear "browser too old / update to use P2P + Workshop" message** rather than silently shipping a JS crypto polyfill (polyfilled curve crypto in-page is a weaker, larger attack surface). Single-user tools (clipboard/OCR/STT/TTS) still work without the curves; only the crypto-dependent features gate.
- **Keys non-extractable**, stored as `CryptoKey` in IndexedDB (OS-keychain-backed on desktop; weaker on mobile WebView, which is documented).
- **Message/file E2EE:** per-connection ephemeral X25519 into HKDF into AES-256-GCM, **plus the per-session HKDF ratchet for forward secrecy (section 6).** 64 KiB file chunks, fresh nonce + index each. Double-Ratchet (post-compromise security) is the P4 upgrade (section 12).
- **Peer auth:** TOFU + safety numbers (`SHA-256(min(pkA,pkB)||max)`, shown as 20 hex digits in 5x4 groups) with QR exchange; loud warning on key change.

### Key lifecycle for encrypted-at-rest IDB
**Encrypting IDB does not defend against an in-page XSS attacker** who can *use* the non-extractable key in place. What each mode buys:
- **MVP "at-rest" mode (no passphrase):** the AES-GCM wrapping key is a **non-extractable `CryptoKey` generated once and stored in IDB**. It protects against **offline profile copy / another origin / a casual IDB dump**, but NOT against same-origin XSS (XSS can call the key). **Therefore the primary XSS control is CSP + Trusted Types + DOMPurify, not encryption**; the threat-model table now reflects this ordering. We do not claim encrypted-IDB stops XSS.
- **P4 "passphrase-lock" mode:** the wrapping key is **derived on unlock via PBKDF2>=600k from a user passphrase and held only in memory**, zeroised on lock/idle-timeout. This is the mode that actually raises the bar against both offline attackers and a *later* XSS (locked vault = no key in memory). It is opt-in because it trades convenience (re-unlock) for that protection.

### Prioritized controls checklist
| # | Control | Phase gate |
|---|---|---|
| P0 | Native WebCrypto only; non-extractable keys in IDB; **hard-fail on missing Ed25519/X25519** (no JS-crypto fallback) | MVP |
| P0 | Strict CSP (`default-src 'none'`, no `unsafe-eval`/`unsafe-inline`); `require-trusted-types-for 'script'` | MVP |
| P0 | COOP `same-origin` + COEP via `vercel.json`; SW re-injects on cached navs; **singlethread ffmpeg so STT/OCR survive COEP relaxation** | MVP |
| P0 | Encrypted-at-rest IDB facade **(documented as NOT an XSS control)**; exact-pinned deps + lockfile; bundle-not-CDN; `npm audit` in CI | MVP |
| P1 | Custom-password SDP encryption; app-layer AES-GCM **+ per-session HKDF ratchet (FS)** on every channel; opaque room ids; relay-only toggle | P2P |
| P1 | Challenge-response (signature) admission; trusted-peers vouching; PoW anti-flood speed-bump (not a Sybil cure) | P2P |
| P1 | TOFU + safety-number verification **offered** (progressive, not a forced ceremony, per section 10) | P2P |
| P2 | Null-origin iframe + QuickJS + `connect-src 'none'`; **enumerated, validated, rate-limited postMessage capability API (section 8.2)** | Workshop |
| P2 | Declarative interpreter safe-by-construction: op-whitelist, no-eval, ReDoS worker + RE2-WASM, depth/op caps | Workshop |
| P2 | Ed25519 author signing; verify-before-display; same-key updates; no auto-approve; two-gesture consent + per-run re-verify + 30 s kill-timeout | Workshop |
| P3 | Stale-Chromium banner; Trusted Types polyfill for Firefox; **passphrase-lock mode (the real at-rest/XSS-after-lock control)** | Hardening |

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
- **`DOMParser.parseFromString` is a TrustedHTML sink, not an escape from one.** It sits in
  the same sink list as `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and
  `Range.createContextualFragment`. HTML stripping used it with a plain string on the
  assumption that "not innerHTML" meant "not a sink", so `stripHtml()` threw
  "This document requires 'TrustedHTML' assignment" and the tool silently did nothing in
  production. It is now fed by a dedicated **named** policy (`html-strip`) created in
  `src/tools/html-strip.ts`. A named policy is reachable only through the policy object its
  own module holds, so the rest of the app gains no HTML sink; adding `createHTML` to the
  *default* policy would have reopened `innerHTML` for the whole bundle to fix one tool.
  Pass-through is acceptable there because the parsed document is inert (no browsing
  context, so scripts never run), is never attached to the live DOM, and only `textContent`
  is read out of it. Any new use of an HTML sink needs the same treatment: its own named
  policy plus a written argument for why the output cannot execute.
- **Never autorun shared or executable tools.** Install and run are separate explicit
  gestures, and verification (hash plus signature) gates both display and execution.
- **Sandbox boundary.** Guest scripts run in a null-origin `blob:` iframe with
  `allow-scripts` and never `allow-same-origin`, behind an enumerated postMessage
  capability API. The iframe is defence in depth; the API is the boundary.
- **Local media routing is an allow-list, never a deny-list.** `MEDIA_TIERS` names the
  tiers that may receive camera, microphone and screen. As a deny-list, every tier added
  later was silently opted in.
- **Never join a room because a peer asked you to.** Inbound peer text renders a Join
  button and waits for the click. Auto-joining on a code found in a received message let
  any peer pull your live media into a room they control.
- **The nearby and presence tiers are untrusted.** No clipboard auto-share and no local
  media, ever. The presence tier additionally carries no chat, files or gossip in either
  direction, enforced in the session layer and not only in the console.
- **Crypto.** Native WebCrypto only, never a JS-crypto polyfill, keys non-extractable.
  Encrypted-at-rest is not an XSS control; CSP and Trusted Types are.
- **Dependencies** are exact-pinned with a committed lockfile. Self-host assets where that
  keeps `script-src 'self'`, and add a `connect-src` origin only for a genuinely consented
  download, with a note saying why.

## 10. Free Deployment on Vercel

Static deploy, generous free bandwidth (P2P data flows browser-to-browser, not through Vercel). `vercel.json`:

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
      { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" },
      { "key": "Content-Security-Policy", "value":
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://relay.damus.io wss://nos.lol wss://relay.nostr.band wss://tracker.openwebtorrent.com; frame-src 'self' blob:; require-trusted-types-for 'script'; base-uri 'none'" }
    ]
  }],
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

- **`wasm-unsafe-eval`** required for Whisper/Tesseract/Kokoro/QuickJS WASM. No nonces: a static site takes Vite-generated hashes, and a clean build has zero inline scripts.
- **`connect-src` is a CURATED relay allow-list, and it is NOT the WebRTC boundary.** It lists the relay WebSockets (Nostr/BT). **STUN/TURN are deliberately absent because ICE traffic is out of CSP scope (section 2)**. Listing them would be cargo-cult. **Conflict with "user-supplied relays" (resolved):** a static `connect-src` cannot admit arbitrary user `wss://` origins, so the shipped app uses the curated list only; "bring-your-own-relay" is available **(a)** via WebRTC-strategy relays not bound by `connect-src`, or **(b)** in a documented self-host fork where the user edits this header. We do **not** advertise arbitrary user relays on the hosted build. BitTorrent tracker fallback similarly needs its tracker origins in this list, so keep the tracker set curated and small.
- **COEP choice = `credentialless`** (not `require-corp`) as the default, precisely because `require-corp` breaks any cross-origin resource lacking CORP (URL-preview embeds, third-party media). `credentialless` still grants `crossOriginIsolated` (SharedArrayBuffer, multithread ffmpeg fast-path) while letting no-CORP subresources load credential-free. **And because OCR/STT use the singlethread cores (sections 4.2 and 4.3), the core tools work even if a future tool forces COEP off entirely.** Disable the Vercel toolbar in prod (known COEP conflict).
- **Service worker must re-inject COOP/COEP** on cached navigation responses (Workbox doesn't) or `crossOriginIsolated` breaks on reload.

**Backends & external dependencies, explicitly flagged:**
- **No backend you operate is required for the core product.** But "client-only/free" is **not** the same as "no third parties": the app depends on **(1) third-party Nostr relays + BitTorrent trackers** (signaling: free, unreliable, no SLA, may gate writes), **(2) Metered OpenRelay TURN** (third-party free tier, shared public credential, finite pool you cannot meter, per section 5.2). Optional **(3) self-hosted coturn on Oracle Always Free** is *a server you operate* (one box) if you want reliability. None of these are *your* application backend, but each dents a naive "fully serverless, depends on nothing" reading, so we state them.
- **One optional Vercel concession:** a **stateless TURN-credential vending Edge Function** holding a free-tier Metered/Cloudflare API key server-side, returning short-lived rotating TURN creds (sub-second, no state, within Hobby timeout). Justification: keeps the secret out of client code and isolates your bandwidth from the shared public-credential pool. **Recommendation: ship without it early (OpenRelay static creds, accept best-effort); add it only if relay reliability becomes a real problem.** Self-hosted coturn is the alternative that keeps everything off Vercel.

**Minimalist UI vs security ceremony. Primitives in `shell/ui.ts`:**
The security-first posture risks UX overload. We reconcile by making ceremony **progressive, not upfront**:
```
+- Tool consent dialog, only on Run ---------------------------------+
|  ⚠ JSON Key Sorter  v1.2.0     badge: [self-signed, unverified]    |
|  by alice (ed25519:9a4c...)      SHA-256: 7d8e...   [copy]         |
|  Capabilities requested:  [ ] read clipboard  [ ] write clipboard  |
|  Source  [ Expand full source ]                                    |
|            [ Cancel ]                        [ Run once ]          |
+--------------------------------------------------------------------+
Roster row:  alice (verified)  |  bob (unverified)  [ Verify ]
```
- **Safety-number verification is OFFERED, not forced.** First contact works immediately (TOFU); an unobtrusive "unverified" chip invites a one-time QR/number check when the user cares. This avoids a mandatory QR ceremony on every onboarding (the minimalist priority) while keeping the control available for the threat that needs it.
- **Per-run consent is the deliberate, single point of friction** for executable tools (no remember/auto-approve). Everything else (size disclosure, badge) is inline, not a separate dialog.

---

## 11. Phased Build Roadmap

**Phase 0: Foundation.** Vite 8 + TS skeleton, tokens.css, hash-router, registry contract, **crypto core + encrypted-store facade + key-lifecycle modes**, PWA shell, `vercel.json` headers, `shell/ui.ts` primitives.
- *Security gate:* CSP/COOP/COEP live and verified (`crossOriginIsolated===true`; cached-nav headers correct); non-extractable keypair round-trips through IDB; **hard-fail path verified on a browser lacking Ed25519**; zero inline scripts; lockfile committed.

**Phase 1: MVP (single-user tools).** Clipboard hybrid one-tap + router + sub-tools (OCR/Tesseract v7, NLP/compromise, JSON, URL, HTML/DOMPurify); transcription (files first via **singlethread ffmpeg**, then VAD live); TTS (SpeechSynthesis + Kokoro opt-in). All lazy-loaded + Cache/OPFS-cached.
- *Security gate:* no clipboard data ever leaves device; no auto-URL-fetch; `localService:true` enforced; **model-weight SHA-256 verified against pinned digest before load**; OOM/`deviceMemory` gating verified on a low-RAM device; **STT/OCR confirmed working with COEP both on and off**.

**Phase 2: P2P Messenger.** Trystero discovery + signed-heartbeat roster (with custom-password SDP encryption); E2EE DataChannel wrapper **with per-session HKDF ratchet**; chat; raw-DataChannel file transfer into OPFS; VoIP + screen-share with caps; relay-only toggle; local `getStats()` relay-bandwidth estimate.
- *Security gate:* app-layer AES-GCM **+ ratchet** on every channel (ciphertext + key-advance verified on the wire; old key zeroised); challenge-response signature admission; PoW anti-flood verified to not block honest peers; safety-number verification flow works (offered, not forced); room caps enforced; **default-relay SDP shown encrypted to a simulated relay observer**.

**Phase 3: Workshop / sandboxed scripts.** Gossip catalog + IDB pinning + signed file export/import; manifest schema + zod + Ed25519 sign/verify; trust tiers/badges; **declarative automations first** (safe-by-construction interpreter + ReDoS worker), then the QuickJS iframe runner for `type:"script"`; two-gesture consent.
- *Security gate:* `allow-same-origin` provably absent; in-doc `connect-src 'none'`; **postMessage capability API audited as if the iframe is fully escaped** (every method permission-gated, validated, rate-limited, under red-team review); interpreter op-whitelist has no eval/host-access path; ReDoS worker terminates on a known catastrophic pattern; verify-before-display + per-run re-verify; 30 s kill-timeout; no auto-approve path exists.

**Phase 4: Hardening.** Passphrase-lock mode (the real at-rest/post-XSS control); stale-Chromium banner; Trusted Types polyfill; optional TURN-vending Edge Function / self-hosted coturn; **Double-Ratchet upgrade** if threat model escalates.

---

## 12. Open Decisions for the User

| # | Decision | Options | Recommendation | Trade-off |
|---|---|---|---|---|
| 1 | **Signaling/discovery backend** | (a) Trystero on free public Nostr/BitTorrent infra; (b) self-host `@trystero-p2p/ws-relay` on Oracle/Fly free tier; (c) keep PeerJS cloud | **(a)** for v1, **curated relay allow-list** (not arbitrary user relays, section 10) | (a) zero ops, no SLA / write-gating risk; (b) reliable but a box you run; (c) ~50-conn cap, "not production." |
| 2 | **TURN strategy** | (a) OpenRelay public static; (b) Vercel cred-vending Edge Fn + Metered key; (c) self-host coturn (Oracle Always Free) | **(a) now, (c) if reliability matters, (b) to stay all-Vercel** | (a) shared-pool exhaustion you can't meter; (b) one tiny backend touchpoint; (c) $0 + own box, best reliability. |
| 3 | **Identity model** | (a) single keypair + room-scoping + challenge-response; (b) dual public/private peer | **(a)** | (b) adds state + linkability risk for no gain once signature admission exists. |
| 4 | **Executable-script sharing** | (a) declarative automations only; (b) declarative + QuickJS-sandboxed JS; (c) full JS | **(b)**: declarative primary, sandboxed JS as an opt-in tier behind section 8.2 | (a) safest, limited; (b) covers most needs with bounded risk + honest "isolated, not safe" framing; (c) unacceptable. |
| 5 | **Stack confirmation** | Vite 8 + TS + vanilla DOM + nanostores + hash-router | **Confirm as specified** | Preact (~3 kB) is the only sanctioned escape hatch if a tool needs components. |
| 6 | **Forward secrecy depth** | (a) per-session HKDF ratchet (v1, **already in scope** section 6); (b) full Double-Ratchet now | **(a) now, (b) at P4** | v1 already gives session FS (gap closed); (b) adds post-compromise security at X3DH/prekey/state cost. Defer unless contacting high-risk strangers is a core use case. |
| 7 | **COEP mode** | (a) `credentialless`; (b) `require-corp`; (c) no COEP | **(a)** | (a) keeps `crossOriginIsolated` + loads no-CORP embeds credential-free; (b) breaks third-party embeds; (c) loses SharedArrayBuffer fast-paths (singlethread cores still work, section 4). |

---

## 13. Hard Constraints & Reality Checks

- **Clipboard auto-read on load works on Chromium** after a one-time `clipboard-read` grant (tab focus satisfies the focus requirement). This was verified in the user's prior project; returning users get "open and it reads." First visit needs one gesture to surface the grant prompt; **Firefox/Safari have no persistent grant**, so they fall back to the paste-listener + scan-button. Continuous "watch clipboard" stays default-off.
- **No-backend signaling is real (from your side); no-backend *reliable* connectivity is not, and even signaling leans on third parties.** STUN covers ~70-90% residential `[~]`; the ~10-30% symmetric-NAT/CGNAT tail `[~]` needs TURN. Free TURN is best-effort/shared-pool and **you cannot read the remaining pool quota**, only a local `getStats()` estimate. Nostr/BT relays are third-party, unreliable, may gate writes.
- **In-browser Whisper:** files/video solid; **live-mic real-time = best-effort, device/browser-dependent**, degrades to VAD-chunked near-real-time. Accuracy capped at base/small, below cloud large-v3. Don't trust WebGPU to be faster; benchmark at runtime. Download is tens of MB, never auto-fetched, hash-verified.
- **"Catalog with literally no server" is false**: it's "no server *you* operate," persistence degrading to online-peer overlap; **no durable hosting without accepting a relay/KV dependency** (browsers have no DHT). Installed tools survive locally + via signed file export; swarm re-seeding is best-effort, not a guarantee.
- **Safe script execution is "isolated + consent-gated," never "safe."** Sandbox escapes are exploited in the wild on unpatched/embedded Chromium (**CVE-2025-2783, CVE-2025-4609** `[v]`); the **enumerated postMessage capability API (section 8.2), not the iframe, is the real boundary**; consent fatigue and social engineering are irreducible by technical means. Declarative tools are safer *only because* the interpreter is provably non-Turing-complete and side-effect-bounded (section 7.1). Market accordingly.
- **`connect-src 'none'` does NOT block WebRTC inside the guest.** An adversarial red-team confirmed a guest script could exfiltrate via `RTCPeerConnection` ICE/STUN/TURN (or DNS) despite the inner CSP, because CSP `connect-src` never governs ICE (same root fact as sections 2 and 10, but applied to the *guest*). **Fixed:** the guest bootstrap poisons `RTCPeerConnection`/`webkitRTCPeerConnection`/`mozRTCPeerConnection`/`RTCDataChannel` (browser-enforced, CSP-independent) before any untrusted source runs (`sandbox.ts`). Per-tool IndexedDB is also quota-capped (1 MiB) so a `storage`-granted tool can't exhaust origin storage.
- **COEP interaction is real.** `require-corp` breaks cross-origin embeds, so default to **`credentialless`**. ffmpeg.wasm multithread needs cross-origin isolation; **we ship its singlethread core** so STT/OCR survive COEP relaxation `[v]`. Trusted Types is Chromium-only (polyfill Firefox). Workbox won't forward COOP/COEP on cached navigations (custom SW handler required).
- **Native WebCrypto Ed25519/X25519 is recent**: FF 129 / Safari 17 / Chrome 137 `[v]`; saturates ~2027 `[v]`. We **hard-fail crypto-dependent features on older browsers** rather than ship a weaker JS-crypto polyfill. Single-user tools still work.
- **Encrypted-at-rest IDB is not an XSS control.** A same-origin attacker can use the non-extractable key in place. CSP + Trusted Types + DOMPurify are the primary XSS controls; passphrase-lock mode (P4) is the only mode that protects against a *later* compromise.
- **Mesh ceiling ~20-30 peers `[~]`; video ~6 `[~]`.** No free SFU. Scope groups small.

---

### Source notes
`[v]` verified June 2026 against primary sources:
- Vite 8 stable (Rolldown) released Mar 2026. vite.dev/blog/announcing-vite8.
- Trystero v0.25.2 (11 Jun 2026), scoped `@trystero-p2p/*` incl. `ws-relay`, default SDP key derived from app+room ID (reverse-engineerable by relay; custom password recommended). github.com/dmotz/trystero.
- WebCrypto Ed25519/X25519: Firefox 129 (Aug 2024), Safari 17, Chrome 137 (May 2025); ~2027 saturation. Igalia/blogs.igalia.com, chromestatus 4913922408710144.
- Tesseract.js v7 relaxed-SIMD, 15-35% faster than v6. github.com/naptha/tesseract.js/releases.
- kokoro-js (Kokoro-82M-v1.0-ONNX, Apache-2.0), WASM default + WebGPU device option, ~80 MB fp32. npmjs.com/package/kokoro-js, huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX.
- ffmpeg.wasm multithread requires SharedArrayBuffer/COOP+COEP; singlethread does not. github.com/ffmpegwasm/ffmpeg.wasm issues #234/#353.
- CVE-2025-2783 (Chrome Mojo sandbox escape, in-the-wild, fixed 134.0.6998.177) and CVE-2025-4609 (ipcz handle leak, fixed 136.0.7103.113). nvd.nist.gov, ox.security.

`[~]` unverified order-of-magnitude estimate. Treat as planning figures, measure for real before quoting to users:
- STUN ~70-90% / TURN ~10-30% (industry ranges, vary by population; cellular/enterprise skews higher TURN).
- Mesh ceiling ~20-30 peers, video ~6 (Chromium PeerConnection practical limits).
- Relay budget hours, model/library byte sizes, nanostores/Open Props sizes, PoW ~100-300 ms: all depend on build flags, quantization, and hardware; surface build-measured values in the UI rather than these placeholders.
