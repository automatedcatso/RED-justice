/**
 * GET /api/cases/[id]/export — export a complete case as JSON for backup /
 * transfer to another RED Justice instance.
 *
 * Returns a structured JSON document containing:
 *   - case metadata
 *   - all evidence (with content)
 *   - all entities, relationships, transactions, communications
 *   - all timeline events, findings, communities, actor risks
 *   - investigator notes
 *
 * The response can be saved as a .json file and later re-imported via
 * POST /api/cases/import.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const EXPORT_VERSION = 'red-justice-1.0'

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const [
      caseRow,
      evidence,
      entities,
      relationships,
      transactions,
      communications,
      timeline,
      findings,
      communities,
      communityMembers,
      actorRisks,
      notes,
      activity,
    ] = await Promise.all([
      db.case.findUnique({ where: { id: caseId } }),
      db.evidence.findMany({ where: { caseId } }),
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
      db.transaction.findMany({ where: { caseId } }),
      db.communication.findMany({ where: { caseId } }),
      db.timelineEvent.findMany({ where: { caseId } }),
      db.finding.findMany({ where: { caseId } }),
      db.community.findMany({ where: { caseId } }),
      db.communityMember.findMany({
        where: { community: { caseId } },
        include: { community: { select: { id: true } } },
      }),
      db.actorRisk.findMany({ where: { caseId } }),
      db.investigatorNote.findMany({ where: { caseId } }),
      db.activityLog.findMany({ where: { caseId } }),
    ])

    if (!caseRow) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    // Evidence provenance links — without these, an imported case shows
    // every entity with "0 evidence" even though relationships survive.
    const entityIdSet = entities.map((e) => e.id)
    const entityLinks = await db.entityLink.findMany({
      where: { entityId: { in: entityIdSet } },
      select: { entityId: true, evidenceId: true },
    })

    const exportData = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      case: caseRow,
      evidence,
      entities,
      entityLinks,
      relationships,
      transactions,
      communications,
      timeline,
      findings,
      communities,
      communityMembers: communityMembers.map((cm) => ({
        communityId: cm.communityId,
        entityId: cm.entityId,
      })),
      actorRisks,
      notes,
      activity,
    }

    return NextResponse.json(exportData)
  } catch (err) {
    console.error('[api/cases/[id]/export GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'export failed' },
      { status: 500 },
    )
  }
}
