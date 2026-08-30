/**
 * GET    /api/cases/[id]  — fetch a single case.
 * PATCH  /api/cases/[id]  — update partial fields on a case.
 * DELETE /api/cases/[id]  — soft-close (set status="archived").
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'

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
    const caseRow = await db.case.findUnique({
      where: { id: caseId },
      include: {
        _count: {
          select: {
            evidence: true,
            entities: true,
            relationships: true,
            transactions: true,
            communications: true,
            findings: true,
            actorRisks: true,
            communities: true,
            timeline: true,
          },
        },
      },
    })
    if (!caseRow) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    return NextResponse.json({ case: caseRow })
  } catch (err) {
    console.error('[api/cases/[id] GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'fetch failed' },
      { status: 500 },
    )
  }
}

export async function PATCH(
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
    const allowed = [
      'title',
      'description',
      'status',
      'classification',
      'aiMode',
      'investigators',
      'tags',
      'notes',
      'sourceMetadata',
      'metadataJson',
    ] as const
    const data: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body && body[key] !== undefined) {
        if (key === 'investigators' || key === 'tags') {
          const v = body[key]
          if (Array.isArray(v)) {
            data[key] = JSON.stringify(v)
          } else if (typeof v === 'string') {
            data[key] = v
          }
        } else {
          data[key] = body[key]
        }
      }
    }
    const updated = await db.case.update({
      where: { id: caseId },
      data,
    })
    await logActivity(db, caseId, `Case updated: ${Object.keys(data).join(', ')}`)
    return NextResponse.json({ case: updated })
  } catch (err) {
    console.error('[api/cases/[id] PATCH] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'update failed' },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    const updated = await db.case.update({
      where: { id: caseId },
      data: { status: 'archived' },
    })
    await logActivity(db, caseId, `Case archived (soft-close)`)
    return NextResponse.json({ case: updated })
  } catch (err) {
    console.error('[api/cases/[id] DELETE] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'delete failed' },
      { status: 500 },
    )
  }
}
