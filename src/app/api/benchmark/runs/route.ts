/**
 * GET /api/benchmark/runs — list benchmark runs (newest first) with result
 * summaries. Per-test details are omitted here; fetch /runs/[id] for those.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const runs = await db.benchmarkRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        results: {
          select: {
            id: true,
            model: true,
            provider: true,
            overallScore: true,
            categoryScoresJson: true,
            metricsJson: true,
            createdAt: true,
          },
        },
      },
    })
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        config: safeJson(r.configJson, {}),
        progress: safeJson(r.progressJson, {}),
        models: safeJson(r.modelsJson, []),
        results: r.results.map((res) => ({
          id: res.id,
          model: res.model,
          provider: res.provider,
          overallScore: res.overallScore,
          categoryScores: safeJson(res.categoryScoresJson, []),
          metrics: safeJson(res.metricsJson, {}),
          createdAt: res.createdAt,
        })),
      })),
    })
  } catch (err) {
    console.error('[api/benchmark/runs GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed to list runs' }, { status: 500 })
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
