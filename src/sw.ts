/// <reference lib="webworker" />
// Custom service worker (injectManifest). Built by vite-plugin-pwa and excluded from the
// app tsconfig. Beyond precaching it re-injects COOP/COEP on cached navigation responses,
// because caches strip them and crossOriginIsolated would otherwise break on an offline
// reload (ARCHITECTURE sections 2 and 10).

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

const manifest = self.__WB_MANIFEST

// Named after the build (FNV-1a over the precache revisions), so each deploy fills a fresh
// cache and activate drops the previous one along with every chunk it collected. Only
// names under this prefix are ours: transformers.js keeps its downloaded models in
// 'transformers-cache' on the same origin.
const PREFIX = 'wt-precache-'
let hash = 0x811c9dc5
for (const e of manifest) {
  for (const ch of `${e.url} ${e.revision ?? ''};`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193)
}
const CACHE = PREFIX + (hash >>> 0).toString(36)
const ASSETS = manifest.map((e) => e.url)
const indexEntry = manifest.find((e) => e.url.endsWith('index.html'))
const INDEX_URL = indexEntry ? indexEntry.url : 'index.html'
// A module script sends Origin even to its own origin, while addAll sends none, so under
// a host that answers Vary: Origin (vite preview does) a precached chunk never matched the
// page's request and the offline start failed on the entry script. Nothing served here
// differs by Origin.
const MATCH: CacheQueryOptions = { ignoreVary: true }

// The entry chunk's static imports carry hashed names the manifest glob cannot tell apart
// from the lazy tool chunks, and on a first visit they load before this worker exists, so
// the runtime cache never sees them either. Missing, they fail the module graph offline
// before main.ts runs and leave a blank page. index.html names each one as a
// modulepreload, so install reads them from the copy it has just cached.
async function precache(): Promise<void> {
  const cache = await caches.open(CACHE)
  await cache.addAll(ASSETS)
  const html = (await (await cache.match(INDEX_URL))?.text()) ?? ''
  const deps = new Set<string>()
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
    if (href && /\brel="modulepreload"/.test(tag)) deps.add(href)
  }
  const missing: string[] = []
  for (const d of deps) if (!(await cache.match(d, MATCH))) missing.push(d)
  await cache.addAll(missing)
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

function withIsolation(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

self.addEventListener('fetch', (event) => {
  const req = event.request

  // Navigations are network-first, so they get the real Vercel headers, falling back
  // offline to the cached shell with COOP/COEP re-injected.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(INDEX_URL)
        return cached ? withIsolation(cached) : Response.error()
      }),
    )
    return
  }

  if (req.method !== 'GET') return

  // Same-origin only. Cross-origin (HF models, OCR lang data, CDN wasm) is left to the
  // libraries' own caching and never cached here. Hashed build output under /assets/ never
  // changes behind its URL, so it is cache-first and lazy tool chunks and workers cache as
  // they are used rather than all being precached up front. Everything else keeps its URL
  // across deploys (public/tesseract, the icon), so it is network-first and the cached copy
  // only answers offline.
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(url.pathname.startsWith('/assets/') ? cacheFirst(req) : networkFirst(req))
})

// Vercel answers a path it no longer has with index.html (the SPA rewrite), so a chunk an
// old tab asks for after a deploy comes back 200 text/html. Stored under the .js URL, that
// page would break the import for good, so HTML is never stored for a subresource. Only a
// full 200 is stored, since Cache.put rejects a partial response.
function storable(res: Response): boolean {
  return res.status === 200 && res.type === 'basic' && !(res.headers.get('content-type') ?? '').startsWith('text/html')
}

async function remember(req: Request, res: Response): Promise<void> {
  if (storable(res)) await (await caches.open(CACHE)).put(req, res)
}

async function cacheFirst(req: Request): Promise<Response> {
  const cached = await caches.match(req, MATCH)
  if (cached) return cached
  const res = await fetch(req)
  void remember(req, res.clone()).catch(() => {}) // a full quota costs the copy, not the response
  return res
}

async function networkFirst(req: Request): Promise<Response> {
  try {
    const res = await fetch(req)
    void remember(req, res.clone()).catch(() => {})
    return res
  } catch (e) {
    const cached = await caches.match(req, MATCH)
    if (cached) return cached
    throw e
  }
}
