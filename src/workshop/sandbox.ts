// Host-side sandbox runner (ARCHITECTURE section 8). Untrusted script source executes in a
// null-origin iframe (public/sandbox/script.html plus sandbox="allow-scripts", with no
// allow-same-origin) whose own CSP is `default-src 'none'; connect-src 'none'`, so the guest
// has no DOM loads and no network to exfiltrate over. The guest is a real same-origin URL
// with its own CSP header (vercel.json, vite.config.ts): a blob: or srcdoc document inherits
// the host policy, whose script-src and Trusted Types refuse the guest's inline bootstrap and
// its eval. The iframe is defence-in-depth and the boundary is the enumerated postMessage
// capability API below: the guest has zero ambient authority, every capability is
// host-mediated, permission-gated and validated, and the iframe is destroyed on a 30 s
// deadline. The caller must obtain consent first and NEVER autorun. Swapping the guest's
// eval for QuickJS-WASM is the planned upgrade, for preemptive interruption and interpreter
// isolation.

export interface SandboxPermissions {
  clipboardRead: boolean
  clipboardWrite: boolean
  storage: boolean
  net: string[] // allowed origins (must also be in the app CSP connect-src to fetch)
  p2pRoom: boolean // room-channel relay for html apps, with game-channel semantics (see runHtmlApp)
}

export interface SandboxCallbacks {
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  storageGet(key: string): Promise<unknown>
  storageSet(key: string, value: unknown): Promise<void>
  netFetch(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }>
  log(msg: string): void
}

export interface SandboxResult {
  ok: boolean
  value?: unknown
  error?: string
}

// Static guest documents. The untrusted source is delivered via postMessage after 'ready'
// and never interpolated into their markup.
const GUEST_SCRIPT_URL = `${import.meta.env.BASE_URL}sandbox/script.html`
const GUEST_APP_URL = `${import.meta.env.BASE_URL}sandbox/app.html`

const NET_MAX_BYTES = 2_000_000

export function runInSandbox(source: string, perms: SandboxPermissions, cb: SandboxCallbacks, timeoutMs = 30000): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.className = 'hidden'
    iframe.setAttribute('sandbox', 'allow-scripts') // no allow-same-origin, so the origin is opaque
    iframe.src = GUEST_SCRIPT_URL

    let done = false
    let started = false
    const finish = (r: SandboxResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      iframe.remove()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timed out (30s): sandbox destroyed' }), timeoutMs)

    const post = (msg: unknown) => iframe.contentWindow?.postMessage(msg, '*')

    const handleCap = async (d: { id: number; method: string; args: unknown[] }) => {
      const reply = (ok: boolean, value?: unknown, error?: string) => post({ k: 'cap-result', id: d.id, ok, value, error })
      try {
        switch (d.method) {
          case 'clipboard.read':
            if (!perms.clipboardRead) throw new Error('clipboard-read not granted')
            return reply(true, await cb.clipboardRead())
          case 'clipboard.write':
            if (!perms.clipboardWrite) throw new Error('clipboard-write not granted')
            await cb.clipboardWrite(String(d.args[0] ?? ''))
            return reply(true, null)
          case 'storage.get':
            if (!perms.storage) throw new Error('storage not granted')
            return reply(true, await cb.storageGet(String(d.args[0])))
          case 'storage.set':
            if (!perms.storage) throw new Error('storage not granted')
            await cb.storageSet(String(d.args[0]), d.args[1])
            return reply(true, null)
          case 'net.fetch': {
            const u = String(d.args[0])
            const origin = new URL(u).origin
            if (!perms.net.includes(origin)) throw new Error(`net origin not allowed: ${origin}`)
            const init = (d.args[1] ?? {}) as { method?: string; body?: string; headers?: Record<string, string> }
            return reply(true, await cb.netFetch(u, init))
          }
          default:
            throw new Error(`unknown method: ${d.method}`)
        }
      } catch (e) {
        reply(false, undefined, (e as Error).message)
      }
    }

    const onMsg = (e: MessageEvent) => {
      // The guest is a sandboxed, opaque iframe, so its origin is the string "null".
      if (e.source !== iframe.contentWindow || e.origin !== 'null') return
      const d = (e.data ?? {}) as { k?: string; id?: number; method?: string; args?: unknown[]; msg?: unknown; value?: unknown; error?: unknown }
      if (d.k === 'ready') {
        if (started) return // a guest spamming 'ready' cannot make us re-exec
        started = true
        post({ k: 'exec', source })
      } else if (d.k === 'log') cb.log(String(d.msg).slice(0, 2000))
      else if (d.k === 'done') finish({ ok: true, value: d.value })
      else if (d.k === 'error') finish({ ok: false, error: String(d.error) })
      else if (d.k === 'cap' && typeof d.id === 'number' && typeof d.method === 'string') void handleCap({ id: d.id, method: d.method, args: d.args ?? [] })
    }

    window.addEventListener('message', onMsg)
    document.body.append(iframe)
  })
}

/** Host-mediated fetch for a sandboxed tool. Credential-free, size-capped, no off-list redirects. */
export async function hostFetch(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: init.headers,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  const buf = await res.arrayBuffer()
  return { status: res.status, body: new TextDecoder().decode(buf.slice(0, NET_MAX_BYTES)) }
}

