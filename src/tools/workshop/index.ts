import { z } from '../../core/zod'
import { CryptoUnsupportedError, loadOrCreateIdentity, type DeviceIdentity } from '../../core/identity'
import { runAutomation, StepSchema } from '../../workshop/automation'
import { ManifestSchema, signManifest, trustTier, verifyManifest, type Manifest, type Permission } from '../../workshop/manifest'
import { hostFetch, runHtmlApp, runInSandbox, type SandboxPermissions } from '../../workshop/sandbox'
import { getActiveSession } from '../../p2p/session'
import type { ToolContext, ToolModule } from '../../shell/registry'
import { badge, button, consent, el, toast } from '../../shell/ui'

// Per-card teardown keyed by container: the cached module is shared across open Workshop
// cards, so the running-app handle and the session tool-handler unsubscribe must be
// per-activation. A module-level handle would let one card's close tear down another's.
const teardowns = new WeakMap<HTMLElement, () => void>()

const EXAMPLE = JSON.stringify([{ op: 'json.parse' }, { op: 'json.sortKeys', recursive: true }, { op: 'json.stringify', indent: 2 }], null, 2)

const EXAMPLE_HTML = `<style>body{background:#111;color:#eee;font-family:monospace;margin:1rem}</style>
<h3>sandboxed app</h3>
<button id="b">ping room</button>
<script>
host.room.onMessage((d, from) => host.log('from ' + from.slice(0, 8) + ': ' + JSON.stringify(d)))
document.getElementById('b').onclick = () => host.room.send({ hello: Date.now() })
</script>`

function permLabel(p: Permission): string {
  return typeof p === 'string' ? p : `net: ${p.net.join(', ')}`
}

