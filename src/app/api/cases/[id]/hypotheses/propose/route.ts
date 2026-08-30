/**
 * POST /api/cases/[id]/hypotheses/propose — AI proposes a hypothesis from the
 * case data (falls back to a deterministic gap-based suggestion offline).
 *
 * The proposal is created as a draft hypothesis for the investigator to
 * accept, edit or discard — the AI never auto-promotes its own hypothesis.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity, buildPatternContext, toGraphInput } from '@/lib/api/helpers'
import { computeAll } from '@/lib/analytics/graphAnalytics'
import { computeGaps } from '@/lib/investigation/gapEngine'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const caseRow = await db.case.findUnique({ where: { id: caseId }, select: { title: true } })

    // Gather deterministic material for the proposal.
    const ctx = await buildPatternContext(db, caseId)
    const valueOf = new Map((ctx?.entities ?? []).map((e) => [e.id, `${e.type}:${e.value}`]))
    let centralityHint = ''
    let bridgeHint = ''
    if (ctx && ctx.entities.length > 0) {
      const g = toGraphInput(ctx.entities, ctx.relationships)
      const metrics = computeAll(g)
      const topCentral = Object.entries(metrics.pagerank).sort((a, b) => b[1] - a[1])[0]
      const topBridge = Object.entries(metrics.betweenness).sort((a, b) => b[1] - a[1])[0]
      if (topCentral) centralityHint = valueOf.get(topCentral[0]) ?? topCentral[0]
      if (topBridge && topBridge[0] !== topCentral?.[0]) bridgeHint = valueOf.get(topBridge[0]) ?? topBridge[0]
    }

    const gaps = await computeGaps(db, caseId)
    const topGap = gaps.gaps.find((g) => g.severity === 'high') ?? gaps.gaps[0]

    let title = ''
    let statement = ''
    let proposedBy = 'deterministic'

    // Try the local AI first.
    try {
      const { localChat, pingLocalAi } = await import('@/lib/localAi')
      // v3.3 tier routing: hypothesis drafting is compact structured output
      // → STANDARD tier, chain-of-thought off (a tiny JSON, speed wins).
      const { modelForTier } = await import('@/lib/modelTiers')
      const standardModel = await modelForTier('standard')
      const ping = await pingLocalAi()
      if (ping.available) {
        const findings = await db.finding.findMany({
          where: { caseId },
          take: 8,
          orderBy: { severity: 'desc' },
          select: { type: true, severity: true, description: true },
        })
        const prompt = `You are assisting a criminal-network investigator. Based ONLY on the deterministic material below, propose ONE testable hypothesis for case "${caseRow?.title ?? ''}".

Material:
- Top central actor: ${centralityHint || 'n/a'}
- Top bridge: ${bridgeHint || 'n/a'}
- Findings: ${findings.map((f) => `${f.type}(${f.severity})`).join(', ') || 'none'}
- Top gap: ${topGap ? `${topGap.title}: ${topGap.description.slice(0, 140)}` : 'none'}

Respond with ONLY a JSON block:
\`\`\`json
{"title": "short hypothesis title", "statement": "1-2 sentence testable statement using only the material above"}
\`\`\`
Rules: measurable, falsifiable, no accusations, use words like "appears", "warrants testing".`

        const raw = await localChat(
          [
            { role: 'system', content: 'You propose careful, testable investigation hypotheses. Always write in ENGLISH.' },
            { role: 'user', content: prompt },
          ],
          { temperature: 0.4, maxTokens: 1500, thinking: false, model: standardModel },
        )
        const { extractJsonObject } = await import('@/lib/aiJson')
        const parsed = extractJsonObject<{ title?: string; statement?: string }>(raw)
        if (parsed?.title && parsed?.statement) {
          title = String(parsed.title)
          statement = String(parsed.statement)
          proposedBy = 'ai'
        }
      }
    } catch { /* fall through to deterministic */ }

    if (!statement) {
      // Deterministic fallback: hypothesise around the top bridge / gap.
      if (bridgeHint) {
        title = `Bridge-role hypothesis for ${bridgeHint}`
        statement = `${bridgeHint} shows the highest betweenness in the current graph. Hypothesis: it functions as the coordination bridge between the two largest clusters; testing requires corroborating its transactions with at least one more independent source.`
      } else if (centralityHint) {
        title = `Hub-role hypothesis for ${centralityHint}`
        statement = `${centralityHint} is the most central actor in the current graph. Hypothesis: it controls the majority of value flow; testing requires verifying its fan-in/fan-out against the underlying bank statement rows.`
      } else if (topGap) {
        title = `Evidence-gap hypothesis`
        statement = `${topGap.title}. Hypothesis: obtaining the missing source (${topGap.recommendation.slice(0, 80)}…) will materially change the network conclusions; until then the current structure should be treated as provisional.`
      } else {
        return NextResponse.json({ error: 'not enough case data to propose a hypothesis — ingest evidence first' }, { status: 400 })
      }
    }

    const note = await db.investigatorNote.create({
      data: {
        caseId,
        body: statement,
        metadataJson: JSON.stringify({
          hypothesis: true,
          title,
          status: 'draft',
          proposedBy,
          supportingEvidence: [],
          contradictingEvidence: [],
          graphSupport: 'none',
          temporalSupport: 'none',
          confidence: 0,
        }),
      },
    })

    await logActivity(db, caseId, `Hypothesis proposed (${proposedBy}): ${title}`)
    return NextResponse.json(
      {
        hypothesis: {
          id: note.id,
          title,
          statement,
          status: 'draft',
          proposedBy,
          confidence: 0,
          createdAt: note.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[hypotheses/propose POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
