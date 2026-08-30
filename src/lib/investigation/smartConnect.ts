/**
 * smartConnect.ts — Story-aware, proximity-bounded connection engine.
 *
 * v2.2 replacement for the old "connect EVERY entity pair found in a file"
 * all-pairs mesh, which produced hairball graphs (a 40-phone register became
 * 780 mechanical CO_OCCURRED edges and every node showed "29 neighbors").
 *
 * The engine answers two questions the old loop never asked:
 *
 *   1. ARE these two mentions actually related in the text?
 *      → proximity: two values are co-occurrence-linked only when they appear
 *        within {@link CO_WINDOW} characters of each other (same passage).
 *        Identifier↔identifier pairs (phone-phone, imei-account, …) need to
 *        be REALLY close ({@link ID_PAIR_WINDOW}) because two identifiers far
 *        apart in a register almost never imply a relationship.
 *
 *   2. WHO anchors the story?
 *      → semantic priority: person/organization nodes anchor narratives, so
 *        they get a higher degree budget and win ties. Identifier→identifier
 *        pairs are pruned first when the degree budget runs out, which keeps
 *        star-shaped, human-legible topologies instead of cliques.
 *
 * Everything here is deterministic — no AI calls — so it is unit-testable and
 * safe to run inside ingest paths.
 */

import { normalizeAiRelVerb } from './relVocabulary'

export interface SmartNodeInput {
  entityId: string
  value: string
  type: string
}

export interface SmartPair {
  /** Lower entity id (a < b lexicographically — stable ordering). */
  a: string
  /** Higher entity id. */
  b: string
  /** Minimum distance in chars between ANY mention pair of the two nodes. */
  minDistance: number
  /** 0..1 — 1.0 = adjacent mentions, 0.0 = at the window edge. */
  proximity: number
  /** True when at least one endpoint anchors the story (person/organization). */
  anchored: boolean
}

/**
 * Max chars between two mentions for them to count as "appearing together".
 * Roughly 4-6 lines of text — the same paragraph / table row neighborhood.
 */
export const CO_WINDOW = 420

/**
 * Identifiers (phones, IMEIs, accounts…) far apart in a register do NOT
 * imply a relationship. They must be this close to connect to each other.
 */
export const ID_PAIR_WINDOW = 170

/** Co-occurrence edges one entity may get per file (anchors get 2×). */
export const CO_DEGREE_CAP = 6

/** Types that anchor a story — humans and organizations. */
const ANCHOR_TYPES = new Set(['person', 'organization'])

/**
 * Identifier-ish types. When BOTH endpoints are identifier types the pair
 * must be ultra-close to justify an edge (they are attributes, not actors).
 */
const IDENTIFIER_TYPES = new Set([
  'phone', 'imei', 'account', 'ifsc', 'upi', 'email', 'wallet',
  'mac', 'device', 'vehicle', 'document_id', 'ip', 'url', 'domain',
  'social', 'aadhaar', 'pan', 'passport', 'gstin',
])

/** Find up to `cap` occurrence offsets of `value` inside `text`. */
export function occurrencesOf(text: string, value: string, cap = 24): number[] {
  const v = value?.trim()
  if (!v || v.length < 2) return []
  const out: number[] = []
  const lowerText = text.toLowerCase()
  const push = (needle: string): void => {
    let i = lowerText.indexOf(needle.toLowerCase())
    while (i !== -1 && out.length < cap) {
      out.push(i)
      i = lowerText.indexOf(needle.toLowerCase(), i + needle.length)
    }
  }
  // Exact first (respecting original casing matters little for proximity).
  push(v)
  if (out.length === 0) {
    // Try digit-only variants for formatted identifiers: "+91-99999-10001"
    // → "919999910001", and (when long enough, e.g. country-code prefixed)
    // also the 10-digit local tail "9999910001" — statements frequently list
    // the bare local form while extracts keep the international one.
    const digits = v.replace(/[^0-9a-z]/gi, '')
    if (digits.length >= 4 && digits !== v) {
      push(digits)
      if (out.length === 0 && digits.length > 10) push(digits.slice(-10))
    }
  }
  return out
}

/** Minimum |a-b| across two sorted offset lists (two-pointer, O(len_a+len_b)). */
function minCrossDistance(a: number[], b: number[]): number {
  let i = 0
  let j = 0
  let best = Number.POSITIVE_INFINITY
  while (i < a.length && j < b.length) {
    const d = Math.abs(a[i] - b[j])
    if (d < best) best = d
    if (best === 0) return 0
    if (a[i] < b[j]) i += 1
    else j += 1
  }
  return best
}

/**
 * Build the proximity-bounded co-occurrence pair set for one file.
 *
 * Returns deterministic, score-ranked pairs. Degrees are capped so no node
 * turns into a hairball hub from a single file, anchors (people/orgs) get a
 * 2× budget, and identifier↔identifier pairs only survive when they are
 * genuinely adjacent in the source text.
 */
