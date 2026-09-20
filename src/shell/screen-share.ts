// Screen sharing belongs to the browser. The window that lists screens, windows and tabs,
// the audio checkbox on it and the permission prompt are all the browser's; this app only
// receives whatever track comes back. What differs between browsers is whether audio can
// be captured alongside the picture, which is the thing people actually want when they
// share a tab, so the copy below is derived from a capability probe rather than from a
// user-agent string.

import { el } from './ui'

export interface ScreenShareSupport {
  /** getDisplayMedia exists on MediaDevices at all. */
  capture: boolean
  /** The browser reports `suppressLocalAudioPlayback`, which the Screen Capture spec
   *  defines only for audio tracks produced by getDisplayMedia. Reporting it is the
   *  closest the API comes to stating that display audio is implemented. */
  audio: boolean
  /** One line, short enough to serve as a title attribute or a <summary>. */
  line: string
  /** The rest, revealed on demand. */
  detail: string[]
}

const PICKER = 'The list of screens, windows and tabs, its audio checkbox and the permission prompt all belong to the browser. Nothing in this app changes what it offers.'
const SPLIT = 'Chrome, Edge and Brave capture the audio of a shared tab. Firefox and LibreWolf capture picture only.'

/** Probe on every call: a cached answer would survive a browser that gains the capability
 *  mid-session, and the probe is two property reads. */
export function screenShareSupport(): ScreenShareSupport {
  // Undefined on an insecure origin, where the whole interface is withheld.
  const md = navigator.mediaDevices as MediaDevices | undefined
  const capture = typeof md?.getDisplayMedia === 'function'
  const constraints = (md?.getSupportedConstraints?.() ?? {}) as Record<string, boolean | undefined>
  const audio = capture && constraints.suppressLocalAudioPlayback === true
  if (!capture) return { capture, audio, line: 'This browser exposes no screen capture.', detail: [PICKER, SPLIT] }
  if (audio) {
    return {
      capture,
      audio,
      line: 'Your browser runs the picker, and this one can capture audio along with the picture.',
      // Which surface carries the checkbox is settled inside the picker, and no API
      // reports it beforehand, so the copy says that instead of guessing.
      detail: [
        PICKER,
        'Audio is offered only where the browser allows it, in practice a tab, and only when you tick the box there. Which entries offer it is decided inside the picker, so it cannot be read here in advance.',
        SPLIT,
      ],
    }
  }
  return {
    capture,
    audio,
    line: 'Your browser runs the picker, and this one reports no audio capture, so picture only.',
    detail: [PICKER, 'With no audio capture reported, a share carries picture only, and sound playing in the shared tab stays on this machine.', SPLIT],
  }
}

/** The same note for every screen-share affordance: one line in the summary, the rest
 *  behind it. A <details> rather than a title attribute wherever there is room for a
 *  block, since a tooltip is unreachable by touch and cannot hold three lines. */
export function screenShareNote(): HTMLElement {
  const cap = screenShareSupport()
  const summary = el('summary', {}, [el('span', { class: 'chev', text: '>' }), el('span', { text: cap.line })])
  const body = el(
    'div',
    { class: 'note-body' },
    cap.detail.map((t) => el('div', { class: 'muted small', text: t })),
  )
  return el('details', { class: 'note' }, [summary, body])
}
