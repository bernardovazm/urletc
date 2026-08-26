/// <reference lib="webworker" />
// Custom service worker (injectManifest). Built by vite-plugin-pwa; excluded from
// the app tsconfig. Its one load-bearing job beyond precaching: re-inject COOP/COEP
// on cached navigation responses, because caches strip them and crossOriginIsolated
// would otherwise break on an offline reload (ARCHITECTURE sections 2 and 10).

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

const CACHE = 'wt-precache-v1'
const manifest = self.__WB_MANIFEST
const ASSETS = manifest.map((e) => e.url)
const indexEntry = manifest.find((e) => e.url.endsWith('index.html'))
const INDEX_URL = indexEntry ? indexEntry.url : 'index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
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

  // Navigations: network-first (gets real Vercel headers); offline fallback to the
  // cached shell with COOP/COEP re-injected.
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

  // Same-origin assets: cache-first, populating the cache on first fetch so lazy
  // tool chunks/workers cache as they are used (not all precached up front).
  // Cross-origin (HF models, OCR lang data, CDN wasm) is left to the libraries'
  // own caching and never cached here.
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      const cached = await caches.match(req)
      if (cached) return cached
      const res = await fetch(req)
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE)
        void cache.put(req, res.clone())
      }
      return res
    })(),
  )
})