export function smartCoOccurrencePairs(
  nodes: SmartNodeInput[],
  text: string,
  opts?: { window?: number; idPairWindow?: number; degreeCap?: number },
): SmartPair[] {
  const window = opts?.window ?? CO_WINDOW
  const idWindow = opts?.idPairWindow ?? ID_PAIR_WINDOW
  const cap = opts?.degreeCap ?? CO_DEGREE_CAP
  if (!text || nodes.length < 2) return []

  // Dedupe nodes by id (same entity can be emitted by regex + registry passes)
  // and compute mention offsets once.
  const byId = new Map<string, SmartNodeInput & { positions: number[] }>()
  for (const n of nodes) {
    if (!n?.entityId || byId.has(n.entityId)) continue
    const positions = occurrencesOf(text, n.value ?? '')
    byId.set(n.entityId, { ...n, positions })
  }
  const list = [...byId.values()].filter((n) => n.positions.length > 0)
  if (list.length < 2) return []

  // Candidate pairs with proximity scoring.
  const candidates: SmartPair[] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i]
      const B = list[j]
      const dist = minCrossDistance(A.positions, B.positions)
      if (dist > window) continue
      const aAnchor = ANCHOR_TYPES.has(A.type)
      const bAnchor = ANCHOR_TYPES.has(B.type)
      const bothIdentifiers =
        !aAnchor && !bAnchor &&
        IDENTIFIER_TYPES.has(A.type) && IDENTIFIER_TYPES.has(B.type)
      if (bothIdentifiers && dist > idWindow) continue
      const [a, b] = [A.entityId, B.entityId].sort()
      candidates.push({
        a,
        b,
        minDistance: dist,
        proximity: Math.max(0, 1 - dist / window),
        anchored: aAnchor || bAnchor,
      })
    }
  }

  // Rank: anchored pairs first, then closeness, then stable id order.
  candidates.sort((x, y) =>
    (y.anchored ? 1 : 0) - (x.anchored ? 1 : 0) ||
    y.proximity - x.proximity ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
    (x.b < y.b ? -1 : 1),
  )

  // Degree-capped greedy acceptance — keeps topologies star-shaped.
  const degree = new Map<string, number>()
  const capFor = (type: string): number =>
    (ANCHOR_TYPES.has(type) ? cap * 2 : cap)
  const typeById = new Map(list.map((n) => [n.entityId, n.type]))
  const accepted: SmartPair[] = []
  for (const p of candidates) {
    const aType = typeById.get(p.a) ?? 'other'
    const bType = typeById.get(p.b) ?? 'other'
    const da = degree.get(p.a) ?? 0
    const db = degree.get(p.b) ?? 0
    if (da >= capFor(aType) || db >= capFor(bType)) continue
    degree.set(p.a, da + 1)
    degree.set(p.b, db + 1)
    accepted.push(p)
  }
  return accepted
}

// ─────────────────────────────────────────────────────────────────────────────
// Story-connection persistence (AI scan → typed, rationale-carrying edges)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v3.6 — AI story verbs now flow through the DYNAMIC relationship vocabulary
 * (src/lib/investigation/relVocabulary.ts). This map is kept ONLY as the
 * historical reference of AI snake_case verbs with curated canonical
 * mappings — persistStoryConnections no longer drops unmapped verbs: a
 * well-formed novel verb the AI derived from evidence (e.g.
 * `laundered_money_for`, `supplied_drugs_to`) is sanitized to UPPER_SNAKE and
 * kept as a first-class edge type so the intelligence survives.
 */
export const STORY_REL_MAP: Record<string, string> = {
  communicated_with: 'COMMUNICATED_WITH',
  transferred_money: 'TRANSFERRED_TO',
  associated_with: 'ASSOCIATED_WITH',
  located_at: 'LOCATED_AT',
  owns_account: 'CONTROLS_ACCOUNT',
  worked_for: 'WORKS_FOR',
  director_of: 'DIRECTOR_OF',
  traveled_with: 'TRAVELED_WITH',
  called: 'CALLED',
  used_vehicle: 'USED_VEHICLE',
  registered_at: 'REGISTERED_AT',
  same_identity: 'SHARED_IDENTIFIER',
  accessed_by: 'ACCESSED_BY',
  connected_to: 'CONNECTED_TO',
  owns: 'OWNS',
  uses: 'USES',
  affiliated_with: 'AFFILIATED_WITH',
  studied_at: 'STUDIED_AT',
  identified_by: 'IDENTIFIED_BY',
  issued_by: 'ISSUED_BY',
  signed_by: 'SIGNED_BY',
  authorized_by: 'AUTHORIZED_BY',
  employs: 'EMPLOYS',
  member_of: 'MEMBER_OF',
  related_to: 'RELATED_TO',
  recommends: 'RECOMMENDS',
  mentioned_in: 'MENTIONED_IN',
}

