/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Set only by test builds; see APP_ID in src/p2p/session.ts. */
  readonly VITE_RENDEZVOUS_NS?: string
}
