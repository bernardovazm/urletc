// Host-side sandbox runner (ARCHITECTURE section 8). Untrusted script source executes in a
// NULL-ORIGIN iframe (blob: + sandbox="allow-scripts", NO allow-same-origin) whose
// own inner CSP is `default-src 'none'; connect-src 'none'`, so the guest has no DOM
// loads and NO network (no exfiltration). The iframe is defence-in-depth; the real
// boundary is the enumerated postMessage capability API below: the guest has zero
// ambient authority, every capability is host-mediated + permission-gated + validated,
// and the iframe is destroyed on a 30 s deadline. Caller must obtain consent first
// (never autorun). Swapping the guest's eval for QuickJS-WASM is the planned upgrade
// for preemptive interruption + interpreter isolation.

export interface SandboxPermissions {
  clipboardRead: boolean
  clipboardWrite: boolean
  storage: boolean
  net: string[] // allowed origins (must ALSO be in the app CSP connect-src to actually fetch)
  p2pRoom: boolean // room-channel relay for html apps (game-channel semantics; see runHtmlApp)
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

// Static guest document. The untrusted source is delivered via postMessage AFTER
// 'ready', never interpolated into this markup.
const GUEST_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; style-src 'none'">
</head><body><script>
(function(){
  // CSP connect-src 'none' does NOT govern WebRTC, so a guest could exfiltrate via
  // ICE/STUN/TURN or DNS. Poison the WebRTC constructors before the untrusted source
  // (delivered later via the 'exec' message) ever runs. Browser-enforced, CSP-independent.
  try {
    ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','RTCDataChannel'].forEach(function(n){
      try { delete window[n]; } catch(e){}
      try { Object.defineProperty(window, n, { configurable:false, get:function(){ throw new Error('network is blocked in the sandbox'); } }); } catch(e){}
    });
  } catch(e){}
  var seq=0, pending={};
  function call(method, args){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; parent.postMessage({k:'cap', id:id, method:method, args:args}, '*'); }); }
  var host = {
    clipboard: { read:function(){return call('clipboard.read',[]);}, write:function(t){return call('clipboard.write',[String(t)]);} },
    storage: { get:function(key){return call('storage.get',[String(key)]);}, set:function(key,val){return call('storage.set',[String(key),val]);} },
    net: { fetch:function(url,init){return call('net.fetch',[String(url), init||{}]);} },
    log: function(m){ try{ parent.postMessage({k:'log', msg:String(m)}, '*'); }catch(e){} }
  };
  function safe(v){ try{ return JSON.parse(JSON.stringify(v===undefined?null:v)); }catch(e){ return String(v); } }
  window.addEventListener('message', function(e){
    var d=e.data||{};
    if(d.k==='exec'){
      (async function(){
        try{
          var fn = new Function('host','"use strict"; return (async function(){\\n'+d.source+'\\n})();');
          var value = await fn(host);
          parent.postMessage({k:'done', value: safe(value)}, '*');
        }catch(err){ parent.postMessage({k:'error', error: String(err && err.message || err)}, '*'); }
      })();
    } else if(d.k==='cap-result'){
      var p=pending[d.id]; if(p){ delete pending[d.id]; if(d.ok){ p.res(d.value); } else { p.rej(new Error(d.error)); } }
    }
  });
  parent.postMessage({k:'ready'}, '*');
})();
</script></body></html>`

const NET_MAX_BYTES = 2_000_000

export function runInSandbox(source: string, perms: SandboxPermissions, cb: SandboxCallbacks, timeoutMs = 30000): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([GUEST_HTML], { type: 'text/html' }))
    const iframe = document.createElement('iframe')
    iframe.className = 'hidden'
    iframe.setAttribute('sandbox', 'allow-scripts') // deliberately NO allow-same-origin, so the origin is opaque
    iframe.src = url

    let done = false
    let started = false
    const finish = (r: SandboxResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      window.removeEventListener('message', onMsg)
      iframe.remove()
      URL.revokeObjectURL(url)
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
      // The guest is a sandboxed (opaque) iframe, so its origin is the string "null".
      if (e.source !== iframe.contentWindow || e.origin !== 'null') return
      const d = (e.data ?? {}) as { k?: string; id?: number; method?: string; args?: unknown[]; msg?: unknown; value?: unknown; error?: unknown }
      if (d.k === 'ready') {
        if (started) return // guest can't make us re-exec by spamming 'ready'
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

/** Host-mediated fetch for a sandboxed tool: credential-free, size-capped, no off-list redirects. */
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
// HTML apps (Workshop `type:'html'`): the same boundary, made visible & durable.
// The app executes in the SAME null-origin blob: iframe configuration as scripts
// (`sandbox="allow-scripts"`, inner CSP with no network, WebRTC poisoned before any
// untrusted code) behind the SAME enumerated postMessage capability API, plus an
// opt-in `room` channel the host relays over the authenticated best-effort `game`
// channel (ARCHITECTURE section 5.4 semantics: state/scores, transport-encrypted, never
// secrets, never the ratchet). Differences from runInSandbox, deliberately minimal:
//   - the iframe is VISIBLE (mounted where the caller says) and has NO deadline;
//     teardown is an explicit close() (user gesture or tool deactivation).
//   - styles may exist INSIDE the guest document (its own CSP: style-src
//     'unsafe-inline'); the host page CSP is untouched.
//   - the app HTML is still delivered via postMessage after 'ready', never
//     interpolated into the static guest markup. The bootstrap mounts it with
//     DOMParser and re-creates <script> nodes so they execute in document order.
// The guest can render arbitrary UI, so the host chrome MUST keep the app name +
// trust badge visible OUTSIDE the frame. The frame can imitate anything inside.

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

const ROOM_MSG_MAX = 16_384 // JSON chars: a compact map chunk fits, bulk exfil doesn't
const ROOM_MIN_INTERVAL_MS = 15 // about 66 msg/s ceiling per app

const GUEST_APP_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:">
<script>
(function(){
  try {
    ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','RTCDataChannel'].forEach(function(n){
      try { delete window[n]; } catch(e){}
      try { Object.defineProperty(window, n, { configurable:false, get:function(){ throw new Error('network is blocked in the sandbox'); } }); } catch(e){}
    });
  } catch(e){}
  var seq=0, pending={}, roomHandlers=[];
  function call(method, args){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; parent.postMessage({k:'cap', id:id, method:method, args:args}, '*'); }); }
  window.host = {
    clipboard: { read:function(){return call('clipboard.read',[]);}, write:function(t){return call('clipboard.write',[String(t)]);} },
    storage: { get:function(key){return call('storage.get',[String(key)]);}, set:function(key,val){return call('storage.set',[String(key),val]);} },
    net: { fetch:function(url,init){return call('net.fetch',[String(url), init||{}]);} },
    room: {
      send:function(data){ return call('room.send',[data]); },
      peers:function(){ return call('room.peers',[]); },
      onMessage:function(cb){ if(typeof cb==='function') roomHandlers.push(cb); }
    },
    log: function(m){ try{ parent.postMessage({k:'log', msg:String(m)}, '*'); }catch(e){} }
  };
  window.addEventListener('error', function(e){ try{ parent.postMessage({k:'log', msg:'app error: '+e.message}, '*'); }catch(x){} });
  function mount(html){
    var doc = new DOMParser().parseFromString(String(html), 'text/html');
    var codes = [];
    var found = doc.querySelectorAll('script');
    for (var i=0;i<found.length;i++){
      var slot = doc.createElement('app-script-slot');
      slot.setAttribute('data-i', String(codes.length));
      codes.push(found[i].textContent || '');
      found[i].parentNode.replaceChild(slot, found[i]);
    }
    document.title = doc.title || 'app';
    var hs = doc.querySelectorAll('head style');
    for (var j=0;j<hs.length;j++) document.head.appendChild(hs[j].cloneNode(true));
    while (doc.body.firstChild) document.body.appendChild(doc.body.firstChild);
    var placed = document.querySelectorAll('app-script-slot');
    var byIdx = {};
    for (var p=0;p<placed.length;p++) byIdx[placed[p].getAttribute('data-i')] = placed[p];
    for (var c=0;c<codes.length;c++){
      var s = document.createElement('script');
      s.textContent = codes[c];
      var at = byIdx[String(c)];
      if (at) at.parentNode.replaceChild(s, at); else document.body.appendChild(s); // head scripts run last-resort at end
    }
  }
  window.addEventListener('message', function(e){
    var d=e.data||{};
    if(d.k==='exec'){ try{ mount(d.source); }catch(err){ parent.postMessage({k:'log', msg:'mount failed: '+String(err&&err.message||err)}, '*'); } }
    else if(d.k==='cap-result'){ var p=pending[d.id]; if(p){ delete pending[d.id]; if(d.ok){ p.res(d.value); } else { p.rej(new Error(d.error)); } } }
    else if(d.k==='room'){ for(var i=0;i<roomHandlers.length;i++){ try{ roomHandlers[i](d.data, String(d.from||'')); }catch(e2){} } }
  });
  parent.postMessage({k:'ready'}, '*');
})();
</script></head><body></body></html>`

export function runHtmlApp(source: string, perms: SandboxPermissions, cb: AppCallbacks, mountEl: HTMLElement): AppHandle {
  const url = URL.createObjectURL(new Blob([GUEST_APP_HTML], { type: 'text/html' }))
  const iframe = document.createElement('iframe')
  iframe.className = 'ws-app-frame'
  iframe.setAttribute('sandbox', 'allow-scripts') // deliberately NO allow-same-origin, so the origin is opaque
  iframe.src = url

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
    // Same authentication as runInSandbox: an opaque-origin iframe reports origin === 'null'.
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
      URL.revokeObjectURL(url)
    },
  }
}