// ---------------------------------------------------------------------------
// HTML apps (Workshop `type:'html'`) use the same boundary, made visible and durable.
// The app executes in the same null-origin iframe configuration as scripts
// (public/sandbox/app.html, `sandbox="allow-scripts"`, CSP with no network, WebRTC
// poisoned before any untrusted code) behind the same enumerated postMessage capability
// API, plus an opt-in `room` channel the host relays over the authenticated best-effort
// `game` channel (ARCHITECTURE section 5.4 semantics: state and scores,
// transport-encrypted, never secrets and never the ratchet). Differences from runInSandbox, kept minimal:
//   - the iframe is visible, mounted where the caller says, and has no deadline; teardown
//     is an explicit close() from a user gesture or tool deactivation.
//   - styles may exist inside the guest document, whose own CSP allows style-src
//     'unsafe-inline'; the host page CSP is untouched.
//   - the app HTML is still delivered via postMessage after 'ready' and never
//     interpolated into the static guest markup. The bootstrap mounts it with DOMParser
//     and re-creates <script> nodes so they execute in document order.
// The guest can render arbitrary UI, so the host chrome must keep the app name and trust
// badge visible outside the frame, since the frame can imitate anything inside.

export interface AppCallbacks extends SandboxCallbacks {
  /** Relay app data to authenticated room peers running the same content hash. */
  roomSend(data: unknown): void
  roomPeers(): Promise<Array<{ peerId: string; name: string }>>
}

export interface AppHandle {
  /** Push a room payload from a peer into the app. No-op after close(). */
  postRoom(from: string, data: unknown): void
  close(): void
}

const ROOM_MSG_MAX = 16_384 // JSON chars; a compact map chunk fits, a bulk transfer does not
const ROOM_MIN_INTERVAL_MS = 15 // about 66 msg/s ceiling per app

export function runHtmlApp(source: string, perms: SandboxPermissions, cb: AppCallbacks, mountEl: HTMLElement): AppHandle {
  const iframe = document.createElement('iframe')
  iframe.className = 'ws-app-frame'
  iframe.setAttribute('sandbox', 'allow-scripts') // no allow-same-origin, so the origin is opaque
  iframe.src = GUEST_APP_URL

  let closed = false
  let started = false
  let lastRoomSend = 0
  const post = (msg: unknown) => iframe.contentWindow?.postMessage(msg, '*')

  const handleCap = async (d: { id: number; method: string; args: unknown[] }) => {
    const reply = (ok: boolean, value?: unknown, error?: string) => post({ k: 'cap-result', id: d.id, ok, value, error })
    try {
      switch (d.method) {
        case 'clipboard.read':
          if (!perms.clipboardRead) throw new Error('clipboard-read not granted')
          return reply(true, await cb.clipboardRead())
        case 'clipboard.write':
          if (!perms.clipboardWrite) throw new Error('clipboard-write not granted')
          await cb.clipboardWrite(String(d.args[0] ?? ''))
          return reply(true, null)
        case 'storage.get':
          if (!perms.storage) throw new Error('storage not granted')
          return reply(true, await cb.storageGet(String(d.args[0])))
        case 'storage.set':
          if (!perms.storage) throw new Error('storage not granted')
          await cb.storageSet(String(d.args[0]), d.args[1])
          return reply(true, null)
        case 'net.fetch': {
          const u = String(d.args[0])
          const origin = new URL(u).origin
          if (!perms.net.includes(origin)) throw new Error(`net origin not allowed: ${origin}`)
          const init = (d.args[1] ?? {}) as { method?: string; body?: string; headers?: Record<string, string> }
          return reply(true, await cb.netFetch(u, init))
        }
        case 'room.send': {
          if (!perms.p2pRoom) throw new Error('p2p-room not granted')
          const now = performance.now()
          if (now - lastRoomSend < ROOM_MIN_INTERVAL_MS) return reply(true, false) // dropped by rate cap
          const size = JSON.stringify(d.args[0] ?? null).length
          if (size > ROOM_MSG_MAX) throw new Error(`room message too large (${size} > ${ROOM_MSG_MAX})`)
          lastRoomSend = now
          cb.roomSend(d.args[0] ?? null)
          return reply(true, true)
        }
        case 'room.peers':
          if (!perms.p2pRoom) throw new Error('p2p-room not granted')
          return reply(true, await cb.roomPeers())
        default:
          throw new Error(`unknown method: ${d.method}`)
      }
    } catch (e) {
      reply(false, undefined, (e as Error).message)
    }
  }

  const onMsg = (e: MessageEvent) => {
    // Same authentication as runInSandbox; an opaque-origin iframe reports origin === 'null'.
    if (e.source !== iframe.contentWindow || e.origin !== 'null') return
    const d = (e.data ?? {}) as { k?: string; id?: number; method?: string; args?: unknown[]; msg?: unknown }
    if (d.k === 'ready') {
      if (started) return
      started = true
      post({ k: 'exec', source })
    } else if (d.k === 'log') cb.log(String(d.msg).slice(0, 2000))
    else if (d.k === 'cap' && typeof d.id === 'number' && typeof d.method === 'string') void handleCap({ id: d.id, method: d.method, args: d.args ?? [] })
  }

  window.addEventListener('message', onMsg)
  mountEl.append(iframe)

  return {
    postRoom(from: string, data: unknown) {
      if (!closed) post({ k: 'room', from, data })
    },
    close() {
      if (closed) return
      closed = true
      window.removeEventListener('message', onMsg)
      iframe.remove()
    },
  }
}
