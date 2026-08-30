/**
 * POST /api/cases/[id]/graph/shortest-path
 * Body: { srcId, dstId }
 * Returns: { path: string[] | null, edges: GraphEdge[] }
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  toGraphInput,
} from '@/lib/api/helpers'
import { shortestPath, extractSubgraph } from '@/lib/analytics'

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
    const { srcId, dstId } = body as { srcId?: string; dstId?: string }
    if (!srcId || !dstId) {
      return NextResponse.json(
        { error: 'srcId and dstId are required' },
        { status: 400 },
      )
    }

    const [entities, relationships] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
    ])
    const g = toGraphInput(entities, relationships)

    const path = shortestPath(g, srcId, dstId)
    const subgraph =
      path && path.length > 0 ? extractSubgraph(g, path) : { nodes: [], edges: [] }

    return NextResponse.json({
      path,
      edges: subgraph.edges,
      nodes: subgraph.nodes,
    })
  } catch (err) {
    console.error('[api/cases/[id]/graph/shortest-path POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'shortest-path failed' },
      { status: 500 },
    )
  }
}
