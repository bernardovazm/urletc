// Built-in tool registration. Manifests are cheap and static; the heavy module
// (and any WASM) is fetched only when `load()` runs (on activation), so boot stays light.

import { registry } from '../shell/registry'

export function registerBuiltins(): void {
  registry.register({
    id: 'clipboard',
    name: 'Clipboard',
    description: 'Detect clipboard content and route it to the right action',
    category: 'clipboard',
    version: '0.2.0',
    icon: '📋',
    source: 'builtin',
    // 'storage' carries one flag: whether focus re-scan is on. Without it the tool's
    // storage facade is the denied one and the choice cannot survive a reload.
    permissions: ['clipboard-read', 'clipboard-write', 'storage'],
    load: () => import('./clipboard'),
  })

  registry.register({
    id: 'generators',
    name: 'Generators',
    description: 'Test data for any country: names, national IDs, cards, UUID',
    category: 'util',
    version: '0.4.0',
    icon: '🎲',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./generators'),
  })

  registry.register({
    id: 'workshop',
    name: 'Workshop',
    description: 'Create, sign, share & run sandboxed tools',
    category: 'workshop',
    version: '0.1.0',
    icon: '🧰',
    source: 'builtin',
    permissions: ['clipboard-read', 'clipboard-write', 'storage'],
    load: () => import('./workshop'),
  })

  registry.register({
    id: 'pong',
    name: 'Pong',
    description: 'Two-player Pong over P2P; open it on both devices in a room',
    category: 'p2p',
    version: '0.1.0',
    icon: '🏓',
    source: 'builtin',
    permissions: [],
    load: () => import('./pong'),
  })

  registry.register({
    id: 'ocr',
    name: 'OCR',
    description: 'Extract text from an image with Tesseract',
    category: 'media',
    version: '0.1.0',
    icon: '🔎',
    source: 'builtin',
    permissions: ['clipboard-read', 'clipboard-write'],
    load: () => import('./ocr'),
  })

  registry.register({
    id: 'stt',
    name: 'Speech to Text',
    description: 'Transcribe a file or the mic on-device with Whisper',
    category: 'media',
    version: '0.1.0',
    icon: '🎙',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./stt'),
  })

  registry.register({
    id: 'tts',
    name: 'Text to Speech',
    description: 'Speak text aloud with on-device voices',
    category: 'media',
    version: '0.1.0',
    icon: '🔊',
    source: 'builtin',
    permissions: ['clipboard-read'],
    load: () => import('./tts'),
  })

  registry.register({
    id: 'html-strip',
    name: 'HTML to Text',
    description: 'Strip HTML tags to plain text',
    category: 'util',
    version: '0.1.0',
    icon: '🏷',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./html-strip'),
  })

  registry.register({
    id: 'url-info',
    name: 'URL Inspector',
    description: 'Parse a URL into its parts, never fetching it',
    category: 'util',
    version: '0.1.0',
    icon: '🔗',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./url-info'),
  })

  registry.register({
    id: 'text-utils',
    name: 'Text Utilities',
    description: 'Stats, case transforms, entity extraction',
    category: 'util',
    version: '0.1.0',
    icon: '📝',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./text-utils'),
  })

  registry.register({
    id: 'json-format',
    name: 'JSON Formatter',
    description: 'Pretty-print or minify JSON',
    category: 'util',
    version: '0.1.0',
    icon: '🧩',
    source: 'builtin',
    permissions: ['clipboard-read', 'clipboard-write'],
    load: () => import('./json-format'),
  })

  registry.register({
    id: 'base64',
    name: 'Base64',
    description: 'Encode and decode Base64, UTF-8 safe',
    category: 'util',
    version: '0.1.0',
    icon: '🔡',
    source: 'builtin',
    permissions: ['clipboard-read', 'clipboard-write'],
    load: () => import('./base64'),
  })

  registry.register({
    id: 'hash',
    name: 'Hash',
    description: 'SHA-1/256/384/512 of text or a file',
    category: 'util',
    version: '0.2.0',
    icon: '#️⃣',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./hash'),
  })

  registry.register({
    id: 'diff',
    name: 'Diff',
    description: 'Line-by-line diff of two texts',
    category: 'util',
    version: '0.1.0',
    icon: '🔀',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./diff'),
  })

  registry.register({
    id: 'epoch',
    name: 'Timestamp',
    description: 'Convert between epoch, ISO and local time',
    category: 'util',
    version: '0.1.0',
    icon: '🕒',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./epoch'),
  })

  registry.register({
    id: 'studio',
    name: 'Studio',
    description: 'Publish camera, mic or screen, arrange the stage, record, and copy an OBS link',
    category: 'p2p',
    version: '0.1.0',
    icon: '🎬',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./studio'),
  })

  registry.register({
    id: 'device-check',
    name: 'Device Check',
    description: 'Test mic, camera and speakers: preview, level meter, loopback, sample recording',
    category: 'media',
    version: '0.1.0',
    icon: '🎛',
    source: 'builtin',
    permissions: [],
    load: () => import('./device-check'),
  })

  registry.register({
    id: 'uptime',
    name: 'Session Uptime',
    description: 'How long this tab has been open, and when it was opened',
    category: 'util',
    version: '0.1.0',
    icon: '⏱',
    source: 'builtin',
    permissions: ['clipboard-write'],
    load: () => import('./uptime'),
  })

  registry.register({
    id: 'settings',
    name: 'Settings',
    description: 'Passphrase lock, auto-OCR and live captions',
    category: 'util',
    version: '0.2.0',
    icon: '⚙',
    source: 'builtin',
    permissions: [],
    load: () => import('./settings'),
  })
}
