/**
 * GET /api/cases/[id]/reports/json — structured JSON export of the same
 * investigation summary content as /reports/summary.
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
      evidence,
      entities,
      transactions,
      communities,
      findings,
      actorRisks,
      timeline,
    ] = await Promise.all([
      db.case.findUnique({ where: { id: caseId } }),
      db.evidence.findMany({
        where: { caseId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          originalName: true,
          source: true,
          status: true,
          sha256: true,
          size: true,
          createdAt: true,
          _count: {
            select: {
              entityLinks: true,
              transactions: true,
              communications: true,
            },
          },
        },
      }),
      db.entity.findMany({
        where: { caseId },
        include: {
          _count: {
            select: { links: true, srcRels: true, dstRels: true },
          },
        },
      }),
      db.transaction.findMany({
        where: { caseId },
        orderBy: { amount: 'desc' },
        select: {
          id: true,
          amount: true,
          senderAccount: true,
          receiverAccount: true,
          txnDate: true,
          utr: true,
          remarks: true,
        },
      }),
      db.community.findMany({
        where: { caseId },
        orderBy: { size: 'desc' },
        include: {
          members: {
            include: {
              entity: {
                select: { id: true, type: true, value: true, label: true },
              },
            },
          },
        },
      }),
      db.finding.findMany({
        where: { caseId },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      }),
      db.actorRisk.findMany({
        where: { caseId },
        orderBy: { score: 'desc' },
        take: 20,
        include: {
          entity: {
            select: { id: true, type: true, value: true, label: true },
          },
        },
      }),
      db.timelineEvent.findMany({
        where: { caseId },
        orderBy: { ts: 'asc' },
        take: 50,
      }),
    ])

    if (!caseRow) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const amounts = transactions
      .map((t) => t.amount ?? 0)
      .filter((a) => Number.isFinite(a))
    const totalVolume = amounts.reduce((a, b) => a + b, 0)
    const avgAmount = amounts.length === 0 ? 0 : totalVolume / amounts.length
    const maxAmount = amounts.length === 0 ? 0 : Math.max(...amounts)

    const findingsBySeverity: Record<string, number> = {}
    const findingsByType: Record<string, number> = {}
    for (const f of findings) {
      findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1
      findingsByType[f.type] = (findingsByType[f.type] ?? 0) + 1
    }

    const evidenceBySource: Record<string, number> = {}
    for (const e of evidence) {
      const k = e.source ?? 'unspecified'
      evidenceBySource[k] = (evidenceBySource[k] ?? 0) + 1
    }

    const entityRows = entities
      .map((e) => ({
        id: e.id,
        type: e.type,
        value: e.value,
        label: e.label,
        linkCount: e._count.links,
        neighborCount: e._count.srcRels + e._count.dstRels,
      }))
      .sort((a, b) => b.linkCount - a.linkCount)

    const report = {
      generatedAt: new Date().toISOString(),
      case: {
        uid: caseRow.uid,
        title: caseRow.title,
        description: caseRow.description,
        status: caseRow.status,
        classification: caseRow.classification,
        aiMode: caseRow.aiMode,
        investigators: caseRow.investigators,
        tags: caseRow.tags,
        createdAt: caseRow.createdAt,
        updatedAt: caseRow.updatedAt,
      },
      evidence: {
        total: evidence.length,
        bySource: evidenceBySource,
        items: evidence.map((e) => ({
          id: e.id,
          originalName: e.originalName,
          source: e.source,
          status: e.status,
          sha256: e.sha256,
          size: e.size,
          createdAt: e.createdAt,
          entityCount: e._count.entityLinks,
          transactionCount: e._count.transactions,
          communicationCount: e._count.communications,
        })),
      },
      entities: {
        total: entities.length,
        top: entityRows.slice(0, 30),
      },
      transactions: {
        total: transactions.length,
        totalVolume,
        avgAmount,
        maxAmount,
        topFlows: transactions.slice(0, 20),
      },
      communities: communities.map((c) => ({
        id: c.id,
        label: c.label,
        size: c.size,
        dominantTypes: c.dominantTypes,
        transactionVolume: c.transactionVolume,
        internalRels: c.internalRels,
        externalRels: c.externalRels,
        suspiciousPatterns: c.suspiciousPatterns,
        members: c.members
          .map((m) => m.entity)
          .filter(Boolean)
          .map((e) => ({
            id: e!.id,
            type: e!.type,
            value: e!.value,
            label: e!.label,
          })),
      })),
      findings: {
        total: findings.length,
        bySeverity: findingsBySeverity,
        byType: findingsByType,
        high: findings.filter((f) => f.severity === 'high').slice(0, 30),
        all: findings,
      },
      actors: actorRisks.map((a) => ({
        entityId: a.entityId,
        entity: a.entity,
        score: a.score,
        contributors: (() => {
          try {
            return JSON.parse(a.contributorsJson ?? '[]')
          } catch {
            return []
          }
        })(),
        components: (() => {
          try {
            return JSON.parse(a.componentsJson ?? '{}')
          } catch {
            return {}
          }
        })(),
      })),
      timeline,
      disclaimer:
        'Advisory report — must be reviewed by a human investigator before any action.',
    }

    return NextResponse.json(report)
  } catch (err) {
    console.error('[api/cases/[id]/reports/json GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'json report failed' },
      { status: 500 },
    )
  }
}
