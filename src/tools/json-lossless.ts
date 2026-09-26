// JSON parsing that keeps every number exactly as written. JSON.parse turns each number
// into a float64, so an integer above 2^53 (a snowflake id, a database bigint, an order
// reference) comes back as a different number that still looks valid, and reformatting
// hands that changed value on to be copied. A reviver that receives the source text
// (the JSON.parse source text access proposal) returns the literal wrapped in JSON.rawJSON,
// which JSON.stringify emits unchanged.

interface SourceContext {
  source?: string
}

interface LosslessJson {
  parse(text: string, reviver: (key: string, value: unknown, context?: SourceContext) => unknown): unknown
  rawJSON?: (text: string) => unknown
  isRawJSON?: (value: unknown) => boolean
}

const J = JSON as unknown as LosslessJson

let support: boolean | undefined
function keepsLiterals(): boolean {
  if (support === undefined) {
    let seen = false
    if (typeof J.rawJSON === 'function') {
      J.parse('1', (_k, v, ctx) => {
        seen = ctx?.source === '1'
        return v
      })
    }
    support = seen
  }
  return support
}

/** Raised instead of returning a value that would print as a different number. */
export class JsonPrecisionError extends Error {}

function hasUnsafeInteger(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v)
  if (Array.isArray(v)) return v.some(hasUnsafeInteger)
  if (v && typeof v === 'object') return Object.values(v).some(hasUnsafeInteger)
  return false
}

/**
 * JSON.parse, except that a number whose text would change on output keeps its literal, so
 * JSON.stringify of the result prints it as it was written. Where the engine cannot supply
 * the literal, input holding an integer that float64 cannot represent throws
 * JsonPrecisionError rather than parsing to a changed value.
 */
export function parseJson(text: string): unknown {
  if (keepsLiterals()) {
    const raw = J.rawJSON as (text: string) => unknown
    return J.parse(text, (_k, v, ctx) => (typeof v === 'number' && ctx?.source !== undefined && String(v) !== ctx.source ? raw(ctx.source) : v))
  }
  const v: unknown = JSON.parse(text)
  if (hasUnsafeInteger(v)) throw new JsonPrecisionError('it holds an integer above 2^53, which this browser cannot keep exact')
  return v
}

/** Whether a parsed value is a kept literal, which must be passed through, never walked. */
export function isRawJson(v: unknown): boolean {
  return J.isRawJSON?.(v) ?? false
}
