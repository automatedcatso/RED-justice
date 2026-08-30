/**
 * GET /api/cases/[id]/timeline — list TimelineEvent rows.
 * Supports ?kind=&from=&to=&q= filters. Sorted by ts asc.
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
    const kind = sp.get('kind') ?? undefined
    const from = sp.get('from') ?? undefined
    const to = sp.get('to') ?? undefined
    const q = sp.get('q') ?? undefined
    const limit = Math.min(
      5000,
      Math.max(1, parseInt(sp.get('limit') ?? '1000', 10)),
    )

    const where: {
      caseId: string
      kind?: string
      ts?: { gte?: string; lte?: string }
      summary?: { contains: string }
    } = { caseId }
    if (kind) where.kind = kind
    if (from || to) {
      where.ts = {}
      if (from) where.ts.gte = from
      if (to) where.ts.lte = to
    }
    if (q) {
      where.summary = { contains: q }
    }

    const events = await db.timelineEvent.findMany({
      where,
      orderBy: { ts: 'asc' },
      take: limit,
      include: {
        evidence: {
          select: { id: true, originalName: true },
        },
      },
    })

    return NextResponse.json({
      timeline: events,
      total: events.length,
    })
  } catch (err) {
    console.error('[api/cases/[id]/timeline GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'timeline failed' },
      { status: 500 },
    )
  }
}
