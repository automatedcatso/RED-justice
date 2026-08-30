/**
 * GET /api/ai/models — list available local AI models (Ollama) with tier info.
 *
 * Returns the models installed on the local server, each annotated with its
 * probed parameter size and computed tier (fast ≤3B / standard 3–7B /
 * deep 7B+), plus the ACTIVE tier assignment and the currently-selected
 * fallback model.
 *
 * POST /api/ai/models — set the tier assignment.
 *   Body: { tiers: { fast, standard, deep } }   (v3.3 tier router)
 *   Body: { model }                             (legacy single-model —
 *                                                 assigns every tier to it)
 * Values are applied to process.env immediately and persisted to .env for
 * restarts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'

import { listLocalAiModels, getLocalAiConfig, probeModelParamSize } from '@/lib/localAi'
import { getTierAssignment, inferModelTierProbed, MODEL_TIERS } from '@/lib/modelTiers'

export const dynamic = 'force-dynamic'

interface ModelRow {
  name: string
  size?: number
  modifiedAt?: string
  paramSizeB?: number | null
  tier?: 'fast' | 'standard' | 'deep' | null
  thinkingCapable?: boolean | null
}

export async function GET() {
  try {
    const cfg = getLocalAiConfig()
    const result = await listLocalAiModels()

    // Annotate every installed model with its parameter size + tier. Probe
    // /api/show in parallel (short timeout); fall back to name parsing.
    const models: ModelRow[] = await Promise.all(
      result.models.map(async (m): Promise<ModelRow> => {
        const fromName = inferModelTierProbed(m.name, null)
        if (fromName && !m.name.includes('google-gemini')) {
          // The name already encodes the size (qwen3:4b …) — no probe needed.
          return { ...m, tier: fromName }
        }
        const probed = await probeModelParamSize(m.name).catch(() => null)
        const tier = inferModelTierProbed(m.name, probed != null ? `${probed}B` : null)
        return { ...m, paramSizeB: probed, tier }
      }),
    )

    const tiers = await getTierAssignment().catch(() => null)

    return NextResponse.json({
      models,
      currentModel: cfg.model,
      tiers: tiers
        ? {
            fast: tiers.fast,
            standard: tiers.standard,
            deep: tiers.deep,
            source: tiers.source,
          }
        : { fast: cfg.model, standard: cfg.model, deep: cfg.model, source: 'fallback' },
      endpoint: result.endpoint,
      available: result.available,
      error: result.error,
    })
  } catch (err) {
    console.error('[api/ai/models GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list models' },
      { status: 500 },
    )
  }
}

/** Replace or append an env line, preserving everything else. */
async function persistEnv(entries: Array<{ key: string; value: string }>): Promise<void> {
  const envPath = join(process.cwd(), '.env')
  let envContent = ''
  try {
    envContent = await readFile(envPath, 'utf-8')
  } catch {
    // .env may not exist yet.
  }
  const lines = envContent.split('\n')
  for (const { key, value } of entries) {
    process.env[key] = value
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
    if (idx >= 0) {
      lines[idx] = `${key}=${value}`
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  await writeFile(envPath, lines.join('\n'), 'utf-8')
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { tiers, model } = body as {
      tiers?: { fast?: string; standard?: string; deep?: string }
      model?: string
    }

    let assignment: { fast: string; standard: string; deep: string }

    if (tiers && typeof tiers === 'object') {
      // v3.3 tier router payload.
      const picked: Record<string, string> = {}
      for (const tier of MODEL_TIERS) {
        const v = tiers[tier]
        if (!v || typeof v !== 'string' || !v.trim()) {
          return NextResponse.json(
            { error: `tiers.${tier} is required (select one model per tier)` },
            { status: 400 },
          )
        }
        picked[tier] = v.trim()
      }
      assignment = { fast: picked.fast, standard: picked.standard, deep: picked.deep }
    } else if (model && typeof model === 'string') {
      // Legacy single-model payload: every tier serves this model.
      assignment = { fast: model, standard: model, deep: model }
    } else {
      return NextResponse.json(
        { error: 'provide { tiers: { fast, standard, deep } } or { model }' },
        { status: 400 },
      )
    }

    await persistEnv([
      { key: 'LOCAL_AI_FAST_MODEL', value: assignment.fast },
      { key: 'LOCAL_AI_STANDARD_MODEL', value: assignment.standard },
      { key: 'LOCAL_AI_DEEP_MODEL', value: assignment.deep },
      // The primary model stays meaningful for legacy paths and the offline
      // fallback: pin it to the standard tier (the default scan brain).
      { key: 'LOCAL_AI_MODEL', value: assignment.standard },
    ])

    // Invalidate caches so the next call resolves the new assignment.
    const { clearTierCache } = await import('@/lib/modelTiers')
    const { clearProviderDetectionCache } = await import('@/lib/localAi')
    clearTierCache()
    clearProviderDetectionCache()

    return NextResponse.json({ ok: true, tiers: assignment })
  } catch (err) {
    console.error('[api/ai/models POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to set models' },
      { status: 500 },
    )
  }
}
