/**
 * GET /api/cases/[id]/graph — return the case's knowledge graph.
 *
 * Returns `{ nodes, edges }` with each node carrying its computed degree,
 * per-node evidence counts (heatmap), a confidence state (observed /
 * corroborated / inferred / uncertain), and per-edge evidence provenance
 * (evidenceId, evidenceRef, locator, provenance, extractionMethod) so every
 * relationship can be traced to the exact source file/page/record.
 *
 * Supports ?entityType=&relType=&minWeight=&limit=&includeContextual= filters.
 *
 * Key behaviours:
 *   1. Contextual entity types (date, amount) are EXCLUDED by default — they
 *      add visual noise without network-analysis value. Pass ?includeContextual=1
 *      to include them.
 *   2. Edge prioritisation: TRANSFERRED_TO, OWNS, USES, SHARED_IDENTIFIER edges
 *      are always included (semantic meaning). CO_OCCURRED edges are capped at
 *      200 by weight desc to avoid a hairball mesh.
 *   3. Nodes with degree 0 after edge filtering are excluded (isolated nodes
 *      add clutter).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import {
  resolveCaseId,
  toGraphInput,
  computeDegrees,
} from '@/lib/api/helpers'
import { whyConnected } from '@/lib/investigation/linkExplain'

/** Parse an entity/relationship metadataJson blob defensively. */
function metaOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Table-row snapshots carried on relationship metadata (full-fidelity mode). */
interface TableRowSnapshot {
  rowId?: string
  srcTableId?: string
  tgtTableId?: string
  state?: string
  method?: string
  evidenceRefs?: string[]
  timestamp?: string
  row?: Record<string, string>
}

function rowsOf(meta: Record<string, unknown>): TableRowSnapshot[] {
  const rows = meta.rows
  return Array.isArray(rows) ? (rows as TableRowSnapshot[]) : []
}

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// Contextual entity types that add noise to the graph — excluded by default.
const CONTEXTUAL_TYPES = new Set(['date', 'amount'])

/**
 * v3.6 — DYNAMIC relationship typing. Every edge type EXCEPT the mechanical
 * CO_OCCURRED mesh is evidence-derived and ALWAYS included. The former
 * hardcoded SEMANTIC_TYPES allow-list starved novel evidence-derived types
 * (a Palantir export's SUPPLIED_DRUGS_TO or an AI-inferred RECRUITED_BY was
 * pooled with CO_OCCurred and dropped past the 200-edge budget). Now the
 * only budget-capped family is mechanical co-occurrence.
 */
const MAX_CO_OCCURRED = 200

/** True for evidence-derived (semantic) edge types — always rendered. */
function isSemanticType(type: string): boolean {
  return type !== 'CO_OCCURRED'
}

/**
 * Confidence state for an edge (Confidence-Aware Investigation Graph):
 *   corroborated — ≥2 independent evidence files produced this relationship
 *                  (weight > 1 via different files) or high-confidence txn edge
 *   observed     — single direct extraction from one file
 *   inferred     — derived by co-occurrence / analytics, not a direct record
 *   uncertain    — sub-0.5 extraction confidence
 */
