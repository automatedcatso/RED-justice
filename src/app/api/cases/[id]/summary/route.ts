/**
 * GET /api/cases/[id]/summary — case overview.
 *
 * Returns counts of evidence/entities/transactions/findings/communities,
 * top 5 actor risks, top 5 recent findings, top 5 recent timeline events.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

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
      evidenceCount,
      entityCount,
      relationshipCount,
      txnCount,
      commCount,
      findingCount,
      communityCount,
      actorRiskCount,
      timelineCount,
      topActors,
      topFindings,
      recentTimeline,
      entityByTypeAgg,
      findingBySeverityAgg,
      findingByTypeAgg,
    ] = await Promise.all([
      db.case.findUnique({
        where: { id: caseId },
        include: {
          _count: {
            select: {
              evidence: true,
              entities: true,
              relationships: true,
              transactions: true,
              communications: true,
              findings: true,
              actorRisks: true,
              communities: true,
            },
          },
        },
      }),
      db.evidence.count({ where: { caseId } }),
      db.entity.count({ where: { caseId } }),
      db.relationship.count({ where: { caseId } }),
      db.transaction.count({ where: { caseId } }),
      db.communication.count({ where: { caseId } }),
      db.finding.count({ where: { caseId } }),
      db.community.count({ where: { caseId } }),
      db.actorRisk.count({ where: { caseId } }),
      db.timelineEvent.count({ where: { caseId } }),
      db.actorRisk.findMany({
        where: { caseId },
        orderBy: { score: 'desc' },
        take: 5,
        include: { entity: true },
      }),
      db.finding.findMany({
        where: { caseId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      db.timelineEvent.findMany({
        where: { caseId },
        orderBy: { ts: 'desc' },
        take: 5,
      }),
      db.entity.groupBy({
        by: ['type'],
        where: { caseId },
        _count: { _all: true },
      }),
      db.finding.groupBy({
        by: ['severity'],
        where: { caseId },
        _count: { _all: true },
      }),
      db.finding.groupBy({
        by: ['type'],
        where: { caseId },
        _count: { _all: true },
      }),
    ])

    if (!caseRow) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const entityByType: Record<string, number> = {}
    for (const e of entityByTypeAgg) entityByType[e.type] = e._count._all
    const findingBySeverity: Record<string, number> = {}
    for (const f of findingBySeverityAgg) findingBySeverity[f.severity] = f._count._all
    const findingByType: Record<string, number> = {}
    for (const f of findingByTypeAgg) findingByType[f.type] = f._count._all

    return NextResponse.json({
      case: caseRow,
      counts: {
        evidence: evidenceCount,
        entities: entityCount,
        relationships: relationshipCount,
        transactions: txnCount,
        communications: commCount,
        findings: findingCount,
        communities: communityCount,
        actorRisks: actorRiskCount,
        timelineEvents: timelineCount,
      },
      entityByType,
      findingsBySeverity: findingBySeverity,
      findingsByType: findingByType,
      topActors: topActors.map((a) => ({
        id: a.id,
        score: a.score,
        entityId: a.entityId,
        entity: a.entity
          ? {
              id: a.entity.id,
              type: a.entity.type,
              value: a.entity.value,
              label: a.entity.label,
            }
          : null,
        contributors: (() => {
          try {
            return JSON.parse(a.contributorsJson ?? '[]')
          } catch {
            return []
          }
        })(),
      })),
      topFindings,
      recentTimeline,
    })
  } catch (err) {
    console.error('[api/cases/[id]/summary GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'summary failed' },
      { status: 500 },
    )
  }
}
