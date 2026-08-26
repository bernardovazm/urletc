import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

// `DOMParser.parseFromString` IS a TrustedHTML sink, exactly like innerHTML, outerHTML,
// insertAdjacentHTML, document.write and Range.createContextualFragment. The CSP sets
// `require-trusted-types-for 'script'` and the default policy in src/core/trusted-types.ts
// deliberately implements only createScriptURL, so handing this sink a plain string threw
// "This document requires 'TrustedHTML' assignment" and the tool did nothing in production.
//
// The fix is a NARROW NAMED policy, not `createHTML` on the default policy. A named policy
// is reachable only through the policy object this module holds, so no other call site in
// the app gains an HTML sink. Adding createHTML to the default policy would instead reopen
// innerHTML for the entire bundle to make one tool work.
//
// Pass-through is safe in this one case because nothing is ever executed or attached:
//   * parseFromString(..., 'text/html') builds an INERT document with no browsing context,
//     so <script> never runs and event-handler attributes never fire.
//   * that document is never inserted into the live DOM.
//   * only textContent is read back out, so no markup survives the round trip.

// Minimal local shape: the Trusted Types lib types are not in this TS target's lib.dom.
// createHTML returns a TrustedHTML at runtime, which is what the sink accepts; typing it
// as string keeps the call site honest to the compiler without pulling in the lib.
interface HtmlPolicy {
  createHTML(input: string): string
}
interface TrustedTypesShim {
  createPolicy(name: string, rules: { createHTML: (input: string) => string }): HtmlPolicy
}

let cached: HtmlPolicy | null | undefined

function htmlPolicy(): HtmlPolicy | null {
  if (cached !== undefined) return cached
  const tt = (globalThis as { trustedTypes?: TrustedTypesShim }).trustedTypes
  // Firefox has no Trusted Types and the CSP directive is inert there, so the plain string
  // is accepted by the sink as-is.
  try {
    cached = tt?.createPolicy ? tt.createPolicy('html-strip', { createHTML: (s: string) => s }) : null
  } catch {
    // A `trusted-types` allow-list directive could reject the name. Fall back to the plain
    // string so the failure is the browser's clear sink error, not a silent wrong answer.
    cached = null
  }
  return cached
}

// Elements whose textContent is source code, not page text. Left in place,
// "<p>hi</p><script>alert(1)</script>" strips to "hialert(1)".
const NON_TEXT = 'x-strip-script, x-strip-style, script, style, noscript, template'

// Renaming script and style BEFORE parsing, rather than only removing them after, is
// deliberate. Chromium evaluates style-src against a <style> element even inside the inert
// document DOMParser builds, so parsing real-world markup (which nearly always carries a
// <style>) logged "Applying inline style violates ... style-src 'self'" on every strip.
// Removing the node afterwards is too late; the violation has already been reported. Under
// a custom tag name the content is inert text, so no CSS is ever parsed. The names are
// still in NON_TEXT so the subtree is dropped either way, including anything this misses.
const neutralize = (html: string) => html.replace(/<(\/?)(script|style)\b/gi, '<$1x-strip-$2')

/** Strip HTML to plain text. Parses into an inert document and reads only textContent. */
export function stripHtml(html: string): string {
  const policy = htmlPolicy()
  const raw = neutralize(html)
  const source = policy ? policy.createHTML(raw) : raw
  const doc = new DOMParser().parseFromString(source, 'text/html')
  for (const node of doc.body.querySelectorAll(NON_TEXT)) node.remove()
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

const tool: ToolModule = {
  activate(container: HTMLElement, ctx: ToolContext) {
    const input = el('textarea', { placeholder: 'Paste HTML' }) as HTMLTextAreaElement
    const out = el('pre', { class: 'muted', text: 'plain text output' })

    const run = () => {
      out.classList.remove('muted')
      out.textContent = stripHtml(input.value) || '(empty)'
    }

    container.append(input, el('div', { class: 'row' }, [button('Strip to text', run, 'primary'), copyButton(() => out.textContent ?? '', ctx.clipboard.write)]), out)
  },
}

export default tool
