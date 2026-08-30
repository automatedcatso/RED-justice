/**
 * GET /api/cases/[id]/temporal/playback — Temporal Intelligence playback.
 *
 * ?bins=8      — target number of time frames (3..24)
 * ?overlaps=1  — also compute pairwise co-activity overlaps
 *
 * Returns chronological frames each carrying what is NEW in that window
 * (entities, relationships) plus cumulative counts so the UI can scrub the
 * investigation like a video:
 *
 *   Jul 01: A ─ Phone1            (cum: 2 entities, 1 edge)
 *   Jul 12: B joins               (cum: 5 entities, 4 edges)
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { buildPlayback, computeOverlaps } from '@/lib/investigation/temporal'

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
    const bins = Number(url.searchParams.get('bins') ?? 8) || 8
    const wantOverlaps = url.searchParams.get('overlaps') === '1'

    const playback = await buildPlayback(db, caseId, { bins })
    const overlaps = wantOverlaps
      ? await computeOverlaps(db, caseId, { limitPairs: 3000 })
      : null

    return NextResponse.json({
      ...playback,
      overlaps: overlaps?.overlaps ?? [],
      windowsCompared: overlaps?.windowsCompared ?? 0,
    })
  } catch (err) {
    console.error('[temporal/playback GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'playback failed' },
      { status: 500 },
    )
  }
}
