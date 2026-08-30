/**
 * localAi.ts — Model-Aware Local AI Engine for RED Justice.
 *
 * Works with ANY OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp
 * server, vLLM, Jan, text-generation-webui…), and auto-optimizes itself for
 * whatever model is loaded — from 1B tiny models to 20B+ reasoning models
 * with huge context windows.
 *
 * What the engine handles automatically:
 *
 *   1. PROVIDER DETECTION      Ollama native API vs OpenAI-compatible /v1.
 *                              On Ollama we use /api/chat + options.num_ctx,
 *                              which is REQUIRED for big prompts (Ollama's
 *                              default context is only ~4K tokens and large
 *                              prompts are silently truncated otherwise).
 *   2. MODEL PROBING           /api/show reveals context length, parameter
 *                              size and "thinking" capability. Cached per model.
 *   3. REASONING MODELS        gpt-oss / DeepSeek-R1 / QwQ / Qwen3-thinking:
 *                              recommended temperature, big token budget for
 *                              the thinking phase, thinking-channel parsing
 *                              (message.thinking / reasoning_content /
 *                              <think> tags), optional think-off when safe —
 *                              with graceful fallback when a server rejects
 *                              the think toggle (older Ollama + gpt-oss).
 *   4. CONTEXT BUDGETING       getContentBudgetChars() tells callers how much
 *                              document text fits in a single prompt with the
 *                              current model's window, so huge-context models
 *                              actually USE their window instead of a hardcoded
 *                              12K chars. num_ctx is sized PER REQUEST to what the
 *                              prompt actually needs (capped by
 *                              LOCAL_AI_MAX_NUM_CTX, default 32768) — asking
 *                              Ollama for the full 131072-token window of a
 *                              20B model causes giant KV-cache allocations,
 *                              glacial loads and aborted requests. NOTE: for
 *                              LOCAL models the single-pass budget is capped at
 *                              12K chars by default (see LOCAL_AI_MAX_INPUT_CHARS)
 *                              — dense documents extract completely via
 *                              map-reduce chunks instead of one giant, slow,
 *                              truncation-prone call.
 *   5. STREAMING PLUMBING      Chat requests stream internally (NDJSON from
 *                              Ollama, SSE from OpenAI-compat) with an IDLE
 *                              watchdog, not just a total timeout: a healthy
 *                              generation may legitimately run for many
 *                              minutes on 20B models; a dead server is cut
 *                              quickly instead.
 *   6. ROBUST OUTPUT           think-stripping + fenced/balanced JSON
 *                              extraction via aiJson.ts helpers; timeout-type
 *                              failures retry with a LONGER budget and the
 *                              same payload; empty answers retry once with a
 *                              format nudge. Retries DROP the JSON grammar
 *                              (the think:false+format:"json" combination
 *                              stalls/empties on several Qwen3 Ollama builds).
 *   7. CALL SERIALIZATION      Local calls are serialized in-process: local
 *                              servers generate one request at a time, and a
 *                              queued second request looks exactly like a
 *                              hang to the silence watchdog.
 *
 * Configuration via environment variables:
 *   LOCAL_AI_BASE_URL     — OpenAI-compatible base URL
 *                           (default: http://localhost:11434/v1)
 *   LOCAL_AI_MODEL        — model name (default: llama3.2). Serves as the
 *                           offline fallback for every tier when no tier
 *                           models are assigned.
 *   LOCAL_AI_FAST_MODEL    — model for the FAST tier (≤3B class): simple
 *   LOCAL_AI_STANDARD_MODEL  classification + obvious extraction.        (v3.3
 *   LOCAL_AI_DEEP_MODEL    — 7B+ reasoning tier: investigator chat, tiered model routing; see
 *                           narrative explanations, escalation.)      modelTiers.ts)
 *   LOCAL_AI_API_KEY      — API key if required (default: empty)
 *   LOCAL_AI_TIMEOUT_MS   — total request timeout; default adapts to model
 *                           size & workload (180s small → up to 900s for
 *                           13B+/thinking models on big prompts). The idle
 *                           watchdog (below) usually fires first on hangs.
 *   LOCAL_AI_IDLE_MS      — abort when NO streaming bytes arrive for this
 *                           long (default 150s). Protects against dead/hung
 *                           servers without killing slow-but-progressing ones.
 *   LOCAL_AI_MAX_NUM_CTX  — hard cap on Ollama num_ctx allocation, tokens
 *                           (default 32768). Raise only if your machine has
 *                           VRAM/RAM for the model's full advertised window.
 *   LOCAL_AI_NUM_CTX      — override detected context length in tokens
 *   LOCAL_AI_MAX_TOKENS   — override max output tokens
 *   LOCAL_AI_THINK        — 'auto' | 'on' | 'off'  (default: auto;
 *                           'off' = disable CoT everywhere it's supported).
 *                           Note: structured scans ALWAYS request think:false
 *                           on hybrid models (Qwen3/Qwen3.5/gpt-oss…) —
 *                           extraction quality is unaffected and it is
 *                           5-10× faster. Open-ended reasoning (AI
 *                           Investigator, link narratives) keeps the model's
 *                           default thinking so answer quality is preserved.
 *   LOCAL_AI_JSON_MODE    — 'off' disables the JSON grammar constraint for
 *                           structured calls (Ollama format:"json" /
 *                           response_format json_object). Default: on.
 *   LOCAL_AI_KEEP_ALIVE   — Ollama keep_alive for loaded models
 *                           (default '30m'; prevents reload thrash).
 *   LOCAL_AI_MAX_INPUT_CHARS — cap on document text per single prompt for
 *                           LOCAL models (default 12000). Dense forensic
 *                           documents larger than this are scanned via
 *                           map-reduce chunks: every call stays small and
 *                           fast, and the merged extraction is complete
 *                           instead of truncated by the output budget.
 *                           Raise it only on big-GPU machines to trade fewer
 *                           calls for larger prompts.
 */

import { stripReasoning } from './aiJson'
import { getGeminiProviderConfig } from './geminiProvider'
import {
  estimateTokensHeuristic,
  probeTokenizer,
  countTokensExact,
} from './tokenEstimator'
import type { ModelTier } from './modelTiers'
import { inferModelTier, tierContextContract, getTierAssignment, MODEL_TIERS } from './modelTiers'

export interface LocalAiConfig {
  baseUrl: string
  model: string
  apiKey: string
  timeoutMs: number
}

export function getLocalAiConfig(): LocalAiConfig {
  return {
    baseUrl: process.env.LOCAL_AI_BASE_URL ?? 'http://localhost:11434/v1',
    // v3.9.1: the legacy single-model knob was never set by tier-based
    // deployments (.env ships LOCAL_AI_{FAST,STANDARD,DEEP}_MODEL), so the
    // status panel kept advertising a phantom "llama3.2". Fall through to the
    // FAST tier — the brain that actually serves most calls.
    model:
      process.env.LOCAL_AI_MODEL
      ?? process.env.LOCAL_AI_FAST_MODEL
      ?? 'llama3.2',
    apiKey: process.env.LOCAL_AI_API_KEY ?? '',
    timeoutMs: parseInt(process.env.LOCAL_AI_TIMEOUT_MS ?? '0', 10) || 0,
  }
}

export function isLocalAiConfigured(): boolean {
  return true
}

/**
 * Which chat backend serves this deployment. LOCAL-FIRST: your own
 * Ollama / OpenAI-compatible server is the primary brain; Google Gemini
 * is the cloud FALLBACK only.
 *
 *   local  — the configured OpenAI-compatible endpoint (Ollama, LM Studio, …)
 *   gemini — Google Gemini via the generativelanguage REST API
 *
 * Selection order (AI_PROVIDER env overrides everything):
 *   1. AI_PROVIDER=local         → always the configured local endpoint
 *   2. AI_PROVIDER=gemini        → always Gemini
 *   3. auto (default)            → local endpoint when reachable, otherwise
 *                                  Gemini (when GEMINI_API_KEY is set) so the
 *                                  Fully-AI pipeline keeps a brain available.
 */
export type AiProviderChoice = 'local' | 'gemini' | 'auto'

export function getAiProviderChoice(): AiProviderChoice {
  const v = (process.env.AI_PROVIDER ?? 'auto').toLowerCase()
  if (v === 'local' || v === 'ollama' || v === 'openai-compat') return 'local'
  if (v === 'gemini' || v === 'google' || v === 'zai' || v === 'cloud') return 'gemini'
  return 'auto'
}

