import type { ToolContext, ToolModule } from '../shell/registry'
import { copyText, el } from '../shell/ui'

// How long this tab has been open. The elapsed number comes from performance.now(),
// which counts from performance.timeOrigin on a monotonic clock: an NTP step, a manual
// clock change or a timezone switch cannot corrupt it the way `Date.now() - startedAt`
// can. timeOrigin is also the wall-clock anchor, read once for the "Opened at" row.
// A reload is a new document, so it starts a new count.

/** "00:00:04", "02:14:03", "3d 02:14:03". Always hours:minutes:seconds, so the width
 *  stays put as it ticks and no field can be mistaken for a bigger unit. */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
  const days = Math.floor(total / 86400)
  return days ? `${days}d ${clock}` : clock
}

// Per-card teardown, keyed by container: launchTool shares one cached module across all
// open cards, so the interval handle must be per-activation. A module-level handle would
// let a second card clobber the first's and leak its timer.
const detachers = new WeakMap<HTMLElement, () => void>()

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    const openedAt = new Date(performance.timeOrigin)

    const valueRow = (label: string) => {
      const value = el('button', { class: 'gen-value', text: '-', title: 'Click to copy' })
      value.addEventListener('click', () => void copyText(value.textContent ?? '', ctx.clipboard.write))
      return { value, row: el('div', { class: 'gen-row' }, [el('span', { class: 'gen-label', text: label }), value]) }
    }
    const openFor = valueRow('Open for')
    const opened = valueRow('Opened at')
    opened.value.textContent = openedAt.toLocaleString()

    // Recomputed from performance.now() every tick rather than incremented, so a
    // throttled or skipped interval in a background tab cannot make the total drift.
    const tick = () => {
      openFor.value.textContent = formatUptime(performance.now())
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    // Background tabs throttle timers to about once a minute, so refresh on the way back
    // in: the number is then correct the moment it is looked at.
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    container.append(
      openFor.row,
      opened.row,
      el('div', { class: 'muted small', text: 'Measured on a monotonic clock, so a system time change cannot skew it. Reloading the tab starts a new count.' }),
    )

    detachers.set(container, () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    })
  },

  deactivate(container: HTMLElement) {
    detachers.get(container)?.()
    detachers.delete(container)
  },
}

export default tool
