/**
 * modelTiers.ts — the three-tier model routing system (v3.3).
 *
 * RED Justice never asks "which model?" — it asks "which TIER?", and each
 * tier is served by whatever model the investigator assigned to it:
 *
 *   FAST      ≤ 3B params (10m–3b)   — simple classification, obvious
 *                                        extraction, tiny structured docs.
 *                                        Chain-of-thought OFF (speed).
 *   STANDARD  3B–7B params           — contextual entity extraction,
 *                                        relationship candidates, chunk
 *                                        enrichment. CoT OFF (structured JSON).
 *   DEEP      7B+ params             — investigation reasoning, narrative
 *                                        explanations, complex relationship
 *                                        interpretation, escalation target.
 *                                        CoT ON where the server supports it.
 *
 * Deterministic extraction always runs FIRST (regex/registry/rows — zero
 * tokens). The tiers only serve what code cannot see.
 *
 * Assignment order:
 *   1. env LOCAL_AI_FAST_MODEL / LOCAL_AI_STANDARD_MODEL / LOCAL_AI_DEEP_MODEL
 *      (set in the UI or .env — MANUAL)
 *   2. auto-assign from the models actually installed on the server, ranked
 *      by parameter size: largest ≤3B → fast, largest 3–7B → standard,
 *      largest >7B → deep (AUTO)
 *   3. everything falls back to LOCAL_AI_MODEL (OFFLINE)
 *
 * A tier never hard-fails: if its model is missing from the server the call
 * simply goes to whatever Ollama answers with (server-side 404 → the normal
 * retry/error handling in localAi applies).
 */

export type ModelTier = 'fast' | 'standard' | 'deep'

export interface TierMeta {
  id: ModelTier
  label: string
  /** Human-readable parameter range this tier serves. */
  range: string
  /** What kinds of work is routed here. */
  purpose: string
  /** Chain-of-thought policy for calls on this tier. */
  cot: 'off' | 'on'
  /** Tailwind classes for the tier badge. */
  badgeClass: string
}

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'standard', 'deep']

