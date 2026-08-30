/**
 * POST /api/cases/[id]/graph/ego
 * Body: { entityId, radius }
 * Returns: ego network subgraph { nodes, edges }.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  toGraphInput,
} from '@/lib/api/helpers'
import { egoNetwork } from '@/lib/analytics'

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
    const { entityId, radius } = body as { entityId?: string; radius?: number }
    if (!entityId) {
      return NextResponse.json(
        { error: 'entityId is required' },
        { status: 400 },
      )
    }
    const r = typeof radius === 'number' && radius > 0 ? Math.min(radius, 5) : 1

    const [entities, relationships] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
    ])
    const g = toGraphInput(entities, relationships)

    const subgraph = egoNetwork(g, entityId, r)

    return NextResponse.json({
      entityId,
      radius: r,
      subgraph,
    })
  } catch (err) {
    console.error('[api/cases/[id]/graph/ego POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ego failed' },
      { status: 500 },
    )
  }
}
