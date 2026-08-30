/**
 * POST /api/cases/[id]/explain-connection — the "Explain Connection" engine.
 *
 * Body: { srcId, dstId, persist?: boolean, actor?: string }
 *
 * Select two entities and RED Justice reconstructs WHY / HOW they may be
 * connected (architecture §27):
 *
 *   1. Bounded multi-path enumeration  → up to 4 corridors between the pair
 *   2. Edge-level provenance           → which evidence file(s), page/row
 *                                        locator, extraction method, and how
 *                                        many INDEPENDENT sources support
 *                                        each hop; corroborated state when ≥2
 *   3. Temporal validity               → first/last observed per edge and an
 *                                        overall overlap window
 *   4. Contradiction scan              → open contradictions touching either
 *                                        endpoint or the supporting files
 *   5. Evidence Sufficiency scoring    → the deterministic sufficiency engine
 *                                        (independent sources × quality −
 *                                        contradiction penalty)
 *   6. Evidence Contract               → machine-readable contract returned
 *                                        with every explanation ("no finding
 *                                        without this contract", §28)
 *   7. Optional persistence            → persist=true stores it as a Claim +
 *                                        a DecisionRecord audit entry
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, toGraphInput } from '@/lib/api/helpers'
import { enumeratePaths } from '@/lib/analytics/graphAnalytics'
import { scoreFinding } from '@/lib/investigation/sufficiency'
import {
  buildContract,
  assertValidContract,
  type ContractEvidenceRef,
} from '@/lib/investigation/evidenceContract'
import { recordDecision } from '@/lib/investigation/decisions'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

interface RelRowLite {
  id: string
  srcId: string
  dstId: string
  type: string
  confidence: number
  evidenceId: string | null
  locator: string | null
  extractionMethod: string | null
  provenance: string | null
  timestamp: string | null
  createdAt: Date
}

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
      persist?: boolean
      actor?: string
    }
    if (!body.srcId || !body.dstId) {
      return NextResponse.json({ error: 'srcId and dstId are required' }, { status: 400 })
    }

    const [entities, relationships] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
    ])
    const g = toGraphInput(entities, relationships)

    const src = entities.find((e) => e.id === body.srcId)
    const dst = entities.find((e) => e.id === body.dstId)
    if (!src || !dst) return NextResponse.json({ error: 'entities not found in this case' }, { status: 404 })

    // ── 1. Multi-path enumeration ────────────────────────────────────────────
    const paths = enumeratePaths(g, src.id, dst.id, { maxPaths: 4, maxHops: 5 })

    const nodeById = new Map(entities.map((e) => [e.id, e]))
    const labelOf = (eid: string) => {
      const e = nodeById.get(eid)
      return e ? `${e.type}:${e.label ?? e.value}` : eid
    }

    // ── 2. Per-hop provenance aggregation ────────────────────────────────────
    // Group every relationship by unordered endpoint pair so all parallel
    // edges contribute their independent sources to a single "hop".
    const relsByPair = new Map<string, RelRowLite[]>()
    for (const r of relationships) {
      const key = [r.srcId, r.dstId].sort().join('~')
      const arr = relsByPair.get(key) ?? []
      arr.push(r as RelRowLite)
      relsByPair.set(key, arr)
    }

    interface HopProvenance {
      from: string
      to: string
      relationTypes: string[]
      independentSources: number
      state: 'corroborated' | 'observed' | 'inferred'
      evidence: Array<{ evidenceId: string; locator: string | null; method: string | null }>
      firstObserved: string | null
      lastObserved: string | null
    }

    const hops: HopProvenance[] = []
    const pathHops: HopProvenance[][] = []

    for (const p of paths) {
      const pHops: HopProvenance[] = []
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i]
        const b = p[i + 1]
        let h = hops.find(
          (x) => (x.from === a && x.to === b) || (x.from === b && x.to === a),
        )
        if (!h) {
          const key = [a, b].sort().join('~')
          const rows = relsByPair.get(key) ?? []
          const evRows = rows.filter((r) => r.evidenceId)
          const distinctEv = new Set(evRows.map((r) => r.evidenceId))
          const inferred = rows.some((r) => r.provenance === 'ai-crosslink')
          const times = rows
            .map((r) => r.timestamp)
            .filter((x): x is string => Boolean(x))
            .sort()
          h = {
            from: labelOf(a),
            to: labelOf(b),
            relationTypes: Array.from(new Set(rows.map((r) => r.type))),
            independentSources: distinctEv.size,
            state:
              distinctEv.size >= 2
                ? 'corroborated'
                : inferred && distinctEv.size <= 1
                  ? 'inferred'
                  : 'observed',
            evidence: Array.from(
              new Map(
                evRows.map((r) => [
                  r.evidenceId as string,
                  {
                    evidenceId: r.evidenceId as string,
                    locator: r.locator,
                    method: r.extractionMethod,
                  },
                ]),
              ).values(),
            ),
            firstObserved: times[0] ?? null,
            lastObserved: times.length > 0 ? times[times.length - 1] : null,
          }
          hops.push(h)
        }
        pHops.push(h)
      }
      pathHops.push(pHops)
    }

    // Union of evidence cited by any hop on any path.
    const citedEvIds = new Set<string>()
    for (const h of hops) for (const e of h.evidence) citedEvIds.add(e.evidenceId)

    // Fallback augmentation: many relationships (co-occurrence wiring, legacy
    // rows) carry no direct edge-level evidenceId even though their endpoint
    // entities DO have solid evidence links. Pull those in so the contract's
    // independent_sources matches what the sufficiency engine counts.
    const pathEntityIds = Array.from(new Set(paths.flat()))
    if (pathEntityIds.length > 0) {
      const linkedRows = await db.entityLink.findMany({
        where: { entityId: { in: pathEntityIds } },
        select: { evidenceId: true },
      })
      for (const l of linkedRows) if (l.evidenceId) citedEvIds.add(l.evidenceId)
    }

    // ── 4. Contradiction scan ────────────────────────────────────────────────
    const contradictions = await db.contradiction.findMany({
      where: { caseId, status: { not: 'resolved' } },
    })
    const touching = contradictions.filter((c) => {
      let evIds: string[] = []
      try { evIds = JSON.parse(c.evidenceIdsJson ?? '[]') as string[] } catch { /* ignore */ }
      const hitsEvidence = evIds.some((x) => citedEvIds.has(x))
      const subjects = [c.subjectAId, c.subjectBId, c.subjectARef, c.subjectBRef].filter(Boolean)
      const hitsEntities =
        subjects.includes(src.id) ||
        subjects.includes(dst.id) ||
        paths.some((p) => p.slice(1, -1).some((n) => subjects.includes(n)))
      return hitsEvidence || hitsEntities
    })

    const contradictingRefs: ContractEvidenceRef[] = touching.flatMap((c) => {
      let raws: unknown[] = []
      try { raws = JSON.parse(c.evidenceIdsJson ?? '[]') as unknown[] } catch { /* ignore */ }
      return raws.flatMap((raw): ContractEvidenceRef[] => {
        if (typeof raw === 'string') return [{ evidenceId: raw }]
        if (raw && typeof raw === 'object' && 'evidenceId' in raw)
          return [{ evidenceId: String((raw as { evidenceId: unknown }).evidenceId) }]
        return []
      })
    }).filter((r) => Boolean(r.evidenceId))

    // ── 5. Evidence sufficiency (deterministic engine) ───────────────────────
    const sufficiency = await scoreFinding(db, caseId, {
      id: `explain-${src.id}-${dst.id}`,
      entitiesJson: JSON.stringify(pathEntityIds),
      supportingEvidence: JSON.stringify(Array.from(citedEvIds)),
      transactionsJson: '[]',
    })

    // Penalty for open contradictions on this connection.
    if (touching.length > 0) {
      const penalty = Math.min(0.4, touching.length * 0.15)
      sufficiency.score = Math.max(0, Math.round(sufficiency.score * (1 - penalty)))
      sufficiency.reasons.push(`${touching.length} open contradiction(s) touched (−${Math.round(penalty * 100)}%)`)
    }
    sufficiency.band =
      sufficiency.score >= 75 ? 'strong'
      : sufficiency.score >= 50 ? 'sufficient'
      : sufficiency.score >= 25 ? 'partial'
      : 'insufficient'

    // Temporal validity across all hops.
    const firstAll = hops.map((h) => h.firstObserved).filter(Boolean).sort()
    const lastAll = hops.map((h) => h.lastObserved).filter(Boolean).sort()

    // Supporting evidence refs for the contract.
    const evidenceRows = citedEvIds.size > 0
      ? await db.evidence.findMany({
          where: { id: { in: Array.from(citedEvIds) }, caseId },
          select: { id: true, originalName: true },
        })
      : []
    const evidenceNameById = new Map(evidenceRows.map((e) => [e.id, e.originalName]))
    // Hop evidence may be sparse (co-occurrence rows carry no direct file
    // refs); when a cited id isn't tied to a specific hop we still cite it as
    // case-grounding provenance rather than dropping it from the contract.
    const hopEvidenceByEv = new Map<string, { locator: string | null; relationTypes: string[] }>()
    for (const h of hops) {
      for (const he of h.evidence) {
        if (!hopEvidenceByEv.has(he.evidenceId))
          hopEvidenceByEv.set(he.evidenceId, { locator: he.locator, relationTypes: h.relationTypes })
      }
    }
    const supportingRefs: ContractEvidenceRef[] = Array.from(citedEvIds).flatMap((evId): ContractEvidenceRef[] => {
      if (!evidenceNameById.has(evId)) return [] // unknown/unscoped id ⇒ flagged via warnings
      const hopMeta = hopEvidenceByEv.get(evId)
      return [{
        evidenceId: evId,
        name: evidenceNameById.get(evId),
        locator: hopMeta?.locator ?? undefined,
        record: hopMeta?.relationTypes.join('/') ?? 'case-entity-evidence',
      }]
    })

    // ── 6. Evidence Contract ─────────────────────────────────────────────────
    const contract = buildContract({
      findingId: `EXPLAIN-${Date.now()}`,
      claim: `${labelOf(src.id)} may be associated with ${labelOf(dst.id)} via ${paths.length} graph path(s)`,
      supporting: supportingRefs,
      contradicting: contradictingRefs,
      paths: paths.map((p) => ({ nodes: p })),
      sufficiency,
      llmConfidence: null,
      temporal: { from: firstAll[0] ?? null, to: lastAll[lastAll.length - 1] ?? null },
      generator: 'deterministic-verifier/explain-connection',
    })
    try {
      assertValidContract(contract)
    } catch (err) {
      contract.warnings.push(err instanceof Error ? err.message : 'contract validation failed')
    }

    // Narrative conclusion — deterministic wording from verified composition.
    const conclusion =
      contract.status === 'corroborated'
        ? 'ASSOCIATION — CORROBORATED'
        : contract.status === 'partial'
          ? 'ASSOCIATION — PARTIALLY SUPPORTED'
          : paths.length > 0
            ? 'POSSIBLE ASSOCIATION — INSUFFICIENTLY CORROBORATED'
            : 'NO GRAPH CONNECTION FOUND'

    let persistedClaimId: string | null = null
    let persistedDecisionUid: string | null = null
    if (body.persist && paths.length > 0) {
      const claim = await db.claim.create({
        data: {
          caseId,
          level: 'claim',
          text: `[Explain Connection] ${contract.claim} — status ${contract.status}, sufficiency ${contract.evidence_sufficiency}`,
          status: contract.status === 'corroborated' ? 'supported' : 'unsupported',
          sourcesJson: JSON.stringify({
            entities: [src.id, dst.id],
            evidence: Array.from(citedEvIds),
            paths,
            contract,
          }),
        },
      })
      persistedClaimId = claim.id
      const decision = await recordDecision(db, {
        caseId,
        action: 'explain_connection',
        objectType: 'claim',
        objectRef: claim.id,
        objectLabel: contract.claim,
        beforeState: null,
        afterState: contract.status,
        reason: `Generated via Explain Connection (${paths.length} paths, ${contract.independent_sources} sources)`,
        actor: body.actor,
        evidence: Array.from(citedEvIds).map((evId) => ({
          evidenceId: evId,
          name: evidenceNameById.get(evId),
        })),
        metadata: { contract },
      })
      persistedDecisionUid = decision?.uid ?? null
    }

    return NextResponse.json({
      src: { id: src.id, type: src.type, label: src.label ?? src.value },
      dst: { id: dst.id, type: dst.type, label: dst.label ?? dst.value },
      connected: paths.length > 0,
      paths: paths.map((p, i) => ({
        nodes: p,
        labels: p.map(labelOf),
        hops: pathHops[i] ?? [],
      })),
      hops,
      contradictions: touching.map((c) => ({
        id: c.id,
        description: c.description,
        status: c.status,
        detector: c.detector,
      })),
      sufficiency: {
        score: sufficiency.score,
        band: sufficiency.band,
        reasons: sufficiency.reasons,
        breakdown: {
          independentSources: sufficiency.independentSources,
          sourceQuality: sufficiency.sourceQuality,
          corroboration: sufficiency.corroboration,
          contradictionPenalty: sufficiency.contradictionPenalty,
          provenance: sufficiency.provenance,
        },
      },
      conclusion,
      contract,
      persistedClaimId,
      persistedDecisionUid,
    })
  } catch (err) {
    console.error('[explain-connection POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'explain-connection failed' },
      { status: 500 },
    )
  }
}