/** Normalize the configured base URL: strip trailing slash + '/v1'. */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Endpoints used per provider. */
function endpoints(baseUrl: string) {
  const root = ollamaRoot(baseUrl)
  return {
    root,
    nativeTags: `${root}/api/tags`,
    nativeShow: `${root}/api/show`,
    nativeChat: `${root}/api/chat`,
    compatModels: `${baseUrl.replace(/\/+$/, '')}/models`,
    compatChat: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    altCompatChat: `${root}/v1/chat/completions`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model profile probing (cached)
// ─────────────────────────────────────────────────────────────────────────────

export type AiProvider = 'ollama' | 'openai-compat' | 'gemini' | 'zai'

export interface ModelProfile {
  provider: AiProvider
  /** Context window in tokens — probed, env-overridden, or sensible default. */
  contextTokens: number
  /** Probed from the server (as opposed to defaulted)? */
  contextProbed: boolean
  /** Parameter size label like "20B" / "7.6B" when reported. */
  paramSize: string | null
  /** Model family (llama, qwen2, gpt-oss…). */
  family: string | null
  /** Does this model emit visible chain-of-thought? */
  thinkingCapable: boolean
  /** Recommended temperature for structured extraction tasks. */
  temperature: number
  /** Max output tokens we will request. */
  maxOutputTokens: number
  /** Effective request timeout ms. */
  timeoutMs: number
  probedAt: number
}

const PROFILE_TTL_MS = 10 * 60_000
let profileCache: Map<string, { profile: ModelProfile }> | null = null

/**
 * Known reasoning-model name patterns.
 *
 * IMPORTANT: the whole Qwen3+ family (qwen3, qwen3.5, qwen3-coder, qwen4…
 * — anything matching `qwen<3-9>`) is HYBRID: Ollama enables THINKING BY
 * DEFAULT even though these models also answer excellently without it.
 * Detecting them as thinking-capable is what lets structured scan calls
 * send `think:false` (5-10× faster, zero quality loss on extraction) and
 * size watchdog budgets for their real behaviour. Missing "qwen3.5" here
 * previously made every scan think invisibly for minutes and get murdered
 * by the 240s small-model total budget, then pay the cost AGAIN on retry.
 */
const REASONING_NAME_RE =
  /(gpt[-_]?oss|deepseek[-_]?r1|qwq|qwen[-_ ]?[3-9]|think(?:ing)?$|reasoner|harmony)/i

async function fetchWithTimeout(url: string, init: RequestInit & { headers?: Record<string, string> }, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(cfg: LocalAiConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
}

/** Provider detection result, cached briefly (it fetches on every call otherwise). */
let providerDetectCache: { at: number; value: AiProvider } | null = null

/** Is an Ollama-native server reachable at this root? */
async function detectProvider(cfg: LocalAiConfig): Promise<AiProvider> {
  if (providerDetectCache && Date.now() - providerDetectCache.at < 60_000) {
    return providerDetectCache.value
  }
  // v3.8 Z.ai GLM: `LOCAL_AI_BASE_URL=zai://glm` (or LOCAL_AI_PROVIDER=zai)
  // routes every tier through the z-ai-web-dev-sdk — no HTTP endpoint needed.
  // Fail-soft: when the SDK package is not installed we fall through to the
  // normal endpoint detection so the app still boots.
  if (isZaiEndpoint(cfg)) {
    try {
      await loadZaiSdk()
      providerDetectCache = { at: Date.now(), value: 'zai' }
      return 'zai'
    } catch {
      console.warn(
        '[localAi] LOCAL_AI_BASE_URL=zai://glm but the z-ai-web-dev-sdk package is not installed — falling back to endpoint detection (bun/npm i z-ai-web-dev-sdk to enable GLM)',
      )
    }
  }
  const ep = endpoints(cfg.baseUrl)
  let detected: AiProvider = 'openai-compat'
  try {
    const res = await fetchWithTimeout(
      ep.nativeTags,
      { headers: authHeaders(cfg) },
      4000,
    )
    if (res.ok) {
      const j = await res.json().catch(() => null)
      if (j && Array.isArray(j.models)) detected = 'ollama'
    }
  } catch {
    /* not ollama */
  }
  if (detected === 'openai-compat') {
    // Is ANY OpenAI-compatible chat server alive at the configured URL?
    try {
      const res = await fetchWithTimeout(
        ep.compatModels,
        { headers: authHeaders(cfg) },
        4000,
      )
      if (res.ok) detected = 'openai-compat'
    } catch {
      /* not reachable */
    }
  }
  if (detected === 'openai-compat') {
    // Local-first with Gemini fallback: when no local server answers, keep the
    // Fully-AI pipeline alive through Google Gemini (if a key is configured).
    if (getAiProviderChoice() === 'auto') {
      const { isGeminiAvailable } = await import('./geminiProvider')
      if (await isGeminiAvailable()) detected = 'gemini'
    }
  }
  providerDetectCache = { at: Date.now(), value: detected }
  return detected
}

/** True when the configured brain is the Z.ai GLM SDK bridge. */
export function isZaiEndpoint(cfg: LocalAiConfig = getLocalAiConfig()): boolean {
  return cfg.baseUrl.trim().toLowerCase().startsWith('zai://')
    || (process.env.LOCAL_AI_PROVIDER ?? '').trim().toLowerCase() === 'zai'
}

/**
 * Load the OPTIONAL z-ai-web-dev-sdk. The specifier is built at runtime so
 * bundlers cannot trace it (Turbopack tried to inline the SDK into a
 * client-component SSR chunk and died on its 'fs/promises' import) — the
 * package is require()d at runtime ONLY on machines that installed it, and
 * the caller fail-softs when it is absent.
 */
async function loadZaiSdk(): Promise<unknown> {
  const specifier = ['z-ai', '-web-dev-sdk'].join('')
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ specifier)
}

interface OllamaShowResponse {
  license?: string
  modelfile?: string
  parameters?: string
  template?: string
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
  model_info?: Record<string, unknown>
  capabilities?: string[]
}

function parseParamSize(show: OllamaShowResponse | null): string | null {
  const d = show?.details?.parameter_size
  if (d) return String(d)
  const info = show?.model_info ?? {}
  for (const [k, v] of Object.entries(info)) {
    if (/general\.parameter_size/i.test(k)) return String(v)
  }
  return null
}

function parseContextLength(show: OllamaShowResponse | null): number | null {
  const info = show?.model_info ?? {}
  let best: number | null = null
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
      best = best === null ? v : Math.max(best, v)
    }
  }
  // Fall back to num_ctx stated in the Modelfile parameters ("num_ctx 8192").
  if (best === null && show?.parameters) {
    const m = show.parameters.match(/num_ctx\s+(\d+)/i)
    if (m) best = parseInt(m[1], 10)
  }
  return best
}

function parseThinkingCapable(modelName: string, show: OllamaShowResponse | null): boolean {
  if (Array.isArray(show?.capabilities) && show.capabilities.some((c) => /think/i.test(String(c)))) {
    return true
  }
  const tmpl = String(show?.template ?? '')
  if (/think|harmony|analysis/i.test(tmpl) && /channel|think/i.test(tmpl)) return true
  return REASONING_NAME_RE.test(modelName)
}

function recommendedTemperature(modelName: string, thinking: boolean): number {
  if (/gpt[-_]?oss/i.test(modelName)) return 1.0 // vendor-recommended
  if (/deepseek[-_]?r1|qwq/i.test(modelName)) return 0.6
  if (thinking) return 0.6
  return 0.2
}

/** Compute adaptive timeout + output budget from detected size/class. */
function computeBudgets(modelName: string, paramSize: string | null, thinking: boolean) {
  const billions = (() => {
    const m = (paramSize ?? modelName).match(/(\d+(?:\.\d+)?)\s*b/i)
    return m ? parseFloat(m[1]) : null
  })()
  const bigModel = (billions !== null && billions >= 13) || thinking
  const envMax = parseInt(process.env.LOCAL_AI_MAX_TOKENS ?? '0', 10)
  const envTimeout = getLocalAiConfig().timeoutMs
  return {
    maxOutputTokens: envMax > 0 ? envMax : thinking ? 12288 : bigModel ? 8192 : 4096,
    // 20B+ models easily need 10-15 minutes for a large scan (prefill of tens
    // of thousands of chars + thousands of output tokens). The idle watchdog
    // protects against genuinely dead servers; the total budget just has to
    // be generous enough not to kill healthy generations.
    timeoutMs: envTimeout > 0 ? envTimeout : bigModel ? 900_000 : 240_000,
  }
}

