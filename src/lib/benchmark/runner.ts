/**
 * runner.ts — orchestrates a benchmark run.
 *
 * For each selected model × each generated case × each suite test:
 * call the model (temperature 0.1), time it, parse + score the answer,
 * persist progress incrementally so the UI can poll. A failed call scores 0
 * for that test with the error noted — the run never crashes.
 *
 * Providers: local Ollama / OpenAI-compatible servers via localAi, plus the
 * Google Gemini REST fallback via geminiProvider (local-first policy).
 */

import { db } from '@/lib/db'
import { listLocalAiModels, probeModelParamSize } from '@/lib/localAi'
import { inferModelTierProbed } from '@/lib/modelTiers'
import {
  geminiChatDetailed,
  geminiUnavailableMessage,
  isGeminiAvailable,
  isGeminiConfigured,
} from '@/lib/geminiProvider'
import { extractJsonObject } from '@/lib/aiJson'
import { generateCase } from './caseGenerator'
import { buildTestCases } from './suites'
import { latencyMetrics, scoreCategory, weightedOverall } from './scorer'
import type {
  BenchmarkModelInfo,
  BenchmarkProgress,
  BenchmarkRunConfig,
  CategoryScore,
  TestOutcome,
} from './types'
import { categoriesForSuite, resolveRunMode } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Model registry
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_BENCHMARK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']

const GEMINI_LABELS: Record<string, string> = {
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
}

export interface ProviderStatus {
  local: { available: boolean; endpoint: string; error?: string; count: number }
  gemini: { configured: boolean; available: boolean; error?: string }
}

export interface ModelListing {
  models: BenchmarkModelInfo[]
  providers: ProviderStatus
}

/**
 * List benchmarkable models: local Ollama models (when the local server is
 * reachable) + Gemini models (only when GEMINI_API_KEY is set). Local models
 * are annotated with their computed tier (fast ≤3B / standard 3–7B /
 * deep 7B+) so the lab shows exactly how RED Justice's tier router would
 * classify each candidate.
 */
export async function listBenchmarkModels(): Promise<ModelListing> {
  const localListing = await listLocalAiModels().catch(() => ({
    models: [],
    endpoint: '',
    available: false,
    error: 'probe failed',
  }))
  // In auto/gemini mode listLocalAiModels may fall back to the Gemini endpoint
  // — that means the LOCAL server is not reachable.
  const isGeminiFallback = (localListing.endpoint ?? '').includes('google-gemini')
  const localAvailable = Boolean(localListing.available) && !isGeminiFallback
  const localModels: BenchmarkModelInfo[] = await Promise.all(
    (localAvailable ? localListing.models : []).map(async (m): Promise<BenchmarkModelInfo> => {
      // Name-encoded size first (qwen3:4b …), then a /api/show probe.
      const fromName = inferModelTierProbed(m.name, null)
      if (fromName) return { id: m.name, label: m.name, provider: 'local' as const, available: true, sizeBytes: m.size, tier: fromName }
      const probedB = await probeModelParamSize(m.name).catch(() => null)
      return {
        id: m.name,
        label: m.name,
        provider: 'local' as const,
        available: true,
        sizeBytes: m.size,
        paramSizeB: probedB,
        tier: inferModelTierProbed(m.name, probedB != null ? `${probedB}B` : null),
      }
    }),
  )

  const geminiConfigured = isGeminiConfigured()
  let geminiAvailable = false
  let geminiError: string | undefined
  if (geminiConfigured) {
    geminiAvailable = await isGeminiAvailable()
    if (!geminiAvailable) geminiError = geminiUnavailableMessage()
  } else {
    geminiError = 'GEMINI_API_KEY is not set — get one at https://aistudio.google.com/apikey'
  }
  const geminiModels: BenchmarkModelInfo[] = GEMINI_BENCHMARK_MODELS.map((id) => ({
    id,
    label: GEMINI_LABELS[id] ?? id,
    provider: 'gemini' as const,
    available: geminiAvailable,
    detail: geminiAvailable ? undefined : (geminiError ?? 'unavailable'),
  }))

  return {
    models: [...localModels, ...geminiModels],
    providers: {
      local: {
        available: localAvailable,
        endpoint: localListing.endpoint ?? '',
        error: localAvailable ? undefined : isGeminiFallback ? 'local server unreachable' : localListing.error,
        count: localModels.length,
      },
      gemini: { configured: geminiConfigured, available: geminiAvailable, error: geminiError },
    },
  }
}

