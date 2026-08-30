/**
 * GET /api/cases/[id]/patterns — list findings.
 * Supports ?severity=&type=&status= filters.
 * Includes resolved entities/transactions references.
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
    const severity = sp.get('severity') ?? undefined
    const type = sp.get('type') ?? undefined
    const status = sp.get('status') ?? undefined
    const limit = Math.min(
      2000,
      Math.max(1, parseInt(sp.get('limit') ?? '500', 10)),
    )

    const where: {
      caseId: string
      severity?: string
      type?: string
      reviewStatus?: string
    } = { caseId }
    if (severity) where.severity = severity
    if (type) where.type = type
    if (status) where.reviewStatus = status

    const findings = await db.finding.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    // Resolve entity / transaction references in bulk.
    const entityIds = new Set<string>()
    const txnIds = new Set<string>()
    for (const f of findings) {
      try {
        const eIds = JSON.parse(f.entitiesJson ?? '[]')
        if (Array.isArray(eIds)) {
          for (const id of eIds) {
            if (typeof id === 'string') entityIds.add(id)
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const tIds = JSON.parse(f.transactionsJson ?? '[]')
        if (Array.isArray(tIds)) {
          for (const id of tIds) {
            if (typeof id === 'string') txnIds.add(id)
          }
        }
      } catch {
        /* ignore */
      }
    }

    const [entities, transactions] = await Promise.all([
      db.entity.findMany({
        where: { id: { in: Array.from(entityIds) } },
        select: {
          id: true,
          type: true,
          value: true,
          label: true,
          norm: true,
        },
      }),
      db.transaction.findMany({
        where: { id: { in: Array.from(txnIds) } },
        select: {
          id: true,
          amount: true,
          senderAccount: true,
          receiverAccount: true,
          txnDate: true,
          utr: true,
        },
      }),
    ])

    const entityById = new Map(entities.map((e) => [e.id, e]))
    const txnById = new Map(transactions.map((t) => [t.id, t]))

    // Evidence Sufficiency Scoring — every finding gets a 0-100 score built
    // from independent sources, source quality, corroboration, contradiction
    // and provenance (NOT an AI confidence score).
    const { scoreFinding } = await import('@/lib/investigation/sufficiency')
    const resolved = await Promise.all(
      findings.map(async (f) => {
        let entIds: string[] = []
        let txIds: string[] = []
        try {
          const parsed = JSON.parse(f.entitiesJson ?? '[]')
          if (Array.isArray(parsed)) entIds = parsed.filter((x) => typeof x === 'string')
        } catch {
          /* ignore */
        }
        try {
          const parsed = JSON.parse(f.transactionsJson ?? '[]')
          if (Array.isArray(parsed)) txIds = parsed.filter((x) => typeof x === 'string')
        } catch {
          /* ignore */
        }
        let sufficiency: Awaited<ReturnType<typeof scoreFinding>> | null = null
        try {
          sufficiency = await scoreFinding(db, caseId, f)
        } catch {
          sufficiency = null
        }
        return {
          ...f,
          decision: f.decision,
          decidedAt: f.decidedAt?.toISOString() ?? null,
          decidedBy: f.decidedBy,
          decisionNote: f.decisionNote,
          entities: entIds.map((id) => entityById.get(id)).filter(Boolean),
          transactions: txIds.map((id) => txnById.get(id)).filter(Boolean),
          sufficiency,
        }
      }),
    )

    return NextResponse.json({
      findings: resolved,
      total: resolved.length,
    })
  } catch (err) {
    console.error('[api/cases/[id]/patterns GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'patterns failed' },
      { status: 500 },
    )
  }
}