/**
 * Hard cap on Ollama `num_ctx` allocations. gpt-oss:20b advertises a
 * 131072-token window; requesting it verbatim makes Ollama allocate KV cache
 * for ALL of it, which on typical hardware either swaps to RAM or takes so
 * long that requests look hung and abort. Default cap keeps allocation sane;
 * owners of big GPUs can raise LOCAL_AI_MAX_NUM_CTX.
 */
export function maxNumCtxCap(): number {
  const v = parseInt(process.env.LOCAL_AI_MAX_NUM_CTX ?? '0', 10)
  return v > 0 ? v : 32768
}

/** Context window we may actually use: probed ∩ hard cap. */
export function effectiveContextTokens(profile: ModelProfile | null): number {
  // The num_ctx cap is an Ollama KV-cache allocation concern only — the
  // Gemini cloud provider has no such allocation and uses its full window.
  if (profile?.provider === 'gemini') return profile.contextTokens
  return Math.min(profile?.contextTokens ?? 8192, maxNumCtxCap())
}

/** Invalidate cached provider detection (e.g. after server restart). */
export function clearProviderDetectionCache(): void {
  providerDetectCache = null
}

/**
 * Probe (or fetch cached) profile for a model — the ACTIVE model by default,
 * or any specific model (tier routing asks for fast/standard/deep profiles
 * so thinking toggles, context windows and budgets match the model that
 * will actually serve the call). Never throws — falls back to a conservative
 * generic profile offline.
 */
export async function getModelProfile(force = false, modelOverride?: string): Promise<ModelProfile> {
  const cfg = getLocalAiConfig()
  profileCache ??= new Map()
  const model = (modelOverride ?? cfg.model).trim() || cfg.model

  // ── Gemini cloud provider (forced or auto-detected) ──
  const forced = getAiProviderChoice()
  if (forced === 'gemini') {
    const cachedGem = profileCache.get('gemini')
    if (!force && cachedGem && Date.now() - cachedGem.profile.probedAt < PROFILE_TTL_MS) {
      return cachedGem.profile
    }
    const profile: ModelProfile = {
      provider: 'gemini',
      contextTokens: parseInt(process.env.GEMINI_CONTEXT_TOKENS ?? '0', 10) || 1_048_576,
      contextProbed: false,
      paramSize: null,
      family: 'gemini',
      thinkingCapable: false,
      temperature: 0.2,
      maxOutputTokens: parseInt(process.env.LOCAL_AI_MAX_TOKENS ?? '0', 10) || 8192,
      timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : 600_000,
      probedAt: Date.now(),
    }
    profileCache.set('gemini', { profile })
    return profile
  }

  const cached = profileCache.get(model)
  if (!force && cached && Date.now() - cached.profile.probedAt < PROFILE_TTL_MS) {
    return cached.profile
  }

  const provider = await detectProvider(cfg)
  if (provider === 'gemini') {
    // No local server answered, but the Gemini fallback is configured.
    const profile: ModelProfile = {
      provider: 'gemini',
      contextTokens: parseInt(process.env.GEMINI_CONTEXT_TOKENS ?? '0', 10) || 1_048_576,
      contextProbed: false,
      paramSize: null,
      family: 'gemini',
      thinkingCapable: false,
      temperature: 0.2,
      maxOutputTokens: parseInt(process.env.LOCAL_AI_MAX_TOKENS ?? '0', 10) || 8192,
      timeoutMs: cfg.timeoutMs > 0 ? cfg.timeoutMs : 600_000,
      probedAt: Date.now(),
    }
    profileCache.set('gemini', { profile })
    return profile
  }
  const ep = endpoints(cfg.baseUrl)

  let paramSize: string | null = null
  let family: string | null = null
  let ctxProbed: number | null = null
  let thinking = false

  if (provider === 'ollama') {
    try {
      const res = await fetchWithTimeout(
        ep.nativeShow,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
          body: JSON.stringify({ model }),
        },
        6000,
      )
      if (res.ok) {
        const show = (await res.json()) as OllamaShowResponse
        paramSize = parseParamSize(show)
        family = show?.details?.family ?? null
        ctxProbed = parseContextLength(show)
        thinking = parseThinkingCapable(model, show)
      }
    } catch {
      /* probe failed — defaults below */
    }
  } else {
    // OpenAI-compatible servers may expose /models with metadata.
    try {
      const res = await fetchWithTimeout(ep.compatModels, { headers: authHeaders(cfg) }, 5000)
      if (res.ok) {
        const data = await res.json().catch(() => null)
        const rows: Array<Record<string, unknown>> =
          (data?.data as Array<Record<string, unknown>>) ??
          (data?.models as Array<Record<string, unknown>>) ??
          []
        const me = rows.find((r) => String(r.id ?? r.name ?? '') === model)
        const rawCtx = (me?.context_length ?? me?.max_context_length ?? me?.contextLength) as number | undefined
        if (typeof rawCtx === 'number' && rawCtx > 0) ctxProbed = rawCtx
        thinking = REASONING_NAME_RE.test(model)
      }
    } catch {
      /* ignore */
    }
    if (!thinking) thinking = REASONING_NAME_RE.test(model)
  }

  const budgets = computeBudgets(model, paramSize, thinking)
  const envCtx = parseInt(process.env.LOCAL_AI_NUM_CTX ?? '0', 10)
  // v3.9 UNKNOWN-window defaults align with the tier contract table
  // (fast 8,192 / standard 16,384 / deep 32,768): qwen-class thinking models
  // (the standard/deep fleet) natively carry 32K, and the deep tier's explicit
  // num_ctx must not be clamped by a stale 16K guess. A /api/show probe that
  // reports the real context_length still overrides this.
  const profile: ModelProfile = {
    provider,
    contextTokens: envCtx > 0 ? envCtx : ctxProbed && ctxProbed >= 2048 ? Math.min(ctxProbed, 262144) : thinking ? 32768 : 8192,
    contextProbed: ctxProbed !== null,
    paramSize,
    family,
    thinkingCapable: thinking,
    temperature: recommendedTemperature(cfg.model, thinking),
    maxOutputTokens: budgets.maxOutputTokens,
    timeoutMs: budgets.timeoutMs,
    probedAt: Date.now(),
  }
  profileCache.set(model, { profile })
  return profile
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-model param-size probe (tier auto-assignment + settings UI badges)
// ─────────────────────────────────────────────────────────────────────────────

const PARAM_SIZE_TTL_MS = 10 * 60_000
const paramSizeCache = new Map<string, { at: number; b: number | null }>()

/**
 * Probe a model's parameter size in BILLIONS via Ollama /api/show
 * (details.parameter_size like "8.0B"). Cached 10 minutes; null when the
 * server can't answer (name-based parsing is the caller's fallback).
 */
export async function probeModelParamSize(model: string): Promise<number | null> {
  const key = model.trim()
  if (!key) return null
  const cached = paramSizeCache.get(key)
  if (cached && Date.now() - cached.at < PARAM_SIZE_TTL_MS) return cached.b
  let b: number | null = null
  const cfg = getLocalAiConfig()
  const ep = endpoints(cfg.baseUrl)
  try {
    const res = await fetchWithTimeout(
      ep.nativeShow,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
        body: JSON.stringify({ model: key }),
      },
      5000,
    )
    if (res.ok) {
      const show = (await res.json()) as OllamaShowResponse
      const label = parseParamSize(show)
      if (label) {
        const m = label.match(/(\d+(?:\.\d+)?)/i)
        if (m) {
          b = /m/i.test(label) && !/b/i.test(label) ? parseFloat(m[1]) / 1000 : parseFloat(m[1])
        }
      }
    }
  } catch {
    /* offline / not ollama */
  }
  paramSizeCache.set(key, { at: Date.now(), b })
  return b
}

export interface OllamaModel {
  name: string
  size?: number
  modifiedAt?: string
}