function sandboxPerms(perms: Permission[]): SandboxPermissions {
  return {
    clipboardRead: perms.some((p) => p === 'clipboard-read'),
    clipboardWrite: perms.some((p) => p === 'clipboard-write'),
    storage: perms.some((p) => p === 'storage'),
    net: perms.flatMap((p) => (typeof p === 'object' ? p.net : [])),
    p2pRoom: perms.some((p) => p === 'p2p-room'),
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = el('a', { href: url, download: name }) as HTMLAnchorElement
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const tool: ToolModule = {
  async activate(container: HTMLElement, ctx: ToolContext) {
    container.replaceChildren()
    let id: DeviceIdentity
    try {
      id = await loadOrCreateIdentity()
    } catch (e) {
      container.append(el('p', { class: 'muted', text: e instanceof CryptoUnsupportedError ? e.message : 'Workshop needs a newer browser to sign tools.' }))
      return
    }
    const selfHex = id.publicKeyHex

    const installed = (await ctx.storage.get<Manifest[]>('installed')) ?? []
    const trusted = new Set<string>((await ctx.storage.get<string[]>('trusted')) ?? [])
    const displayName = (await ctx.storage.get<string>('name')) ?? 'me'

    // Verify signatures of stored manifests on load so the displayed trust badge is
    // honest even against a tampered IDB (ARCHITECTURE section 7, verify before any display).
    const verifiedMap = new Map<string, boolean>()
    for (const m of installed) verifiedMap.set(m.id, (await verifyManifest(m)).ok)

    const sess = getActiveSession()
    const listBox = el('div', { class: 'stack' })
    const incomingBox = el('div', { class: 'stack' })
    const appBox = el('div', { class: 'stack' })
    let closeApp: (() => void) | null = null // this card's one running html app (exclusive)
    let clearToolHandler: (() => void) | null = null
    const incoming: Manifest[] = []
    const out = el('pre', { class: 'muted', text: 'run output' })

    const persist = () => ctx.storage.set('installed', installed)

    const install = async (m: Manifest, tier: ReturnType<typeof trustTier>) => {
      const ok = await consent({
        title: `Install: ${m.name}`,
        version: m.version,
        author: m.author.displayName,
        hash: m.contentHash,
        tier,
        permissions: m.permissions.map(permLabel),
        source: m.body.kind === 'rules' ? JSON.stringify(m.body.steps, null, 2) : m.body.source,
        runLabel: 'Install',
      })
      if (!ok) return
      const i = installed.findIndex((x) => x.id === m.id)
      if (i >= 0) {
        // Enforce same-key updates (section 7): a different author key for the same id must
        // be an explicit override, not a silent overwrite.
        if (
          installed[i].author.pubkey !== m.author.pubkey &&
          !confirm(`Author key changed for "${m.name}".\nfrom ${installed[i].author.pubkey.slice(0, 28)}...\nto   ${m.author.pubkey.slice(0, 28)}...\nReplace anyway?`)
        ) {
          return
        }
        installed[i] = m
      } else {
        installed.push(m)
      }
      verifiedMap.set(m.id, true) // install() inputs are always verified (signed self / verified import / verified gossip)
      await persist()
      renderList()
      toast('Installed')
    }

    const run = async (m: Manifest) => {
      // Re-verify on every run (verify-before-display AND before-run).
      const v = await verifyManifest(m)
      if (!v.ok) {
        toast(`Verification failed: ${v.reason}`)
        return
      }
      const tier = trustTier(m, selfHex, trusted, true)
      const ok = await consent({
        title: `Run: ${m.name}`,
        version: m.version,
        author: m.author.displayName,
        hash: m.contentHash,
        tier,
        permissions: m.permissions.map(permLabel),
        source: m.body.kind === 'rules' ? JSON.stringify(m.body.steps, null, 2) : m.body.source,
        runLabel: 'Run once',
      })
      if (!ok) return
      out.classList.remove('muted')

      if (m.body.kind === 'html') {
        openApp(m)
        return
      }

      if (m.body.kind === 'rules') {
        let input = ''
        try {
          input = await ctx.clipboard.readText()
        } catch {
          /* no clipboard input */
        }
        try {
          out.textContent = await runAutomation(m.body.steps, input)
        } catch (e) {
          out.textContent = `Run failed: ${(e as Error).message}`
        }
        return
      }

      // type:'script' runs in the null-origin sandbox behind the capability API. Never
      // autorun: the consent above is the gesture that authorises this run.
      out.textContent = 'Running in sandbox...'
      const logs: string[] = []
      const res = await runInSandbox(m.body.source, sandboxPerms(m.permissions), {
        clipboardRead: () => ctx.clipboard.readText(),
        clipboardWrite: (t) => ctx.clipboard.write(t),
        storageGet: (k) => ctx.storage.get(`script:${m.id}:${k}`),
        storageSet: (k, val) => ctx.storage.set(`script:${m.id}:${k}`, val),
        netFetch: (u, init) => hostFetch(u, init),
        log: (msg) => {
          if (logs.length < 200) logs.push(msg)
        },
      })
      out.textContent = (res.ok ? `Result: ${JSON.stringify(res.value, null, 2)}` : `Error: ${res.error}`) + (logs.length ? `\n\n--- logs ---\n${logs.join('\n')}` : '')
    }

    // type:'html' opens a visible, persistent sandbox panel. One app at a time; name and
    // trust badge live OUTSIDE the frame (the frame can imitate any UI inside it).
    const openApp = (m: Manifest) => {
      if (m.body.kind !== 'html') return
      closeApp?.()
      const tier = trustTier(m, selfHex, trusted, verifiedMap.get(m.id) ?? false)
      const mountRow = el('div', { class: 'stack ws-app-mount' })
      const head = el('div', { class: 'row' }, [
        badge(tier),
        el('strong', { text: m.name }),
        el('span', {
          class: 'muted small',
          text: getActiveSession() ? 'sandboxed app, room relay on' : 'sandboxed app, no room joined',
        }),
        el('span', { class: 'spacer' }),
        button('Close app', () => closeApp?.(), 'ghost'),
      ])
      appBox.replaceChildren(head, mountRow)
      const appLog = (msg: string) => {
        out.classList.remove('muted')
        out.textContent = `${(out.textContent ?? '').split('\n').slice(-60).join('\n')}\n${msg}`.trim()
      }
      const handle = runHtmlApp(
        m.body.source,
        sandboxPerms(m.permissions),
        {
          clipboardRead: () => ctx.clipboard.readText(),
          clipboardWrite: (t) => ctx.clipboard.write(t),
          storageGet: (k) => ctx.storage.get(`app:${m.id}:${k}`),
          storageSet: (k, val) => ctx.storage.set(`app:${m.id}:${k}`, val),
          netFetch: (u, init) => hostFetch(u, init),
          log: appLog,
          // Tagged with the CONTENT hash: peers only hear it inside the app with the
          // exact same body they consented to, the same trust story as install itself.
          roomSend: (data) => getActiveSession()?.sendGame({ ws: 1, id: m.contentHash, d: data }),
          roomPeers: () => Promise.resolve((getActiveSession()?.roster() ?? []).filter((p) => p.ready).map((p) => ({ peerId: p.peerId, name: p.name || 'peer' }))),
        },
        mountRow,
      )
      const relaySess = getActiveSession()
      relaySess?.setGameHandler((payload, from) => {
        const p = payload as { ws?: number; id?: string; d?: unknown }
        if (p && p.ws === 1 && p.id === m.contentHash) handle.postRoom(from, p.d)
      })
      closeApp = () => {
        handle.close()
        relaySess?.setGameHandler(null)
        appBox.replaceChildren()
        closeApp = null
      }
    }

    const renderList = () => {
      listBox.replaceChildren(
        el('h3', { text: 'Installed' }),
        ...(installed.length ? [] : [el('div', { class: 'muted', text: 'Nothing installed yet.' })]),
        ...installed.map((m) => {
          const tier = trustTier(m, selfHex, trusted, verifiedMap.get(m.id) ?? false)
          const pub = m.author.pubkey.replace(/^ed25519:/, '')
          const row = el('div', { class: 'card stack' }, [
            el('div', { class: 'row' }, [badge(tier), el('strong', { text: m.name }), el('span', { class: 'muted', text: `v${m.version}, ${m.type}` })]),
            el('div', { class: 'muted', text: `by ${m.author.displayName}, ${pub.slice(0, 12)}...` }),
          ])
          const actions = el('div', { class: 'row' }, [
            button('Run', () => void run(m), 'primary'),
            button('Export', () => download(`${m.name}.wtool.json`, JSON.stringify(m, null, 2))),
            button(
              'Remove',
              () => {
                const i = installed.findIndex((x) => x.id === m.id)
                if (i >= 0) installed.splice(i, 1)
                void persist().then(renderList)
              },
              'danger',
            ),
          ])
          if (tier === 'unverified') {
            actions.append(
              button('Trust author', () => {
                trusted.add(pub)
                void ctx.storage.set('trusted', [...trusted]).then(renderList)
              }),
            )
          }
          if (sess) {
            actions.append(
              button('Share to room', () => {
                void sess.publishTool(m)
                toast('Shared to room')
              }),
            )
          }
          row.append(actions)
          return row
        }),
      )
    }
    renderList()

    const renderIncoming = () => {
      incomingBox.replaceChildren(
        ...(incoming.length ? [el('h3', { text: 'Shared by peers' })] : []),
        ...incoming.map((m) => {
          const tier = trustTier(m, selfHex, trusted, true)
          return el('div', { class: 'card row' }, [
            badge(tier),
            el('strong', { text: m.name }),
            el('span', { class: 'muted', text: `v${m.version}, ${m.type}` }),
            button('Install', () => void install(m, tier), 'primary'),
          ])
        }),
      )
    }
    if (sess) {
      sess.setToolHandler((m) => {
        if (incoming.length >= 50) return // bound the inbox against a flooding peer
        if (!incoming.some((x) => x.id === m.id)) {
          incoming.push(m)
          renderIncoming()
        }
      })
      clearToolHandler = () => sess.setToolHandler(null)
    }

    // --- Create ---
    const nameI = el('input', { type: 'text', class: 'full', placeholder: 'Tool name', value: 'JSON Sorter' }) as HTMLInputElement
    const verI = el('input', { type: 'text', class: 'full', placeholder: 'Version', value: '0.1.0' }) as HTMLInputElement
    const typeSel = el('select', { 'aria-label': 'Tool type' }) as HTMLSelectElement
    typeSel.append(
      el('option', { value: 'automation', text: 'automation: bounded interpreter' }),
      el('option', { value: 'script', text: 'script: sandboxed JS' }),
      el('option', { value: 'html', text: 'html app: sandboxed and persistent' }),
    )
    const bodyI = el('textarea', { placeholder: 'Steps JSON' }) as HTMLTextAreaElement
    bodyI.value = EXAMPLE
    typeSel.addEventListener('change', () => {
      if (typeSel.value === 'script') {
        bodyI.placeholder = 'JS source'
        bodyI.value = 'const t = await host.clipboard.read();\nreturn t.toUpperCase();'
      } else if (typeSel.value === 'html') {
        bodyI.placeholder = 'Self-contained HTML'
        bodyI.value = EXAMPLE_HTML
      } else {
        bodyI.placeholder = 'Steps JSON'
        bodyI.value = EXAMPLE
      }
    })

    const createAndInstall = async () => {
      const type = typeSel.value === 'script' ? 'script' : typeSel.value === 'html' ? 'html' : 'automation'
      let body: { kind: 'rules'; steps: ReturnType<typeof StepSchema.parse>[] } | { kind: 'script'; source: string } | { kind: 'html'; source: string }
      if (type === 'automation') {
        try {
          body = { kind: 'rules', steps: z.array(StepSchema).max(64).parse(JSON.parse(bodyI.value)) }
        } catch (e) {
          toast(`Invalid steps: ${(e as Error).message}`)
          return
        }
      } else if (type === 'html') {
        body = { kind: 'html', source: bodyI.value }
      } else {
        body = { kind: 'script', source: bodyI.value }
      }
      // Apps default to storage + room, which is what a shared game needs; automations and
      // scripts keep the clipboard pair. Consent shows the exact list before install or run.
      const permissions: Permission[] = type === 'html' ? ['storage', 'p2p-room'] : ['clipboard-read', 'clipboard-write']
      const m = await signManifest(id, displayName, { name: nameI.value.trim() || 'Tool', version: verI.value.trim() || '0.1.0', type, permissions, body }, Date.now())
      await install(m, 'self')
    }

    // --- Import ---
    const fileI = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement
    fileI.addEventListener('change', () => {
      const f = fileI.files?.[0]
      fileI.value = ''
      if (!f) return
      void (async () => {
        try {
          const m = ManifestSchema.parse(JSON.parse(await f.text()))
          const v = await verifyManifest(m)
          if (!v.ok) {
            toast(`Rejected: ${v.reason}`)
            return
          }
          await install(m, trustTier(m, selfHex, trusted, true))
        } catch (e) {
          toast(`Invalid tool file: ${(e as Error).message}`)
        }
      })()
    })

    container.append(
      el('p', {
        class: 'muted',
        text: 'Shareable, signed tools. Declarative automations run in a bounded, op-whitelisted interpreter; scripts and HTML apps run in a null-origin sandbox. Apps stay visible and persistent, with an opt-in room channel for shared state such as game maps and scores. You always see the source and approve every run, and nothing ever autoruns. Keep your browser updated: the sandbox is defence-in-depth, not a guarantee.',
      }),
      el('p', { class: 'muted', text: sess ? 'Connected to a room. Share to room gossips a tool to peers.' : 'Join a room in Messenger to share tools with peers over P2P.' }),
      listBox,
      incomingBox,
      appBox,
      out,
      el('hr'),
      el('h3', { text: 'Create a tool' }),
      el('div', { class: 'row' }, [nameI, verI, typeSel]),
      bodyI,
      el('div', { class: 'row' }, [button('Sign & install', () => void createAndInstall(), 'primary')]),
      el('h3', { text: 'Import a signed tool' }),
      fileI,
    )
    teardowns.set(container, () => {
      closeApp?.()
      clearToolHandler?.()
    })
  },
  deactivate(container: HTMLElement) {
    teardowns.get(container)?.()
    teardowns.delete(container)
  },
}

export default tool
