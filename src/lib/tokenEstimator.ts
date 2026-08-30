/**
 * tokenEstimator.ts — v3.9 token-aware budgeting core.
 *
 * MASTER-PROMPT CONTRACT (extraction pipeline fix):
 *   1. Chunk sizes are computed in TOKENS, not chars. A fixed chars→token
 *      ratio (e.g. ÷4) is FORBIDDEN — identifier-heavy evidence (phones,
 *      IMEIs, account numbers, case numbers) tokenizes far less efficiently
 *      than prose and would silently overflow the context window.
 *   2. When the serving model exposes a real tokenizer (Ollama /api/tokenize
 *      — tokenizer DATA only, no weights download), we use exact counts.
 *   3. When it does not, the fallback heuristic is CONSERVATIVE (~3 chars per
 *      token for prose, ~2 for digit runs, 1 for CJK) — it deliberately
 *      OVERESTIMATES token usage so chunks fail SMALL, never overflow.
 *
 * Everything here is pure/synchronous at the core (the chunk planner must not
 * await); the live tokenizer probe is opt-in and its cached results flow back
 * into the sync path via `setMeasuredRatio`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Conservative heuristic estimator (no I/O — the always-available fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conservative chars-per-token rates. Real qwen-family BPE averages ~3.5-4
 * chars/token on English prose, but evidence documents are NOT prose-heavy:
 * digit runs, identifiers and transliterated names fragment into small
 * tokens. Every rate below is LOWER (worse) than reality so the estimate
 * lands HIGH — chunks shrink instead of overflowing.
 */
const RATE_PROSE = 3.0 // conservative prose fallback (master prompt: ~3 c/t)
const RATE_DIGITS = 2.0 // phones/IMEI/accounts fragment hard (~1.5-2.5 real)
const RATE_MIXED_ID = 1.8 // alphanumeric+separator identifiers (worst case)
const RATE_CJK = 1.0 // every CJK char is its own token
const RATE_OTHER = 3.0 // punctuation/whitespace ride along with neighbors

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const DIGIT_RUN_RE = /\d+/g
const MIXED_ID_RE = /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/gi

/** Sample the head, middle and tail of long text so budgets reflect the whole doc. */
function sampleText(text: string, maxLen = 12_000): string {
  if (text.length <= maxLen) return text
  const third = Math.floor(maxLen / 3)
  return (
    text.slice(0, third) +
    text.slice(Math.floor(text.length / 2) - Math.floor(third / 2), Math.floor(text.length / 2) + Math.ceil(third / 2)) +
    text.slice(-third)
  )
}

/**
 * CONSERVATIVE token estimate — never below the real count for practical
 * evidence content. Digit-heavy text is charged at ~2 chars/token (and
 * alphanumeric identifiers at 1.8) so their chunks shrink accordingly.
 */
export function estimateTokensHeuristic(text: string): number {
  if (!text) return 0
  const s = sampleText(text)
  const scale = text.length / s.length

  const cjkChars = (s.match(new RegExp(CJK_RE.source, 'g')) || []).length
  let consumed = cjkChars

  // Mixed alphanumeric identifiers first (they also contain digits — count
  // them before the pure-digit pass so their digits are not double-charged).
  let mixedChars = 0
  for (const m of s.matchAll(MIXED_ID_RE)) mixedChars += m[0].length
  consumed += mixedChars

  // Pure digit runs outside mixed ids: approximate overlap by scanning a
  // copy with mixed-id spans blanked.
  let digitChars = 0
  if (mixedChars > 0) {
    const blanked = s.replace(MIXED_ID_RE, (mm) => ' '.repeat(mm.length))
    digitChars = (blanked.match(DIGIT_RUN_RE) || []).reduce((a, r) => a + r.length, 0)
  } else {
    digitChars = (s.match(DIGIT_RUN_RE) || []).reduce((a, r) => a + r.length, 0)
  }
  consumed += digitChars

  const rest = s.length - consumed
  const tokens =
    Math.ceil(cjkChars * RATE_CJK) +
    Math.ceil(mixedChars / RATE_MIXED_ID) +
    Math.ceil(digitChars / RATE_DIGITS) +
    Math.ceil(Math.max(0, rest) / RATE_PROSE)
  return Math.max(1, Math.ceil(tokens * scale))
}

/** How digit-heavy is this text? 0 = pure prose, 1 = pure identifiers. */
export function digitDensity(text: string): number {
  const s = sampleText(text, 8_000)
  if (!s) return 0
  let idish = 0
  for (const m of s.matchAll(MIXED_ID_RE)) idish += m[0].length
  const blanked = s.replace(MIXED_ID_RE, (mm) => ' '.repeat(mm.length))
  idish += (blanked.match(DIGIT_RUN_RE) || []).reduce((a, r) => a + r.length, 0)
  return Math.min(1, idish / s.length)
}

