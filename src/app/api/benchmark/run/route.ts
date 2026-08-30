/**
 * POST /api/benchmark/run — create a benchmark run and execute it in the
 * background (fire-and-forget; progress is persisted for polling).
 *
 * Body: { modelIds: string[], config?: { suite?: 'quick'|'full', caseCount?: number, seed?: number, mode?: 'turbo'|'quality' } }
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveModels, runBenchmark } from '@/lib/benchmark/runner'
import { resolveRunMode } from '@/lib/benchmark/types'
import type { BenchmarkRunConfig } from '@/lib/benchmark/types'

export const dynamic = 'force-dynamic'

const MAX_MODELS = 6

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      modelIds?: unknown
      config?: { suite?: unknown; caseCount?: unknown; seed?: unknown; mode?: unknown }
    }

    const modelIds = Array.isArray(body.modelIds)
      ? body.modelIds.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
      : []
    if (modelIds.length === 0) {
      return NextResponse.json({ error: 'select at least one model' }, { status: 400 })
    }
    if (modelIds.length > MAX_MODELS) {
      return NextResponse.json({ error: `at most ${MAX_MODELS} models per run` }, { status: 400 })
    }

    const suite = body.config?.suite === 'full' ? 'full' : 'quick'
    const caseCountRaw = Number(body.config?.caseCount ?? 2)
    const caseCount = Math.min(5, Math.max(1, Number.isFinite(caseCountRaw) ? Math.floor(caseCountRaw) : 2))
    const seedRaw = Number(body.config?.seed)
    const seed = Number.isFinite(seedRaw) && seedRaw > 0 ? Math.floor(seedRaw) : Math.floor(Date.now() / 1000) % 1_000_000
    // turbo = production scan config (fast); quality = raw model defaults.
    const mode = resolveRunMode(body.config?.mode)

    const config: BenchmarkRunConfig = { suite, caseCount, seed, mode }
    const models = await resolveModels(modelIds)

    const label =
      models.length === 1
        ? `${models[0].id} · ${suite} · ${caseCount} case${caseCount > 1 ? 's' : ''} · ${mode}`
        : `${models.length} models · ${suite} · ${caseCount} case${caseCount > 1 ? 's' : ''} · ${mode}`

    const run = await db.benchmarkRun.create({
      data: {
        label,
        status: 'running',
        configJson: JSON.stringify(config),
        progressJson: JSON.stringify({ done: 0, total: models.length * caseCount * (suite === 'quick' ? 7 : 11) }),
        modelsJson: JSON.stringify(models),
      },
    })

    // Fire-and-forget: the runner persists progress + results incrementally.
    void runBenchmark(run.id, models, config).catch(async (err) => {
      console.error('[api/benchmark/run] runner crashed:', err)
      await db.benchmarkRun
        .update({
          where: { id: run.id },
          data: {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          },
        })
        .catch(() => {})
    })

    return NextResponse.json({ runId: run.id, run: { id: run.id, label, status: run.status } })
  } catch (err) {
    console.error('[api/benchmark/run POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to start run' },
      { status: 500 },
    )
  }
}
