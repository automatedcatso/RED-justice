/**
 * POST /api/cases/[id]/graph/purge-mechanical — legacy graph hygiene.
 *
 * Pre-v3 cases may still carry MECHANICAL graph content created by the old
 * deterministic pipeline:
 *   - CO_OCCURRED edges with provenance 'level0-co-occurrence' /
 *     'ai-scan-cooccurrence' (the row-wise proximity mesh — the cause of
 *     "29 neighbors" hairballs), and
 *   - orphan entities that have NO evidence links and NO relationships
 *     (regex leftovers such as standalone dates/phones that never earned
 *     their place in the graph).
 *
 * v3 never CREATES these anymore; this endpoint cleans up history. Safe to
 * call repeatedly (idempotent). Never touches AI-authored edges
 * (provenance ai-story / ai-crosslink / record-txn) or their endpoints.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { MECHANICAL_PROVENANCES } from '@/lib/investigation/aiScan'

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

    const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean }
    const dryRun = body.dryRun === true

    // 1. Mechanical proximity edges.
    const mechEdges = await db.relationship.findMany({
      where: {
        caseId,
        type: 'CO_OCCURRED',
        provenance: { in: [...MECHANICAL_PROVENANCES] },
      },
      select: { id: true },
    })

    // 2. Orphan entities: zero evidence links AND zero relationships.
    const entities = await db.entity.findMany({
      where: { caseId },
      select: {
        id: true,
        _count: { select: { links: true, srcRels: true, dstRels: true } },
      },
    })
    const orphanIds = entities
      .filter((e) => e._count.links === 0 && e._count.srcRels === 0 && e._count.dstRels === 0)
      .map((e) => e.id)

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        mechanicalEdges: mechEdges.length,
        orphanEntities: orphanIds.length,
      })
    }

    let deletedEdges = 0
    if (mechEdges.length > 0) {
      const res = await db.relationship.deleteMany({
        where: { id: { in: mechEdges.map((e) => e.id) } },
      })
      deletedEdges = res.count
    }

    let deletedOrphans = 0
    for (let i = 0; i < orphanIds.length; i += 100) {
      const res = await db.entity.deleteMany({
        where: { id: { in: orphanIds.slice(i, i + 100) } },
      })
      deletedOrphans += res.count
    }

    await logActivity(
      db,
      caseId,
      `Graph hygiene: purged ${deletedEdges} mechanical CO links and ${deletedOrphans} orphan entities (legacy deterministic content)`,
    )

    return NextResponse.json({
      ok: true,
      deletedEdges,
      deletedOrphans,
    })
  } catch (err) {
    console.error('[api/cases/[id]/graph/purge-mechanical POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'purge failed' },
      { status: 500 },
    )
  }
}
