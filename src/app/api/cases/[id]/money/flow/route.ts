/**
 * GET /api/cases/[id]/money/flow — aggregate money-flow stats.
 *
 * Returns txn graph, fan-in/out per account, top flows, circular flows,
 * velocity, recurring.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import {
  aggregateStats,
  buildTxnGraph,
  circularFlows,
  fanIn,
  fanOut,
  recurringTransfers,
  unusualSequences,
  velocityAnalysis,
} from '@/lib/analytics'

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

    const transactions = await db.transaction.findMany({ where: { caseId } })
    const graph = buildTxnGraph(transactions)
    const stats = aggregateStats(transactions)
    const circular = circularFlows(transactions, 5)
    const unusual = unusualSequences(transactions)

    // Per-account fan-in/out, top 20 each by volume.
    const accountSet = new Set<string>()
    for (const n of graph.nodes) {
      accountSet.add(n.account)
    }
    const fanInStats = Array.from(accountSet)
      .map((a) => fanIn(transactions, a))
      .sort((a, b) => b.totalIn - a.totalIn)
      .slice(0, 20)
    const fanOutStats = Array.from(accountSet)
      .map((a) => fanOut(transactions, a))
      .sort((a, b) => b.totalOut - a.totalOut)
      .slice(0, 20)

    // Per-account recurring transfers; merge across accounts.
    const recurring = Array.from(accountSet).flatMap((a) =>
      recurringTransfers(transactions, a),
    )

    // Velocity (max 7-day window per account).
    const velocityByAccount = Array.from(accountSet)
      .map((a) => {
        const windows = velocityAnalysis(transactions, a, 7)
        const max = windows.reduce(
          (acc, w) => (w.count > acc.count ? w : acc),
          { count: 0, start: '', end: '', volume: 0 } as {
            count: number
            start: string
            end: string
            volume: number
          },
        )
        return { account: a, maxWindow: max, allWindows: windows }
      })
      .sort((a, b) => b.maxWindow.count - a.maxWindow.count)
      .slice(0, 20)

    // Top flows (edges sorted by totalAmount desc).
    const topFlows = [...graph.edges]
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 20)

    return NextResponse.json({
      stats,
      txnGraph: graph,
      topFlows,
      fanIn: fanInStats,
      fanOut: fanOutStats,
      circularFlows: circular,
      recurringTransfers: recurring,
      unusualSequences: unusual,
      velocityByAccount,
    })
  } catch (err) {
    console.error('[api/cases/[id]/money/flow GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'flow failed' },
      { status: 500 },
    )
  }
}