/** List available models (Ollama native preferred, OpenAI-compat fallback). */
export async function listLocalAiModels(): Promise<{
  models: OllamaModel[]
  endpoint: string
  available: boolean
  error?: string
}> {
  const cfg = getLocalAiConfig()
  // v3.8 Z.ai GLM: the SDK bridge serves the GLM fleet — surface the tier
  // trio so the Model Router can assign GLM models to fast/standard/deep.
  if (isZaiEndpoint(cfg)) {
    if ((await detectProvider(cfg)) === 'zai') {
      return {
        models: [
          { name: 'glm-4.5-flash' },
          { name: 'glm-4.5-air' },
          { name: 'glm-4.6' },
          { name: 'glm-4.5' },
        ],
        endpoint: 'z-ai-sdk (GLM)',
        available: true,
      }
    }
    return {
      models: [],
      endpoint: 'z-ai-sdk (GLM)',
      available: false,
      error: 'z-ai-web-dev-sdk is not installed in this deployment (bun/npm i z-ai-web-dev-sdk)',
    }
  }
  // Gemini provider: exactly one configured model, always listed when forced.
  if (getAiProviderChoice() === 'gemini') {
    const { isGeminiAvailable, geminiUnavailableMessage, getGeminiProviderConfig } =
      await import('./geminiProvider')
    if (await isGeminiAvailable()) {
      return {
        models: [{ name: getGeminiProviderConfig().model }],
        endpoint: 'google-gemini',
        available: true,
      }
    }
    return {
      models: [],
      endpoint: 'google-gemini',
      available: false,
      error: geminiUnavailableMessage(),
    }
  }
  const ep = endpoints(cfg.baseUrl)
  try {
    const provider = await detectProvider(cfg)
    const url = provider === 'ollama' ? ep.nativeTags : ep.compatModels
    const res = await fetchWithTimeout(url, { headers: authHeaders(cfg) }, 5000)
    if (!res.ok) return { models: [], endpoint: cfg.baseUrl, available: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    const models: OllamaModel[] = []
    if (Array.isArray(data?.data)) {
      for (const m of data.data) {
        models.push({
          name: String(m.id ?? m.name ?? 'unknown'),
          size: m.size ? Number(m.size) : undefined,
          modifiedAt: m.modified_at ?? m.created ? String(m.modified_at ?? m.created) : undefined,
        })
      }
    } else if (Array.isArray(data?.models)) {
      for (const m of data.models) {
        models.push({
          name: String(m.name ?? m.id ?? 'unknown'),
          size: m.size ? Number(m.size) : undefined,
          modifiedAt: m.modified_at ? String(m.modified_at) : undefined,
        })
      }
    }
    return { models, endpoint: cfg.baseUrl, available: true }
  } catch (err) {
    // Local endpoint unreachable → auto mode may still serve through the
    // Gemini fallback; surface that as the resolved capability.
    if (getAiProviderChoice() === 'auto') {
      const { isGeminiAvailable, getGeminiProviderConfig } = await import('./geminiProvider')
      if (await isGeminiAvailable()) {
        return {
          models: [{ name: getGeminiProviderConfig().model }],
          endpoint: 'google-gemini (local endpoint unreachable — auto fallback)',
          available: true,
        }
      }
    }
    return {
      models: [],
      endpoint: cfg.baseUrl,
      available: false,
      error: err instanceof Error ? err.message : 'connection failed',
    }
  }
}

/**
 * Check if the local AI server is reachable + report the resolved model
 * profile so UI/status surfaces what the engine will actually do.
 */
export async function pingLocalAi(force = false): Promise<{
  available: boolean
  model: string
  endpoint: string
  error?: string
}> {
  const cfg = getLocalAiConfig()
  try {
    const listing = await listLocalAiModels()
    if (!listing.available) {
      throw new Error(listing.error ?? 'connection failed')
    }
    // Warm the active model's profile cache (thinking/context probe) so the
    // first real call doesn't pay the probe latency.
    await getModelProfile(force).catch(() => null)
    const isGemini = listing.endpoint.includes('google-gemini')
    return {
      available: true,
      model: isGemini ? getGeminiProviderConfig().model : cfg.model,
      endpoint: listing.endpoint,
    }
  } catch (err) {
    return {
      available: false,
      model: cfg.model,
      endpoint: cfg.baseUrl,
      error: err instanceof Error ? err.message : 'connection failed',
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat completion
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  model?: string
  /**
   * For thinking-capable models: allow chain-of-thought? Default true.
   * Structured-extraction calls pass false to save time/tokens when the
   * server supports disabling it (Ollama `think:false`). On hybrid models
   * (Qwen3/Qwen3.5/gpt-oss…) this is the difference between a 60s scan and
   * an 11-minute one, with NO quality loss on structured extraction.
   */
  thinking?: boolean
  /**
   * Constrain the reply to JSON (Ollama native `format:"json"`, OpenAI-compat
   * `response_format:{type:"json_object"}`). Callers that parse the reply as
   * JSON set this: the model cannot emit prose preambles or broken JSON, so
   * the whole parse-retry pass disappears. Kill-switch: LOCAL_AI_JSON_MODE=off.
   */
  json?: boolean
  /**
   * v3.9 — which TIER contract governs this call's explicit num_ctx
   * (fast 8,192 / standard 16,384 / deep 32,768). When omitted the tier is
   * inferred from the model (active assignment match, then param size).
   * Master prompt: NEVER rely on the server's default context length.
   */
  tier?: 'fast' | 'standard' | 'deep'
  /** Skip the retry pass (used by the retry itself). */
  _noRetry?: boolean
}

interface RawChatResult {
  content: string
  reasoning: string
  /** Provider-reported model name (built-in hosted provider fills this). */
  model?: string
}

/**
 * v3.9 CONSERVATIVE prompt-token estimate — digit-aware, never optimistic.
 * The old fixed ÷3.4 chars ratio under-counted identifier-heavy evidence
 * (phones/IMEI/accounts fragment into small BPE tokens); the master prompt
 * forbids fixed ratios for budgeting. Delegates to tokenEstimator.
 */
function estimatePromptTokensFromMessages(messages: Array<{ content: string }>): number {
  return messages.reduce(
    (a, m) => a + estimateTokensHeuristic(m.content) + 4, // +4: role/separator overhead
    0,
  )
}

/**
 * v3.9 EXPLICIT num_ctx RESOLUTION (pure, exported for tests).
 *
 * Master-prompt contract: every Ollama generation request carries an explicit
 * `num_ctx` from the tier table (fast 8,192 / standard 16,384 / deep 32,768) —
 * NEVER the server default (which silently truncates long prompts).
 *
 *   numCtx = tier contract value
 *          ├─ clamped DOWN to the model's real probed window when smaller
 *          └─ in the emergency case (composed prompt + output > tier window —
 *             planners should make this impossible) sized UP to the need,
 *             still capped by the real window, with a loud warning — we
 *             prefer a bigger allocation over silent truncation.
 */
export function resolveNumCtx(params: {
  tier?: ModelTier | null
  model: string
  promptTokens: number
  maxTokens: number
  /** The serving model's REAL window when probed (/api/show context_length). */
  effectiveWindowTokens?: number | null
}): { numCtx: number; tier: ModelTier; emergency: boolean } {
  const tier =
    params.tier && (MODEL_TIERS as readonly string[]).includes(params.tier)
      ? params.tier
      : (inferModelTier(params.model) ?? 'standard')
  const window =
    params.effectiveWindowTokens && params.effectiveWindowTokens > 0
      ? params.effectiveWindowTokens
      : null
  const contract = tierContextContract(tier, window)
  const need = Math.max(0, params.promptTokens) + Math.max(0, params.maxTokens) + 256

  let numCtx = contract.numCtx
  let emergency = false
  if (need > contract.numCtx) {
    // Planners violated the chunk budget — allocate what the prompt actually
    // needs (never truncate) but say so loudly.
    numCtx = window ? Math.min(Math.max(need, contract.numCtx), Math.max(window, contract.numCtx)) : need
    emergency = true
  }
  return { numCtx: Math.max(2_048, Math.floor(numCtx)), tier, emergency }
}

/**
 * Idle watchdog + total watchdog over an in-flight response body.
 * Aborts when no bytes arrive for `idleMs` OR the whole call exceeds
 * `totalMs`. Returns assembled Uint8Array chunks via onChunk callbacks.
 */
class StreamWatchdog {
  private controller = new AbortController()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private totalTimer: ReturnType<typeof setTimeout> | null = null
  readonly signal = this.controller.signal
  abortedFor: 'idle' | 'total' | null = null
  bytesSeen = 0
  startedAt = Date.now()

  constructor(private idleMs: number, private totalMs: number) {}

  start() {
    this.bumpIdle()
    this.totalTimer = setTimeout(() => {
      this.abortedFor = 'total'
      this.controller.abort()
    }, this.totalMs)
  }

  /** Reset the idle timer — call for EVERY received byte batch. */
  bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.abortedFor = 'idle'
      this.controller.abort()
    }, this.idleMs)
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.totalTimer) clearTimeout(this.totalTimer)
  }
}