/**
 * Persist AI-story connections as typed edges with a human-readable
 * "why" (stored in metadataJson.rationale — the edge panel and graph API
 * surface it as the connection's explanation).
 *
 * `valueToEntityId` maps entity values (plus norms) to graph ids for THIS
 * evidence; unresolved endpoints are fuzzy-matched case-insensitively and
 * skipped rather than invented — a story edge must reference real nodes.
 */
export async function persistStoryConnections(
  db: import('@prisma/client').PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  connections: Array<{ from?: unknown; to?: unknown; rel?: unknown; why?: unknown; confidence?: unknown }>,
  valueToEntityId: Map<string, string>,
): Promise<{ created: number; skipped: number }> {
  let created = 0
  let skipped = 0
  // v3.6 dynamic vocabulary: known AI verbs map to canonical types;
  // novel well-formed verbs (evidence-specific, e.g. laundered_money_for)
  // are KEPT as first-class edge types. Only garbage is skipped.
  const novelRels = new Set<string>()

  const lookup = (raw: unknown): string | null => {
    const v = String(raw ?? '').trim()
    if (!v) return null
    const direct = valueToEntityId.get(v) ?? valueToEntityId.get(v.toLowerCase())
    if (direct) return direct
    const clean = v.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (clean && valueToEntityId.has(clean)) return valueToEntityId.get(clean)!
    // Case-insensitive prefix/suffix containment — handles verbatim drift.
    for (const [k, id] of valueToEntityId.entries()) {
      const kc = k.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (kc.length >= 4 && (kc.includes(clean) || clean.includes(kc))) return id
    }
    return null
  }

  const existing = await db.relationship.findMany({
    where: { caseId },
    select: { srcId: true, dstId: true, type: true },
    take: 8000,
  })
  const edgeSet = new Set(existing.map((e) => `${e.srcId}|${e.dstId}|${e.type}`))

  // Dense forensic documents legitimately produce 100+ story connections
  // (every identifier attaches to its owner). The scan-level pipeline caps
  // at 150; the old 24-cap silently dropped most of a dense extraction's
  // wiring, leaving "entities that couldn't be connected".
  for (const c of connections.slice(0, 150)) {
    const relNorm = normalizeAiRelVerb(String(c.rel ?? ''))
    // Reverse-direction verbs (received_from, paid_by, …): flip endpoints so
    // the canonical arrow reads correctly while preserving the AI's meaning.
    let fromRaw = c.from
    let toRaw = c.to
    if (relNorm.reversed) {
      fromRaw = c.to
      toRaw = c.from
    }
    const relType = relNorm.type
    if (relNorm.novel) novelRels.add(relType)
    if (!relType) { skipped += 1; continue }
    const srcId = lookup(fromRaw)
    const dstId = lookup(toRaw)
    const why = String(c.why ?? '').slice(0, 300)
    const evidence = String((c as { evidence?: string }).evidence ?? '').trim().slice(0, 400)
    const conf = typeof c.confidence === 'number' ? Math.min(1, Math.max(0.1, c.confidence)) : 0.7
    if (!srcId || !dstId || srcId === dstId) { skipped += 1; continue }
    // PRESERVE the AI's direction (from → to). Verbs like EMPLOYS, ISSUED_BY,
    // RECOMMENDS, IDENTIFIED_BY are directional — sorting the endpoints used
    // to scramble them into meaningless arrows.
    const dirKey = `${srcId}|${dstId}|${relType}`
    const revKey = `${dstId}|${srcId}|${relType}`
    if (edgeSet.has(dirKey) || edgeSet.has(revKey)) { skipped += 1; continue }
    try {
      await db.relationship.upsert({
        where: {
          caseId_srcId_dstId_type: { caseId, srcId, dstId, type: relType },
        },
        update: { weight: { increment: 1 } },
        create: {
          caseId,
          srcId,
          dstId,
          type: relType,
          weight: 1,
          confidence: conf,
          evidenceRef: evidenceName,
          evidenceId,
          provenance: 'ai-story',
          extractionMethod: 'ai',
          metadataJson: JSON.stringify({
            rationale: why,
            ...(evidence ? { evidence } : {}), // v3.8 gate-verified proof quote
            story: true,
            // v3.6: preserve the AI's original verb so novel relationship
            // types stay traceable to the model's exact wording.
            ...(relNorm.raw && relNorm.raw !== relType ? { rawRel: relNorm.raw } : {}),
            ...(relNorm.novel ? { novelRel: true } : {}),
          }),
        },
      })
      edgeSet.add(dirKey)
      created += 1
    } catch (err) {
      console.error('[smartConnect] story edge failed:', err)
      skipped += 1
    }
  }
  if (novelRels.size > 0) {
    console.warn(`[smartConnect] kept ${novelRels.size} novel evidence-derived relationship type(s): ${[...novelRels].join(', ')}`)
  }
  return { created, skipped }
}