/** Resolve model ids to provider descriptors, tolerating flapping providers. */
export async function resolveModels(modelIds: string[]): Promise<Array<{ id: string; provider: 'local' | 'gemini' }>> {
  const listing = await listBenchmarkModels().catch(() => null)
  return modelIds.map((id) => {
    const known = listing?.models.find((m) => m.id === id)
    if (known) return { id, provider: known.provider }
    // Best-effort guess: Gemini model ids are namespaced.
    return { id, provider: id.startsWith('gemini') ? ('gemini' as const) : ('local' as const) }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface BenchChatMessage {
  role: string
  content: string
}

export async function chatForModel(
  model: { id: string; provider: 'local' | 'gemini' },
  messages: BenchChatMessage[],
  opts: {
    temperature?: number
    maxTokens?: number
    timeoutMs?: number
    /** Turbo mode: disable chain-of-thought on thinking models (think:false). */
    thinking?: boolean
    /** Turbo mode: constrain the reply to JSON (grammar / response_format). */
    json?: boolean
  } = {},
): Promise<{ content: string; model: string }> {
  if (model.provider === 'gemini') {
    const r = await geminiChatDetailed(messages, {
      model: model.id,
      temperature: opts.temperature ?? 0.1,
      maxTokens: opts.maxTokens ?? 4096,
      timeoutMs: opts.timeoutMs ?? 180_000,
    })
    return { content: r.content, model: r.model }
  }
  const r = await localChatDetailedAdapter(messages, model.id, opts)
  return { content: r.content, model: r.model }
}

async function localChatDetailedAdapter(
  messages: BenchChatMessage[],
  modelId: string,
  opts: { temperature?: number; maxTokens?: number; thinking?: boolean; json?: boolean },
): Promise<{ content: string; model: string }> {
  // Imported lazily so this module stays importable from route handlers that
  // only need the model registry.
  const { localChatDetailed } = await import('@/lib/localAi')
  const r = await localChatDetailed(messages, {
    model: modelId,
    temperature: opts.temperature ?? 0.1,
    // Undefined → localAi applies its profile-sized default (mirrors the
    // production scan path, incl. the tighter 8192 cap when thinking is off).
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
  })
  return { content: r.content, model: r.model }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run orchestration
// ─────────────────────────────────────────────────────────────────────────────

interface RunModel {
  id: string
  provider: 'local' | 'gemini'
}

/**
 * Execute a full benchmark run and persist progress + results.
 * Never throws — catastrophic failures are recorded on the run row.
 */
export async function runBenchmark(
  runId: string,
  models: RunModel[],
  config: BenchmarkRunConfig,
): Promise<void> {
  const categories = categoriesForSuite(config.suite)
  const seed = config.seed ?? 42
  const mode = resolveRunMode(config.mode)
  const cases = Array.from({ length: config.caseCount }, (_, i) => generateCase(seed + i * 1013))
  const testsPerCase = categories.length

  // Per-call delivery options for this run's mode.
  //  turbo   → EXACTLY the production scan configuration from v3.1.1:
  //            thinking off + JSON grammar. On hybrid thinking models
  //            (Qwen3/Qwen3.5/gpt-oss…) this is 5-10× faster with no
  //            extraction-quality loss, so runs finish in minutes, not hours.
  //  quality → model defaults with thinking allowed. CoT + the JSON answer
  //            must BOTH fit the output budget, so give it real room (the old
  //            fixed 3072-token cap truncated chain-of-thought mid-answer →
  //            broken JSON → unfair 0 scores).
  const callOpts =
    mode === 'turbo'
      ? ({ temperature: 0.1, thinking: false, json: true } as const)
      : ({ temperature: 0.1, maxTokens: 8192 } as const)
  console.log(
    `[benchmark] run ${runId.slice(0, 8)} mode=${mode} — ${
      mode === 'turbo'
        ? 'production scan config (thinking off + JSON grammar)'
        : 'raw model defaults (thinking allowed)'
    }`,
  )
  const total = models.length * config.caseCount * testsPerCase
  const perModel = models.map((m) => ({
    model: m.id,
    provider: m.provider,
    done: 0,
    total: config.caseCount * testsPerCase,
    status: 'pending' as 'pending' | 'running' | 'complete',
  }))
  let done = 0

  const setProgress = async (currentModel?: string, currentTest?: string) => {
    const progress: BenchmarkProgress = {
      done,
      total,
      currentModel,
      currentTest,
      perModel: perModel.map((p) => ({ ...p })),
    }
    await db.benchmarkRun
      .update({ where: { id: runId }, data: { progressJson: JSON.stringify(progress) } })
      .catch(() => {})
  }

  try {
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi]
      perModel[mi].status = 'running'
      const outcomes: TestOutcome[] = []

      for (let ci = 0; ci < cases.length; ci++) {
        const c = cases[ci]
        const tests = buildTestCases(c, config.suite)
        for (const test of tests) {
          await setProgress(model.id, `${test.label} — case ${ci + 1}/${config.caseCount} (${c.caseId})`)
          const started = Date.now()
          let outcome: TestOutcome
          try {
            const res = await chatForModel(
              model,
              [
                { role: 'system', content: test.systemPrompt },
                { role: 'user', content: test.userPrompt },
              ],
              callOpts,
            )
            const latencyMs = Date.now() - started
            const parsed = extractJsonObject<Record<string, unknown>>(res.content)
            const scored = scoreCategory(test, parsed, res.content)
            outcome = {
              category: test.category,
              label: `${test.label} — ${c.caseId}`,
              caseIndex: ci,
              score: scored.score,
              notes: scored.notes,
              latencyMs,
              responsePreview: (res.content ?? '').slice(0, 500),
              parsed: Boolean(parsed),
            }
          } catch (err) {
            outcome = {
              category: test.category,
              label: `${test.label} — ${c.caseId}`,
              caseIndex: ci,
              score: 0,
              notes: 'model call failed — scored 0',
              latencyMs: Date.now() - started,
              error: err instanceof Error ? err.message : String(err),
              responsePreview: '',
              parsed: false,
            }
          }
          outcomes.push(outcome)
          done++
          perModel[mi].done++
          await setProgress(model.id, `${test.label} — case ${ci + 1}/${config.caseCount} (${c.caseId})`)
        }
      }

      // Aggregate + persist this model's result row.
      const categoryScores: CategoryScore[] = categories.map((cat) => {
        const catOutcomes = outcomes.filter((o) => o.category === cat)
        return {
          category: cat,
          score: catOutcomes.length > 0 ? catOutcomes.reduce((a, o) => a + o.score, 0) / catOutcomes.length : 0,
          samples: catOutcomes.length,
        }
      })
      const overall = weightedOverall(categoryScores)
      const lat = latencyMetrics(outcomes.map((o) => o.latencyMs))
      await db.benchmarkResult.create({
        data: {
          runId,
          model: model.id,
          provider: model.provider,
          overallScore: overall,
          categoryScoresJson: JSON.stringify(categoryScores),
          metricsJson: JSON.stringify({
            ...lat,
            testsRun: outcomes.length,
            failures: outcomes.filter((o) => Boolean(o.error)).length,
            suite: config.suite,
            caseCount: config.caseCount,
            seed,
            mode,
          }),
          detailsJson: JSON.stringify(outcomes),
        },
      })
      perModel[mi].status = 'complete'
    }

    await setProgress()
    await db.benchmarkRun.update({
      where: { id: runId },
      data: { status: 'complete', finishedAt: new Date() },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.benchmarkRun
      .update({ where: { id: runId }, data: { status: 'failed', error: message, finishedAt: new Date() } })
      .catch(() => {})
  }
}
