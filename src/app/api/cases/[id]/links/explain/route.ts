/**
 * POST /api/cases/[id]/links/explain — AI "why connected" for one edge.
 *
 * Body: { srcId, dstId, type? }
 *
 * The v3 answer to "when you click the link it should have an explanation
 * why those nodes were connected — not deterministic, only AI":
 *
 *   1. Gathers BOTH entities, every relationship row between them (all
 *      types when `type` is omitted), the shared evidence files and REAL
 *      text excerpts around each mention of both values.
 *   2. Calls the local AI (linkExplain.aiExplainLink) for a plain-language
 *      narrative grounded in those excerpts.
 *   3. Falls back to the deterministic `whyConnected` sentence when the AI
 *      is unreachable — always labeled as such in the response/UI.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import {
  aiExplainLink,
  mineLinkExcerpts,
  whyConnected,
} from '@/lib/investigation/linkExplain'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Params = { params: Promise<{ id: string }> }

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      srcId?: string
      dstId?: string
      type?: string
    }
    if (!body.srcId || !body.dstId) {
      return NextResponse.json({ error: 'srcId and dstId are required' }, { status: 400 })
    }

    const [src, dst] = await Promise.all([
      db.entity.findFirst({ where: { id: body.srcId, caseId } }),
      db.entity.findFirst({ where: { id: body.dstId, caseId } }),
    ])
    if (!src || !dst) {
      return NextResponse.json({ error: 'entities not found in this case' }, { status: 404 })
    }

    // Every relationship row between the pair (either direction); prefer the
    // requested type when given.
    const allRows = await db.relationship.findMany({
      where: {
        caseId,
        OR: [
          { srcId: src.id, dstId: dst.id },
          { srcId: dst.id, dstId: src.id },
        ],
      },
      orderBy: { weight: 'desc' },
      take: 20,
    })
    const rows = body.type
      ? allRows.filter((r) => r.type === body.type)
      : allRows
    const primary = rows[0] ?? null
    const relationTypes = Array.from(new Set(rows.map((r) => r.type)))

    // Shared evidence: files linked to BOTH entities, plus the edge's own
    // evidenceId (they can differ for cross-file AI links).
    const linkRows = await db.entityLink.findMany({
      where: { entityId: { in: [src.id, dst.id] } },
      select: { entityId: true, evidenceId: true },
    })
    const byEntity = new Map<string, Set<string>>()
    for (const l of linkRows) {
      const set = byEntity.get(l.entityId) ?? new Set<string>()
      set.add(l.evidenceId)
      byEntity.set(l.entityId, set)
    }
    const sharedIds = new Set<string>(
      [...(byEntity.get(src.id) ?? [])].filter((id) => (byEntity.get(dst.id) ?? new Set()).has(id)),
    )
    if (primary?.evidenceId) sharedIds.add(primary.evidenceId)

    const evidenceFiles = sharedIds.size
      ? await db.evidence.findMany({
          where: { id: { in: [...sharedIds] }, caseId },
          select: { id: true, originalName: true, content: true },
        })
      : []

    const excerpts = mineLinkExcerpts(
      evidenceFiles.map((e) => ({ name: e.originalName, content: e.content ?? '' })),
      src.value,
      dst.value,
    )

    // Deterministic layer (always present, instant).
    let meta: Record<string, unknown> = {}
    if (primary?.metadataJson) {
      try { meta = JSON.parse(primary.metadataJson) as Record<string, unknown> } catch { /* ignore */ }
    }
    const rationale = typeof meta.rationale === 'string' ? meta.rationale
      : typeof meta.note === 'string' ? meta.note : undefined
    const heuristicWhy = primary
      ? whyConnected(primary, rationale, sharedIds.size, meta)
      : `${relationTypes.join('/') || 'A link'} between ${src.label ?? src.value} and ${dst.label ?? dst.value} exists in the case graph.`

    // AI narrative layer.
    const ai = await aiExplainLink({
      srcLabel: `${src.label ?? src.value}${src.value !== (src.label ?? src.value) ? ` (${src.value})` : ''}`,
      srcType: src.type,
      dstLabel: `${dst.label ?? dst.value}${dst.value !== (dst.label ?? dst.value) ? ` (${dst.value})` : ''}`,
      dstType: dst.type,
      relationTypes,
      confidence: primary?.confidence ?? null,
      provenance: primary?.provenance ?? null,
      rationale,
      excerpts,
      sharedEvidenceFiles: evidenceFiles.map((e) => e.originalName),
    })

    return NextResponse.json({
      src: { id: src.id, type: src.type, label: src.label ?? src.value },
      dst: { id: dst.id, type: dst.type, label: dst.label ?? dst.value },
      relationship: primary
        ? {
            id: primary.id,
            type: primary.type,
            allTypes: relationTypes,
            confidence: primary.confidence,
            weight: primary.weight,
            provenance: primary.provenance,
            evidenceRef: primary.evidenceRef,
            rationale,
          }
        : null,
      // AI-authored narrative ("" when the AI is offline).
      explanation: ai.explanation,
      aiAvailable: ai.aiAvailable,
      model: ai.model,
      // Deterministic fallback sentence — UI shows it as the baseline.
      heuristicWhy,
      sharedEvidence: {
        count: sharedIds.size,
        files: evidenceFiles.map((e) => e.originalName),
      },
      excerpts,
    })
  } catch (err) {
    console.error('[api/cases/[id]/links/explain POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'link explain failed' },
      { status: 500 },
    )
  }
}