function idleWatchdogMs(): number {
  const v = parseInt(process.env.LOCAL_AI_IDLE_MS ?? '0', 10)
  return v > 0 ? v : 150_000
}

/** Big-model detector shared by budget calculators. */
function isBigModelClass(modelName: string | undefined, thinking?: boolean): boolean {
  const m = (modelName ?? '').match(/(\d+(?:\.\d+)?)\s*b/i)
  const billions = m ? parseFloat(m[1]) : null
  return (billions !== null && billions >= 13) || Boolean(thinking)
}

/** Silence-budget knob: ms allowed per 1K prompt chars before first token. */
function silencePerKMs(bigModel: boolean): number {
  const v = parseInt(process.env.LOCAL_AI_SILENCE_PER_K_MS ?? '0', 10)
  if (v > 0) return v
  return bigModel ? 45_000 : 8_000
}

/** Hard ceiling for the silence window itself. */
function firstTokenCapMs(bigModel: boolean): number {
  const v = parseInt(process.env.LOCAL_AI_FIRST_TOKEN_CAP_MS ?? '0', 10)
  return v > 0 ? v : bigModel ? 900_000 : 240_000
}

/**
 * Compute how long we may hear NOTHING from the server without giving up.
 *
 * WHY THIS EXISTS: with stream:true Ollama sends zero bytes during prompt
 * evaluation (prefill). A gpt-oss:20b swallowing a ~20K-char scan on modest
 * hardware can legitimately sit silent for MANY minutes — a fixed 150s idle
 * kill murders healthy requests mid-prefill, then the retry dies identically.
 * The budget therefore scales with prompt size and model class:
 *
 *   grace = max(envIdle, perK × promptK + coldLoadCushion) × retryFactor
 *   capped at firstTokenCapMs
 *
 * Env knobs: LOCAL_AI_IDLE_MS (floor), LOCAL_AI_SILENCE_PER_K_MS (speed),
 * LOCAL_AI_FIRST_TOKEN_CAP_MS (ceiling).
 */
export function computeSilenceBudgetMs(
  promptChars: number,
  opts?: { modelName?: string; thinking?: boolean; attempt?: number },
): number {
  const bigModel = isBigModelClass(opts?.modelName, opts?.thinking)
  const floor = idleWatchdogMs()
  const perK = silencePerKMs(bigModel)
  const cushion = bigModel ? 90_000 : 25_000 // cold model load / connect
  const promptK = Math.max(0, promptChars) / 1000
  const thinkingFactor = opts?.thinking ? 1.2 : 1
  const attempt = Math.max(1, opts?.attempt ?? 1)
  const retryFactor = attempt >= 3 ? 2 : attempt === 2 ? 1.6 : 1
  // Cap applies to the FIRST-attempt window; retries multiply afterwards so a
  // watchdog kill can always escalate past the ceiling.
  const base = Math.min(
    Math.max(floor, (perK * promptK + cushion) * thinkingFactor),
    firstTokenCapMs(bigModel),
  )
  return base * retryFactor
}

/** Total-timeout factor applied to profile.timeoutMs based on workload. */
export function computeWorkloadTimeoutMs(
  baseTimeoutMs: number,
  promptChars: number,
  opts?: { thinking?: boolean; outputTokens?: number },
): number {
  let ms = baseTimeoutMs
  // Prefill grows linearly with input size; add headroom beyond ~24K chars.
  const bigPromptExtra = Math.max(0, promptChars - 24_000)
  ms += Math.ceil(bigPromptExtra / 4_000) * 30_000 // +30s per ~4K extra chars
  if (opts?.thinking) ms = Math.max(ms, 900_000)
  // Structured (thinking-off) calls must still GENERATE the whole JSON, and
  // on CPU-class hardware generation is the slow part (~5-8 tok/s on an 8B
  // model). Budget ~0.15s per requested output token so a healthy 10K-token
  // extraction isn't murdered mid-stream by a 15-minute total cap. The
  // allowance is capped at 3× the base timeout so an explicit
  // LOCAL_AI_TIMEOUT_MS stays authoritative for slow-model operators.
  if (opts?.outputTokens && opts.outputTokens > 0) {
    const genMs = 240_000 + Math.round(opts.outputTokens * 150)
    ms = Math.max(ms, Math.min(genMs, baseTimeoutMs * 3))
  }
  return Math.min(ms, 2_700_000) // absolute ceiling 45 min
}

async function readStreamWithWatchdog(
  res: Response,
  wd: StreamWatchdog,
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      wd.bumpIdle()
      if (value) {
        wd.bytesSeen += value.byteLength
        text += decoder.decode(value, { stream: true })
      }
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return text
}

/** Parse Ollama NDJSON stream lines into accumulated chat result. */
function parseOllamaStream(ndjson: string): RawChatResult {
  let content = ''
  let reasoning = ''
  for (const line of ndjson.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (j.error) throw new Error(String(j.error))
    const msg = j.message as Record<string, unknown> | undefined
    if (msg) {
      if (typeof msg.content === 'string') content += msg.content
      if (typeof msg.thinking === 'string') reasoning += msg.thinking
      if (typeof msg.reasoning === 'string') reasoning += msg.reasoning
    }
  }
  return { content, reasoning }
}

/** Parse OpenAI-compatible SSE stream into accumulated chat result. */
function parseOpenAiSse(sse: string): RawChatResult {
  let content = ''
  let reasoning = ''
  for (const rawLine of sse.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }
    const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const delta = choice?.delta as Record<string, unknown> | undefined
    const msg = choice?.message as Record<string, unknown> | undefined
    const c = delta?.content ?? msg?.content
    if (typeof c === 'string') content += c
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (typeof p === 'string') content += p
        else if (p && typeof p === 'object' && typeof (p as { text?: string }).text === 'string') {
          content += (p as { text: string }).text
        }
      }
    }
    const r =
      (delta?.reasoning_content as string | undefined) ??
      (delta?.reasoning as string | undefined) ??
      (delta?.thinking as string | undefined) ??
      (msg?.reasoning_content as string | undefined) ?? ''
    if (r) reasoning += r
  }
  return { content, reasoning }
}

function collectContent(data: Record<string, unknown>): RawChatResult {
  // OpenAI shape: { choices: [{ message: { content, reasoning_content } }] }
  const choice = (data as { choices?: Array<{ message?: Record<string, unknown>; text?: string }> }).choices?.[0]
  const msg = choice?.message
  let content = ''
  let reasoning = ''
  if (msg) {
    const c = msg.content
    if (typeof c === 'string') content = c
    else if (Array.isArray(c)) {
      content = c
        .map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? '')))
        .join('')
    }
    reasoning =
      (msg.thinking as string) ??
      (msg.reasoning as string) ??
      (msg.reasoning_content as string) ??
      ''
  }
  // Ollama native shape: { message: { content, thinking } }
  if (!content && !reasoning) {
    const om = (data as { message?: Record<string, unknown> }).message
    if (om) {
      content = typeof om.content === 'string' ? om.content : ''
      reasoning = (om.thinking as string) ?? ''
    }
  }
  if (!content) {
    // Legacy completions shape
    content = (choice?.text as string) ?? (data as { content?: string; output?: string }).content ?? (data as { output?: string }).output ?? ''
    if (typeof content !== 'string') content = String(content)
  }
  return { content: stripReasoning(content), reasoning: stripReasoning(reasoning) }
}

