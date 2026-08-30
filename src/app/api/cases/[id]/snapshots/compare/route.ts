/**
 * GET /api/cases/[id]/snapshots/compare?a=<id>&b=<id>
 * Compare two graph snapshots: T1 = a (older), T2 = b (newer).
 * Returns added/removed edges & nodes, emerging/dissolved communities and
 * central-actor movement.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { compareSnapshots, type SnapshotData } from '@/lib/investigation/snapshots'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const aId = req.nextUrl.searchParams.get('a')
    const bId = req.nextUrl.searchParams.get('b')
    if (!aId || !bId) {
      return NextResponse.json({ error: 'query params a and b (snapshot ids) are required' }, { status: 400 })
    }

    const [a, b] = await Promise.all([
      db.graphSnapshot.findFirst({ where: { id: aId, caseId } }),
      db.graphSnapshot.findFirst({ where: { id: bId, caseId } }),
    ])
    if (!a || !b) return NextResponse.json({ error: 'snapshot(s) not found' }, { status: 404 })

    const parse = (json: string): SnapshotData => {
      try {
        return JSON.parse(json) as SnapshotData
      } catch {
        return { nodes: [], edges: [], communities: [], central: [] }
      }
    }

    const diff = compareSnapshots(parse(a.dataJson), parse(b.dataJson))

    return NextResponse.json({
      a: { id: a.id, label: a.label, nodesCount: a.nodesCount, edgesCount: a.edgesCount, createdAt: a.createdAt.toISOString() },
      b: { id: b.id, label: b.label, nodesCount: b.nodesCount, edgesCount: b.edgesCount, createdAt: b.createdAt.toISOString() },
      diff,
    })
  } catch (err) {
    console.error('[snapshots/compare GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
