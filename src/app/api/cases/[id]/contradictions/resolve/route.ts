/**
 * POST /api/cases/[id]/contradictions/resolve — investigator resolution.
 * Body: { contradictionId, status: 'resolved'|'accepted'|'open', note?, actor? }
 *
 * Contradictions are first-class graph objects (architecture §7): every human
 * resolution is captured as a structured Decision Record so the audit trail
 * shows WHY a conflicting evidence pair was settled one way or another.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { recordDecision } from '@/lib/investigation/decisions'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      contradictionId?: string
      status?: string
      note?: string
      actor?: string
    }
    if (!body.contradictionId || !['resolved', 'accepted', 'open'].includes(body.status ?? '')) {
      return NextResponse.json({ error: 'contradictionId and status (resolved|accepted|open) required' }, { status: 400 })
    }

    const existing = await db.contradiction.findFirst({
      where: { id: body.contradictionId, caseId },
    })
    if (!existing) return NextResponse.json({ error: 'contradiction not found' }, { status: 404 })

    await db.contradiction.update({
      where: { id: existing.id },
      data: { status: body.status, resolutionNote: body.note ?? null },
    })

    await logActivity(db, caseId, `Contradiction ${existing.id} → ${body.status}${body.note ? `: ${body.note.slice(0, 80)}` : ''}`)

    // Structured Decision Record — before/after states with the reason.
    const decisionRec = await recordDecision(db, {
      caseId,
      action: body.status === 'open' ? 'reopen_contradiction' : body.status === 'accepted' ? 'accept_contradiction' : 'resolve_contradiction',
      objectType: 'contradiction',
      objectRef: existing.id,
      objectLabel: existing.description.slice(0, 160),
      beforeState: existing.status,
      afterState: body.status,
      reason: body.note ?? null,
      actor: body.actor,
      metadata: { detector: existing.detector, relation: existing.relation },
    })

    return NextResponse.json({ ok: true, decisionUid: decisionRec?.uid ?? null })
  } catch (err) {
    console.error('[contradictions/resolve POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
