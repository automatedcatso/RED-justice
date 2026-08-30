/**
 * geminiProvider.ts — Google Gemini provider (local-first fallback).
 *
 * RED Justice is LOCAL-FIRST: the Fully-AI pipeline's brain is your own
 * Ollama / OpenAI-compatible server. When no local server is reachable,
 * this module adapts the Google Gemini REST API into the same
 * `localChatDetailed` contract the whole engine already speaks, so the
 * pipeline keeps working with zero local infrastructure:
 *
 *   - GEMINI_API_KEY   — Google AI Studio API key (required)
 *   - GEMINI_MODEL     — default "gemini-2.0-flash"
 *   - GEMINI_TIMEOUT_MS— wall-clock guard per request (default 600 s)
 *
 *   AI_PROVIDER=auto  (default) — local server when reachable, Gemini otherwise
 *   AI_PROVIDER=local            — never leave the local server
 *   AI_PROVIDER=gemini           — always Gemini
 */

export interface GeminiProviderConfig {
  apiKey: string
  model: string
  timeoutMs: number
  apiBase: string
}

export function getGeminiProviderConfig(): GeminiProviderConfig {
  return {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS ?? '600000', 10) || 600_000,
    apiBase:
      process.env.GEMINI_API_BASE ?? 'https://generativelanguage.googleapis.com/v1beta',
  }
}

/** Configured with an API key? (Does NOT make a network call.) */
export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiProviderConfig().apiKey)
}

let lastUnavailableReason: string | null = null

/**
 * Can the Gemini provider serve requests in this environment?
 * Cheap check: key configured (+ one lightweight model-list ping, cached).
 */
let availabilityCache: { value: boolean; ts: number } | null = null
const AVAILABILITY_TTL_MS = 5 * 60_000

export async function isGeminiAvailable(): Promise<boolean> {
  const cfg = getGeminiProviderConfig()
  if (!cfg.apiKey) {
    lastUnavailableReason = 'GEMINI_API_KEY is not set — get one at https://aistudio.google.com/apikey'
    return false
  }
  if (availabilityCache && Date.now() - availabilityCache.ts < AVAILABILITY_TTL_MS) {
    return availabilityCache.value
  }
  // Lightweight reachability ping: list models with a tiny timeout.
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${cfg.apiBase}/models?key=${encodeURIComponent(cfg.apiKey)}&pageSize=1`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    const ok = res.ok
    if (!ok) {
      const text = await res.text().catch(() => '')
      lastUnavailableReason = `Gemini API HTTP ${res.status}: ${text.slice(0, 160)}`
    } else {
      lastUnavailableReason = null
    }
    availabilityCache = { value: ok, ts: Date.now() }
    return ok
  } catch (err) {
    lastUnavailableReason = err instanceof Error ? err.message : 'Gemini API unreachable'
    availabilityCache = { value: false, ts: Date.now() }
    return false
  }
}

/** Why the provider is unusable (for status surfaces / error messages). */
export function geminiUnavailableMessage(): string {
  return lastUnavailableReason ?? 'Gemini provider not initialized'
}

export interface GeminiChatResult {
  content: string
  reasoning: string
  model: string
}

export interface GeminiChatOptions {
  temperature?: number
  maxTokens?: number
  /** Gemini has no server-side thinking toggle in this path — accepted for interface parity. */
  thinking?: boolean
  /** Wall-clock guard in ms (default GEMINI_TIMEOUT_MS). */
  timeoutMs?: number
  /** Override the model for this call (e.g. benchmark runs). */
  model?: string
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

/**
 * One chat completion through Gemini, shaped like the local engine's
 * RawChatResult (+ model name). Multi-turn messages preserved: system
 * messages become systemInstruction, the rest become contents turns.
 */
export async function geminiChatDetailed(
  messages: Array<{ role: string; content: string }>,
  options?: GeminiChatOptions,
): Promise<GeminiChatResult> {
  const cfg = getGeminiProviderConfig()
  if (!cfg.apiKey) {
    throw new Error('GEMINI_API_KEY is not set — configure it in .env to enable the Gemini fallback')
  }
  const model = options?.model ?? cfg.model
  const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs

  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(
      `${cfg.apiBase}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: turns.length > 0 ? turns : [{ role: 'user', parts: [{ text: '' }] }],
          generationConfig: {
            temperature: options?.temperature ?? 0.2,
            maxOutputTokens: Math.min(options?.maxTokens ?? 8192, 65536),
          },
        }),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as GeminiResponse
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`)
    }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    let content = ''
    let reasoning = ''
    for (const p of parts) {
      const t = typeof p.text === 'string' ? p.text : ''
      if (!t) continue
      // Gemini 2.5 "thought" parts carry chain-of-thought separately.
      if (p.thought === true) reasoning += t
      else content += t
    }
    return { content, reasoning, model }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${(timeoutMs / 1000).toFixed(0)}s`)
    }
    throw err instanceof Error ? err : new Error('Gemini request failed')
  } finally {
    clearTimeout(timer)
  }
}
