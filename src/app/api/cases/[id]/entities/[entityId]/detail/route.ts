/**
 * GET /api/cases/[id]/entities/[entityId]/detail — 360° Entity Intelligence View.
 *
 * Returns everything about a single entity:
 *   - Entity metadata
 *   - All connected entities (neighbors) with relationship types
 *   - Transactions involving this entity
 *   - Communications involving this entity
 *   - Timeline events
 *   - Findings that reference this entity
 *   - Actor risk score (if computed)
 *   - Community membership
 *   - Structural role hypotheses (from roleInference engine)
 *   - Evidence provenance (which evidence files mention this entity)
 *
 * Based on section 44 of the RED Justice research scope document.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, toGraphInput } from '@/lib/api/helpers'
import { computeAll } from '@/lib/analytics'
import { inferRoles, type RoleMetrics } from '@/lib/analytics/roleInference'
import { parseJsonArray } from '@/lib/ui-helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; entityId: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, entityId } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    // Fetch the entity
    const entity = await db.entity.findFirst({
      where: { id: entityId, caseId },
      include: {
        links: { include: { evidence: { select: { id: true, originalName: true, sha256: true } } } },
      },
    })
    if (!entity) {
      return NextResponse.json({ error: 'entity not found' }, { status: 404 })
    }

    // Fetch relationships (as src and dst)
    const [srcRels, dstRels] = await Promise.all([
      db.relationship.findMany({
        where: { srcId: entityId },
        include: { dst: { select: { id: true, type: true, value: true, label: true } } },
      }),
      db.relationship.findMany({
        where: { dstId: entityId },
        include: { src: { select: { id: true, type: true, value: true, label: true } } },
      }),
    ])

    // Build neighbor list
    const neighbors = [
      ...srcRels.map((r) => ({
        id: r.dst.id,
        type: r.dst.type,
        value: r.dst.value,
        label: r.dst.label,
        relType: r.type,
        weight: r.weight,
        direction: 'outgoing' as const,
      })),
      ...dstRels.map((r) => ({
        id: r.src.id,
        type: r.src.type,
        value: r.src.value,
        label: r.src.label,
        relType: r.type,
        weight: r.weight,
        direction: 'incoming' as const,
      })),
    ]

    // Fetch transactions involving this entity (by account value matching sender/receiver)
    const transactions = await db.transaction.findMany({
      where: {
        caseId,
        OR: [
          { senderAccount: entity.value },
          { receiverAccount: entity.value },
          { accountNo: entity.value },
          { upi: entity.value },
        ],
      },
      take: 20,
      orderBy: { txnDate: 'desc' },
    })

    // Fetch communications involving this entity
    const communications = await db.communication.findMany({
      where: {
        caseId,
        OR: [
          { sender: entity.value },
          { receiver: entity.value },
          { senderHandle: entity.value },
          { receiverHandle: entity.value },
        ],
      },
      take: 20,
      orderBy: { timestamp: 'desc' },
    })

    // Fetch timeline events
    const timeline = await db.timelineEvent.findMany({
      where: { caseId },
      take: 20,
      orderBy: { ts: 'desc' },
    })

    // Fetch findings that reference this entity
    const allFindings = await db.finding.findMany({
      where: { caseId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    })
    const findings = allFindings.filter((f) => {
      const ids = parseJsonArray<string>(f.entitiesJson)
      return ids.includes(entityId)
    })

    // Fetch actor risk
    const actorRisk = await db.actorRisk.findUnique({
      where: { caseId_entityId: { caseId, entityId } },
    })

    // Fetch community membership
    const communityMembers = await db.communityMember.findMany({
      where: { entityId },
      include: { community: { select: { id: true, label: true, size: true } } },
    })

    // Compute graph metrics for role inference
    const [allEntities, allRels] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
    ])
    const g = toGraphInput(allEntities, allRels)
    const metrics = computeAll(g)

    const degree = (metrics.degree[entityId] ?? 0) * (allEntities.length - 1)
    const betweenness = metrics.betweenness[entityId] ?? 0
    const closeness = metrics.closeness[entityId] ?? 0
    const pagerank = metrics.pagerank[entityId] ?? 0

    // Count cross-community edges
    const entityCommunities = new Set(communityMembers.map((cm) => cm.communityId))
    let crossCommunityEdges = 0
    for (const r of [...srcRels, ...dstRels]) {
      const otherId = r.srcId === entityId ? r.dstId : r.srcId
      const otherCm = await db.communityMember.findMany({ where: { entityId: otherId } })
      const otherCommunities = new Set(otherCm.map((cm) => cm.communityId))
      const hasOverlap = [...entityCommunities].some((c) => otherCommunities.has(c))
      if (!hasOverlap) crossCommunityEdges++
    }

    const roleMetrics: RoleMetrics = {
      degree: Math.round(degree),
      betweenness,
      closeness,
      pagerank,
      crossCommunityEdges,
      shortestPathParticipation: betweenness, // proxy
      inDegree: dstRels.length,
      outDegree: srcRels.length,
    }

    const roleHypotheses = inferRoles(roleMetrics)

    // Evidence provenance
    const evidence = entity.links.map((l) => ({
      id: l.evidence.id,
      originalName: l.evidence.originalName,
      sha256: l.evidence.sha256,
    }))

    // Provenance-preserving observations (individual source occurrences).
    const observations = await db.entityObservation.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, rawType: true, rawValue: true, norm: true, evidenceId: true,
        evidenceName: true, locator: true, extractionMethod: true,
        mergedFromId: true, createdAt: true,
      },
    })

    return NextResponse.json({
      entity: {
        id: entity.id,
        type: entity.type,
        value: entity.value,
        norm: entity.norm,
        label: entity.label,
        confidence: entity.confidence,
        metadataJson: entity.metadataJson,
        createdAt: entity.createdAt,
      },
      neighbors,
      transactions,
      communications,
      timeline,
      findings,
      actorRisk,
      communities: communityMembers.map((cm) => ({
        id: cm.community.id,
        label: cm.community.label,
        size: cm.community.size,
      })),
      roleHypotheses,
      evidence,
      observations: observations.map((o) => ({
        ...o,
        createdAt: o.createdAt.toISOString(),
      })),
      metrics: roleMetrics,
    })
  } catch (err) {
    console.error('[api/cases/[id]/entities/[entityId]/detail GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'detail failed' },
      { status: 500 },
    )
  }
}
