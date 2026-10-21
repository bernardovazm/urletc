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
// cache; activate keeps it and the one it replaced, and drops anything older. Only names
// under this prefix are ours: transformers.js keeps its downloaded models in
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

// The build this one replaced is kept, and anything older dropped. A tab with a call or a
// share stays on the old bundle until it is idle (main.ts), and the lazy chunks and
// workers already fetched under that build live in its cache; deleting it at activate
// failed them. A tool no tab opened under that build is in no cache and still falls over to
// the preloadError notice. Which build is current lives in a one-entry cache of its own,
// read by main.ts as well.
const META = 'wt-meta'
const META_KEY = '/__wt-current-build'

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const meta = await caches.open(META)
      const prev = await (await meta.match(META_KEY))?.text()
      const keep = new Set([CACHE, prev ?? CACHE])
      for (const n of await caches.keys()) if (n.startsWith(PREFIX) && !keep.has(n)) await caches.delete(n)
      if (prev !== CACHE) await meta.put(META_KEY, new Response(CACHE))
      await self.clients.claim()
    })(),
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
    // A factory reset deletes every cache, the shell included, and nothing else puts it
    // back before the next deploy, so offline start failed until then.
    // The build marker went with it, and without it the next activate would drop this
    // build's cache instead of keeping it.
    event.waitUntil(
      (async () => {
        if (!(await caches.match(INDEX_URL, { ...MATCH, cacheName: CACHE }))) await precache()
        const meta = await caches.open(META)
        if (!(await meta.match(META_KEY))) await meta.put(META_KEY, new Response(CACHE))
      })().catch(() => {}),
    )
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await fromCache(INDEX_URL)
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
  // Only the app's own files, by their exact path. Any other same-origin URL, and any URL
  // with a query, passes through unstored: the host answers a query on an asset with the
  // asset, so a Workshop tool fetching one large file under endless queries filled origin
  // storage with copies of it.
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.search || !STORABLE_PATH.test(url.pathname)) return
  event.respondWith(url.pathname.startsWith('/assets/') ? cacheFirst(req) : networkFirst(req))
})

const STORABLE_PATH = /^\/(?:assets|tesseract)\/[\w.-]+$|^\/(?:icon(?:-alert)?\.svg|manifest\.webmanifest)$/

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

/** A cached copy, from this build's cache first. The previous build's cache is kept too,
 *  and was created first, so a match across all caches answered with the older copy. */
async function fromCache(req: Request | string): Promise<Response | undefined> {
  return (await caches.match(req, { ...MATCH, cacheName: CACHE })) ?? (await caches.match(req, MATCH))
}

async function networkFirst(req: Request): Promise<Response> {
  try {
    const res = await fetch(req)
    void remember(req, res.clone()).catch(() => {})
    return res
  } catch (e) {
    const cached = await fromCache(req)
    if (cached) return cached
    throw e
  }
}
