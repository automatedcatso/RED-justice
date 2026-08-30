/**
 * GET  /api/cases/[id]/observations — list provenance-preserving entity
 *      observations for the case (filterable by ?entityId=).
 * POST /api/cases/[id]/observations — backfill observations for entities that
 *      pre-date the observation ledger (idempotent).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { backfillObservations } from '@/lib/investigation/observations'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const entityId = req.nextUrl.searchParams.get('entityId') ?? undefined
    const take = Math.min(1000, parseInt(req.nextUrl.searchParams.get('limit') ?? '300', 10))

    const observations = await db.entityObservation.findMany({
      where: { caseId, ...(entityId ? { entityId } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        entity: { select: { id: true, type: true, value: true, label: true } },
      },
    })

    return NextResponse.json({
      observations: observations.map((o) => ({
        id: o.id,
        entityId: o.entityId,
        entity: o.entity,
        rawType: o.rawType,
        rawValue: o.rawValue,
        norm: o.norm,
        evidenceId: o.evidenceId,
        evidenceName: o.evidenceName,
        locator: o.locator,
        extractionMethod: o.extractionMethod,
        mergedFromId: o.mergedFromId,
        createdAt: o.createdAt.toISOString(),
      })),
      total: observations.length,
    })
  } catch (err) {
    console.error('[observations GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const result = await backfillObservations(db, caseId)
    if (result.created > 0) {
      await logActivity(db, caseId, `Observation ledger backfilled — ${result.created} observations created from evidence links`)
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[observations POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
