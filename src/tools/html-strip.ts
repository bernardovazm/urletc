import type { ToolContext, ToolModule } from '../shell/registry'
import { button, copyButton, el } from '../shell/ui'

// `DOMParser.parseFromString` is a TrustedHTML sink, like innerHTML, outerHTML,
// insertAdjacentHTML, document.write and Range.createContextualFragment. The CSP sets
// `require-trusted-types-for 'script'` and the default policy in src/core/trusted-types.ts
// implements only createScriptURL, so handing this sink a plain string threw "This document
// requires 'TrustedHTML' assignment" and the tool did nothing in production.
//
// The fix is a narrow named policy rather than `createHTML` on the default policy. A named
// policy is reachable only through the policy object this module holds, so no other call
// site in the app gains an HTML sink. Adding createHTML to the default policy would reopen
// innerHTML for the entire bundle to make one tool work.
//
// Pass-through is safe here because nothing is executed or attached:
//   * parseFromString(..., 'text/html') builds an inert document with no browsing context,
//     so <script> never runs and event-handler attributes never fire.
//   * that document is never inserted into the live DOM.
//   * only textContent is read back out, so no markup survives the round trip.

// Minimal local shape, because the Trusted Types lib types are not in this TS target's
// lib.dom. createHTML returns a TrustedHTML at runtime, which is what the sink accepts;
// typing it as string satisfies the compiler without pulling in the lib.
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
    // string so the failure surfaces as the browser's sink error rather than a wrong answer.
    cached = null
  }
  return cached
}

// Elements whose textContent is source code rather than page text. Left in place,
// "<p>hi</p><script>alert(1)</script>" strips to "hialert(1)".
const NON_TEXT = 'x-strip-script, x-strip-style, script, style, noscript, template'

// script and style elements are renamed, and style attributes with them, before parsing
// rather than removed afterwards. Chromium evaluates style-src against both even inside the
// inert document DOMParser builds, so real-world markup logged "Applying inline style
// violates ... style-src 'self'" on every strip, once per style attribute, and an HTML mail
// body carries hundreds. Removing them afterwards is too late, since the violation has
// already been reported. Under a custom tag name the content is inert text, and under a
// renamed attribute no CSS is parsed. The element names stay in NON_TEXT so the subtree is
// dropped either way, including anything this misses.
//
// The attribute pass is confined to spans the HTML parser reads as a tag, because stripHtml
// returns textContent, where the literal text "style=" is ordinary body copy that must
// survive. Matching the name alone defuses quoted, single-quoted and unquoted values
// identically and leaves every value byte intact.
const TAG_SPAN = /<[a-zA-Z][^>]*>/g
// Leading whitespace or quote pins the match to a whole attribute name, so `data-style` and
// the already rewritten `x-strip-style` are left alone. The optional prefix covers
// namespaced forms such as `xlink:style` in inline SVG.
const STYLE_ATTR = /([\s"'])(?:[a-zA-Z_][\w.-]*:)?style(\s*=)/gi

const neutralize = (html: string) => html.replace(/<(\/?)(script|style)\b/gi, '<$1x-strip-$2').replace(TAG_SPAN, (tag) => tag.replace(STYLE_ATTR, '$1x-strip-style$2'))

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
