/**
 * POST /api/cases/[id]/patterns/run — re-run pattern detection on the case.
 *
 * Persists new Findings (dedup by type+trigger+entitiesJson hash).
 * Returns `{ created, skipped, total }`.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  buildPatternContext,
  persistFindings,
  logActivity,
} from '@/lib/api/helpers'
import { detectPatterns } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const ctx = await buildPatternContext(db, caseId)
    if (!ctx) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const findings = detectPatterns(ctx)
    const result = await persistFindings(db, caseId, findings)

    await logActivity(
      db,
      caseId,
      `Pattern detection re-run: ${result.created} created, ${result.skipped} skipped`,
    )

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/cases/[id]/patterns/run POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'pattern run failed' },
      { status: 500 },
    )
  }
}
