/**
 * GET    /api/benchmark/runs/[id] — full run + results + progress (polling).
 * DELETE /api/benchmark/runs/[id] — delete run (cascades results).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const run = await db.benchmarkRun.findUnique({
      where: { id },
      include: { results: { orderBy: { createdAt: 'asc' } } },
    })
    if (!run) {
      return NextResponse.json({ error: 'run not found' }, { status: 404 })
    }
    return NextResponse.json({
      run: {
        id: run.id,
        label: run.label,
        status: run.status,
        error: run.error,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        config: safeJson(run.configJson, {}),
        progress: safeJson(run.progressJson, {}),
        models: safeJson(run.modelsJson, []),
        results: run.results.map((res) => ({
          id: res.id,
          model: res.model,
          provider: res.provider,
          overallScore: res.overallScore,
          categoryScores: safeJson(res.categoryScoresJson, []),
          metrics: safeJson(res.metricsJson, {}),
          details: safeJson(res.detailsJson, []),
          createdAt: res.createdAt,
        })),
      },
    })
  } catch (err) {
    console.error('[api/benchmark/runs/[id] GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'fetch failed' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const existing = await db.benchmarkRun.findUnique({ where: { id }, select: { id: true } })
    if (!existing) {
      return NextResponse.json({ error: 'run not found' }, { status: 404 })
    }
    await db.benchmarkRun.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/benchmark/runs/[id] DELETE] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'delete failed' }, { status: 500 })
  }
}
