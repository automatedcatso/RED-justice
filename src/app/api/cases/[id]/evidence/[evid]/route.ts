/**
 * GET    /api/cases/[id]/evidence/[evid] — get single evidence with related rows.
 * DELETE /api/cases/[id]/evidence/[evid] — delete evidence (cascade).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; evid: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    const evidence = await db.evidence.findFirst({
      where: { id: evid, caseId },
      include: {
        entityLinks: {
          include: { entity: true },
        },
        transactions: true,
        communications: true,
        evidenceStages: true,
        chainOfCustody: { orderBy: { at: 'desc' } },
        timelineEvents: { orderBy: { ts: 'desc' }, take: 20 },
      },
    })
    if (!evidence) {
      return NextResponse.json({ error: 'evidence not found' }, { status: 404 })
    }
    return NextResponse.json({ evidence })
  } catch (err) {
    console.error('[api/cases/[id]/evidence/[evid] GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'fetch failed' },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    const existing = await db.evidence.findFirst({
      where: { id: evid, caseId },
      select: { id: true, originalName: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'evidence not found' }, { status: 404 })
    }
    await db.evidence.delete({ where: { id: evid } })
    await logActivity(
      db,
      caseId,
      `Deleted evidence "${existing.originalName}"`,
    )
    return NextResponse.json({ ok: true, id: evid })
  } catch (err) {
    console.error('[api/cases/[id]/evidence/[evid] DELETE] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'delete failed' },
      { status: 500 },
    )
  }
}
