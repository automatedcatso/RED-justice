/**
 * GET /api/cases/[id]/decisions — Investigator Decision Record ledger.
 *
 * Every human decision is structured intelligence (architecture §18):
 * WHO · WHAT · WHEN · OBJECT · BEFORE → AFTER · REASON · evidence relied on.
 * Optional filters: ?action=reject_finding&objectType=hypothesis&limit=200
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

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

    const url = new URL(req.url)
    const action = url.searchParams.get('action')
    const objectType = url.searchParams.get('objectType')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500)

    const [decisions, total] = await Promise.all([
      db.decisionRecord.findMany({
        where: {
          caseId,
          ...(action ? { action } : {}),
          ...(objectType ? { objectType } : {}),
        },
        orderBy: { at: 'desc' },
        take: limit,
      }),
      db.decisionRecord.count({ where: { caseId } }),
    ])

    return NextResponse.json({
      decisions,
      total,
      pendingDecisions:
        // decisions still awaiting a human: open findings + unresolved hypotheses
        // are derived by the client from other endpoints; this count tracks the
        // ledger size so UI can show "N decisions recorded".
        total,
    })
  } catch (err) {
    console.error('[decisions GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'decisions failed' },
      { status: 500 },
    )
  }
}
