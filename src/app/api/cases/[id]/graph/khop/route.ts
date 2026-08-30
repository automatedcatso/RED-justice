/**
 * POST /api/cases/[id]/graph/khop
 * Body: { entityId, k }
 * Returns: { nodeIds: string[], subgraph: { nodes, edges } }
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  toGraphInput,
} from '@/lib/api/helpers'
import { kHopNeighbors, extractSubgraph } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const body = await req.json().catch(() => ({}))
    const { entityId, k } = body as { entityId?: string; k?: number }
    if (!entityId) {
      return NextResponse.json(
        { error: 'entityId is required' },
        { status: 400 },
      )
    }
    const hops = typeof k === 'number' && k > 0 ? Math.min(k, 5) : 1

    const [entities, relationships] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
    ])
    const g = toGraphInput(entities, relationships)

    const neighborSet = kHopNeighbors(g, entityId, hops)
    const nodeIds = Array.from(neighborSet)
    const subgraph = extractSubgraph(g, [entityId, ...nodeIds])

    return NextResponse.json({
      entityId,
      k: hops,
      nodeIds,
      subgraph,
    })
  } catch (err) {
    console.error('[api/cases/[id]/graph/khop POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'khop failed' },
      { status: 500 },
    )
  }
}