/**
 * Native Ollama chat via NDJSON streaming.
 *
 * - `num_ctx` is sized PER REQUEST from the real prompt length (capped by
 *   effectiveContextTokens) — never the model's full advertised window.
 * - `keep_alive` prevents model reload thrash between scan calls.
 * - `think` toggle is retried WITHOUT the field when this Ollama build
 *   rejects it for the active model (older gpt-oss builds do).
 */
async function ollamaNativeChat(
  messages: ChatMessage[],
  opts: Required<Pick<ChatOptions, 'temperature' | 'maxTokens'>> & {
    model: string
    think: boolean | null
    attempt?: number
    json?: boolean
    tier?: ModelTier | null
  },
  timeoutMs: number,
): Promise<RawChatResult> {
  const cfg = getLocalAiConfig()
  const ep = endpoints(cfg.baseUrl)
  // Profile of THE MODEL serving this call (tier routing may pick a
  // fast/standard/deep model different from the primary).
  const profile = await getModelProfile(false, opts.model).catch(() => null)

  const promptChars = messages.reduce((a, m) => a + m.content.length + 12, 0)
  const effCtx = effectiveContextTokens(profile)
  // v3.9 EXPLICIT num_ctx from the tier contract — never the server default.
  // Token count: exact via the live tokenizer (/api/tokenize — tokenizer data
  // only, no weights) when the server exposes it, else the conservative
  // digit-aware heuristic. Both overestimate rather than under.
  void probeTokenizer(cfg.baseUrl, opts.model, { apiKey: cfg.apiKey }).catch(() => false)
  const promptTokens =
    (await countTokensExact(cfg.baseUrl, opts.model, messages.map((m) => m.content).join('\n'), {
      apiKey: cfg.apiKey,
    }).catch(() => null)) ?? estimatePromptTokensFromMessages(messages)
  const tierHint =
    opts.tier ??
    (await getTierAssignment()
      .then((t) => (MODEL_TIERS as readonly ModelTier[]).find((x) => t[x] === opts.model) ?? null)
      .catch(() => null))
  const resolved = resolveNumCtx({
    tier: tierHint,
    model: opts.model,
    promptTokens,
    maxTokens: opts.maxTokens,
    effectiveWindowTokens: effCtx,
  })
  const numCtx = resolved.numCtx
  if (resolved.emergency) {
    console.warn(
      `[localAi] num_ctx EMERGENCY: ${opts.model} (${resolved.tier}) prompt ~${promptTokens}tok + ${opts.maxTokens}out exceeds the tier window — allocating ${numCtx} (never truncate; planners should prevent this)`,
    )
  }

  const buildBody = (includeThink: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: true,
      keep_alive: process.env.LOCAL_AI_KEEP_ALIVE ?? '30m',
      options: {
        temperature: opts.temperature,
        num_predict: opts.maxTokens,
        num_ctx: numCtx, // ← per-request sizing; Ollama's default ctx truncates big prompts silently
      },
    }
    if (includeThink && opts.think !== null) body.think = opts.think
    // JSON grammar constraint: the reply is forced to be valid JSON — no
    // prose preambles, no fenced blocks, no parse-retry round trips.
    if (opts.json) body.format = 'json'
    return body
  }

  const post = async (body: Record<string, unknown>) => {
    // Prompt-aware silence budget: big models sit silent during prefill for
    // MINUTES on ~20K-char scans — a fixed 150s idle kill aborts healthy work.
    const silenceMs = computeSilenceBudgetMs(promptChars, {
      modelName: opts.model,
      // Actual request thinking state (think:false structured calls must not
      // get the reasoning-model prefill multiplier — it inflated a 13.7K-char
      // qwen3:4b budget to 845s and stalled scans sat unpunished for it).
      thinking: Boolean(profile?.thinkingCapable) && opts.think !== false,
      attempt: opts.attempt ?? 1,
    })
    const shouldLogBudget =
      (opts.attempt ?? 1) === 1 && (silenceMs > 60_000 || process.env.LOCAL_AI_DEBUG === '1')
    if (shouldLogBudget) {
      console.log(
        `[localAi] silence budget ${Math.round(silenceMs / 1000)}s for ${(promptChars / 1000).toFixed(1)}K-char prompt (${opts.model})`,
      )
    }
    const wd = new StreamWatchdog(silenceMs, timeoutMs)
    try {
      // Arm the watchdog BEFORE fetch so the header-wait phase is covered too:
      // a stalled model load must abort after the idle window, never hang.
      wd.start()
      const res = await fetch(ep.nativeChat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
        body: JSON.stringify(body),
        signal: wd.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const err = new Error(`ollama HTTP ${res.status}: ${text.slice(0, 180)}`)
        ;(err as Error & { httpStatus?: number }).httpStatus = res.status
        throw err
      }
      const raw = await readStreamWithWatchdog(res, wd)
      return parseOllamaStream(raw)
    } finally {
      wd.dispose()
    }
  }

  try {
    return await post(buildBody(true))
  } catch (err) {
    // Older Ollama + gpt-oss combos answer 400 "does not support thinking" /
    // "does not support disabling thinking". Strip the toggle and retry once.
    const msg = err instanceof Error ? err.message : ''
    if (/think/i.test(msg) && /support|invalid|unknown|unexpected/i.test(msg)) {
      console.warn('[localAi] ollama rejected think toggle — retrying without it')
      return await post(buildBody(false))
    }
    throw err
  }
}

/**
 * v3.8 — Z.ai GLM chat via the z-ai-web-dev-sdk (backend only).
 *
 * Selected with LOCAL_AI_BASE_URL=zai://glm (or LOCAL_AI_PROVIDER=zai).
 * Every tier can carry a GLM model name (glm-4.5-flash on fast,
 * glm-4.5-air on standard, glm-4.6 on deep — or any GLM model the account
 * serves). Runs AROUND the local-call serialization chain (cloud endpoint,
 * parallel-safe) and honors the wall-clock timeout.
 */
async function zaiSdkChat(
  messages: ChatMessage[],
  opts: { temperature: number; maxTokens: number; model?: string; thinking?: boolean; timeoutMs: number },
): Promise<RawChatResult> {
  const mod = (await loadZaiSdk()) as {
    default: { create: () => Promise<{ chat: { completions: { create: (a: unknown) => Promise<{ choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }> } } }> }
  }
  const zai = await mod.default.create()
  const payload = {
    messages: messages.map((m) => ({ role: m.role === 'system' ? 'assistant' : m.role, content: m.content })),
    thinking: { type: opts.thinking === true ? 'enabled' : 'disabled' },
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(opts.model ? { model: opts.model } : {}),
  }
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`zai sdk call timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs),
  )
  const completion = await Promise.race([zai.chat.completions.create(payload), timeout])
  const choice = completion.choices?.[0]?.message
  return {
    content: String(choice?.content ?? ''),
    reasoning: String((choice as { reasoning_content?: string } | undefined)?.reasoning_content ?? ''),
  }
}

/** OpenAI-compatible chat. Streams SSE first; falls back to non-streaming. */
async function openAiCompatChat(
  messages: ChatMessage[],
  opts: Required<Pick<ChatOptions, 'temperature' | 'maxTokens'>> & {
    model: string
    attempt?: number
    json?: boolean
  },
  timeoutMs: number,
): Promise<RawChatResult> {
  const cfg = getLocalAiConfig()
  const ep = endpoints(cfg.baseUrl)
  const profile = await getModelProfile(false, opts.model).catch(() => null)
  const promptChars = messages.reduce((a, m) => a + m.content.length + 12, 0)
  let lastErr: Error | null = null
  // JSON-mode constraint, stripped for servers that reject response_format
  // (older llama.cpp/vLLM builds answer 400/422) — one flag, checked lazily.
  let jsonRejected = false
  const jsonBodyExtra = (): Record<string, unknown> =>
    opts.json && !jsonRejected ? { response_format: { type: 'json_object' } } : {}
  for (const url of [ep.compatChat, ep.altCompatChat]) {
    // ── Attempt 1: SSE streaming (lets long generations survive) ──
    const silenceMs = computeSilenceBudgetMs(promptChars, {
      modelName: opts.model,
      thinking: profile?.thinkingCapable,
      attempt: opts.attempt ?? 1,
    })
    const wd = new StreamWatchdog(silenceMs, timeoutMs)
    try {
      // Armed pre-fetch: covers connect/header wait as well as the body.
      wd.start()
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
          stream: true,
          ...jsonBodyExtra(),
        }),
        signal: wd.signal,
      })
      if (res.ok) {
        const sse = await readStreamWithWatchdog(res, wd)
        const parsed = parseOpenAiSse(sse)
        if (process.env.RJ_DEBUG_SSE) {
          console.log(
            `[localAi][sse-debug] bytes=${wd.bytesSeen} textLen=${sse.length} contentLen=${parsed.content.length} reasoningLen=${parsed.reasoning.length} head=${JSON.stringify(sse.slice(0, 160))}`,
          )
        }
        if (parsed.content.trim() || parsed.reasoning.trim()) return parsed
        // Streamed but empty → treat as failure of this URL shape.
        lastErr = new Error('streamed response was empty')
      } else if ((res.status === 400 || res.status === 422) && opts.json && !jsonRejected) {
        // Server may be rejecting response_format — consume the error body
        // and retry the SAME streaming request without it.
        await res.text().catch(() => '')
        jsonRejected = true
        lastErr = new Error(`HTTP ${res.status} (json mode rejected)`)
      } else {
        lastErr = new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('stream request failed')
    } finally {
      wd.dispose()
    }

    // ── Attempt 2: classic non-streaming request on the same URL ──
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
          body: JSON.stringify({
            model: opts.model,
            messages,
            temperature: opts.temperature,
            max_tokens: opts.maxTokens,
            stream: false,
            ...jsonBodyExtra(),
          }),
        },
        timeoutMs,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if ((res.status === 400 || res.status === 422) && opts.json && !jsonRejected) {
          jsonRejected = true
          lastErr = new Error(`HTTP ${res.status} (json mode rejected): ${text.slice(0, 120)}`)
          // Re-run the non-streaming attempt once without response_format.
          const res2 = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
              body: JSON.stringify({
                model: opts.model,
                messages,
                temperature: opts.temperature,
                max_tokens: opts.maxTokens,
                stream: false,
              }),
            },
            timeoutMs,
          )
          if (res2.ok) return collectContent(await res2.json())
          lastErr = new Error(`HTTP ${res2.status}`)
          continue
        }
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`)
        continue
      }
      return collectContent(await res.json())
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('request failed')
    }
  }
  throw lastErr ?? new Error('chat request failed')
}