/**
 * Conservative chars-per-token ratio for THIS text (≥1, ≤4). Used to convert
 * a token budget into the char budget the line-aligned planner consumes:
 * digit-heavy documents get a lower ratio ⇒ smaller chunks. Fail-small.
 */
export function conservativeCharsPerToken(text: string): number {
  const d = digitDensity(text)
  // Blend prose (3.0) toward identifier-heavy (1.9) by density. The result is
  // always ≤ RATE_PROSE so the derived char budget never exceeds the token
  // budget's true capacity.
  return Math.max(1.9, RATE_PROSE - d * (RATE_PROSE - 1.9))
}

/**
 * Convert a TOKEN budget into a conservative CHAR budget for `content`.
 * Guarantees: estimated tokens of the returned char budget ≤ budgetTokens.
 */
export function charBudgetForTokens(content: string, budgetTokens: number): number {
  const ratio = conservativeCharsPerToken(content)
  return Math.max(500, Math.floor(budgetTokens * ratio))
}

// ─────────────────────────────────────────────────────────────────────────────
// Live tokenizer (Ollama /api/tokenize — tokenizer data only, no weights)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenizeProbe {
  ok: boolean
  /** Measured chars/token from the live tokenizer (blended into the heuristic). */
  measuredRatio?: number
  at: number
}

const probes = new Map<string, TokenizeProbe>()
const PROBE_TTL_MS = 10 * 60_000

/** Cache of EXACT token counts per (model, text-hash). Bounded — evicts wholesale at 4K entries. */
const exactCache = new Map<string, number>()
const EXACT_CACHE_MAX = 4_096

function hashKey(model: string, text: string): string {
  // Cheap stable-enough key: length + fnv-1a over a sampled window.
  let h = 0x811c9dc5
  const s = sampleText(text, 4_096)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${model}:${text.length}:${h.toString(36)}`
}

/**
 * Probe whether the server exposes /api/tokenize for this model. Never
 * throws; a failed probe pins ok:false for the TTL so we stop asking.
 */
export async function probeTokenizer(
  baseUrl: string,
  model: string,
  opts?: { apiKey?: string; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<boolean> {
  const now = Date.now()
  const prev = probes.get(model)
  if (prev && now - prev.at < PROBE_TTL_MS) return prev.ok

  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const doFetch = opts?.fetchFn ?? fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts?.timeoutMs ?? 6_000)
  let ok = false
  let measuredRatio: number | undefined
  try {
    const res = await doFetch(`${root}/api/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts?.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, prompt: 'RED Justice tokenizer probe: account 9876543210, IMEI 356938035643809.' }),
      signal: ctl.signal,
    })
    if (res.ok) {
      const data = (await res.json()) as { tokens?: unknown }
      if (Array.isArray(data.tokens)) {
        ok = true
        const probeText = 'RED Justice tokenizer probe: account 9876543210, IMEI 356938035643809.'
        measuredRatio = probeText.length / Math.max(1, data.tokens.length)
      }
    }
  } catch {
    ok = false
  } finally {
    clearTimeout(timer)
  }
  probes.set(model, { ok, measuredRatio, at: now })
  return ok
}

/** Exact token count via the live tokenizer (null when unavailable). Cached. */
export async function countTokensExact(
  baseUrl: string,
  model: string,
  text: string,
  opts?: { apiKey?: string; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<number | null> {
  const p = probes.get(model)
  if (!p?.ok) return null
  const key = hashKey(model, text)
  const cached = exactCache.get(key)
  if (cached != null) return cached

  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const doFetch = opts?.fetchFn ?? fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts?.timeoutMs ?? 10_000)
  try {
    const res = await doFetch(`${root}/api/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts?.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, prompt: text.slice(0, 200_000) }),
      signal: ctl.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { tokens?: unknown }
    if (!Array.isArray(data.tokens)) return null
    const n = data.tokens.length
    if (exactCache.size >= EXACT_CACHE_MAX) exactCache.clear()
    exactCache.set(key, n)
    return n
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best available estimate: exact tokenizer count when probed, else the
 * conservative heuristic. This is what request sizing uses.
 */
export async function countTokensBest(
  baseUrl: string,
  model: string,
  text: string,
  opts?: { apiKey?: string; fetchFn?: typeof fetch },
): Promise<number> {
  const exact = await countTokensExact(baseUrl, model, text, opts).catch(() => null)
  if (exact != null) return exact
  return estimateTokensHeuristic(text)
}

/** Test hook: reset probe/cache state. */
export function resetTokenizerStateForTests(): void {
  probes.clear()
  exactCache.clear()
}

/** Test hook: inspect probe state. */
export function tokenizerProbeState(model: string): TokenizeProbe | undefined {
  return probes.get(model)
}

/** Test hook: pin a probe result (simulates a live /api/tokenize server). */
export function setTokenizerProbeForTests(model: string, ok: boolean, measuredRatio?: number): void {
  probes.set(model, { ok, measuredRatio, at: Date.now() })
}
