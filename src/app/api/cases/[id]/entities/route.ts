/**
 * GET /api/cases/[id]/entities — list entities.
 * Supports ?type=&q= filters. Includes linkCount + neighborCount.
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
    const type = sp.get('type') ?? undefined
    const q = sp.get('q') ?? undefined
    // v3.9: status filter — default returns BOTH confirmed + candidate (the
    // list is the review surface); ?status=confirmed|candidate narrows it.
    const status = sp.get('status') ?? undefined
    const limit = Math.min(
      5000,
      Math.max(1, parseInt(sp.get('limit') ?? '500', 10)),
    )

    const where: {
      caseId: string
      type?: string
      status?: string
      OR?: Array<Record<string, unknown>>
    } = { caseId }
    if (type) where.type = type
    if (status === 'confirmed' || status === 'candidate') where.status = status
    if (q) {
      where.OR = [
        { value: { contains: q } },
        { label: { contains: q } },
        { norm: { contains: q } },
      ]
    }

    const entities = await db.entity.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            links: true,
            srcRels: true,
            dstRels: true,
          },
        },
      },
    })

    // neighborCount = srcRels + dstRels count.
    const result = entities.map((e) => {
      // v3.5: source-table IDs (E0001 …) when the entity came from a
      // relationship-table export — surfaced so rows are traceable.
      let tableIds: string[] | undefined
      if (e.metadataJson) {
        try {
          const meta = JSON.parse(e.metadataJson) as { tableIds?: unknown }
          if (Array.isArray(meta.tableIds)) {
            const clean = meta.tableIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
            if (clean.length > 0) tableIds = clean
          }
        } catch { /* ignore malformed metadata */ }
      }
      return {
        id: e.id,
        type: e.type,
        value: e.value,
        norm: e.norm,
        label: e.label,
        confidence: e.confidence,
        status: e.status,
        createdAt: e.createdAt,
        linkCount: e._count.links,
        neighborCount: e._count.srcRels + e._count.dstRels,
        ...(tableIds ? { tableIds } : {}),
      }
    })

    return NextResponse.json({ entities: result, total: result.length })
  } catch (err) {
    console.error('[api/cases/[id]/entities GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'list failed' },
      { status: 500 },
    )
  }
}
