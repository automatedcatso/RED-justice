/**
 * GET /api/cases/[id]/relationships — list relationships.
 * Supports ?type=&entityId= filters.
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
    const entityId = sp.get('entityId') ?? undefined
    const limit = Math.min(
      5000,
      Math.max(1, parseInt(sp.get('limit') ?? '1000', 10)),
    )

    const where: {
      caseId: string
      type?: string
      OR?: Array<Record<string, unknown>>
    } = { caseId }
    if (type) where.type = type
    if (entityId) {
      where.OR = [{ srcId: entityId }, { dstId: entityId }]
    }

    const relationships = await db.relationship.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        src: { select: { id: true, type: true, value: true, label: true } },
        dst: { select: { id: true, type: true, value: true, label: true } },
      },
    })

    return NextResponse.json({
      relationships,
      total: relationships.length,
    })
  } catch (err) {
    console.error('[api/cases/[id]/relationships GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'list failed' },
      { status: 500 },
    )
  }
}
