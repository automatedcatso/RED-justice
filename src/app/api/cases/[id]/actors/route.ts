/**
 * GET /api/cases/[id]/actors — list ActorRisk rows for the case sorted by
 * score desc, with the entity resolved and contributors array.
 * Supports ?minScore=&limit= filters.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const sp = req.nextUrl.searchParams
    const minScoreRaw = sp.get('minScore')
    const minScore = minScoreRaw ? parseFloat(minScoreRaw) : undefined
    const limit = Math.min(
      500,
      Math.max(1, parseInt(sp.get('limit') ?? '50', 10)),
    )

    const where: { caseId: string; score?: { gte: number } } = { caseId }
    if (minScore !== undefined && Number.isFinite(minScore)) {
      where.score = { gte: minScore }
    }

    const actors = await db.actorRisk.findMany({
      where,
      orderBy: { score: 'desc' },
      take: limit,
      include: {
        entity: {
          select: {
            id: true,
            type: true,
            value: true,
            label: true,
            norm: true,
            confidence: true,
          },
        },
      },
    })

    const result = actors.map((a) => ({
      id: a.id,
      caseId: a.caseId,
      entityId: a.entityId,
      score: a.score,
      components: (() => {
        try {
          return JSON.parse(a.componentsJson ?? '{}')
        } catch {
          return {}
        }
      })(),
      contributors: (() => {
        try {
          return JSON.parse(a.contributorsJson ?? '[]')
        } catch {
          return []
        }
      })(),
      entity: a.entity,
      updatedAt: a.updatedAt,
    }))

    return NextResponse.json({ actors: result, total: result.length })
  } catch (err) {
    console.error('[api/cases/[id]/actors GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'actors failed' },
      { status: 500 },
    )
  }
}
