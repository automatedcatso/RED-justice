/**
 * POST /api/cases/[id]/actors/run — re-compute actor risk, persist new
 * ActorRisk rows (upsert by caseId+entityId).
 *
 * Returns `{ updated, total }`.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  buildPatternContext,
  toGraphInput,
  persistActorRisks,
  logActivity,
} from '@/lib/api/helpers'
import {
  computeAll,
  computeActorRisk,
} from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const ctx = await buildPatternContext(db, caseId)
    if (!ctx) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    // Re-fetch findings so the actor-risk computation reflects the latest
    // persisted findings.
    const findingsRows = await db.finding.findMany({
      where: { caseId },
    })
    const findings = findingsRows.map((f) => ({
      id: f.id,
      caseId: f.caseId,
      type: f.type,
      severity: f.severity as 'low' | 'medium' | 'high',
      confidence: f.confidence,
      description: f.description,
      trigger: f.trigger ?? undefined,
      entitiesJson: f.entitiesJson ?? undefined,
      relationshipsJson: f.relationshipsJson ?? undefined,
      transactionsJson: f.transactionsJson ?? undefined,
      supportingEvidence: f.supportingEvidence ?? undefined,
      reviewStatus: f.reviewStatus ?? undefined,
    }))

    const metrics = computeAll(toGraphInput(ctx.entities, ctx.relationships))
    const scores = computeActorRisk(ctx, { metrics, findings })
    const result = await persistActorRisks(db, caseId, scores)

    await logActivity(
      db,
      caseId,
      `Actor risk re-computed: ${result.updated} updated`,
    )

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/cases/[id]/actors/run POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'actors run failed' },
      { status: 500 },
    )
  }
}