/**
 * Send a chat completion to the local AI and get back plain final-answer
 * text (reasoning channels stripped). Returns empty string ONLY when the
 * server is unreachable or answers nothing at all after a retry.
 */
export async function localChat(
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<string> {
  const res = await localChatDetailed(messages, options)
  return res.content
}

/**
 * Local AI servers generate ONE request at a time by default
 * (OLLAMA_NUM_PARALLEL=1 on most builds). A second concurrent request sits
 * in the server's queue emitting NOTHING — indistinguishable from a hang to
 * the silence watchdog, which then kills a perfectly healthy queued call.
 * RED Justice therefore serializes its own local calls through this chain;
 * Gemini (cloud) calls bypass it and stay parallel.
 */
let localCallChain: Promise<unknown> = Promise.resolve()

/**
 * Full variant: also returns the separated reasoning channel when present
 * (useful for surfacing the model's audit trail in explain/scan outputs).
 */
export async function localChatDetailed(
  messages: ChatMessage[],
  options?: ChatOptions,
): Promise<RawChatResult & { model: string; attempts: number }> {
  const cfg = getLocalAiConfig()
  // Probe the profile of the model THIS call will use — tier routing sends
  // different models to the same endpoint, and thinking capability /
  // context window / budgets differ per model.
  const profile = await getModelProfile(false, options?.model).catch(() => null)
  if (profile?.provider === 'gemini' || profile?.provider === 'zai') {
    // Cloud endpoints (Gemini / Z.ai GLM) bypass the local serialization chain —
    // they serve concurrent requests natively.
    return localChatDetailedInner(messages, options, cfg, profile)
  }
  const prev = localCallChain
  let release!: () => void
  localCallChain = new Promise<void>((resolve) => {
    release = resolve
  })
  const waitStart = Date.now()
  await prev.catch(() => undefined)
  const waited = Date.now() - waitStart
  if (waited > 5_000) {
    console.log(
      `[localAi] waited ${(waited / 1000).toFixed(0)}s for the in-flight local AI call to finish (local servers generate one request at a time)`,
    )
  }
  try {
    return await localChatDetailedInner(messages, options, cfg, profile)
  } finally {
    release()
  }
}

async function localChatDetailedInner(
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  cfg: ReturnType<typeof getLocalAiConfig>,
  profile: ModelProfile | null,
): Promise<RawChatResult & { model: string; attempts: number }> {
  const model =
    options?.model ??
    (profile?.provider === 'gemini' ? getGeminiProviderConfig().model : cfg.model)
  const envThink = process.env.LOCAL_AI_THINK?.toLowerCase()
  // Thinking control for reasoning models: 'off'/false → disable CoT where the
  // server supports it; 'on'/true → EXPLICITLY enable (deep-tier escalation
  // per the routing spec — never rely on an ambiguous server default);
  // 'auto' → server default.
  const thinkControl: boolean | null =
    !profile?.thinkingCapable
      ? null
      : envThink === 'off' || options?.thinking === false
        ? false
        : envThink === 'on' || options?.thinking === true
          ? true
          : null

  // Visibility: hybrid models (Qwen3/Qwen3.5/gpt-oss…) think by DEFAULT —
  // when we successfully disable it for a structured call the operator sees
  // why scans just got 5-10× faster instead of wondering what changed.
  if (thinkControl === false) {
    console.log(
      `[localAi] ${model}: chain-of-thought DISABLED for this structured call — direct answer mode (faster, extraction quality unaffected)`,
    )
  }

  // Structured calls that disabled thinking don't need the 12K-token CoT
  // output budget: capping it keeps num_ctx (KV cache) tight → faster prefill.
  const maxOutDefault =
    thinkControl === false
      ? Math.min(profile?.maxOutputTokens ?? 4096, 8192)
      : (profile?.maxOutputTokens ?? 4096)
  // JSON grammar constraint (Ollama format:"json" / response_format) for
  // callers that parse the reply as JSON. Kill-switch: LOCAL_AI_JSON_MODE=off.
  const wantJson = options?.json === true && process.env.LOCAL_AI_JSON_MODE?.toLowerCase() !== 'off'

  const promptChars = messages.reduce((a, m) => a + m.content.length + 12, 0)
  // v3.7.1: budget violations are the #1 cause of watchdog kills on small
  // local models — a 38K-char prompt needs >6 min of prefill on CPU-class
  // qwen3:4b and dies in BOTH attempts. Callers chunk/budget prompts
  // (getContentBudgetChars + manifest budgets); this loud breadcrumb makes
  // any future regression instantly visible in the server log.
  if (profile?.provider !== 'gemini' && promptChars > 20_000) {
    console.warn(
      `[localAi] PROMPT OVER BUDGET: ${(promptChars / 1000).toFixed(1)}K chars for ${model} — ` +
        `local models are budgeted ~12K/prompt (LOCAL_AI_MAX_INPUT_CHARS). Expect watchdog kills; ` +
        `the caller should chunk the document or shrink its entity manifest.`,
    )
  }
  const workloadTimeout = (base: number, factor = 1) =>
    Math.round(
      computeWorkloadTimeoutMs(base || profile?.timeoutMs || 240_000, promptChars, {
        thinking: Boolean(profile?.thinkingCapable) && thinkControl !== false,
        outputTokens:
          thinkControl === false ? (options?.maxTokens ?? maxOutDefault) : undefined,
      }) * factor,
    )

  const attemptOnce = (
    chatMessages: ChatMessage[],
    timeoutMs: number,
    attempt: number,
    jsonMode: boolean = wantJson,
  ): Promise<RawChatResult> => {
    if (profile?.provider === 'zai') {
      // Z.ai GLM cloud via SDK — wall-clock guard inside zaiSdkChat.
      return zaiSdkChat(chatMessages, {
        temperature: options?.temperature ?? profile.temperature,
        maxTokens: options?.maxTokens ?? maxOutDefault,
        model,
        thinking: options?.thinking === true,
        timeoutMs,
      })
    }
    if (profile?.provider === 'gemini') {
      // Gemini cloud fallback — the wall-clock guard lives inside
      // geminiChatDetailed; here we just adapt the result shape.
      return import('./geminiProvider').then(({ geminiChatDetailed }) =>
        geminiChatDetailed(chatMessages, {
          temperature: options?.temperature ?? profile.temperature,
          maxTokens: options?.maxTokens ?? profile.maxOutputTokens,
          thinking: options?.thinking === true,
          timeoutMs,
          model: options?.model ?? undefined,
        }),
      )
    }
    if (profile?.provider === 'ollama') {
      return ollamaNativeChat(chatMessages, {
        temperature: options?.temperature ?? profile.temperature,
        maxTokens: options?.maxTokens ?? maxOutDefault,
        model,
        think: thinkControl,
        attempt,
        json: jsonMode,
        tier: options?.tier ?? null,
      }, timeoutMs)
    }
    return openAiCompatChat(chatMessages, {
      temperature: options?.temperature ?? profile?.temperature ?? 0.2,
      maxTokens: options?.maxTokens ?? maxOutDefault,
      model,
      attempt,
      json: jsonMode,
    }, timeoutMs)
  }

  const isAbort = (err: unknown) =>
    err instanceof Error &&
    (err.name === 'AbortError' || /aborted|timed?\s*out/i.test(err.message))

  const started = Date.now()
  let firstErr: unknown = null
  try {
    const r = await attemptOnce(messages, workloadTimeout(profile?.timeoutMs ?? 240_000), 1)
    if (r.content.trim() || r.reasoning.trim()) {
      console.log(
        `[localAi] ${r.model || model} answered ${(r.content.length + r.reasoning.length).toLocaleString()} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      )
      // If only reasoning came back (final channel cut off), salvage later
      // in caller via aiJson; still treat as usable content.
      if (!r.content.trim() && r.reasoning.trim()) {
        return { ...r, content: r.reasoning, model: r.model || model, attempts: 1 }
      }
      return { ...r, model: r.model || model, attempts: 1 }
    }
    firstErr = new Error('empty response')
  } catch (err) {
    firstErr = err
  }

  if (options?._noRetry) throw firstErr instanceof Error ? firstErr : new Error('chat failed')

  const abortLike = isAbort(firstErr)
  if (abortLike) {
    const silenceNow = computeSilenceBudgetMs(promptChars, {
      modelName: model,
      // Mirror the ACTUAL request thinking state: a thinking-disabled
      // structured call (think:false) does not need the big-model ×1.2
      // prefill allowance — over-budgeting here is what let a stalled
      // qwen3:4b call sit silent for 845s before the retry even started.
      thinking: Boolean(profile?.thinkingCapable) && thinkControl !== false,
      attempt: 2,
    })
    console.warn(
      `[localAi] ${model} hit the time/silence watchdog after ${((Date.now() - started) / 1000).toFixed(0)}s — retrying ONCE with doubled total budget AND ${(silenceNow / 1000).toFixed(0)}s silence allowance (${(promptChars / 1000).toFixed(1)}K-char prompt)`,
    )
  } else {
    console.warn('[localAi] first attempt failed/empty, retrying:', firstErr)
  }
  await new Promise((r) => setTimeout(r, 500))

  // Timeout-style failures replay the SAME payload with a bigger budget —
  // appending extra instructions cannot make a slow model finish faster.
  // Empty/garbled answers additionally get a format nudge appended.
  const retryChatMessages: ChatMessage[] = abortLike
    ? messages
    : [
        ...messages,
        {
          role: 'user',
          content:
            'Your previous reply was empty or unreadable. Answer again now: follow the required format EXACTLY and output it directly with no preamble.',
        },
      ]
  const retryTimeout = abortLike
    ? workloadTimeout(profile?.timeoutMs ?? 240_000, 2)
    : workloadTimeout(profile?.timeoutMs ?? 240_000)
  // The retry deliberately drops the JSON grammar constraint: on several
  // Ollama builds the combination think:false + format:"json" (Qwen3 family)
  // is exactly what stalls or returns empty, and grammar evaluation itself
  // is slow on older builds. Plain JSON (even wrapped in prose) is parsed by
  // the tolerant salvage extractor, so nothing is lost.
  const r2 = await attemptOnce(retryChatMessages, retryTimeout, 2, false).catch((err): RawChatResult => {
    console.error('[localAi] retry failed:', err)
    return { content: '', reasoning: '' }
  })
  const content = r2.content.trim() || r2.reasoning.trim()
  if (!content) {
    const idleEnv = process.env.LOCAL_AI_IDLE_MS
    throw new Error(
      `no usable response from ${model} after 2 attempts (${(promptChars / 1000).toFixed(1)}K-char prompt). ` +
        `If the model is genuinely slow, raise LOCAL_AI_IDLE_MS${idleEnv ? ` (currently ${idleEnv})` : ' (default 150000)'} or LOCAL_AI_FIRST_TOKEN_CAP_MS; ` +
        `to shrink prompts lower LOCAL_AI_MAX_INPUT_CHARS. Last error: ${firstErr instanceof Error ? firstErr.message : 'empty'}`,
    )
  }
  console.log(
    `[localAi] ${r2.model || model} answered ${(r2.content.length + r2.reasoning.length).toLocaleString()} chars in ${((Date.now() - started) / 1000).toFixed(1)}s (retry)`,
  )
  return { content, reasoning: r2.reasoning, model: r2.model || model, attempts: 2 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context budgeting — lets scans USE huge windows instead of hard caps
// ─────────────────────────────────────────────────────────────────────────────

/** Rough token estimate for mixed forensic evidence text (~3.4 chars/token). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.4)
}

/**
 * How many characters of DOCUMENT text fit into a single prompt with the
 * active model (or a specific tier model), given reserved room for system
 * prompt + instructions + output. Env LOCAL_AI_MAX_INPUT_CHARS caps it
 * lower if desired.
 */
export async function getContentBudgetChars(
  reserveOutputTokens?: number,
  model?: string,
): Promise<{
  maxCharsPerPrompt: number
  contextTokens: number
  provider: string
  model: string
  thinkingCapable: boolean
}> {
  const cfg = getLocalAiConfig()
  const profile = await getModelProfile(false, model).catch(() => null)
  // IMPORTANT: budget against the EFFECTIVE window (probed ∩ num_ctx cap),
  // matching what ollamaNativeChat will actually allocate per request.
  const ctx = effectiveContextTokens(profile)
  const reserveOut = reserveOutputTokens ?? Math.min(profile?.maxOutputTokens ?? 4096, 6000)
  const fixedOverhead = 1400 // system prompt + wrapper instructions + metadata
  const usableInput = Math.max(1024, ctx - fixedOverhead - reserveOut)
  let maxChars = Math.floor(usableInput * 3.2) // conservative chars/token
  // Gemini cloud fallback: keep single-pass prompts at a size the hosted
  // endpoint answers reliably+quickly; longer documents chunk (map-reduce).
  if (profile?.provider === 'gemini') {
    const gemCap = parseInt(process.env.GEMINI_MAX_INPUT_CHARS ?? '0', 10) || 90_000
    maxChars = Math.min(maxChars, gemCap)
  } else {
    // LOCAL models: single-pass scans are capped WELL below the raw context
    // window. A dense forensic document needs an output as large as the
    // extraction itself (hundreds of entities + connections), so one giant
    // call is slow to prefill, watchdog-fragile, and truncates the JSON
    // mid-array. ~12K-char map-reduce chunks keep every call small, fast,
    // complete and parseable. LOCAL_AI_MAX_INPUT_CHARS overrides — owners of
    // big GPUs can raise it to trade fewer calls for bigger prompts.
    maxChars = Math.min(maxChars, 12_000)
  }
  const envCap = parseInt(process.env.LOCAL_AI_MAX_INPUT_CHARS ?? '0', 10)
  if (envCap > 0) maxChars = Math.min(maxChars, envCap)
  return {
    maxCharsPerPrompt: Math.max(4_000, maxChars),
    contextTokens: ctx,
    provider: profile?.provider ?? 'unknown',
    model: profile?.provider === 'gemini' ? getGeminiProviderConfig().model : (model ?? cfg.model),
    thinkingCapable: profile?.thinkingCapable ?? REASONING_NAME_RE.test(model ?? cfg.model),
  }
}

/** Estimate how many tokens a document will cost — exposed for chunk planners. */
export function estimateDocumentTokens(text: string): number {
  return estimateTokens(text.length)
}
