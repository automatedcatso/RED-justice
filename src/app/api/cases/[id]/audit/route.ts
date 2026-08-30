/**
 * GET /api/cases/[id]/audit — unified tamper-evident audit feed.
 *
 * Merges four ledgers into one chronological stream (newest first):
 *   decision   — investigator Decision Records (WHO/WHAT/BEFORE/AFTER/REASON)
 *   custody    — evidence chain-of-custody events (sha256-tracked)
 *   activity   — system activity log
 *
 * Filters: ?kind=decision|custody|activity|all  ·  ?limit=300
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { buildAuditFeed } from '@/lib/investigation/decisions'

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
    const kind = url.searchParams.get('kind') ?? 'all'
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 1000)

    const events = await buildAuditFeed(db, caseId, { kind, limit })
    const counts = {
      decision: events.filter((e) => e.kind === 'decision').length,
      custody: events.filter((e) => e.kind === 'custody').length,
      activity: events.filter((e) => e.kind === 'activity').length,
    }

    return NextResponse.json({ events, counts, total: events.length })
  } catch (err) {
    console.error('[audit GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'audit failed' },
      { status: 500 },
    )
  }
}
