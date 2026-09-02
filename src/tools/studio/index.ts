import { getStudio, type DeviceOption, type StageLayout } from '../../shell/studio'
import type { ToolContext, ToolModule } from '../../shell/registry'
import { button, copyText, el, toast } from '../../shell/ui'

// Studio, a VDO.ninja-style control panel for the shared A/V stage: choose which
// camera, mic or screen to publish, arrange incoming sources as grid, spotlight or solo,
// record any source, and copy a chromeless #/stage/<code> link to drop into OBS as a
// browser source. It owns NO streams; the console does, with studio.ts as the seam. This
// panel only issues commands and reflects state.

const RES = [
  { v: 0, label: 'Default' },
  { v: 640, label: '360p' },
  { v: 1280, label: '720p' },
  { v: 1920, label: '1080p' },
]
const LAYOUTS: Array<{ v: StageLayout; label: string }> = [
  { v: 'grid', label: 'Grid' },
  { v: 'spotlight', label: 'Spotlight' },
  { v: 'solo', label: 'Solo' },
]

// Per-card onChange subscription, keyed by container: the cached module singleton is
// shared across open Studio cards, so a shared handle would freeze one card's updates
// when another is opened/closed.
const subs = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const studio = getStudio()
    if (!studio) {
      container.append(el('p', { class: 'muted', text: 'Studio needs the P2P console, which this browser does not support.' }))
      return
    }

    // A chromeless stage view is a pure viewer, so it gets no publish controls.
    if (studio.isStageView()) {
      container.append(el('p', { class: 'muted', text: 'Stage view: this window only displays the sources in the room, for OBS or scenes. Open the app normally to publish.' }))
      return
    }

    // ---- publish controls ----
    const camSel = el('select', { title: 'Camera to publish' }) as HTMLSelectElement
    const micSel = el('select', { title: 'Microphone to publish' }) as HTMLSelectElement
    const resSel = el('select', { title: 'Camera resolution' }) as HTMLSelectElement
    resSel.append(...RES.map((r) => el('option', { value: String(r.v), text: r.label })))
    const fillSel = (sel: HTMLSelectElement, opts: DeviceOption[], none: string) => {
      const cur = sel.value
      sel.replaceChildren(...(opts.length ? opts.map((o) => el('option', { value: o.deviceId, text: o.label })) : [el('option', { value: '', text: none })]))
      if (cur) sel.value = cur
    }
    const refreshDevices = async () => {
      const { cameras, mics } = await studio.listDevices()
      fillSel(camSel, cameras, 'Default camera')
      fillSel(micSel, mics, 'Default microphone')
    }

    const publish = async (kind: 'cam' | 'screen' | 'mic') => {
      try {
        await studio.publish({
          kind,
          cameraId: camSel.value || undefined,
          micId: micSel.value || undefined,
          width: Number(resSel.value) || undefined,
        })
        void refreshDevices() // device labels appear once a permission is granted
      } catch {
        toast('Camera/mic/screen denied or unavailable')
      }
    }

    // ---- layout switch ----
    const layoutRow = el('div', { class: 'row' })
    const renderLayout = () => {
      layoutRow.replaceChildren(
        el('span', { class: 'muted small', text: 'Layout' }),
        ...LAYOUTS.map((l) => {
          const b = button(l.label, () => studio.setLayout(l.v), studio.layout() === l.v ? 'primary' : 'ghost', `Arrange the stage: ${l.label.toLowerCase()}`)
          return b
        }),
      )
    }

    // ---- source list ----
    const list = el('div', { class: 'stack' })
    const renderSources = () => {
      const sources = studio.sources()
      if (!sources.length) {
        list.replaceChildren(el('div', { class: 'muted small', text: 'No sources yet. Publish a camera/screen/mic above, or wait for a peer to send one.' }))
        return
      }
      list.replaceChildren(
        ...sources.map((s) => {
          const ctlRow = el('div', { class: 'row' }, [
            el('span', { class: 'badge', text: s.kind }),
            el('span', { class: 'src-name', text: `${s.label}${s.local ? ' (you)' : ''}` }),
            el('span', { class: 'spacer' }),
          ])
          if (s.hasVideo) {
            ctlRow.append(
              button('📌', () => studio.spotlight(s.id), s.spotlighted ? 'icon sm primary' : 'icon sm', s.spotlighted ? 'Remove the spotlight' : 'Spotlight this source'),
            )
          }
          ctlRow.append(
            button(
              s.recording ? '⏹ Rec' : '🔴 Rec',
              () => studio.toggleRecord(s.id),
              'ghost small',
              s.recording ? 'Stop recording and save the file' : 'Record this source to a downloadable file',
            ),
          )
          return ctlRow
        }),
      )
    }

    const render = () => {
      renderLayout()
      renderSources()
    }
    subs.get(container)?.()
    subs.set(container, studio.onChange(render))

    // ---- OBS / scene link ----
    const linkRow = el('div', { class: 'row' })
    const renderLink = () => {
      const link = studio.stageLink()
      linkRow.replaceChildren(
        link
          ? button(
              'Copy stage link',
              () => void copyText(link, ctx.clipboard.write),
              'ghost',
              'A chromeless view of this room. Add it as a Browser source in OBS, or open it on another screen',
            )
          : el('span', { class: 'muted small', text: 'Open Connect and start or join a code room to get a shareable stage link.' }),
      )
    }

    container.append(
      el('div', { class: 'row' }, [
        el('label', { class: 'row small' }, [el('span', { text: 'Camera' }), camSel]),
        el('label', { class: 'row small' }, [el('span', { text: 'Mic' }), micSel]),
        el('label', { class: 'row small' }, [el('span', { text: 'Res' }), resSel]),
        button('🔄', () => void refreshDevices(), 'icon sm', 'Refresh the device list'),
      ]),
      el('div', { class: 'row' }, [
        button('🎥 Publish camera', () => void publish('cam'), 'primary', 'Send the selected camera to paired/code peers'),
        button('🖥 Publish screen', () => void publish('screen'), 'ghost', 'Share a screen/window/tab'),
        button('🎤 Publish mic', () => void publish('mic'), 'ghost', 'Send the selected microphone'),
        button('⏹ Stop all', () => studio.unpublishAll(), 'ghost', 'Stop all of your own sources'),
      ]),
      layoutRow,
      el('div', { class: 'muted small', text: 'Sources on the stage' }),
      list,
      linkRow,
      el('div', { class: 'muted small', text: 'Your media goes only to paired/code peers, never to nearby devices. Everything is peer-to-peer, so no server sees it.' }),
    )
    render()
    renderLink()
    void refreshDevices()
  },

  deactivate(container: HTMLElement) {
    subs.get(container)?.() // stop reacting to stage changes; the console keeps owning the streams
    subs.delete(container)
  },
}

export default tool
