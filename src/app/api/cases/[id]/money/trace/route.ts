/**
 * POST /api/cases/[id]/money/trace — money-flow trace.
 * Body: { account, direction: 'forward'|'backward', maxHops }
 * Returns: { paths: string[][] }  (paths of account hops)
 *
 * Note: each path returned is a list of ACCOUNT strings (sender → receiver → ...).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { traceForward, traceBackward } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
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
    const { account, direction, maxHops } = body as {
      account?: string
      direction?: 'forward' | 'backward'
      maxHops?: number
    }

    if (!account) {
      return NextResponse.json(
        { error: 'account is required' },
        { status: 400 },
      )
    }
    const dir = direction === 'backward' ? 'backward' : 'forward'
    const hops = typeof maxHops === 'number' && maxHops > 0 ? Math.min(maxHops, 8) : 4

    const transactions = await db.transaction.findMany({ where: { caseId } })

    // Get raw txn-id paths.
    const txnPaths =
      dir === 'forward'
        ? traceForward(transactions, account, hops)
        : traceBackward(transactions, account, hops)

    // Convert txn-id paths into account-id paths.
    const txnById = new Map(transactions.map((t) => [t.id, t]))
    const accountPaths: string[][] = []
    for (const tp of txnPaths) {
      const accs: string[] = []
      let lastReceiver: string | null = null
      for (const txnId of tp) {
        const t = txnById.get(txnId)
        if (!t) continue
        // For forward traces, the path grows sender → receiver → receiver → ...
        // For backward traces (txnIds ordered oldest→newest), same logic but
        // we want to prepend sender → ... → receiver.
        if (accs.length === 0) {
          if (t.senderAccount) accs.push(t.senderAccount)
          if (t.receiverAccount) accs.push(t.receiverAccount)
        } else {
          // Find the link: accs[last] should equal t.senderAccount (forward)
          // or t.receiverAccount (backward).
          if (dir === 'forward' && t.receiverAccount) {
            accs.push(t.receiverAccount)
          } else if (dir === 'backward' && t.senderAccount) {
            accs.unshift(t.senderAccount)
          }
        }
        lastReceiver = t.receiverAccount ?? null
      }
      if (accs.length > 0) accountPaths.push(accs)
      void lastReceiver
    }

    // Deduplicate identical account paths.
    const seen = new Set<string>()
    const deduped: string[][] = []
    for (const p of accountPaths) {
      const k = p.join('|')
      if (seen.has(k)) continue
      seen.add(k)
      deduped.push(p)
    }

    return NextResponse.json({
      account,
      direction: dir,
      maxHops: hops,
      paths: deduped,
      txnPaths,
      total: deduped.length,
    })
  } catch (err) {
    console.error('[api/cases/[id]/money/trace POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'trace failed' },
      { status: 500 },
    )
  }
}