function edgeVerState(r: {
  type: string
  weight: number
  confidence: number
  provenance: string | null
}): 'observed' | 'corroborated' | 'inferred' | 'uncertain' {
  if (r.confidence < 0.5) return 'uncertain'
  const derived = (r.provenance ?? '').includes('co-occurrence') || r.type === 'CO_OCCURRED'
  if (derived) return r.weight >= 3 ? 'corroborated' : 'inferred'
  if (r.weight >= 3 || (r.type === 'TRANSFERRED_TO' && r.confidence >= 0.9)) return 'corroborated'
  return 'observed'
}

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
    const entityType = sp.get('entityType') ?? undefined
    const relType = sp.get('relType') ?? undefined
    const minWeightRaw = sp.get('minWeight')
    const minWeight = minWeightRaw ? parseFloat(minWeightRaw) : undefined
    const includeContextual = sp.get('includeContextual') === '1'
    // v3.9: candidate entities (below the confirmation threshold) are hidden
    // from the canonical graph by default — they are KEPT in the DB for
    // review/promotion and can be surfaced with ?includeCandidates=1.
    const includeCandidates = sp.get('includeCandidates') === '1'
    // v3.8 VARIABLE node limit: no ?limit → the default SCALES WITH THE CASE
    // (small cases render every node, big cases render up to the cap) instead
    // of a fixed 300 that hid most of a large bank-trail graph.
    const explicitLimit = parseInt(sp.get('limit') ?? '', 10)
    const caseEntityCount = await db.entity.count({ where: { caseId } })
    const { dynamicGraphLimit } = await import('@/lib/modelTiers')
    const limit = Number.isFinite(explicitLimit) && explicitLimit > 0
      ? Math.min(5000, explicitLimit)
      : dynamicGraphLimit(caseEntityCount, 3000)

    // Build entity filter — exclude contextual types unless explicitly requested.
    const entityWhere: {
      caseId: string
      type?: string
      NOT?: Array<{ type: string }>
      status?: string
    } = { caseId }
    if (!includeCandidates) entityWhere.status = 'confirmed'
    if (entityType) {
      entityWhere.type = entityType
    } else if (!includeContextual) {
      // Exclude contextual types (date, amount) by default.
      entityWhere.NOT = Array.from(CONTEXTUAL_TYPES).map((t) => ({ type: t }))
    }

    const [entities, relationships] = await Promise.all([
      db.entity.findMany({ where: entityWhere }),
      db.relationship.findMany({
        where: {
          caseId,
          ...(relType ? { type: relType } : {}),
          ...(minWeight !== undefined && Number.isFinite(minWeight)
            ? { weight: { gte: Math.round(minWeight) } }
            : {}),
        },
      }),
    ])

    // v3.5: source-table IDs per entity (E0001 …) — merged from metadata.
    const tableIdsByEntity = new Map<string, string[]>()
    for (const e of entities) {
      const ids = metaOf(e.metadataJson).tableIds
      if (Array.isArray(ids)) {
        const clean = ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
        if (clean.length > 0) tableIdsByEntity.set(e.id, clean)
      }
    }

    // Per-node evidence counts (Network Evidence Heatmap).
    const entityLinkRows = await db.entityLink.findMany({
      where: { entityId: { in: entities.map((e) => e.id) } },
      select: { entityId: true, evidenceId: true },
    })
    const evidenceCountByEntity = new Map<string, number>()
    const evidenceFilesByEntity = new Map<string, Set<string>>()
    for (const l of entityLinkRows) {
      evidenceCountByEntity.set(l.entityId, (evidenceCountByEntity.get(l.entityId) ?? 0) + 1)
      const set = evidenceFilesByEntity.get(l.entityId) ?? new Set<string>()
      set.add(l.evidenceId)
      evidenceFilesByEntity.set(l.entityId, set)
    }

    // Build a set of entity IDs that are NOT contextual (for edge filtering).
    const nonContextualIds = new Set(entities.map((e) => e.id))

    // Edge prioritisation — v3.6: ALL evidence-derived types are semantic and
    // always included; only the mechanical CO_OCCurred mesh is budget-capped.
    const semanticEdges = relationships.filter(
      (r) => isSemanticType(r.type) &&
        nonContextualIds.has(r.srcId) &&
        nonContextualIds.has(r.dstId),
    )
    const coOccurredEdges = relationships
      .filter(
        (r) => !isSemanticType(r.type) &&
          nonContextualIds.has(r.srcId) &&
          nonContextualIds.has(r.dstId) &&
          r.srcId !== r.dstId,
      )
      .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))

    let filteredRels: typeof relationships
    if (minWeight !== undefined && Number.isFinite(minWeight)) {
      filteredRels = relationships.filter(
        (r) => (r.weight ?? 0) >= Math.round(minWeight!) &&
          nonContextualIds.has(r.srcId) &&
          nonContextualIds.has(r.dstId),
      )
    } else if (relType) {
      filteredRels = relationships.filter(
        (r) => nonContextualIds.has(r.srcId) && nonContextualIds.has(r.dstId),
      )
    } else {
      filteredRels = [...semanticEdges, ...coOccurredEdges.slice(0, MAX_CO_OCCURRED)]
    }

    const g = toGraphInput(entities, filteredRels)
    const degrees = computeDegrees(g)

    // Pick top-`limit` highest-degree nodes; keep only edges between them.
    const ranked = g.nodes
      .map((n) => ({ node: n, degree: degrees[n.id] ?? 0 }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, limit)
    const keepIds = new Set(ranked.map((r) => r.node.id))

    // Resolve evidence names for edge provenance (one query, cached map).
    const evidenceIds = Array.from(
      new Set(filteredRels.map((r) => r.evidenceId).filter((x): x is string => Boolean(x))),
    )
    const evidenceRows = evidenceIds.length
      ? await db.evidence.findMany({
          where: { id: { in: evidenceIds } },
          select: { id: true, originalName: true, classification: true },
        })
      : []
    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]))

    const nodes = ranked.map((r) => {
      const evFiles = evidenceFilesByEntity.get(r.node.id)?.size ?? 0
      const evCount = evidenceCountByEntity.get(r.node.id) ?? 0
      return {
        ...r.node,
        degree: r.degree,
        evidenceCount: evCount,
        evidenceFiles: evFiles,
        // v3.5: the source export's own IDs for this node, when present.
        tableIds: tableIdsByEntity.get(r.node.id) ?? undefined,
        // Confidence state for the node itself.
        verState: evFiles >= 2 ? ('corroborated' as const) : evFiles === 1 ? ('observed' as const) : ('uncertain' as const),
      }
    })

    const edges = filteredRels
      .filter((r) => keepIds.has(r.srcId) && keepIds.has(r.dstId) && r.srcId !== r.dstId)
      .map((r) => {
        const ev = r.evidenceId ? evidenceById.get(r.evidenceId) : undefined
        // Edge metadata (rationale / proximity / alias info from smartConnect
        // and the AI story/crosslink engines).
        let meta: Record<string, unknown> = {}
        if (r.metadataJson) {
          try { meta = JSON.parse(r.metadataJson) as Record<string, unknown> } catch { /* ignore */ }
        }
        const rows = rowsOf(meta)
        const rationale =
          typeof meta.rationale === 'string' ? meta.rationale :
          typeof meta.note === 'string' ? meta.note : undefined
        const sharedEvidence = (() => {
          const a = evidenceFilesByEntity.get(r.srcId)
          const b = evidenceFilesByEntity.get(r.dstId)
          if (!a || !b) return 0
          let n = 0
          for (const id of a) if (b.has(id)) n += 1
          return n
        })()
        return {
          id: r.id,
          source: r.srcId,
          target: r.dstId,
          type: r.type,
          weight: r.weight,
          amount: r.amount ?? undefined,
          currency: r.currency ?? undefined,
          timestamp: r.timestamp ?? undefined,
          // Per-edge evidence provenance.
          evidenceId: r.evidenceId ?? undefined,
          evidenceRef: r.evidenceRef ?? ev?.originalName ?? undefined,
          evidenceClassification: ev?.classification ?? undefined,
          locator: r.locator ?? undefined,
          provenance: r.provenance ?? undefined,
          extractionMethod: r.extractionMethod ?? undefined,
          confidence: r.confidence,
          verState: edgeVerState(r),
          // Why-connected explanation fields (edge panel).
          rationale,
          sharedEvidence,
          why: whyConnected(r, rationale, sharedEvidence, meta),
          // v3.5 full-fidelity table rows: the verbatim source rows asserting
          // this edge (with their own IDs, state, method, evidence refs), plus
          // the aggregate state of the newest row.
          ...(rows.length > 0
            ? {
                rows: rows.map((row) => ({
                  ...(row.rowId ? { rowId: row.rowId } : {}),
                  ...(row.srcTableId ? { srcTableId: row.srcTableId } : {}),
                  ...(row.tgtTableId ? { tgtTableId: row.tgtTableId } : {}),
                  ...(row.state ? { state: row.state } : {}),
                  ...(row.method ? { method: row.method } : {}),
                  ...(row.evidenceRefs ? { evidenceRefs: row.evidenceRefs } : {}),
                  ...(row.timestamp ? { timestamp: row.timestamp } : {}),
                  ...(row.row ? { row: row.row } : {}),
                })),
                tableRowCount: rows.length,
                ...(rows[rows.length - 1]?.state ? { state: rows[rows.length - 1].state } : {}),
              }
            : {}),
          // Temporal playback timestamp: extracted event time, falling back
          // to when the relationship row entered the graph.
          t: r.timestamp ?? r.createdAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        }
      })

    // Re-compute degrees after edge filtering so node sizes reflect the
    // visible graph, not the full graph.
    const visibleDegrees: Record<string, number> = {}
    for (const e of edges) {
      visibleDegrees[e.source] = (visibleDegrees[e.source] ?? 0) + 1
      visibleDegrees[e.target] = (visibleDegrees[e.target] ?? 0) + 1
    }
    const nodesWithDegree = nodes.map((n) => ({
      ...n,
      degree: visibleDegrees[n.id] ?? n.degree ?? 0,
    }))

    return NextResponse.json({
      nodes: nodesWithDegree,
      edges,
      meta: {
        totalEntities: entities.length,
        totalRelationships: relationships.length,
        returnedNodes: nodesWithDegree.length,
        returnedEdges: edges.length,
        contextualExcluded: !includeContextual,
        limit,
        // Playback window for the temporal slider.
        timeRange: (() => {
          const times = edges.map((e) => e.t).filter((x): x is string => Boolean(x)).sort()
          return { from: times[0] ?? null, to: times[times.length - 1] ?? null }
        })(),
      },
    })
  } catch (err) {
    console.error('[api/cases/[id]/graph GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'graph failed' },
      { status: 500 },
    )
  }
}
