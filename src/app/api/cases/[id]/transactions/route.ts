/**
 * GET /api/cases/[id]/transactions — list transactions.
 *
 * Supports ?account=&minAmount=&maxAmount=&from=&to=&q= filters.
 * Includes computed `flowDirection` per txn when ?account= is provided.
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
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const sp = req.nextUrl.searchParams
    const account = sp.get('account') ?? undefined
    const minAmount = sp.get('minAmount')
    const maxAmount = sp.get('maxAmount')
    const from = sp.get('from') ?? undefined
    const to = sp.get('to') ?? undefined
    const q = sp.get('q') ?? undefined
    const limit = Math.min(
      5000,
      Math.max(1, parseInt(sp.get('limit') ?? '1000', 10)),
    )

    const where: {
      caseId: string
      OR?: Array<Record<string, unknown>>
      amount?: { gte?: number; lte?: number }
      txnDate?: { gte?: string; lte?: string }
    } = { caseId }

    if (account) {
      where.OR = [
        { senderAccount: account },
        { receiverAccount: account },
      ]
    }
    if (minAmount || maxAmount) {
      where.amount = {}
      if (minAmount) where.amount.gte = parseFloat(minAmount)
      if (maxAmount) where.amount.lte = parseFloat(maxAmount)
    }
    if (from || to) {
      where.txnDate = {}
      if (from) where.txnDate.gte = from
      if (to) where.txnDate.lte = to
    }
    if (q) {
      where.OR = [
        { remarks: { contains: q } },
        { utr: { contains: q } },
        { senderAccount: { contains: q } },
        { receiverAccount: { contains: q } },
        { upi: { contains: q } },
        { wallet: { contains: q } },
      ]
    }

    const transactions = await db.transaction.findMany({
      where,
      take: limit,
      orderBy: { txnDate: 'desc' },
      include: {
        evidence: {
          select: { id: true, originalName: true },
        },
      },
    })

    // Compute flowDirection relative to the queried account.
    const result = account
      ? transactions.map((t) => ({
          ...t,
          flowDirection:
            t.senderAccount === account
              ? 'out'
              : t.receiverAccount === account
                ? 'in'
                : 'unknown',
        }))
      : transactions

    return NextResponse.json({
      transactions: result,
      total: result.length,
      account,
    })
  } catch (err) {
    console.error('[api/cases/[id]/transactions GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'list failed' },
      { status: 500 },
    )
  }
}