export const TIER_META: Record<ModelTier, TierMeta> = {
  fast: {
    id: 'fast',
    label: 'Fast',
    range: '10M – 3B params',
    purpose:
      'Simple classification, obvious entity extraction, tiny structured documents (CDR rows, registers, small notes).',
    cot: 'off',
    badgeClass: 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300',
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    range: '3B – 7B params',
    purpose:
      'Contextual entity extraction, relationship candidates, evidence-chunk enrichment — the default scan brain.',
    cot: 'off',
    badgeClass: 'border-amber-600/50 bg-amber-950/30 text-amber-300',
  },
  deep: {
    id: 'deep',
    label: 'Deep',
    range: '7B+ params',
    purpose:
      'Investigation reasoning, narrative explanations, complex relationships, and escalation when a lower tier cannot resolve the task.',
    cot: 'on',
    badgeClass: 'border-purple-600/50 bg-purple-950/30 text-purple-300',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter-size parsing from model NAMES (Ollama encodes size in the tag)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the parameter size of a model name into billions of parameters.
 *
 *   "qwen3:4b"          → 4
 *   "qwen2.5:0.5b"      → 0.5
 *   "qwen3:30b-a3b"     → 30      (MoE: total params decide the tier)
 *   "llama3.2:1b"       → 1
 *   "deepseek-r1:8x7b"  → 56      (mixture 8×7B)
 *   "qwen3:270m"        → 0.27
 *   "gpt-oss:20b"       → 20
 *   "llama3.2"          → null    (no size in the name — needs a probe)
 *
 * When a colon tag exists the size is parsed from the tag part only, so
 * family names containing digits ("llama3.2", "qwen2.5") are never mistaken
 * for sizes.
 */
export function parseModelParamsB(name: string): number | null {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return null
  const tag = n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n

  // Mixture-of-experts "8x7b" / "8x22b" → multiply out (total params matter
  // for VRAM/latency, which is what tiering protects).
  const moe = tag.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/)
  if (moe) return parseFloat(moe[1]) * parseFloat(moe[2])

  // Prefer an explicit billions marker in the tag.
  const b = tag.match(/(\d+(?:\.\d+)?)\s*b\b/)
  if (b) return parseFloat(b[1])

  // Millions: "270m" → 0.27B.
  const m = tag.match(/(\d+(?:\.\d+)?)\s*m\b/)
  if (m) return parseFloat(m[1]) / 1000

  // No colon (custom name): fall back to a size marker anywhere in the name,
  // but only when it is not glued to a family version ("llama3.2" has no
  // unit letter directly after the number, so it is skipped correctly).
  const any = n.match(/(\d+(?:\.\d+)?)\s*(b|m)\b/)
  if (any) return any[2] === 'b' ? parseFloat(any[1]) : parseFloat(any[1]) / 1000
  return null
}

/**
 * Which tier does a model of this parameter size belong to?
 *   ≥ 7B        → deep
 *   ≥ 3B        → standard
 *   ≥ 0.01B(10M)→ fast
 *   unknown     → null (needs a probe)
 */
export function tierForParams(paramsB: number | null): ModelTier | null {
  if (paramsB == null || !(paramsB > 0)) return null
  if (paramsB >= 7) return 'deep'
  if (paramsB >= 3) return 'standard'
  return 'fast'
}

/** Tier from a model NAME; null when the name hides the size. */
export function inferModelTier(name: string): ModelTier | null {
  return tierForParams(parseModelParamsB(name))
}

/**
 * Tier from a name, using a probed parameter-size label ("8.0B") when
 * available. Probe wins: Ollama's /api/show reports the true parameter size
 * even for custom-named models.
 */
export function inferModelTierProbed(name: string, probedParamSize: string | null | undefined): ModelTier | null {
  if (probedParamSize) {
    const m = String(probedParamSize).match(/(\d+(?:\.\d+)?)\s*b/i)
    if (m) return tierForParams(parseFloat(m[1]))
  }
  return inferModelTier(name)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier assignment (env → auto from installed models → offline fallback)
// ─────────────────────────────────────────────────────────────────────────────

export interface TierAssignment {
  fast: string
  standard: string
  deep: string
  /** How the assignment was resolved. */
  source: 'env' | 'auto' | 'fallback'
}

const TIER_CACHE_TTL_MS = 5 * 60_000
let tierCache: { at: number; value: TierAssignment } | null = null

/** Invalidate the assignment cache (called after the user changes tiers). */
export function clearTierCache(): void {
  tierCache = null
}

function envTiers(): TierAssignment | null {
  const fast = process.env.LOCAL_AI_FAST_MODEL?.trim()
  const standard = process.env.LOCAL_AI_STANDARD_MODEL?.trim()
  const deep = process.env.LOCAL_AI_DEEP_MODEL?.trim()
  if (fast && standard && deep) return { fast, standard, deep, source: 'env' }
  return null
}

/**
 * Auto-assign tiers from the models actually installed on the local server,
 * ranked by parameter size (name-parsed, /api/show-probed when needed):
 *
 *   fast      ← largest model ≤ 3B (best quality inside the speed tier);
 *               when nothing is ≤3B, the SMALLEST installed model.
 *   standard  ← largest model in (3B, 7B]; when the range is empty, the
 *               model closest to 4B; last resort = the primary model.
 *   deep      ← largest model > 7B; when none, the largest overall.
 */
async function autoAssignTiers(): Promise<TierAssignment | null> {
  const { listLocalAiModels, probeModelParamSize } = await import('./localAi')
  const listing = await listLocalAiModels().catch(() => null)
  // Auto mode only makes sense against a live LOCAL server — a Gemini
  // fallback endpoint has exactly one model.
  if (!listing || !listing.available || listing.endpoint.includes('google-gemini')) return null
  const names = listing.models.map((m) => m.name).filter(Boolean)
  if (names.length === 0) return null

  const sized = new Map<string, number>()
  for (const name of names) {
    const fromName = parseModelParamsB(name)
    sized.set(name, fromName ?? (await probeModelParamSize(name)) ?? 0)
  }
  const ranked = [...names].sort((a, b) => (sized.get(a) ?? 0) - (sized.get(b) ?? 0))
  const params = (n: string) => sized.get(n) ?? 0

  const fast =
    ranked.filter((n) => params(n) > 0 && params(n) <= 3).pop() ?? ranked[0]
  const inStd = ranked.filter((n) => params(n) > 3 && params(n) <= 7)
  const standard =
    inStd.length > 0
      ? inStd[inStd.length - 1]
      : names.length > 1
        ? [...names].sort(
            (a, b) => Math.abs(params(a) - 4) - Math.abs(params(b) - 4),
          )[0]
        : ranked[0]
  const deep = ranked.filter((n) => params(n) > 7).pop() ?? ranked[ranked.length - 1]

  return { fast, standard, deep, source: 'auto' }
}

/**
 * Resolve the active tier assignment. Cheap after the first call (cached
 * 5 minutes). Never throws — the offline fallback routes every tier to the
 * primary LOCAL_AI_MODEL so behaviour matches pre-v3.3 single-model setups.
 */
export async function getTierAssignment(): Promise<TierAssignment> {
  if (tierCache && Date.now() - tierCache.at < TIER_CACHE_TTL_MS) return tierCache.value
  const fromEnv = envTiers()
  if (fromEnv) {
    tierCache = { at: Date.now(), value: fromEnv }
    return fromEnv
  }
  const auto = await autoAssignTiers().catch(() => null)
  if (auto) {
    tierCache = { at: Date.now(), value: auto }
    return auto
  }
  const { getLocalAiConfig } = await import('./localAi')
  const fallback: TierAssignment = {
    fast: getLocalAiConfig().model,
    standard: getLocalAiConfig().model,
    deep: getLocalAiConfig().model,
    source: 'fallback',
  }
  tierCache = { at: Date.now(), value: fallback }
  return fallback
}

/** The model serving a given tier right now. */
export async function modelForTier(tier: ModelTier): Promise<string> {
  const t = await getTierAssignment()
  return t[tier]
}

/**
 * Models used per tier for a scan/engine report: {fast: n, standard: n, deep: n}.
 */
export type TierUsage = Record<ModelTier, number>

export function emptyTierUsage(): TierUsage {
  return { fast: 0, standard: 0, deep: 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.9 — EXPLICIT PER-TIER CONTEXT CONTRACT (num_ctx / reserved / 90% margin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MASTER-PROMPT CONTEXT TABLE — every Ollama generation request carries an
 * EXPLICIT `num_ctx` from this contract; nothing relies on the server default
 * (Ollama's default context silently truncates long prompts).
 *
 *   Tier      | num_ctx  | reserved | usable  | 90% margin → chunk budget
 *   ----------|---------:|---------:|--------:|--------------------------:
 *   fast      |   8,192  |    1,024 |   7,168 |  ~6,451 tokens
 *   standard  |  16,384  |    2,048 |  14,336 | ~12,902 tokens
 *   deep      |  32,768  |    4,096 |  28,672 | ~25,805 tokens
 *
 * The FAST tier intentionally uses a SMALL working window (not the model's
 * 32K theoretical max): smaller prefill, faster sweeps, manageable chunks,
 * reduced blast radius when the 1.5B spotter makes a mistake.
 *
 * `reserved` covers the system prompt + wrappers + the output allocation;
 * the 90% safety margin on the remainder becomes the CHUNK budget the
 * planners enforce (fail-small, never overflow).
 */
export interface TierContextContract {
  /** Explicit num_ctx sent with every Ollama request on this tier. */
  numCtx: number
  /** Tokens reserved for system prompt + wrapper + output. */
  reservedTokens: number
  /** numCtx − reserved. */
  usableTokens: number
  /** floor(usable × 0.90) — the chunk CONTENT budget planners enforce. */
  chunkBudgetTokens: number
  /** Max OUTPUT tokens requested from this tier (≤ reserved). */
  maxOutputTokens: number
}

const TIER_CONTRACT_DEFAULTS: Record<ModelTier, Omit<TierContextContract, 'usableTokens' | 'chunkBudgetTokens'>> = {
  fast: { numCtx: 8_192, reservedTokens: 1_024, maxOutputTokens: 1_800 },
  standard: { numCtx: 16_384, reservedTokens: 2_048, maxOutputTokens: 2_500 },
  deep: { numCtx: 32_768, reservedTokens: 4_096, maxOutputTokens: 6_000 },
}

const CONTRACT_ENV: Record<ModelTier, { ctx: string; reserved: string; out: string }> = {
  fast: { ctx: 'LOCAL_AI_FAST_NUM_CTX', reserved: 'LOCAL_AI_FAST_RESERVED_TOKENS', out: 'LOCAL_AI_FAST_MAX_TOKENS' },
  standard: { ctx: 'LOCAL_AI_STD_NUM_CTX', reserved: 'LOCAL_AI_STD_RESERVED_TOKENS', out: 'LOCAL_AI_STD_MAX_TOKENS' },
  deep: { ctx: 'LOCAL_AI_DEEP_NUM_CTX', reserved: 'LOCAL_AI_DEEP_RESERVED_TOKENS', out: 'LOCAL_AI_DEEP_MAX_TOKENS' },
}

/** The safety margin applied to usable tokens before chunk budgeting. */
export const CHUNK_SAFETY_MARGIN = 0.9

/**
 * The context contract for a tier. `profileContextTokens` (the serving
 * model's REAL window when probed) clamps num_ctx down — we never allocate a
 * bigger window than the model actually has — and everything downstream
 * (usable, chunk budget, output cap) follows the clamped value.
 */
export function tierContextContract(
  tier: ModelTier,
  profileContextTokens?: number | null,
): TierContextContract {
  const def = TIER_CONTRACT_DEFAULTS[tier]
  const env = CONTRACT_ENV[tier]
  const envNumCtx = parseInt(process.env[env.ctx] ?? '0', 10)
  const envReserved = parseInt(process.env[env.reserved] ?? '0', 10)
  const envOut = parseInt(process.env[env.out] ?? '0', 10)

  let numCtx = envNumCtx > 0 ? envNumCtx : def.numCtx
  const reservedTokens = envReserved > 0 ? envReserved : def.reservedTokens
  // NOTE: `reserved` carves the window (system prompt + wrappers + output
  // allowance) out of num_ctx for CHUNK budgeting — it is NOT a cap on any
  // single output request. Deep-tier calls may legitimately ask for 6-8K
  // output tokens; resolveNumCtx sizes num_ctx to cover the actual prompt +
  // output when that exceeds the tier default (emergency, never truncate).
  const maxOutputTokens = envOut > 0 ? envOut : def.maxOutputTokens

  // Never allocate beyond the model's real window (probed via /api/show).
  if (profileContextTokens && profileContextTokens > 0 && numCtx > profileContextTokens) {
    numCtx = profileContextTokens
  }
  numCtx = Math.max(numCtx, 2_048) // sanity floor
  const usableTokens = Math.max(512, numCtx - reservedTokens)
  // Math.round reproduces the master-prompt table exactly:
  // 7,168×0.9→6,451 · 14,336×0.9→12,902 · 28,672×0.9→25,805.
  const chunkBudgetTokens = Math.max(256, Math.round(usableTokens * CHUNK_SAFETY_MARGIN))
  return { numCtx, reservedTokens, usableTokens, chunkBudgetTokens, maxOutputTokens }
}

/**
 * Which tier contract applies to a model name? Matches the ACTIVE tier
 * assignment (exact model → its tier), falling back to size inference from
 * the name (≥7B deep, ≥3B standard, else fast).
 */
export async function tierForModel(model: string): Promise<ModelTier> {
  const t = await getTierAssignment()
  for (const tier of MODEL_TIERS) {
    if (t[tier] === model) return tier
  }
  return inferModelTier(model) ?? 'standard'
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.8 — PER-TIER CONTEXT BUDGETS + DYNAMIC (UNCAPPED-BY-DEFAULT) LIMITS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reference context windows for the default tier fleet (tokens, from the
 * vendors' model cards):
 *
 *   qwen2.5:1.5b   (FAST)      32,768 tokens native
 *   qwen3:4b       (STANDARD)  32,768 tokens native (131,072 with YaRN)
 *   qwen3:8b       (DEEP)      32,768 tokens native (131,072 with YaRN)
 *   glm-4.5-flash  (FAST)      128K tokens
 *   glm-4.5-air    (STANDARD)  128K tokens
 *   glm-4.6        (DEEP)      200K tokens
 *
 * v3.9: chunk planning is TOKEN-based (see tokenEstimator.ts) and bounded by
 * the EXPLICIT per-tier context contract above; the historical v3.8 quality
 * zones survive as the tightened operating points inside that ceiling.
 */
const ENV_KEYS: Record<ModelTier, { input: string; overlap: string; out: string }> = {
  fast: { input: 'LOCAL_AI_FAST_INPUT_CHARS', overlap: 'LOCAL_AI_FAST_OVERLAP_CHARS', out: 'LOCAL_AI_FAST_MAX_TOKENS' },
  standard: { input: 'LOCAL_AI_STD_INPUT_CHARS', overlap: 'LOCAL_AI_STD_OVERLAP_CHARS', out: 'LOCAL_AI_STD_MAX_TOKENS' },
  deep: { input: 'LOCAL_AI_DEEP_INPUT_CHARS', overlap: 'LOCAL_AI_DEEP_OVERLAP_CHARS', out: 'LOCAL_AI_DEEP_MAX_TOKENS' },
}

/**
 * The context budget for a tier. v3.9: derived from the EXPLICIT context
 * contract (num_ctx / reserved / 90% margin), then further tightened to the
 * QUALITY ZONE — the operating point where small local models were actually
 * tested to follow instructions (well inside the window). Both layers are
 * env-overridable; the contract layer is additionally clamped by the serving
 * model's probed window. Chunks therefore can NEVER overflow the tier's
 * explicit num_ctx, and in practice stay in the smaller quality zone
 * (fail-small, per the master prompt).
 */
export interface TierContextBudgetV3 {
  /** Chunk CONTENT budget in TOKENS (the real planning unit). */
  chunkBudgetTokens: number
  /** Compat char view of the token budget at the WORST-case prose ratio (3.0).
   *  Content-aware callers must instead use charBudgetForTokens(content, chunkBudgetTokens). */
  inputChars: number
  /** Overlap between consecutive chunks (chars; entities at boundaries are
   *  seen by BOTH chunks, then deduplicated by the merge court). */
  overlapChars: number
  /** Max OUTPUT tokens requested from this tier. */
  maxOutputTokens: number
  /** The underlying explicit context contract (num_ctx et al). */
  contract: TierContextContract
}

const QUALITY_ZONE_TOKENS: Record<ModelTier, number> = {
  // v3.8 tested operating points, converted at the conservative 3 c/t ratio:
  // a 1.5B spotter is only reliable on short single-purpose prompts; the 4B
  // maker likes ~4.7K tokens; deep reasoning scales to ~8K.
  fast: 2_667,
  standard: 4_667,
  deep: 8_000,
}

export function tierContextBudget(
  tier: ModelTier,
  profileContextTokens?: number | null,
): TierContextBudgetV3 {
  const contract = tierContextContract(tier, profileContextTokens)
  const env = ENV_KEYS[tier]

  // Effective token budget: quality zone ∩ contract chunk budget, with the
  // env char input honoured (converted at 3 c/t) when the operator overrides.
  const zoneTokens = QUALITY_ZONE_TOKENS[tier]
  let chunkBudgetTokens = Math.min(zoneTokens, contract.chunkBudgetTokens)
  const envInputChars = parseInt(process.env[env.input] ?? '0', 10)
  if (envInputChars > 0) {
    chunkBudgetTokens = Math.min(
      contract.chunkBudgetTokens,
      Math.max(500, Math.floor(envInputChars / 3)),
    )
  }
  const overlapChars = parseInt(process.env[env.overlap] ?? '0', 10) || DEFAULT_OVERLAP_CHARS[tier]
  const maxOutputTokens = parseInt(process.env[env.out] ?? '0', 10) || contract.maxOutputTokens

  return {
    chunkBudgetTokens: Math.max(256, chunkBudgetTokens),
    inputChars: Math.max(1_500, chunkBudgetTokens * 3),
    overlapChars: Math.min(Math.max(0, overlapChars), Math.floor((chunkBudgetTokens * 3) / 4)),
    maxOutputTokens,
    contract,
  }
}

const DEFAULT_OVERLAP_CHARS: Record<ModelTier, number> = {
  fast: 240,
  standard: 320,
  deep: 400,
}

/**
 * v3.9 ENTITY ALLOWANCE — NOT an entity-count limit. There is NO artificial
 * cap on extracted entities (master prompt: entity count is a quality-gated
 * OUTCOME, never a capacity). This function returns the PATHOLOGICAL guard
 * that protects the process from regex-bomb content (a 500MB string of
 * "1234567890" repeats); its value scales with document size and can never
 * bind a real document: a 6,374-entity bank trail uses 2.5% of it. If a
 * genuine document ever exceeds the allowance, the deterministic extractor
 * warns LOUDLY and keeps going with the first N — the guard is a memory
 * safety valve, not a pipeline policy.
 */
export function dynamicEntityCap(contentChars: number): number {
  const env = parseInt(process.env.RJ_MAX_DET_ENTITIES ?? '0', 10)
  const floor = env > 0 ? env : 4_000
  const bySize = Math.ceil(Math.max(0, contentChars) / 20) // ~1 entity per 20 chars of the densest registry
  return Math.min(Math.max(floor, bySize), 250_000)
}

/**
 * v3.8 DYNAMIC graph node limit — the graph API's default `limit` scales with
 * the case instead of a fixed 300: small cases show everything, big cases
 * render up to `maxNodes` highest-degree nodes. The UI can always override
 * with ?limit=; this is only the DEFAULT.
 */
export function dynamicGraphLimit(caseEntityCount: number, maxNodes = 3_000): number {
  const n = Math.max(0, Math.floor(caseEntityCount))
  return Math.min(Math.max(300, n), maxNodes)
}
