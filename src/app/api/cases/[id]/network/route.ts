/**
 * GET /api/cases/[id]/network — compute & return full analytics snapshot.
 *
 * Returns:
 *   {
 *     centrality: { degree, betweenness, closeness, pagerank } (top 20 each),
 *     components: string[][],
 *     communities: { label, members }[],
 *     bridges: string[],     // bridge node ids
 *     centralActors: { entityId, score }[]
 *   }
 *
 * Results are cached in-memory keyed by caseId + content hash.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  getOrComputeNetwork,
  topNFromRecord,
} from '@/lib/api/helpers'

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

    const { metrics, bridges, centralActorsList } = await getOrComputeNetwork(db, caseId)

    const N = 20
    const result = {
      centrality: {
        degree: topNFromRecord(metrics.degree, N),
        betweenness: topNFromRecord(metrics.betweenness, N),
        closeness: topNFromRecord(metrics.closeness, N),
        pagerank: topNFromRecord(metrics.pagerank, N),
      },
      components: metrics.components,
      // Singleton "communities" (isolated nodes) are noise for the analyst —
      // only real 2+ member groups are reported.
      communities: metrics.communities.filter((c) => c.members.length >= 2),
      bridges,
      centralActors: centralActorsList,
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/cases/[id]/network GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'network failed' },
      { status: 500 },
    )
  }
}
