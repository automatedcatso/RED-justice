/**
 * GET /api/cases/[id]/gaps — Investigation Gap Engine.
 * Reports missing evidence, unlinked entities, thin evidence, unresolved
 * conflicts, unverified hypotheses and record-quality issues.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { computeGaps } from '@/lib/investigation/gapEngine'

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

    const report = await computeGaps(db, caseId)
    return NextResponse.json(report)
  } catch (err) {
    console.error('[gaps GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
