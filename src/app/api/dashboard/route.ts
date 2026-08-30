/**
 * GET /api/dashboard — aggregate stats across all cases.
 *
 * Returns cases, evidence, entities, transactions, relationships, findings,
 * actors, communities, jobs, and recent activity.
 */
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [
      caseCounts,
      evidenceCounts,
      entities,
      transactions,
      relationshipCount,
      findings,
      actorRisks,
      communityCount,
      communityMemberCount,
      jobCounts,
      recentActivity,
    ] = await Promise.all([
      db.case.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      db.evidence.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      db.entity.findMany({ select: { type: true } }),
      db.transaction.findMany({ select: { amount: true } }),
      db.relationship.count(),
      db.finding.findMany({ select: { severity: true, type: true } }),
      db.actorRisk.findMany({ select: { score: true } }),
      db.community.count(),
      db.communityMember.count(),
      db.processingJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      db.activityLog.findMany({
        orderBy: { at: 'desc' },
        take: 20,
      }),
    ])

    const casesByStatus: Record<string, number> = {}
    for (const c of caseCounts) casesByStatus[c.status] = c._count._all
    const cases = {
      total: Object.values(casesByStatus).reduce((a, b) => a + b, 0),
      open: casesByStatus['open'] ?? 0,
      active: casesByStatus['active'] ?? 0,
      closed: casesByStatus['closed'] ?? 0,
      archived: casesByStatus['archived'] ?? 0,
    }

    const evidenceByStatus: Record<string, number> = {}
    for (const e of evidenceCounts) evidenceByStatus[e.status] = e._count._all
    const evidenceTotal = Object.values(evidenceByStatus).reduce((a, b) => a + b, 0)
    const evidence = {
      total: evidenceTotal,
      pending: evidenceByStatus['pending'] ?? 0,
      processing: evidenceByStatus['processing'] ?? 0,
      processed: evidenceByStatus['processed'] ?? 0,
      error: evidenceByStatus['error'] ?? 0,
      done: (evidenceByStatus['processed'] ?? 0) + (evidenceByStatus['done'] ?? 0),
    }

    const entitiesByType: Record<string, number> = {}
    for (const e of entities) {
      entitiesByType[e.type] = (entitiesByType[e.type] ?? 0) + 1
    }
    const entityStats = {
      total: entities.length,
      byType: entitiesByType,
    }

    const txnAmounts = transactions
      .map((t) => t.amount ?? 0)
      .filter((a) => Number.isFinite(a))
    const txnTotalVolume = txnAmounts.reduce((a, b) => a + b, 0)
    const txnAvg = txnAmounts.length === 0 ? 0 : txnTotalVolume / txnAmounts.length
    const txnMax = txnAmounts.length === 0 ? 0 : Math.max(...txnAmounts)
    const txnStats = {
      total: transactions.length,
      totalVolume: txnTotalVolume,
      avgAmount: txnAvg,
      maxAmount: txnMax,
    }

    const findingBySeverity: Record<string, number> = {}
    const findingByType: Record<string, number> = {}
    for (const f of findings) {
      findingBySeverity[f.severity] = (findingBySeverity[f.severity] ?? 0) + 1
      findingByType[f.type] = (findingByType[f.type] ?? 0) + 1
    }
    const findingStats = {
      total: findings.length,
      bySeverity: findingBySeverity,
      byType: findingByType,
    }

    let high = 0
    let medium = 0
    let low = 0
    for (const a of actorRisks) {
      const s = a.score ?? 0
      if (s >= 70) high += 1
      else if (s >= 50) medium += 1
      else low += 1
    }
    const actorStats = { high, medium, low }

    const jobByStatus: Record<string, number> = {}
    for (const j of jobCounts) jobByStatus[j.status] = j._count._all
    const jobStats = {
      queued: jobByStatus['queued'] ?? 0,
      running: jobByStatus['running'] ?? 0,
      completed: jobByStatus['completed'] ?? 0,
      failed: jobByStatus['failed'] ?? 0,
    }

    return NextResponse.json({
      cases,
      evidence,
      entities: entityStats,
      transactions: txnStats,
      relationships: { total: relationshipCount },
      findings: findingStats,
      actors: actorStats,
      communities: { total: communityCount, totalMembers: communityMemberCount },
      jobs: jobStats,
      recentActivity,
    })
  } catch (err) {
    console.error('[api/dashboard] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'dashboard failed' },
      { status: 500 },
    )
  }
}
