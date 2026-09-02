// Studio controller, the seam between the console (which owns all live P2P media and
// its security-critical routing) and the Studio tool (a lazy control-panel module).
// Same pattern as getActiveSession(): the console implements this and registers it here;
// the tool drives the shared video STAGE through it without touching streams directly.

export type SourceKind = 'cam' | 'screen' | 'mic'
export type StageLayout = 'grid' | 'spotlight' | 'solo'

/** Rides Trystero per-stream metadata so recipients can label a source. */
export interface StreamMeta {
  kind: SourceKind
  label: string
}

export interface StudioSource {
  id: string
  kind: SourceKind
  label: string
  local: boolean
  hasVideo: boolean
  spotlighted: boolean
  recording: boolean
}

export interface DeviceOption {
  deviceId: string
  label: string
}

export interface PublishOptions {
  kind: 'cam' | 'screen' | 'mic'
  cameraId?: string
  micId?: string
  width?: number // camera capture width (height derived 16:9)
}

export interface StudioController {
  /** True while a chromeless #/stage/<code> view, which publishes nothing. */
  isStageView(): boolean
  listDevices(): Promise<{ cameras: DeviceOption[]; mics: DeviceOption[] }>
  publish(opts: PublishOptions): Promise<void>
  unpublishAll(): void
  hasLocal(): boolean
  sources(): StudioSource[]
  layout(): StageLayout
  setLayout(l: StageLayout): void
  spotlight(id: string): void
  toggleRecord(id: string): void
  /** #/stage/<code> link for an OBS browser source, or null when no code room is active. */
  stageLink(): string | null
  /** Subscribe to source/layout changes; returns an unsubscribe fn. */
  onChange(cb: () => void): () => void
}

let controller: StudioController | null = null
export function setStudio(c: StudioController | null): void {
  controller = c
}
export function getStudio(): StudioController | null {
  return controller
}
