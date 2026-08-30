/**
 * GET /api/cases/[id]/reports/summary — generate a comprehensive investigation
 * summary as Markdown.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

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

    const [
      caseRow,
      evidence,
      entities,
      topEntities,
      txnStats,
      topFlows,
      communities,
      findings,
      topActors,
      timeline,
    ] = await Promise.all([
      db.case.findUnique({ where: { id: caseId } }),
      db.evidence.findMany({
        where: { caseId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          originalName: true,
          source: true,
          status: true,
          sha256: true,
          size: true,
          createdAt: true,
          _count: {
            select: {
              entityLinks: true,
              transactions: true,
              communications: true,
            },
          },
        },
      }),
      db.entity.findMany({
        where: { caseId },
        include: {
          _count: {
            select: { links: true, srcRels: true, dstRels: true },
          },
        },
      }),
      db.entity.findMany({
        where: { caseId },
        include: {
          _count: {
            select: { links: true, srcRels: true, dstRels: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.transaction.findMany({
        where: { caseId },
        select: { amount: true, senderAccount: true, receiverAccount: true, txnDate: true },
      }),
      db.transaction.findMany({
        where: { caseId },
        orderBy: { amount: 'desc' },
        take: 10,
        select: {
          id: true,
          amount: true,
          senderAccount: true,
          receiverAccount: true,
          txnDate: true,
          utr: true,
        },
      }),
      db.community.findMany({
        where: { caseId },
        orderBy: { size: 'desc' },
        include: {
          members: {
            include: {
              entity: { select: { id: true, type: true, value: true, label: true } },
            },
          },
        },
      }),
      db.finding.findMany({
        where: { caseId },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      }),
      db.actorRisk.findMany({
        where: { caseId },
        orderBy: { score: 'desc' },
        take: 15,
        include: {
          entity: { select: { id: true, type: true, value: true, label: true } },
        },
      }),
      db.timelineEvent.findMany({
        where: { caseId },
        orderBy: { ts: 'asc' },
        take: 30,
      }),
    ])

    if (!caseRow) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    // Evidence by type (using mime / source for grouping).
    const evidenceBySource: Record<string, number> = {}
    for (const e of evidence) {
      const key = e.source ?? 'unspecified'
      evidenceBySource[key] = (evidenceBySource[key] ?? 0) + 1
    }

    // Entity table — top by linkCount.
    const entityRows = topEntities
      .map((e) => ({
        id: e.id,
        type: e.type,
        value: e.value,
        label: e.label,
        linkCount: e._count.links,
        neighborCount: e._count.srcRels + e._count.dstRels,
      }))
      .sort((a, b) => b.linkCount - a.linkCount)
      .slice(0, 20)

    // Transaction stats.
    const amounts = txnStats
      .map((t) => t.amount ?? 0)
      .filter((a) => Number.isFinite(a))
    const totalVolume = amounts.reduce((a, b) => a + b, 0)
    const avgAmount = amounts.length === 0 ? 0 : totalVolume / amounts.length
    const maxAmount = amounts.length === 0 ? 0 : Math.max(...amounts)
    const topTxnFlows = topFlows

    // Findings grouped by severity.
    const bySeverity: Record<string, number> = {}
    const byType: Record<string, number> = {}
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
      byType[f.type] = (byType[f.type] ?? 0) + 1
    }

    // Markdown assembly.
    const md: string[] = []
    md.push(`# Investigation Summary — ${caseRow.uid}`)
    md.push('')
    md.push('## Case Metadata')
    md.push(`- **Title:** ${caseRow.title}`)
    md.push(`- **UID:** ${caseRow.uid}`)
    md.push(`- **Status:** ${caseRow.status}`)
    md.push(`- **Classification:** ${caseRow.classification}`)
    if (caseRow.description) {
      md.push(`- **Description:** ${caseRow.description}`)
    }
    if (caseRow.investigators) {
      md.push(`- **Investigators:** ${caseRow.investigators}`)
    }
    if (caseRow.tags) {
      md.push(`- **Tags:** ${caseRow.tags}`)
    }
    md.push(`- **Created:** ${caseRow.createdAt.toISOString()}`)
    md.push(`- **Updated:** ${caseRow.updatedAt.toISOString()}`)
    md.push('')

    md.push('## Evidence Inventory')
    md.push(`Total evidence items: **${evidence.length}**`)
    md.push('')
    md.push('| # | Name | Source | Status | Size | Entities | Txns | Comms |')
    md.push('|---|------|--------|---------|------|----------|------|-------|')
    for (const [i, e] of evidence.entries()) {
      md.push(
        `| ${i + 1} | ${e.originalName} | ${e.source ?? '-'} | ${e.status} | ${e.size} | ${e._count.entityLinks} | ${e._count.transactions} | ${e._count.communications} |`,
      )
    }
    md.push('')
    md.push('**By source:**')
    for (const [src, n] of Object.entries(evidenceBySource)) {
      md.push(`- ${src}: ${n}`)
    }
    md.push('')

    md.push('## Entity Intelligence')
    md.push(`Total entities: **${entities.length}**`)
    md.push('')
    md.push('| # | Type | Value | Label | Link count | Neighbor count |')
    md.push('|---|------|-------|-------|------------|-----------------|')
    for (const [i, e] of entityRows.entries()) {
      md.push(
        `| ${i + 1} | ${e.type} | ${e.value} | ${e.label ?? '-'} | ${e.linkCount} | ${e.neighborCount} |`,
      )
    }
    md.push('')

    md.push('## Transaction Summary')
    md.push(`- **Total transactions:** ${txnStats.length}`)
    md.push(`- **Total volume:** ₹${totalVolume.toFixed(2)}`)
    md.push(`- **Average amount:** ₹${avgAmount.toFixed(2)}`)
    md.push(`- **Max amount:** ₹${maxAmount.toFixed(2)}`)
    md.push('')
    md.push('### Top flows by amount')
    md.push('| # | Date | Amount | Sender → Receiver | UTR |')
    md.push('|---|------|--------|--------------------|-----|')
    for (const [i, t] of topTxnFlows.entries()) {
      md.push(
        `| ${i + 1} | ${t.txnDate ?? '-'} | ₹${t.amount ?? 0} | ${t.senderAccount ?? '?'} → ${t.receiverAccount ?? '?'} | ${t.utr ?? '-'} |`,
      )
    }
    md.push('')

    md.push('## Communities')
    md.push(`Detected communities: **${communities.length}**`)
    md.push('')
    for (const c of communities) {
      md.push(
        `### ${c.label ?? 'community'} (size=${c.size}, internalRels=${c.internalRels}, externalRels=${c.externalRels})`,
      )
      if (c.dominantTypes) {
        md.push(`- Dominant types: ${c.dominantTypes}`)
      }
      md.push(`- Transaction volume: ₹${(c.transactionVolume ?? 0).toFixed(2)}`)
      md.push(`- Suspicious patterns: ${c.suspiciousPatterns}`)
      md.push(`- Members:`)
      for (const m of c.members.slice(0, 10)) {
        if (m.entity) {
          md.push(
            `  - ${m.entity.type}: ${m.entity.value}${m.entity.label ? ' (' + m.entity.label + ')' : ''}`,
          )
        }
      }
      if (c.members.length > 10) {
        md.push(`  - ... and ${c.members.length - 10} more`)
      }
      md.push('')
    }

    md.push('## Suspicious Patterns (Findings)')
    md.push(`Total findings: **${findings.length}**`)
    md.push('')
    md.push('**By severity:**')
    for (const [sev, n] of Object.entries(bySeverity)) {
      md.push(`- ${sev}: ${n}`)
    }
    md.push('')
    md.push('**By type:**')
    for (const [t, n] of Object.entries(byType)) {
      md.push(`- ${t}: ${n}`)
    }
    md.push('')
    md.push('### High-severity findings')
    const highFindings = findings.filter((f) => f.severity === 'high')
    for (const f of highFindings.slice(0, 20)) {
      md.push(
        `- **[${f.type}]** (confidence=${f.confidence.toFixed(2)}) ${f.description}`,
      )
      if (f.trigger) md.push(`  - Trigger: \`${f.trigger}\``)
    }
    md.push('')

    md.push('## Top Actor Risks')
    md.push('| # | Entity | Type | Score | Top contributors |')
    md.push('|---|--------|------|-------|------------------|')
    for (const [i, a] of topActors.entries()) {
      let contributors: string[] = []
      try {
        contributors = JSON.parse(a.contributorsJson ?? '[]')
      } catch {
        /* ignore */
      }
      const top3 = contributors.slice(0, 3).join('; ')
      md.push(
        `| ${i + 1} | ${a.entity?.value ?? a.entityId} | ${a.entity?.type ?? '-'} | ${a.score.toFixed(1)} | ${top3} |`,
      )
    }
    md.push('')

    md.push('## Timeline Highlights')
    md.push('| # | Timestamp | Kind | Summary |')
    md.push('|---|-----------|------|---------|')
    for (const [i, t] of timeline.entries()) {
      md.push(
        `| ${i + 1} | ${t.ts ?? '-'} | ${t.kind ?? '-'} | ${t.summary ?? ''} |`,
      )
    }
    md.push('')
    md.push('---')
    md.push(
      `_Generated by RED Justice investigation platform. This report is advisory only and must be reviewed by a human investigator before any action._`,
    )

    return NextResponse.json({ markdown: md.join('\n') })
  } catch (err) {
    console.error('[api/cases/[id]/reports/summary GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'summary report failed' },
      { status: 500 },
    )
  }
}
