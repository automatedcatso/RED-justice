/**
 * aiJson.ts — Robust JSON extraction for LLM output.
 *
 * Bigger reasoning models (gpt-oss, QwQ, DeepSeek-R1, Qwen3-thinking…)
 * commonly wrap their answer in any of these shapes:
 *
 *   - a ```json fenced block                      (standard)
 *   - a plain ``` fenced block                    (sometimes mislabeled)
 *   - bare JSON object                            (well-behaved)
 *   - prose followed by a JSON block              ("Here is the result:")
 *   - <think>…</think> reasoning BEFORE the block (DeepSeek-R1 style)
 *   - an "analysis" channel before "final" text    (gpt-oss harmony style)
 *   - JSON broken across multiple lines with trailing commas
 *   - truncated JSON that still has balanced braces up to a point
 *
 * extractJsonObject() tries, in order:
 *   1. strip reasoning artifacts (<think>, harmony channels)
 *   2. ```json fenced blocks
 *   3. any other fenced blocks that start/end like an object
 *   4. balanced-brace scan for the largest valid {...} candidate,
 *      trying progressively shorter candidates (recovers truncation)
 *   5. repair pass: remove trailing commas + close unbalanced braces
 */

/** Remove common reasoning-channel artifacts from raw LLM text. */
export function stripReasoning(raw: string): string {
  let s = String(raw ?? '')
  // <think>…</think> (DeepSeek-R1, QwQ, some Qwen3 builds)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/<\|?(?:thought|thinking)\|?>[\s\S]*?<\/(?:thought|thinking)>/gi, '')
  // Unclosed <think> prefix — drop everything up to the LAST closing tag,
  // otherwise the model stopped mid-thought and the rest is unusable anyway.
  const lastClose = s.toLowerCase().lastIndexOf('</think>')
  if (/^\s*<think>/i.test(s) && lastClose !== -1) {
    s = s.slice(lastClose + 8)
  }
  // Harmony-style channels (gpt-oss): keep only what follows the FINAL
  // channel marker, e.g. …<|channel|>final<|message|>ANSWER
  const finalMatch = s.match(/<\|channel\|>\s*final\s*<\|message\|>([\s\S]*)/i)
  if (finalMatch) s = finalMatch[1]
  s = s.replace(/<\|(?:channel|message|end|start)\|>/g, '')
  return s.trim()
}

/** Balanced-brace scanner: returns the innermost-balanced object substrings. */
function balancedObjects(s: string): string[] {
  const out: string[] = []
  const stack: number[] = []
  let inStr: string | null = null
  let esc = false
  const starts: number[] = []

  // Record positions of top-level-ish object openings paired later.
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      continue
    }
    if (ch === '{') {
      stack.push(i)
    } else if (ch === '}') {
      const open = stack.pop()
      if (open !== undefined && stack.length === 0) out.push(s.slice(open, i + 1))
    }
  }
  return out
}

/** Remove trailing commas before } or ] — the most common model slip. */
function repairTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1')
}

/** Parse text as JSON after light repairs; returns undefined on failure. */
function tryParse(candidate: string): unknown | undefined {
  const attempts = [candidate, repairTrailingCommas(candidate)]
  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object') return v
    } catch {
      /* next */
    }
  }
  return undefined
}

/**
 * Extract the first parseable JSON OBJECT from raw model output.
 * Returns undefined when nothing parseable is found.
 */
export function extractJsonObject<T = Record<string, unknown>>(raw: string): T | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  const cleaned = stripReasoning(raw)

  // 1. ```json fences (first match wins; fall through on parse failure)
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi
  let fm: RegExpExecArray | null
  while ((fm = fenceRe.exec(cleaned)) !== null) {
    const body = (fm[1] ?? '').trim()
    if (body.startsWith('{')) {
      const parsed = tryParse(body)
      if (parsed !== undefined) return parsed as T
    }
  }

  // 2. Fenced block found but braces are unbalanced → repair-close it.
  fenceRe.lastIndex = 0
  while ((fm = fenceRe.exec(cleaned)) !== null) {
    const body = (fm[1] ?? '').trim()
    if (body.includes('{')) {
      const opens = (body.match(/\{/g) ?? []).length
      const closes = (body.match(/\}/g) ?? []).length
      if (opens > closes) {
        const repaired = body + '}'.repeat(opens - closes)
        const parsed = tryParse(repaired)
        if (parsed !== undefined) return parsed as T
      }
    }
  }

  // 3. Balanced-brace candidates anywhere in the text (longest first —
  //    the outermost object usually contains the most information).
  const candidates = balancedObjects(cleaned)
    .sort((a, b) => b.length - a.length)
    .slice(0, 12)
  for (const c of candidates) {
    const parsed = tryParse(c)
    if (parsed !== undefined) return parsed as T
  }

  // 4. Unbalanced truncation recovery: from the FIRST '{', progressively
  //    re-scan shorter tails closing braces at each step.
  const firstBrace = cleaned.indexOf('{')
  if (firstBrace !== -1) {
    let opens = 0
    let inStr2: string | null = null
    let esc2 = false
    for (let i = firstBrace; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inStr2) {
        if (esc2) esc2 = false
        else if (ch === '\\') esc2 = true
        else if (ch === inStr2) inStr2 = null
        continue
      }
      if (ch === '"' || ch === "'") {
        inStr2 = ch
        continue
      }
      if (ch === '{') opens++
      // At every spot where appending (opens-1) braces could balance,
      // try a cheap parse every 500 chars to bound cost.
      if (!inStr2 && i > firstBrace && i % 500 === 0) {
        const candidate = cleaned.slice(firstBrace, i + 1) + '}'.repeat(Math.max(0, opens))
        const parsed = tryParse(candidate)
        if (parsed !== undefined) return parsed as T
      }
    }
    const tail = cleaned.slice(firstBrace) + '}'.repeat(Math.max(0, opens))
    const parsed = tryParse(tail)
    if (parsed !== undefined) return parsed as T
  }

  return undefined
}

/**
 * Best-effort scalar/array getters that tolerate model variance.
 */
export function strArray(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : []
  return v
    .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max)
}
