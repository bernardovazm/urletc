// Declarative automation interpreter, safe-by-construction (ARCHITECTURE section 7.1).
// The op set is a fixed discriminated-union whitelist: no eval, no Function, no
// dynamic dispatch by arbitrary string, no property access into host objects. It
// reads/writes only the value passed to it. The single dangerous op (text.replace,
// a ReDoS vector) runs in a worker with a hard wall-clock timeout that terminates
// the worker on overrun. This is why declarative tools get a lower consent barrier.

import { z } from '../core/zod'

export const StepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('json.parse') }),
  z.object({ op: z.literal('json.stringify'), indent: z.number().int().min(0).max(8).default(2) }),
  z.object({ op: z.literal('json.sortKeys'), recursive: z.boolean().default(false) }),
  z.object({ op: z.literal('text.upper') }),
  z.object({ op: z.literal('text.lower') }),
  z.object({ op: z.literal('text.trim') }),
  z.object({
    op: z.literal('text.replace'),
    pattern: z.string().max(200),
    flags: z.string().max(8).default('g'),
    replacement: z.string().max(500),
  }),
])
export type Step = z.infer<typeof StepSchema>

const REGEX_TIMEOUT_MS = 1000
const MAX_INPUT = 1_000_000

function asString(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? '')
}

function sortKeys(v: unknown, recursive: boolean): unknown {
  if (Array.isArray(v)) return recursive ? v.map((x) => sortKeys(x, true)) : v
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = recursive ? sortKeys(obj[k], true) : obj[k]
    return out
  }
  return v
}

/** Run user regex in a worker with a hard timeout; terminate on overrun (ReDoS guard). */
function safeRegexReplace(input: string, pattern: string, flags: string, replacement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../workers/re-engine.worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error('regex timed out (possible ReDoS), pattern rejected'))
    }, REGEX_TIMEOUT_MS)
    w.onmessage = (e) => {
      clearTimeout(timer)
      w.terminate()
      if (!e.data.ok) {
        reject(new Error(String(e.data.error)))
        return
      }
      const result = e.data.result as string
      if (typeof result === 'string' && result.length > MAX_INPUT) {
        reject(new Error('regex output too large'))
        return
      }
      resolve(result)
    }
    w.postMessage({ input, pattern, flags, replacement })
  })
}

export async function runAutomation(steps: Step[], input: string): Promise<string> {
  if (input.length > MAX_INPUT) throw new Error('input too large for automation')
  let value: unknown = input
  for (const step of steps) {
    switch (step.op) {
      case 'json.parse':
        value = JSON.parse(asString(value))
        break
      case 'json.stringify':
        value = JSON.stringify(value, null, step.indent)
        break
      case 'json.sortKeys':
        value = sortKeys(value, step.recursive)
        break
      case 'text.upper':
        value = asString(value).toUpperCase()
        break
      case 'text.lower':
        value = asString(value).toLowerCase()
        break
      case 'text.trim':
        value = asString(value).trim()
        break
      case 'text.replace':
        value = await safeRegexReplace(asString(value), step.pattern, step.flags, step.replacement)
        break
    }
    // Bound intermediate growth (e.g. replace amplification) so a step can't build a
    // giant string that blocks the main thread on the next op or the structured clone.
    if (typeof value === 'string' && value.length > MAX_INPUT) {
      throw new Error('intermediate value too large for automation')
    }
  }
  return asString(value)
}
