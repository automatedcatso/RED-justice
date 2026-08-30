/**
 * GET  /api/cases/[id]/contradictions — list the case's contradiction graph.
 * POST /api/cases/[id]/contradictions — (re)run deterministic detection.
 *
 * Contradictions model conflicting claims between evidence records with the
 * relations supports / contradicts / supersedes / unresolved.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { detectContradictions } from '@/lib/investigation/contradictionEngine'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const rows = await db.contradiction.findMany({
      where: { caseId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })

    const contradictions = rows.map((c) => ({
      id: c.id,
      relation: c.relation,
      subjectType: c.subjectType,
      subjectAId: c.subjectAId,
      subjectBId: c.subjectBId,
      subjectARef: c.subjectARef,
      subjectBRef: c.subjectBRef,
      description: c.description,
      status: c.status,
      resolutionNote: c.resolutionNote,
      evidenceIds: (() => { try { return JSON.parse(c.evidenceIdsJson ?? '[]') as string[] } catch { return [] } })(),
      detector: c.detector,
      createdAt: c.createdAt.toISOString(),
    }))

    const byRelation: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    for (const c of contradictions) {
      byRelation[c.relation] = (byRelation[c.relation] ?? 0) + 1
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
    }

    return NextResponse.json({ contradictions, total: contradictions.length, byRelation, byStatus })
  } catch (err) {
    console.error('[contradictions GET] failed:', err)
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

    const result = await detectContradictions(db, caseId)
    await logActivity(db, caseId, `Contradiction detection ran — ${result.created} new of ${result.detected} detected`)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[contradictions POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
