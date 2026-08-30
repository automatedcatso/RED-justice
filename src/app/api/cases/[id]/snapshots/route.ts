/**
 * GET    /api/cases/[id]/snapshots — list graph snapshots.
 * POST   /api/cases/[id]/snapshots — capture a new snapshot. Body: { label? }
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { captureSnapshot } from '@/lib/investigation/snapshots'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const snaps = await db.graphSnapshot.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, nodesCount: true, edgesCount: true, createdAt: true },
    })
    return NextResponse.json({ snapshots: snaps, total: snaps.length })
  } catch (err) {
    console.error('[snapshots GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as { label?: string }
    const { data, nodesCount, edgesCount } = await captureSnapshot(db, caseId)
    const label = body.label?.trim() || `Snapshot ${new Date().toLocaleString('en-IN')}`

    const snap = await db.graphSnapshot.create({
      data: {
        caseId,
        label,
        nodesCount,
        edgesCount,
        dataJson: JSON.stringify(data),
      },
    })

    await logActivity(db, caseId, `Graph snapshot "${label}" captured — ${nodesCount} nodes, ${edgesCount} edges`)
    return NextResponse.json(
      {
        snapshot: {
          id: snap.id,
          label: snap.label,
          nodesCount: snap.nodesCount,
          edgesCount: snap.edgesCount,
          createdAt: snap.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[snapshots POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
