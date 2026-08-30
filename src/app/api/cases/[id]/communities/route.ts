/**
 * GET /api/cases/[id]/communities — list communities with members,
 * type breakdown, central/bridge actors, transaction volume, suspicious count.
 *
 * If the Community table is empty (no persisted communities), this endpoint
 * computes communities on-the-fly using the Label Propagation Algorithm (LPA)
 * from the analytics engine. This ensures the Communities view is always
 * populated even if the user hasn't run the "Recompute analytics" action.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, toGraphInput } from '@/lib/api/helpers'
import { detectCommunities, type GraphInput } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// Contextual entity types to exclude from community detection.
const CONTEXTUAL_TYPES = new Set(['date', 'amount'])

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

    // Try to load persisted communities first.
    const persisted = await db.community.findMany({
      where: { caseId },
      orderBy: { size: 'desc' },
      include: {
        members: {
          include: {
            entity: {
              select: { id: true, type: true, value: true, label: true, norm: true },
            },
          },
        },
      },
    })

    if (persisted.length > 0) {
      const result = persisted
        .filter((c) => c.size >= 2) // legacy singletons are noise — hide them
        .map((c) => {
        const typeBreakdown: Record<string, number> = {}
        for (const m of c.members) {
          if (m.entity) {
            typeBreakdown[m.entity.type] = (typeBreakdown[m.entity.type] ?? 0) + 1
          }
        }
        let centralActors: string[] = []
        let bridgeActors: string[] = []
        try { centralActors = JSON.parse(c.centralActorsJson ?? '[]') } catch { /* ignore */ }
        try { bridgeActors = JSON.parse(c.bridgeActorsJson ?? '[]') } catch { /* ignore */ }
        return {
          id: c.id,
          label: c.label,
          size: c.size,
          dominantTypes: c.dominantTypes,
          transactionVolume: c.transactionVolume,
          internalRels: c.internalRels,
          externalRels: c.externalRels,
          suspiciousPatterns: c.suspiciousPatterns,
          centralActors,
          bridgeActors,
          typeBreakdown,
          members: c.members.map((m) => m.entity).filter(Boolean),
        }
      })
      return NextResponse.json({ communities: result, total: result.length })
    }

    // No persisted communities — compute on-the-fly using LPA.
    const [entities, relationships] = await Promise.all([
      db.entity.findMany({
        where: {
          caseId,
          type: { notIn: Array.from(CONTEXTUAL_TYPES) },
        },
      }),
      db.relationship.findMany({ where: { caseId } }),
    ])

    // Build graph input.
    const entityIds = new Set(entities.map((e) => e.id))
    const validRels = relationships.filter(
      (r) => entityIds.has(r.srcId) && entityIds.has(r.dstId) && r.srcId !== r.dstId,
    )
    const g: GraphInput = {
      nodes: entities.map((e) => ({ id: e.id, type: e.type, label: e.label ?? e.value, value: e.value })),
      edges: validRels.map((r) => ({
        id: r.id,
        source: r.srcId,
        target: r.dstId,
        type: r.type,
        weight: r.weight,
        amount: r.amount ?? undefined,
        timestamp: r.timestamp ?? undefined,
      })),
    }

    // Run community detection.
    const communities = detectCommunities(g)

    // Enrich with member entities and type breakdowns.
    const entityById = new Map(entities.map((e) => [e.id, e]))
    const result = communities
      .filter((c) => c.members.length >= 2) // Only show communities with 2+ members.
      .map((c, i) => {
        const members = c.members
          .map((id) => entityById.get(id))
          .filter((e): e is NonNullable<typeof e> => e !== undefined)
        const typeBreakdown: Record<string, number> = {}
        for (const m of members) {
          typeBreakdown[m.type] = (typeBreakdown[m.type] ?? 0) + 1
        }
        const dominantTypes = Object.entries(typeBreakdown)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([t]) => t)
        return {
          id: `computed-${i + 1}`,
          label: `Community ${i + 1}`,
          size: members.length,
          dominantTypes: JSON.stringify(dominantTypes),
          transactionVolume: null as number | null,
          internalRels: validRels.filter((r) =>
            c.members.includes(r.srcId) && c.members.includes(r.dstId)
          ).length,
          externalRels: validRels.filter((r) =>
            (c.members.includes(r.srcId) && !c.members.includes(r.dstId)) ||
            (!c.members.includes(r.srcId) && c.members.includes(r.dstId))
          ).length,
          suspiciousPatterns: 0,
          centralActors: [] as string[],
          bridgeActors: [] as string[],
          typeBreakdown,
          members: members.map((m) => ({
            id: m.id,
            type: m.type,
            value: m.value,
            label: m.label,
            norm: m.norm,
          })),
        }
      })
      .sort((a, b) => b.size - a.size)

    return NextResponse.json({ communities: result, total: result.length })
  } catch (err) {
    console.error('[api/cases/[id]/communities GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'communities failed' },
      { status: 500 },
    )
  }
}
