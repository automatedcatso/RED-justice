/**
 * gemini.ts — Gemini adapter for the Local-AI / Gemini Equivalence Mode.
 *
 * Calls the Gemini generativelanguage REST API with the exact same
 * investigation prompt the local AI receives, so the two answers can be
 * compared for citations, grounding, hallucinations and latency.
 *
 * The actual REST plumbing lives in geminiProvider.ts (shared with the
 * Fully-AI pipeline fallback); this module keeps the equivalence-mode
 * result shape (available / latencyMs / answer / error).
 *
 * Configuration:
 *   GEMINI_API_KEY  — Google AI Studio API key (empty = feature unavailable)
 *   GEMINI_MODEL    — default "gemini-2.0-flash"
 */

import { getGeminiProviderConfig, geminiChatDetailed } from './geminiProvider'

export interface GeminiConfig {
  apiKey: string
  model: string
  timeoutMs: number
}

export function getGeminiConfig(): GeminiConfig {
  const cfg = getGeminiProviderConfig()
  return { apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs }
}

export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiConfig().apiKey)
}

export interface GeminiResult {
  available: boolean
  model: string
  latencyMs: number
  answer: string
  error?: string
}

/** Mirrors localChat()'s message shape so the two adapters are interchangeable. */
export async function geminiChat(
  messages: Array<{ role: string; content: string }>,
  options?: { temperature?: number; maxTokens?: number; model?: string },
): Promise<GeminiResult> {
  const cfg = getGeminiConfig()
  const started = Date.now()
  if (!cfg.apiKey) {
    return {
      available: false,
      model: cfg.model,
      latencyMs: 0,
      answer: '',
      error: 'GEMINI_API_KEY not configured — equivalence mode unavailable for Gemini side',
    }
  }
  try {
    const r = await geminiChatDetailed(messages, {
      temperature: options?.temperature ?? 0.3,
      maxTokens: options?.maxTokens ?? 2048,
      model: options?.model,
    })
    return { available: true, model: r.model, latencyMs: Date.now() - started, answer: r.content }
  } catch (err) {
    return {
      available: false,
      model: cfg.model,
      latencyMs: Date.now() - started,
      answer: '',
      error: err instanceof Error ? err.message : 'gemini request failed',
    }
  }
}
