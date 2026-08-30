/**
 * POST /api/cases/[id]/patterns/decide — Investigator Decision Record.
 *
 * Body: { findingId, decision: 'approved'|'rejected'|'modified', note?, modifiedDescription? }
 *
 * Records the analyst's decision as structured case knowledge with a
 * timestamp and audit trail (ActivityLog). Approved findings with sufficient
 * evidence automatically enter the claim graph as verified claims.
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
      findingId?: string
      decision?: string
      note?: string
      modifiedDescription?: string
      decidedBy?: string
    }
    if (!body.findingId || !['approved', 'rejected', 'modified'].includes(body.decision ?? '')) {
      return NextResponse.json(
        { error: 'findingId and decision (approved|rejected|modified) are required' },
        { status: 400 },
      )
    }

    const finding = await db.finding.findFirst({ where: { id: body.findingId, caseId } })
    if (!finding) return NextResponse.json({ error: 'finding not found' }, { status: 404 })

    const updated = await db.finding.update({
      where: { id: finding.id },
      data: {
        decision: body.decision,
        decidedAt: new Date(),
        decidedBy: body.decidedBy?.trim() || 'investigator',
        decisionNote: body.note ?? null,
        reviewStatus: body.decision === 'rejected' ? 'rejected' : 'reviewed',
        description: body.decision === 'modified' && body.modifiedDescription?.trim()
          ? body.modifiedDescription.trim()
          : finding.description,
      },
    })

    await logActivity(
      db,
      caseId,
      `Decision record: finding ${finding.type} → ${body.decision} by ${updated.decidedBy}${body.note ? ` — "${body.note.slice(0, 80)}"` : ''}`,
    )

    // Structured Decision Record (architecture §18) — WHO/WHAT/BEFORE/AFTER/REASON.
    const decisionRec = await recordDecision(db, {
      caseId,
      action: body.decision === 'approved' ? 'approve_finding' : body.decision === 'rejected' ? 'reject_finding' : 'modify_finding',
      objectType: 'finding',
      objectRef: finding.id,
      objectLabel: `${finding.type}: ${finding.description.slice(0, 120)}`,
      beforeState: finding.decision ?? finding.reviewStatus,
      afterState: updated.reviewStatus,
      reason: body.note ?? null,
      actor: body.decidedBy ?? updated.decidedBy,
      metadata: {
        severity: finding.severity,
        confidence: finding.confidence,
        modifiedDescription: body.decision === 'modified' && body.modifiedDescription ? true : false,
      },
    })

    return NextResponse.json({
      ok: true,
      decisionUid: decisionRec?.uid ?? null,
      decision: {
        findingId: updated.id,
        decision: updated.decision,
        decidedAt: updated.decidedAt?.toISOString() ?? null,
        decidedBy: updated.decidedBy,
        decisionNote: updated.decisionNote,
      },
    })
  } catch (err) {
    console.error('[patterns/decide POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
