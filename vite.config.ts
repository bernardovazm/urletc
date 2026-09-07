import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Cross-origin isolation: enables SharedArrayBuffer / multithread WASM fast-paths.
// COEP=credentialless, not require-corp, so no-CORP subresources still load
// (ARCHITECTURE section 10).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// Production CSP and Trusted Types, kept in sync with vercel.json. Applied to
// `vite preview`, which serves the built bundle the way the deploy does, so a Trusted
// Types or style-src regression fails the e2e run locally instead of in production. The
// dev server does not get it: HMR injects inline scripts and eval.
//
// vite preview reads this file once at startup, so a change here needs a restart and not
// just a rebuild.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self' https://api.mail.gw https://spoo.me https://raw.githubusercontent.com https://tessdata.projectnaptha.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co https://cdn.jsdelivr.net wss://relay.mostr.pub wss://bucket.coracle.social wss://relay.primal.net",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "base-uri 'none'",
].join('; ')

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: { ...isolation, 'Content-Security-Policy': CSP } },
  build: { target: 'es2022', sourcemap: true },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // No inline registration script: the CSP forbids inline <script>. main.ts calls
      // registerSW() instead.
      injectRegister: false,
      injectManifest: {
        // Precache only the app shell. Lazy tool chunks + workers are runtime-cached
        // on first use by the SW fetch handler (sw.ts). That keeps SW install light and
        // preserves lazy loading. Heavy self-hosted OCR core is never precached.
        //
        // Do not add manifest.webmanifest: vite-plugin-pwa injects it into the precache
        // list itself, and a duplicate URL makes Cache.addAll reject with InvalidStateError,
        // which fails the install event and leaves nothing precached.
        globPatterns: ['index.html', 'assets/index-*.{js,css}', 'assets/workbox-window*.js'],
        maximumFileSizeToCacheInBytes: 3_000_000,
      },
      manifest: {
        name: 'urletc',
        short_name: 'urletc',
        description: 'Client-only productivity and P2P toolkit',
        theme_color: '#060707',
        background_color: '#060707',
        display: 'standalone',
        start_url: '/',
        // Self-hosted SVG (keeps script-src/img-src 'self'); scalable, so one asset covers all sizes.
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      devOptions: { enabled: false },
    }),
  ],
})
