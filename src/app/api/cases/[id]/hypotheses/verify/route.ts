/**
 * POST /api/cases/[id]/hypotheses/verify — AI-Assisted Hypothesis →
 * Verification Loop (deterministic half).
 *
 * Body: { hypothesisId }
 *
 * Runs deterministic graph/evidence queries against the hypothesis statement:
 *   1. keyword/entity match — does the case contain the identifiers named?
 *   2. evidence support     — are there evidence files mentioning them?
 *   3. finding support      — do deterministic findings touch them?
 *   4. contradiction check  — do open contradictions touch the claim?
 *   5. graph support        — are the named entities connected (shortest path)?
 *
 * The hypothesis status becomes confirmed / rejected / unresolved and the
 * verification report is persisted. Only verified hypotheses may advance to
 * claims (claim graph policy).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { recordDecision } from '@/lib/investigation/decisions'
import { shortestPath } from '@/lib/analytics/graphAnalytics'
import { buildPatternContext, toGraphInput } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'of', 'to', 'in', 'on', 'with', 'that', 'this', 'may', 'might', 'be', 'connect', 'connected', 'same', 'person', 'entity', 'account'])

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as { hypothesisId?: string }
    if (!body.hypothesisId) {
      return NextResponse.json({ error: 'hypothesisId is required' }, { status: 400 })
    }

    const note = await db.investigatorNote.findFirst({ where: { id: body.hypothesisId, caseId } })
    if (!note) return NextResponse.json({ error: 'hypothesis not found' }, { status: 404 })

    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(note.metadataJson ?? '{}') as Record<string, unknown> } catch { /* ignore */ }
    if (!meta.hypothesis) return NextResponse.json({ error: 'note is not a hypothesis' }, { status: 400 })

    const statement = note.body
    const lower = statement.toLowerCase()

    // Extract keyword tokens.
    const tokens = Array.from(
      new Set(
        lower
          .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
          .split(/\s+/)
          .filter((t) => t.length >= 4 && !STOP.has(t)),
      ),
    ).slice(0, 12)

    const checks: Array<{ check: string; result: 'pass' | 'partial' | 'fail'; detail: string }> = []

    // 1. Entity match.
    const matchedEntities = tokens.length
      ? await db.entity.findMany({
          where: {
            caseId,
            OR: tokens.flatMap((t) => [
              { value: { contains: t } },
              { norm: { contains: t } },
              { label: { contains: t } },
            ]),
          },
          take: 10,
          select: { id: true, type: true, value: true },
        })
      : []
    checks.push({
      check: 'entity_match',
      result: matchedEntities.length > 0 ? 'pass' : 'fail',
      detail: matchedEntities.length > 0
        ? `${matchedEntities.length} case entities match the statement: ${matchedEntities.slice(0, 5).map((e) => `${e.type}:${e.value}`).join(', ')}`
        : 'No case entity matches the identifiers mentioned in the hypothesis.',
    })

    // 2. Evidence support.
    const matchedEvidence = tokens.length
      ? await db.evidence.findMany({
          where: {
            caseId,
            OR: tokens.flatMap((t) => [
              { content: { contains: t } },
              { originalName: { contains: t } },
            ]),
          },
          take: 6,
          select: { id: true, originalName: true },
        })
      : []
    checks.push({
      check: 'evidence_support',
      result: matchedEvidence.length > 0 ? (matchedEvidence.length >= 2 ? 'pass' : 'partial') : 'fail',
      detail: matchedEvidence.length > 0
        ? `${matchedEvidence.length} evidence file(s) mention the claim: ${matchedEvidence.map((e) => e.originalName).join(', ')}`
        : 'No ingested evidence mentions the identifiers in the hypothesis.',
    })

    // 3. Finding support.
    const matchedFindings = tokens.length
      ? await db.finding.findMany({
          where: { caseId, OR: [{ description: { contains: tokens[0] } }, { trigger: { contains: tokens[0] } }] },
          take: 6,
          select: { id: true, type: true, severity: true },
        })
      : []
    checks.push({
      check: 'finding_support',
      result: matchedFindings.length > 0 ? 'pass' : 'partial',
      detail: matchedFindings.length > 0
        ? `${matchedFindings.length} deterministic finding(s) overlap: ${matchedFindings.map((f) => `${f.type}(${f.severity})`).join(', ')}`
        : 'No deterministic finding directly supports the claim (weak but not disqualifying).',
    })

    // 4. Contradiction check.
    const contradictions = await db.contradiction.findMany({
      where: { caseId, status: 'open' },
      take: 50,
      select: { id: true, description: true },
    })
    const touching = contradictions.filter((c) => tokens.some((t) => c.description.toLowerCase().includes(t)))
    checks.push({
      check: 'contradiction_check',
      result: touching.length > 0 ? 'fail' : 'pass',
      detail: touching.length > 0
        ? `${touching.length} open contradiction(s) touch this claim — resolve them first.`
        : 'No open contradiction touches this claim.',
    })

    // 5. Graph support — are the first two matched entities connected?
    let graphSupport = 'none'
    let pathLen: number | null = null
    if (matchedEntities.length >= 2) {
      const ctx = await buildPatternContext(db, caseId)
      if (ctx) {
        const g = toGraphInput(ctx.entities, ctx.relationships)
        const path = shortestPath(g, matchedEntities[0].id, matchedEntities[1].id)
        if (path) {
          graphSupport = path.length <= 3 ? 'strong' : 'moderate'
          pathLen = path.length - 1
        } else {
          graphSupport = 'weak'
        }
      }
    }
    checks.push({
      check: 'graph_support',
      result: graphSupport === 'none' ? 'partial' : graphSupport === 'weak' ? 'partial' : 'pass',
      detail: graphSupport === 'none'
        ? 'Fewer than two matched entities — no path to test.'
        : pathLen != null
          ? `Matched entities are connected via ${pathLen} hop(s) (${graphSupport}).`
          : 'Matched entities are NOT connected in the current graph (weak structural support).',
    })

    // Aggregate verdict.
    const passCount = checks.filter((c) => c.result === 'pass').length
    const failCount = checks.filter((c) => c.result === 'fail').length
    const status = failCount === 0 && passCount >= 3 ? 'confirmed' : failCount >= 2 ? 'rejected' : 'unresolved'
    const confidence = Math.round(((passCount + 0.5 * checks.filter((c) => c.result === 'partial').length) / checks.length) * 100) / 100

    const verification = {
      verifiedAt: new Date().toISOString(),
      status,
      confidence,
      checks,
    }

    const beforeStatus = String(meta.status ?? 'unresolved')
    const afterStatus = status === 'confirmed' ? 'confirmed' : status === 'rejected' ? 'rejected' : 'unresolved'

    await db.investigatorNote.update({
      where: { id: note.id },
      data: {
        metadataJson: JSON.stringify({
          ...meta,
          status: afterStatus,
          confidence,
          supportingEvidence: matchedEvidence.map((e) => e.id),
          matchedEntityIds: matchedEntities.map((e) => e.id),
          verification,
        }),
      },
    })

    // Structured Decision Record (architecture §18) — deterministic verifier
    // outcomes are recorded just like human decisions, flagged actor=system.
    const decisionRec = await recordDecision(db, {
      caseId,
      action:
        afterStatus === 'confirmed' ? 'confirm_hypothesis'
        : afterStatus === 'rejected' ? 'reject_hypothesis'
        : 'mark_unresolved',
      objectType: 'hypothesis',
      objectRef: note.id,
      objectLabel: `${String(meta.title ?? 'Hypothesis')}: ${note.body.slice(0, 120)}`,
      beforeState: beforeStatus,
      afterState: afterStatus,
      reason: checks.map((c) => `${c.check}=${c.result}`).join(' · '),
      actor: 'deterministic-verifier',
      evidence: matchedEvidence.map((e) => ({ evidenceId: e.id, name: e.originalName })),
      metadata: { confidence, verification },
    })

    await logActivity(db, caseId, `Hypothesis "${String(meta.title ?? 'untitled').slice(0, 50)}" verified → ${status} (${(confidence * 100).toFixed(0)}%)${decisionRec ? ` [${decisionRec.uid}]` : ''}`)

    return NextResponse.json({ ok: true, hypothesisId: note.id, status, confidence, checks, decisionUid: decisionRec?.uid ?? null })
  } catch (err) {
    console.error('[hypotheses/verify POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
