/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Set only by test builds; see APP_ID in src/p2p/session.ts. */
  readonly VITE_RENDEZVOUS_NS?: string
  /** Deployment TURN relay as a JSON iceServers array; compiled into the public bundle (see src/p2p/turn.ts). */
  readonly VITE_TURN_SERVERS?: string
}
