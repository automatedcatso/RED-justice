/**
 * GET /api/cases/[id]/replay?findingId=<id> — Investigation Replay.
 * Reconstructs the full production pipeline of a finding:
 * evidence → extraction → resolution → graph → analytics → AI → decision → report.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { buildFindingReplay } from '@/lib/investigation/replay'

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

    const findingId = req.nextUrl.searchParams.get('findingId')
    if (!findingId) {
      return NextResponse.json({ error: 'findingId query param required' }, { status: 400 })
    }

    const trace = await buildFindingReplay(db, caseId, findingId)
    if (!trace) return NextResponse.json({ error: 'finding not found' }, { status: 404 })
    return NextResponse.json(trace)
  } catch (err) {
    console.error('[replay GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
