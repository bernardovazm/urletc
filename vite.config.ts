import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Cross-origin isolation: enables SharedArrayBuffer / multithread WASM fast-paths.
// COEP=credentialless, not require-corp, so no-CORP subresources still load
// (ARCHITECTURE section 10).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// Production CSP + Trusted Types, kept in sync with vercel.json. Applied to
// `vite preview`, which serves the built, inline-script-free bundle exactly like the
// deploy. Contributors and CI therefore exercise Trusted Types / style-src 'self' locally
// and a regression fails the e2e instead of only surfacing in production. NOT applied to the dev
// server: Vite HMR injects inline scripts/eval that a strict CSP would break.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self' https://api.mail.gw https://spoo.me https://tessdata.projectnaptha.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co https://cdn.jsdelivr.net wss://relay.mostr.pub wss://bucket.coracle.social wss://strfry.shock.network",
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
      // No inline registration script, because strict CSP forbids inline <script>.
      // We call registerSW() from main.ts instead.
      injectRegister: false,
      injectManifest: {
        // Precache only the app shell. Lazy tool chunks + workers are runtime-cached
        // on first use by the SW fetch handler (sw.ts). That keeps SW install light and
        // preserves lazy loading. Heavy self-hosted OCR core is never precached.
        //
        // manifest.webmanifest is NOT listed here. vite-plugin-pwa injects the manifest it
        // generates into the precache list on its own, so naming it again put the same URL
        // in the list twice and `Cache.addAll` rejects duplicate requests with
        // InvalidStateError. That failed the whole install event, so nothing was precached
        // and offline support was dead on every load.
        globPatterns: ['index.html', 'assets/index-*.{js,css}', 'assets/workbox-window*.js'],
        maximumFileSizeToCacheInBytes: 3_000_000,
      },
      manifest: {
        name: 'utilscript',
        short_name: 'utilscript',
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
