/**
 * GET /api/cases/[id]/search?q=&type= — full-text-ish search across
 * evidence content, entity values, transaction remarks, communications text,
 * findings descriptions. Uses Prisma `contains` (case-insensitive).
 *
 * Returns grouped results: `{ evidence, entities, transactions, communications, findings }`.
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
    const q = sp.get('q') ?? ''
    const typeFilter = sp.get('type') ?? undefined
    if (!q) {
      return NextResponse.json(
        { error: 'q is required' },
        { status: 400 },
      )
    }

    const limit = 50

    const tasks: Array<Promise<unknown>> = []
    const keys: Array<'evidence' | 'entities' | 'transactions' | 'communications' | 'findings'> = []

    if (!typeFilter || typeFilter === 'evidence') {
      tasks.push(
        db.evidence.findMany({
          where: {
            caseId,
            OR: [
              { originalName: { contains: q } },
              { description: { contains: q } },
              { content: { contains: q } },
            ],
          },
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
      )
      keys.push('evidence')
    }

    if (!typeFilter || typeFilter === 'entities') {
      tasks.push(
        db.entity.findMany({
          where: {
            caseId,
            OR: [
              { value: { contains: q } },
              { label: { contains: q } },
              { norm: { contains: q } },
            ],
          },
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
      )
      keys.push('entities')
    }

    if (!typeFilter || typeFilter === 'transactions') {
      tasks.push(
        db.transaction.findMany({
          where: {
            caseId,
            OR: [
              { remarks: { contains: q } },
              { utr: { contains: q } },
              { senderAccount: { contains: q } },
              { receiverAccount: { contains: q } },
              { upi: { contains: q } },
              { wallet: { contains: q } },
            ],
          },
          take: limit,
          orderBy: { txnDate: 'desc' },
        }),
      )
      keys.push('transactions')
    }

    if (!typeFilter || typeFilter === 'communications') {
      tasks.push(
        db.communication.findMany({
          where: {
            caseId,
            OR: [
              { messageText: { contains: q } },
              { sender: { contains: q } },
              { receiver: { contains: q } },
            ],
          },
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
      )
      keys.push('communications')
    }

    if (!typeFilter || typeFilter === 'findings') {
      tasks.push(
        db.finding.findMany({
          where: {
            caseId,
            OR: [
              { description: { contains: q } },
              { trigger: { contains: q } },
            ],
          },
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
      )
      keys.push('findings')
    }

    const results = await Promise.all(tasks)
    const grouped: Record<string, unknown> = {}
    for (let i = 0; i < keys.length; i++) {
      grouped[keys[i]] = results[i]
    }

    return NextResponse.json({
      q,
      ...grouped,
    })
  } catch (err) {
    console.error('[api/cases/[id]/search GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'search failed' },
      { status: 500 },
    )
  }
}
