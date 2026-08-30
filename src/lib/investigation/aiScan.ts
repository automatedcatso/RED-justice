/**
 * aiScan.ts — the evidence scan engine (v3.2 TURBO HYBRID).
 *
 * ONE function, `runAiScanForEvidence`, is the single authority that turns an
 * uploaded evidence file into knowledge-graph content. It is used by BOTH:
 *   - the automatic post-upload trigger (`queueAiScan` — fired by the upload
 *     and paste-text routes, so analysis ALWAYS runs without a click), and
 *   - the manual POST /evidence/[evid]/scan route (re-scan / retry).
 *
 * v3.2 HYBRID CONTRACT (user mandate: "scan entities deterministically, then
 * let the AI double-check and add what's missing"):
 *
 *   PHASE A — deterministic base (instant, pure code, no AI):
 *     The regex/registry extractor layer (extractors/) wires entities into the
 *     graph the moment a file lands: phones, accounts, UPIs, IDs, persons,
 *     organizations… plus RECORD edges derived from structured rows
 *     (chat/CDR sender→receiver COMMUNICATED_WITH, bank-statement
 *     sender→receiver TRANSFERRED_TO) and registry relationship rows. The
 *     investigator sees entities in SECONDS, before any model call runs.
 *
 *   PHASE B — AI enrichment (the "double check"):
 *     The model receives the document PLUS a manifest of everything the
 *     deterministic layer already extracted, and outputs ONLY what regex
 *     cannot see: entities the manifest missed, story connections between
 *     entities, and a compact digest. Because it never re-emits the manifest
 *     (re-emitting hundreds of entities dominated scan wall-time on CPU-class
 *     hardware — a 23-minute qwen3:4b scan was ~90% output tokens for values
 *     regex already had), output shrinks 5-10× and the scan completes in a
 *     fraction of the time with the SAME (or better) end-state graph.
 *     There is deliberately NO reduce call — chunk outputs merge in code.
 *
 *   If the AI is unreachable the deterministic graph SURVIVES (aiScanStatus
 *   = 'failed' with the error so the UI can offer a retry; the graph keeps
 *   every deterministic entity and record edge).
 *
 *   Scan modes (RJ_SCAN_MODE): 'hybrid' (default — phases A+B),
 *   'deterministic-only' (phase A alone — zero AI calls), 'ai-only'
 *   (legacy v3.1 behaviour — AI re-extracts everything, no manifest).
 *
 *   Every connection carries a "why" (metadataJson.rationale) and is
 *   explainable on click via /links/explain.
 *
 * Mid-scan resilience: if the evidence row is deleted WHILE a scan is running
 * (the 23-minute scans of v3.1 made this common — investigators deleted the
 * "stuck" file and re-uploaded), every subsequent update used to crash with
 * Prisma P2025 "No record was found for an update". The engine now detects
 * the missing record, aborts quietly and logs an informational line.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

import {
  AI_CONTEXTUAL_TYPES,
  AI_TYPE_MAP,
  CANON_GRAPH_TYPES,
  CHUNK_SYSTEM_PROMPT,
  FAST_NER_CHUNK_SYSTEM_PROMPT,
  FAST_RECHECK_CHUNK_SYSTEM_PROMPT,
  KNOWN_ENTITIES_HEADER,
  MAKER_EVIDENCE_RULE,
  MAKER_ROLLING_HEADER,
  RECHECK_SYSTEM_PROMPT,
  SCAN_SYSTEM_PROMPT,
  RELATIONSHIP_MAKER_SYSTEM_PROMPT,
  TURBO_CHUNK_SYSTEM_PROMPT,
  dedupeEntities,
  guessEntityType,
  knownEntitiesSection,
  planChunks,
  planChunksOverlapped,
  planChunksTokenBudget,
  strArrayOf,
  stripValueLabelPrefix,
  unionStrings,
  type ScanEntity,
  type ScanResult,
  type ScanStory,
  type ScanStoryConnection,
} from './aiScanPrompts'
import { persistStoryConnections } from './smartConnect'
import { evidenceRel, normalizeRelVerb } from './relVocabulary'
import type { CrossLinkSummary } from './crossConnect'
import { extractJsonObject } from '@/lib/aiJson'
import { isWrappedRowGlue, normalizeEntity } from '@/lib/extractors/normalizers'
import type { EntityType } from '@/lib/extractors/types'
import {
  getTierAssignment,
  tierContextBudget,
  dynamicEntityCap,
  type ModelTier,
  type TierUsage,
  emptyTierUsage,
} from '@/lib/modelTiers'
import { charBudgetForTokens } from '@/lib/tokenEstimator'

/** Relationship provenances that were created MECHANICALLY (not by AI). */
export const MECHANICAL_PROVENANCES = [
  'level0-co-occurrence',
  'ai-scan-cooccurrence',
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Scan mode + mid-scan deletion resilience
// ─────────────────────────────────────────────────────────────────────────────

export type ScanMode = 'hybrid' | 'ai-only' | 'deterministic-only'

/**
 * RJ_SCAN_MODE selects the engine:
 *   hybrid (default)      — deterministic base + AI enrichment (fast + smart)
 *   deterministic-only    — pure regex/registry, zero AI calls
 *   ai-only               — legacy v3.1 full-AI re-extraction (no manifest)
 */
export function getScanMode(): ScanMode {
  const v = (process.env.RJ_SCAN_MODE ?? 'hybrid').trim().toLowerCase()
  if (v === 'ai-only' || v === 'ai_only' || v === 'aionly' || v === 'legacy') return 'ai-only'
  if (v === 'deterministic-only' || v === 'deterministic' || v === 'det-only' || v === 'regex-only' || v === 'offline') {
    return 'deterministic-only'
  }
  return 'hybrid'
}

/** Prisma P2025-style "record vanished mid-operation" detector. */
export function isRecordGoneError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /P2025|No record was found|required but not found|Record to update not found/i.test(msg)
}

/** Thrown when the evidence row disappears while its scan is in flight. */
class EvidenceDeletedError extends Error {
  constructor(evidenceName: string) {
    super(`evidence "${evidenceName}" was deleted while its scan was running`)
    this.name = 'EvidenceDeletedError'
  }
}

/**
 * evidence.update that returns false instead of crashing when the row is gone
 * (deleted mid-scan). Other errors propagate.
 */
async function updateEvidenceSafe(
  db: PrismaClient,
  id: string,
  data: Prisma.EvidenceUpdateInput,
): Promise<boolean> {
  try {
    await db.evidence.update({ where: { id }, data })
    return true
  } catch (err) {
    if (isRecordGoneError(err)) return false
    throw err
  }
}

/** One verbatim table row snapshot stored on a relationship (for the edge
 *  provenance panel + investigation timeline). Kept compact: IDs, state,
 *  method, evidence refs and the raw row itself. */
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

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Extract accumulated table-row snapshots from a relationship's metadata. */
export function tableRowsFromMeta(meta: Record<string, unknown>): TableRowSnapshot[] {
  const rows = meta.rows
  return Array.isArray(rows) ? (rows as TableRowSnapshot[]) : []
}

/** Collect source-table IDs from entity metadata (merged across scans). */
export function tableIdsFromMeta(meta: Record<string, unknown>): string[] {
  const ids = meta.tableIds
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Cap on deterministic entities wired per file — v3.8: DYNAMIC, scaled by
 * document size (see dynamicEntityCap in modelTiers.ts). The old fixed cap
 * (800 → 4000) silently truncated monster registers: a 6,374-entity bank
 * trail lost 87% of its nodes at the 800 cap. The allowance now GROWS with
 * the document (≈1 entity per 40 chars of dense registry), so nothing the
 * extractors actually found is discarded; only a pathological 250K ceiling
 * remains as a memory guard.
 */
function maxDeterministicEntities(contentChars = 0): number {
  return dynamicEntityCap(contentChars)
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity → graph wiring (shared by the deterministic base and AI passes)
// ─────────────────────────────────────────────────────────────────────────────

interface WiredEntity {
  inputIndex: number
  entityId: string
  value: string
}

interface WireResult {
  linked: number
  relationships: number
  storyLinks: number
  resolved: WiredEntity[]
  /** "type::norm" → entityId (used to resolve registry relationship rows). */
  keyToEntityId: Map<string, string>
}

/**
 * Wire a list of {type, value, context, confidence} entities into the graph.
 * Used by BOTH the deterministic base (source='deterministic-extract') and
 * the AI passes (source='ai-scan'). Idempotent: re-wiring the same value
 * upserts onto the existing node instead of duplicating it.
 */
async function wireEntitiesIntoGraph(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  entities: Array<Record<string, unknown>>,
  maxEntities: number,
  opts?: { source?: string; defaultConfidence?: number },
): Promise<WireResult> {
  const source = opts?.source ?? 'ai-scan'
  const defaultConfidence = opts?.defaultConfidence ?? 0.75
  const linkedIds: string[] = []
  const resolved: WiredEntity[] = []
  const keyToEntityId = new Map<string, string>()
  let linked = 0

  // v3.9 (master prompt §5): there is NO artificial entity-count limit —
  // every extracted entity persists; entity count is a quality-gated outcome.
  // `maxEntities` survives only as the pathological memory guard (250K-class
  // regex-bomb protection) and can never bind a real document.
  const hardGuard = maxEntities > 0 ? maxEntities : Number.MAX_SAFE_INTEGER

  for (let i = 0; i < entities.length && linked < hardGuard; i++) {
    const ent = entities[i] as { type?: unknown; value?: unknown; context?: unknown; confidence?: unknown; status?: unknown }
    try {
      // Normalize the label: spaces/hyphens → underscores so variants like
      // "Account Number" / "account-number" / "account_number" all resolve.
      const aiTypeRaw = String(ent?.type ?? '').toLowerCase().trim()
      const aiType = aiTypeRaw.replace(/[\s-]+/g, '_')
      let value = String(ent?.value ?? '').trim()
      if (!value || value.length < 2) continue
      // v3.9.1 property-cell guard: a bare 'k=v' attribute cell
      // ('status=watchlist') is a row property, never a graph node — no matter
      // which stage emitted it.
      if (/^[a-z][a-z0-9_ -]{1,23}==?.{1,60}$/i.test(value)) continue
      // v3.10 wrapped-row guard: multi-cell CSV glue
      // ("ORG-001,ORGANIZATION,Asterion Logistics Pvt Ltd") is a flattened
      // table row, never one entity.
      if (isWrappedRowGlue(value)) continue
      if (AI_CONTEXTUAL_TYPES.has(aiType)) continue
      value = stripValueLabelPrefix(value)
      if (value.length < 2) continue
      let type = AI_TYPE_MAP[aiType]
      if (!type) {
        // Tolerant resolution: try suffix-normalized labels, then structural
        // guessing from the VALUE itself. Never silently drop an entity just
        // because its label was unfamiliar.
        const suffixTrimmed = aiType.replace(
          /_(number|no|id|ids|value|detail|details|info|label|text)$/, '',
        )
        type = AI_TYPE_MAP[suffixTrimmed]
        if (!type && CANON_GRAPH_TYPES.has(aiType)) type = aiType
        if (!type) {
          type = guessEntityType(value)
          console.warn(`[aiScan] unmapped entity type "${aiTypeRaw}" → guessed "${type}" for "${value.slice(0, 40)}"`)
        }
      }
      // v3.9 reconciliation gate: the MERGE COURT is the gate — it stamps
      // sweep entities confirmed/candidate from sighting/corroboration
      // evidence. Entities arriving here WITHOUT a court status already
      // passed their own upstream gate (deterministic = checksum/domain
      // validated; legacy enrichment = tier-model structured output), so
      // they default to confirmed — gating them again here would silently
      // hide established graph nodes (and their edges) for no new evidence.
      const status =
        ent?.status === 'candidate' || ent?.status === 'confirmed'
          ? ent.status
          : 'confirmed'
      // Use THE SAME normalizers as the rest of the system so identical
      // values merge into one graph node instead of duplicating families.
      const adhoc = value.toLowerCase().replace(/[^a-z0-9@.+_-]/g, '').slice(0, 80)
      const canonical = normalizeEntity(type as EntityType, value)
      const normCandidates = Array.from(
        new Set(
          [canonical, canonical?.toLowerCase(), adhoc].filter(
            (n): n is string => !!n && n.length >= 2,
          ),
        ),
      ).slice(0, 3)
      if (normCandidates.length === 0) continue
      const norm = normCandidates[0]

      // Match an existing entity with any candidate norm — prefer the same
      // type, otherwise reuse whatever exists (prevents duplicate nodes).
      const candidates = await db.entity.findMany({
        where: { caseId, norm: { in: normCandidates } },
        select: { id: true, type: true, norm: true, metadataJson: true, status: true },
        take: 6,
      })
      let entity = candidates.find((c) => c.type === type) ?? candidates[0]
      // v3.5: the source table's own IDs (E0001 …) ride on the entity so the
      // UI can trace every node back to the export row verbatim. Merged into
      // existing metadata so re-scans and multi-file aliases accumulate.
      const incomingIds = Array.isArray((ent as { tableIds?: unknown }).tableIds)
        ? ((ent as { tableIds?: unknown }).tableIds as unknown[]).filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          ).slice(0, 12)
        : []
      if (!entity) {
        entity = await db.entity.create({
          data: {
            caseId,
            type,
            value: value.slice(0, 120),
            norm,
            label: value.slice(0, 60),
            status,
            confidence: typeof ent?.confidence === 'number' && ent.confidence > 0 && ent.confidence <= 1
              ? ent.confidence
              : defaultConfidence,
            metadataJson: JSON.stringify({
              source,
              context: String(ent?.context ?? '').slice(0, 300),
              ...(status === 'candidate' ? { candidateReason: 'below confirmation threshold — kept for review' } : {}),
              ...(incomingIds.length > 0 ? { tableIds: incomingIds } : {}),
            }),
          },
          select: { id: true, type: true, norm: true, metadataJson: true, status: true },
        })
      } else {
        // v3.9 PROMOTION: a later confirmed sighting (corroboration across
        // files/chunks, or a deterministic re-find) lifts an existing
        // candidate to confirmed. Candidates are never deleted, and a
        // confirmed entity is never demoted.
        const meta = parseMeta(entity.metadataJson)
        const promote = status === 'confirmed' && entity.status === 'candidate'
        const existing = tableIdsFromMeta(meta)
        const mergedIds = [...new Set([...existing, ...incomingIds])].slice(0, 12)
        if (promote || mergedIds.length !== existing.length) {
          try {
            await db.entity.update({
              where: { id: entity.id },
              data: {
                ...(promote ? { status: 'confirmed' } : {}),
                ...(mergedIds.length !== existing.length
                  ? { metadataJson: JSON.stringify({ ...meta, ...(mergedIds.length > 0 ? { tableIds: mergedIds } : {}) }) }
                  : {}),
              },
            })
          } catch (err) {
            if (!isRecordGoneError(err)) throw err
          }
        }
      }

      await db.entityLink.upsert({
        where: { entityId_evidenceId: { entityId: entity.id, evidenceId } },
        update: {},
        create: { entityId: entity.id, evidenceId },
      })

      resolved.push({ inputIndex: i, entityId: entity.id, value: value.slice(0, 120) })
      for (const cand of normCandidates) {
        const k = `${type}::${cand}`
        if (!keyToEntityId.has(k)) keyToEntityId.set(k, entity.id)
        // v3.9.2: ALSO key under the ORIGINAL input type when the graph maps
        // it to a different canonical type (address→location, mac→device).
        // Registry relationship rows key endpoints by the registry's OWN row
        // type ("address::415stationroadpune") — without the alias the join
        // silently drops every address-target edge (25/25 REGISTERED_AT gone).
        if (aiType && aiType !== type) {
          const orig = `${aiType}::${cand}`
          if (!keyToEntityId.has(orig)) keyToEntityId.set(orig, entity.id)
        }
      }
      if (!linkedIds.includes(entity.id)) {
        linkedIds.push(entity.id)
        linked += 1
      }
    } catch (err) {
      console.error('[aiScan] entity wiring failed:', err)
    }
  }

  void caseId
  let relationships = 0
  let storyLinks = 0
  return { linked, relationships, storyLinks, resolved, keyToEntityId }
}

/**
 * Persist AI story connections for a scan — thin wrapper over
 * persistStoryConnections kept here so the engine owns all graph mutation.
 */
async function wireStoryConnections(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  storyConnections: ScanStoryConnection[],
  resolved: WiredEntity[],
  rawEntities: Array<Record<string, unknown>>,
): Promise<{ created: number; skipped: number }> {
  if (storyConnections.length === 0) return { created: 0, skipped: 0 }
  const valueToEntityId = buildValueToEntityId(resolved)
  // Also index the raw values that were filtered/renamed during wiring so
  // story endpoints written slightly differently still resolve.
  for (let i = 0; i < rawEntities.length; i++) {
    const rawVal = String((rawEntities[i] as { value?: unknown })?.value ?? '').trim()
    const hit = resolved.find((r) => r.inputIndex === i)
    if (rawVal && hit) {
      if (!valueToEntityId.has(rawVal)) valueToEntityId.set(rawVal, hit.entityId)
      const clean = rawVal.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (clean && !valueToEntityId.has(clean)) valueToEntityId.set(clean, hit.entityId)
    }
  }
  return persistStoryConnections(
    db, caseId, evidenceId, evidenceName, storyConnections, valueToEntityId,
  )
}

/** value → entityId lookup map (value, lowercase, alphanumeric-only). */
function buildValueToEntityId(resolved: WiredEntity[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of resolved) {
    const variants = [
      r.value,
      r.value.toLowerCase(),
      r.value.toLowerCase().replace(/[^a-z0-9]/g, ''),
    ]
    for (const v of variants) {
      if (v && v.length >= 2 && !m.has(v)) m.set(v, r.entityId)
    }
  }
  return m
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic record edges — structured rows → typed graph edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v3.6 — registry verbs are validated through the DYNAMIC relationship
 * vocabulary (relVocabulary.ts). Known verbs pass (and map to canonical
 * types); NOVEL well-formed verbs from annexure/registry tables are KEPT as
 * first-class edge types instead of being dropped. The old hardcoded
 * allow-list lost evidence whenever a registry used a verb outside it.
 */
function registryRelOk(rel: string): boolean {
  const n = normalizeRelVerb(rel)
  // Accept when the verb normalizes to something meaningful — i.e. the raw
  // verb was non-empty (garbage/blank falls back to ASSOCIATED_WITH, which
  // we still accept only when the raw verb had actual content).
  return n.raw.length > 0
}

interface DeterministicEdge {
  from: string
  to: string
  rel: string
  why: string
  confidence: number
  amount?: number
  timestamp?: string
  locator?: string
  /** Pre-resolved endpoints (registry rows) — bypass value lookup when set. */
  srcId?: string
  dstId?: string
  /** v3.5 full-fidelity table-row fields (deterministic-reltable). */
  rowId?: string
  srcTableId?: string
  tgtTableId?: string
  state?: string
  method?: string
  evidenceRefs?: string[]
  /** The COMPLETE verbatim source row (header → cell). */
  row?: Record<string, string>
}

/**
 * Upsert deterministic edges (registry rows, comm records, txn records,
 * relationship-table rows) with provenance 'deterministic-record' /
 * 'deterministic-registry' / 'deterministic-reltable'.
 *
 * Idempotent — re-scans increment weights instead of duplicating.
 *
 * v3.5 FULL-FIDELITY MODE (mergeRows, relationship tables): the export's rows
 * ARE the evidence, so nothing may be dropped. When the same (src, dst, rel)
 * pair is asserted by MULTIPLE table rows (e.g. three TRANSFERRED_TO records
 * between the same accounts on different dates — structuring patterns), the
 * edge is kept ONCE with weight = number of asserting rows and every verbatim
 * row snapshot accumulated in metadataJson.rows for the provenance panel and
 * the timeline.
 */
async function wireDeterministicEdges(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  edges: DeterministicEdge[],
  valueToEntityId: Map<string, string>,
  provenance: 'deterministic-record' | 'deterministic-registry' | 'deterministic-reltable',
  maxEdges = 400,
  opts?: { mergeRows?: boolean },
): Promise<{ created: number; merged: number }> {
  const mergeRows = opts?.mergeRows ?? false
  let created = 0
  let merged = 0
  const existing = await db.relationship.findMany({
    where: { caseId },
    // v3.6: id + weight are needed in BOTH modes — repeated record rows now
    // increment the existing edge's weight instead of being dropped.
    select: mergeRows
      ? { id: true, srcId: true, dstId: true, type: true, weight: true, timestamp: true, metadataJson: true }
      : { id: true, srcId: true, dstId: true, type: true },
    take: 8000,
  })
  const edgeSet = new Set(existing.map((e) => `${e.srcId}|${e.dstId}|${e.type}`))
  // mergeRows mode: key → full row (for weight/rows accumulation). In
  // non-merge mode a lighter map (id only) still serves weight increments.
  const existingByKey = new Map<string, { id: string; weight: number; timestamp: string | null; meta: Record<string, unknown> }>()
  if (mergeRows) {
    for (const e of existing as Array<{ id: string; srcId: string; dstId: string; type: string; weight: number; timestamp: string | null; metadataJson: string | null }>) {
      existingByKey.set(`${e.srcId}|${e.dstId}|${e.type}`, {
        id: e.id,
        weight: e.weight ?? 1,
        timestamp: e.timestamp,
        meta: parseMeta(e.metadataJson),
      })
    }
  } else {
    for (const e of existing as Array<{ id: string; srcId: string; dstId: string; type: string }>) {
      const k = `${e.srcId}|${e.dstId}|${e.type}`
      if (!existingByKey.has(k)) existingByKey.set(k, { id: e.id, weight: 1, timestamp: null, meta: {} })
    }
  }

  const lookup = (raw: string): string | null => {
    const v = String(raw ?? '').trim()
    if (!v) return null
    const direct = valueToEntityId.get(v) ?? valueToEntityId.get(v.toLowerCase())
    if (direct) return direct
    const clean = v.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (clean && valueToEntityId.has(clean)) return valueToEntityId.get(clean)!
    // Case-insensitive containment — handles masked/prefixed account drift.
    // v3.6 fix: the old rule matched ANY ≥4-char digit containment, which
    // mis-wired unrelated numbers ("12345" ⊂ "1234567890"). Containment is
    // now allowed only when the shorter side is ≥8 chars (a real masked
    // account tail) or the lengths are within 25% of each other.
    if (clean.length >= 4) {
      for (const [k, id] of valueToEntityId.entries()) {
        const kc = k.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (kc.length < 4) continue
        if (kc.includes(clean) || clean.includes(kc)) {
          const minLen = Math.min(kc.length, clean.length)
          const maxLen = Math.max(kc.length, clean.length)
          if (minLen >= 8 || minLen / maxLen >= 0.75) return id
        }
      }
    }
    return null
  }

  /** Row snapshot for metadataJson.rows (compact — no undefined keys). */
  const snapshotFor = (e: DeterministicEdge): TableRowSnapshot => ({
    ...(e.rowId ? { rowId: e.rowId } : {}),
    ...(e.srcTableId ? { srcTableId: e.srcTableId } : {}),
    ...(e.tgtTableId ? { tgtTableId: e.tgtTableId } : {}),
    ...(e.state ? { state: e.state } : {}),
    ...(e.method ? { method: e.method } : {}),
    ...(e.evidenceRefs && e.evidenceRefs.length > 0 ? { evidenceRefs: e.evidenceRefs } : {}),
    ...(e.timestamp ? { timestamp: e.timestamp } : {}),
    ...(e.row ? { row: e.row } : {}),
  })

  for (const e of edges.slice(0, maxEdges)) {
    try {
      const srcId = e.srcId ?? lookup(e.from)
      const dstId = e.dstId ?? lookup(e.to)
      if (!srcId || !dstId || srcId === dstId) continue
      const key = `${srcId}|${dstId}|${e.rel}`
      const revKey = `${dstId}|${srcId}|${e.rel}`

      if (mergeRows) {
        // Full-fidelity mode: NEVER drop an asserting row — accumulate.
        // v3.10: DIRECTION-SENSITIVE — the reverse key no longer folds.
        // Reciprocal rows ("A CONNECTED_TO B" AND "B CONNECTED_TO A") are
        // DISTINCT assertions with their own evidence; folding them onto one
        // edge silently re-oriented half of them (and for directed verbs
        // like TRANSFERRED_TO/RELAYS_TO a reverse fold LOSES the direction
        // the row stated). Identical (src,dst,type) triples still merge by
        // weight with full row snapshots.
        const hit = existingByKey.get(key)
        if (hit) {
          const rows = tableRowsFromMeta(hit.meta)
          const snap = snapshotFor(e)
          const already = snap.rowId && rows.some((r) => r.rowId === snap.rowId)
          if (!already) {
            const nextRows = [...rows, snap].slice(-200)
            const nextTs =
              hit.timestamp && hit.timestamp < (e.timestamp ?? hit.timestamp)
                ? hit.timestamp
                : (e.timestamp ?? hit.timestamp)
            try {
              await db.relationship.update({
                where: { id: hit.id },
                data: {
                  weight: hit.weight + 1,
                  ...(nextTs ? { timestamp: nextTs } : {}),
                  metadataJson: JSON.stringify({
                    ...hit.meta,
                    rationale: e.why,
                    deterministic: true,
                    tableRowIds: nextRows.map((r) => r.rowId).filter(Boolean),
                    rows: nextRows,
                  }),
                },
              })
              hit.weight += 1
              hit.meta = { ...hit.meta, rows: nextRows }
              merged += 1
            } catch (err) {
              if (isRecordGoneError(err)) continue
              throw err
            }
          }
          continue
        }
        const snap = snapshotFor(e)
        const createdEdge = await db.relationship.create({
          data: {
            caseId,
            srcId,
            dstId,
            type: e.rel,
            weight: 1,
            confidence: e.confidence,
            amount: e.amount ?? null,
            timestamp: e.timestamp ?? null,
            evidenceRef: evidenceName,
            evidenceId,
            locator: e.locator ?? null,
            provenance,
            extractionMethod: e.method ?? 'deterministic',
            metadataJson: JSON.stringify({
              rationale: e.why,
              deterministic: true,
              ...(Object.keys(snap).length > 1
                ? { tableRowIds: snap.rowId ? [snap.rowId] : [], rows: [snap] }
                : {}),
            }),
          },
          select: { id: true },
        })
        existingByKey.set(key, {
          id: createdEdge.id,
          weight: 1,
          timestamp: e.timestamp ?? null,
          meta: { rows: [snap] },
        })
        edgeSet.add(key)
        created += 1
        continue
      }

      // v3.6: repeated record rows (a second call between the same numbers, a
      // second transfer between the same accounts) previously DROPPED here —
      // the call volume / structuring pattern was lost. They now increment
      // the existing edge's weight (same direction) or the reversed edge's
      // weight (bidirectional call pair), so volume survives as weight.
      if (edgeSet.has(key) || edgeSet.has(revKey)) {
        try {
          const existingId = existingByKey.get(key)?.id ?? existingByKey.get(revKey)?.id
          if (existingId) {
            await db.relationship.update({
              where: { id: existingId },
              data: { weight: { increment: 1 } },
            })
            merged += 1
          } else {
            // Edge predates this scan (loaded into edgeSet only) — best-effort
            // weight bump, trying BOTH directions (a reversed call pair must
            // increment the stored edge whichever way it is stored).
            const dir = (await db.relationship.findFirst({
              where: { caseId, srcId, dstId, type: e.rel },
              select: { id: true },
            })) ?? (await db.relationship.findFirst({
              where: { caseId, srcId: dstId, dstId: srcId, type: e.rel },
              select: { id: true },
            }))
            if (dir) {
              await db.relationship.update({ where: { id: dir.id }, data: { weight: { increment: 1 } } })
              merged += 1
            }
          }
        } catch {
          /* non-fatal — weight bump only */
        }
        continue
      }
      const createdEdgeRow = await db.relationship.create({
        data: {
          caseId,
          srcId,
          dstId,
          type: e.rel,
          weight: 1,
          confidence: e.confidence,
          amount: e.amount ?? null,
          timestamp: e.timestamp ?? null,
          evidenceRef: evidenceName,
          evidenceId,
          locator: e.locator ?? null,
          provenance,
          extractionMethod: 'deterministic',
          metadataJson: JSON.stringify({ rationale: e.why, deterministic: true }),
        },
        select: { id: true },
      })
      edgeSet.add(key)
      // v3.6: remember the created edge so a REPEATED row later in this same
      // scan (or a reversed-direction duplicate) increments its weight
      // instead of being dropped.
      existingByKey.set(key, { id: createdEdgeRow.id, weight: 1, timestamp: e.timestamp ?? null, meta: {} })
      created += 1
    } catch (err) {
      console.error('[aiScan] deterministic edge failed:', err)
    }
  }
  return { created, merged }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE A — the deterministic base
// ─────────────────────────────────────────────────────────────────────────────

/** Compact rel-table summary handed to the AI enrichment pass. */
interface RelTableSummary {
  coverage: number
  digest: string
  edgeCount: number
  nonTableText: string
  /** "WORKS_FOR ×55, USES ×70, …" — for the record-edge exclusion note. */
  relMix: string
}

interface DeterministicBase {
  entities: ScanEntity[]
  resolved: WiredEntity[]
  linked: number
  recordEdges: number
  registryEdges: number
  /** v3.4: edges read directly from a delimited relationship table. */
  tableEdges: number
  /** v3.5: timeline events created from the table's dated rows. */
  tableTimelineEvents: number
  relTable: RelTableSummary | null
  /** v3.10: entity-register table stats (typed inventories), when detected. */
  entityTable: { entities: number; rows: number } | null
  classification: {
    classification: string
    confidence: number
    source: string
    signals?: string[]
  }
  /**
   * v3.9.1 — registry row-references and attribute values ('E0031', 'active',
   * 'Jio', 'Nashik'…) that the AI sweep keeps mistaking for entities. The
   * sweep filters its Pass-2/Pass-3 output against this set; deterministic
   * entities are NEVER affected.
   */
  aiNoiseTokens: Set<string>
}

/** Extractor types that map onto different canonical graph types. */
const DET_TYPE_MAP: Record<string, string> = {
  address: 'location',
  mac: 'device',
}

/**
 * The instant layer: relationship-table rows (v3.4) + registry rows + flat
 * regex entities wired into the graph, plus record-derived edges
 * (chat/CDR COMMUNICATED_WITH, bank TRANSFERRED_TO, table WORKS_FOR/USES/…)
 * and registry relationship rows. Pure code — completes in milliseconds.
 */
async function runDeterministicBase(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidence: { originalName: string; mime: string | null },
  content: string,
): Promise<DeterministicBase> {
  const { extractEntities, extractRegistry, extractTransactions, extractCommunications, extractRelationshipTable, extractEntityTable } =
    await import('@/lib/extractors')
  const { classifyDeterministic } = await import('@/lib/extractors/classify')

  // 1. Relationship-table pass FIRST — a delimited edge list states its
  //    entities and relationships literally, so its explicit type labels are
  //    AUTHORITATIVE (regex results must never create a second, differently-
  //    typed node for a value the table already typed).
  const relTable = extractRelationshipTable(content)

  // 1b. v3.10 — ENTITY-REGISTER pass: delimited inventories that state typed
  //     entities literally (`entity_id,…,name,…,type`). Their type labels are
  //     equally authoritative; their row ids become cross-file reference
  //     tokens (tableIds) the stitcher joins across documents.
  const entTable = extractEntityTable(content)

  // 2. Registry pass next — its consumedDateSpans suppress per-cell date spam.
  const reg = extractRegistry(content)
  const flat = extractEntities(content, { skipDateSpans: reg.consumedDateSpans })

  // 3. Merge into graph-worthy canonical entities.
  const seen = new Map<string, ScanEntity>()
  const adhocNorm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9@.+_-]/g, '')
  // value-norm → the table's explicit type (cross-type regex dupes skipped).
  const tableTypeByNorm = new Map<string, string>()
  for (const e of relTable.entities) {
    if (!tableTypeByNorm.has(adhocNorm(e.value))) tableTypeByNorm.set(adhocNorm(e.value), e.type)
  }
  // Digit cores of table values ≥10 digits (phones/accounts/IMEIs/aadhaar):
  // a regex hit whose digits match a table value is the SAME object (e.g.
  // bare "352987523382813" vs the table's "IMEI-352987523382813") — skip it.
  const tableDigitCores = new Set<string>()
  for (const e of relTable.entities) {
    const d = e.value.replace(/\D/g, '')
    if (d.length >= 10) tableDigitCores.add(d)
  }
  // v3.9.2: REGISTRY entities are equally authoritative — registry-keyed
  // exports (XML record lists, PDF annexures) carry the full identifiers,
  // and wrapped row cells leak PREFIX/SUFFIX FRAGMENTS of them into the
  // unlabeled layer ("IN10BANK8653507" from "IN10BANK8653507489"). A core
  // that is a CONTIGUOUS SUBSTRING of an authoritative core ≥10 digits is
  // the same object, not a new node.
  const authoritativeCores: string[] = [...tableDigitCores]
  for (const e of reg.entities) {
    const d = String(e.value ?? '').replace(/\D/g, '')
    if (d.length >= 10 && !tableDigitCores.has(d)) {
      tableDigitCores.add(d)
      authoritativeCores.push(d)
    }
  }
  const coreIsFragment = (core: string): boolean => {
    for (const auth of authoritativeCores) {
      if (auth === core) continue
      if (auth.includes(core) || core.includes(auth)) return true
    }
    return false
  }
  // v3.9.2b: wrapped-cell fragments can lose so many glyphs their digit core
  // drops below 10 ("IN10BANK8653507" ← "IN10BANK8653507489": 9-digit core).
  // Normalized-string PREFIX/SUFFIX containment (≥12 shared chars) catches
  // those — an unlabeled token that is a head/tail slice of an authoritative
  // identifier is the same object. Short words can never clear the 12-char
  // bar, so real names are safe.
  const authoritativeNorms: string[] = []
  for (const e of [...relTable.entities, ...reg.entities]) {
    const n = String(e.value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    if (n.length >= 12) authoritativeNorms.push(n)
  }
  const isWrappedFragment = (value: string): boolean => {
    const n = value.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (n.length < 12) return false
    for (const auth of authoritativeNorms) {
      if (auth === n) continue
      if (auth.startsWith(n) || n.startsWith(auth) || auth.endsWith(n) || n.endsWith(auth)) return true
    }
    return false
  }
  const pushDet = (e: { type?: string; value?: string; context?: string; confidence?: number; tableIds?: string[] }, fromTable = false): void => {
    let t = String(e.type ?? '')
    // Contextual scalar tokens (dates/amounts) are properties, not nodes.
    // v3.9.1: structured-table EVENT rows are real investigation objects
    // (annexure event registers) — they now wire as 'event' nodes instead of
    // being silently dropped (6/6 events were missing on the demo dataset).
    if (AI_CONTEXTUAL_TYPES.has(t)) return
    t = DET_TYPE_MAP[t] ?? t
    if (!CANON_GRAPH_TYPES.has(t)) return
    const value = String(e.value ?? '').trim().slice(0, 120)
    if (value.length < 2) return
    if (!fromTable) {
      // The relationship table already typed this value — its label wins and
      // later regex hits of a DIFFERENT type are dropped (duplicate-node guard).
      const tableType = tableTypeByNorm.get(adhocNorm(value))
      if (tableType && tableType !== t) return
      // Digit-core guard: same object, different spelling (IMEI-xxx vs bare
      // digits) — the table's node is authoritative. v3.9.2: fragments of
      // authoritative identifiers (wrapped cells) are the same object too.
      const digitCore = value.replace(/\D/g, '')
      if (digitCore.length >= 10 && (tableDigitCores.has(digitCore) || coreIsFragment(digitCore))) return
      if (isWrappedFragment(value)) return
    }
    const key = `${t}::${value.toLowerCase().replace(/\s+/g, '')}`
    if (seen.has(key)) {
      // Keep the higher-confidence occurrence; merge table IDs either way
      // (an entity's export IDs must survive across occurrences).
      const prev = seen.get(key)!
      const tableIds = [...new Set([...(prev.tableIds ?? []), ...(e.tableIds ?? [])])].slice(0, 12)
      if ((e.confidence ?? 0) > (prev.confidence ?? 0)) {
        seen.set(key, {
          type: t,
          value,
          context: String(e.context ?? '').slice(0, 300),
          confidence: e.confidence,
          ...(tableIds.length > 0 ? { tableIds } : {}),
        })
      } else if (tableIds.length > 0) {
        seen.set(key, { ...prev, tableIds })
      }
      return
    }
    seen.set(key, {
      type: t,
      value,
      context: String(e.context ?? '').slice(0, 300),
      confidence: e.confidence,
      ...((e.tableIds ?? []).length > 0 ? { tableIds: e.tableIds!.slice(0, 12) } : {}),
    })
  }
  for (const e of relTable.entities) pushDet(e, true)
  // v3.9.2: registry rows are structured table rows too — typed by their own
  // ALL-CAPS row grammar; only the UNLABELED regex layer faces the
  // duplicate-node/fragment guards (its hits are the unverified ones).
  for (const e of reg.entities) pushDet(e, true)
  // v3.10: entity-register rows are structured rows as well — typed by the
  // register's own type column, carrying their row ids as reference tokens.
  for (const e of entTable.entities) pushDet(e, true)
  for (const e of flat) pushDet(e)
  const cap = maxDeterministicEntities(content.length)
  const detEntities = [...seen.values()].slice(0, cap)
  if (seen.size > cap) {
    console.warn(`[aiScan] deterministic base capped at ${cap} of ${seen.size} entities (RJ_MAX_DET_ENTITIES raises the cap)`)
  }

  // ── v3.7.1 BATCHED WRITE PATH ────────────────────────────────────────────
  // Steps 3→5 below write THOUSANDS of rows on big files (entities, record
  // edges, endpoint materialization, corroboration links). Row-by-row
  // autocommit meant one fsync per statement — minutes of exclusive DB lock
  // during which every app request hung ("offline mode is broken"). The whole
  // sequence now runs inside ONE interactive transaction (a single commit;
  // WAL, enabled at boot, keeps readers responsive throughout). If the batched
  // path fails for any reason, the sequence re-runs row-by-row — every write
  // is an idempotent upsert, so the retry is safe.
  let wired!: WireResult
  let registryEdges = 0
  let recordEdges = 0
  const runPhaseAWiring = async (gdb: PrismaClient): Promise<void> => {
    // 3. Wire entities (instant) — registry entities carry their own confidence.
    wired = await wireEntitiesIntoGraph(
      gdb, caseId, evidenceId,
      detEntities as unknown as Array<Record<string, unknown>>,
      Math.max(detEntities.length, 24),
      { source: 'deterministic-extract', defaultConfidence: 0.85 },
    )

    // 4. Registry relationship rows → typed edges.
    const keyToEntityId = wired.keyToEntityId
    // v3.9.2: registry rows key endpoints by the REGISTRY's own row type
    // ("address::415stationroadpune"), while wired entities are keyed by the
    // canonical graph type (address→location, mac→device). Resolve through
    // the type map before giving up — otherwise every address-target edge
    // silently dropped (25/25 REGISTERED_AT lost on registry-keyed exports).
    const resolveKey = (key: string): string | undefined => {
      const direct = keyToEntityId.get(key)
      if (direct) return direct
      const sep = key.indexOf('::')
      if (sep < 0) return undefined
      const prefix = key.slice(0, sep)
      const mapped = DET_TYPE_MAP[prefix]
      return mapped && mapped !== prefix ? keyToEntityId.get(`${mapped}::${key.slice(sep + 2)}`) : undefined
    }
    const regRels = reg.relationships.filter((r) => {
      const srcId = resolveKey(r.srcKey)
      const dstId = resolveKey(r.dstKey)
      return srcId && dstId && srcId !== dstId && registryRelOk(r.rel)
    })// v3.9.2: registry rows keep their literal verb (synonym folding is for
    // AI free-form verbs, not structured annexure evidence).
    .map((r) => ({ ...r, rel: evidenceRel(r.rel).rel }))
    if (regRels.length > 0) {
      registryEdges = (
        await wireDeterministicEdges(
          gdb, caseId, evidenceId, evidence.originalName,
          regRels.map((r) => ({
            from: r.srcKey.split('::').slice(1).join('::') || '',
            to: r.dstKey.split('::').slice(1).join('::') || '',
            rel: r.rel,
            why: `registry row ${r.rowId ?? '(unnumbered)'} asserts ${r.rel}${r.state ? ` (${r.state})` : ''}`,
            confidence: r.confidence != null ? Math.min(1, Math.max(0.1, r.confidence)) : 0.8,
            timestamp: r.timestamp,
            locator: r.rowId,
            srcId: resolveKey(r.srcKey),
            dstId: resolveKey(r.dstKey),
          })),
          new Map<string, string>(),
          'deterministic-registry',
        )
      ).created
    }

    // 5. Record edges from structured tables (rel-table rows + chats/CDRs + bank rows).
    const comms = extractCommunications(content, evidence.originalName)
    const txns = extractTransactions(content, evidence.originalName)
    const recordEdgeList: DeterministicEdge[] = []
    for (const c of comms) {
      const from = String(c.sender ?? c.senderHandle ?? '').trim()
      const to = String(c.receiver ?? c.receiverHandle ?? '').trim()
      if (from && to && from !== to) {
        recordEdgeList.push({
          from, to,
          rel: 'COMMUNICATED_WITH',
          why: `${c.platform ?? 'message'} record${c.timestamp ? ` on ${c.timestamp.slice(0, 10)}` : ''}: "${String(c.messageText ?? '').slice(0, 60)}"`,
          confidence: 0.8,
          timestamp: c.timestamp ?? undefined,
        })
      }
    }
    for (const t of txns) {
      const from = String(t.senderAccount ?? '').trim()
      const to = String(t.receiverAccount ?? '').trim()
      if (from && to && from !== to) {
        recordEdgeList.push({
          from, to,
          rel: 'TRANSFERRED_TO',
          why: `bank record${t.utr ? ` UTR ${t.utr}` : ''}${t.amount != null ? ` — ₹${t.amount.toLocaleString('en-IN')}` : ''}${t.txnDate ? ` on ${t.txnDate.slice(0, 10)}` : ''}`,
          confidence: 0.85,
          amount: t.amount ?? undefined,
          timestamp: t.txnDate ?? undefined,
        })
      }
    }

    // 5a. v3.6 — MATERIALIZE record-edge endpoints as entities when missing.
    // A bank narration naming "IMPS DR-50100234567909" or a CDR row naming a
    // phone IS documentary evidence that the entity exists; without this the
    // record edge was silently dropped because one endpoint had no node
    // ("counterparty accounts that couldn't be connected"). Only identifier-ish
    // values are materialized (accounts/phones/UPIs) plus obvious corporate
    // names from narrations — no speculative person-creation from free text.
    const recordValueMap = buildValueToEntityId(wired.resolved)
    const materializeEndpoints = async (): Promise<void> => {
      // Fold the WHOLE case's existing entities into the lookup first — a
      // narration counterparty ("ZENITH PHARMA DISTRIBUTORS") must resolve to
      // the org node another file already created, not spawn a duplicate.
      try {
        const caseEntities = await gdb.entity.findMany({
          where: { caseId },
          select: { id: true, value: true },
          take: 12000,
        })
        for (const ent of caseEntities) {
          for (const variant of [ent.value, ent.value.toLowerCase(), ent.value.toLowerCase().replace(/[^a-z0-9]/g, '')]) {
            if (variant && variant.length >= 2 && !recordValueMap.has(variant)) recordValueMap.set(variant, ent.id)
          }
        }
      } catch {
        /* lookup enrichment is best-effort */
      }
      const missing = new Map<string, EntityType>()
      for (const e of recordEdgeList) {
        for (const v of [e.from, e.to]) {
          const key = v.toLowerCase()
          if (recordValueMap.has(v) || recordValueMap.has(key) || recordValueMap.has(v.toLowerCase().replace(/[^a-z0-9]/g, ''))) continue
          const digits = v.replace(/\D/g, '')
          let type: EntityType | undefined
          if (/^[\w.\-]{2,}@[a-z]{2,}$/i.test(v)) type = 'upi'
          // Phone ONLY when unambiguous: explicit + prefix, a bare 10-digit
          // Indian mobile (starts 6-9), or 91/0 + mobile. Anything else 9-18
          // digits is an ACCOUNT — the earlier guess (any 10-13 digits = phone)
          // mistyped a 13-digit account ("0034100009876") as a phone, and that
          // mislabeled node then absorbed the correctly-typed table entity.
          else if (v.trim().startsWith('+')) type = 'phone'
          else if (digits.length === 10 && /^[6-9]/.test(digits)) type = 'phone'
          else if (/^(91|0)?[6-9]\d{9}$/.test(digits)) type = 'phone'
          else if (digits.length >= 9 && digits.length <= 18) type = 'account'
          else if (/\b(pvt|ltd|llp|inc|corp|bank|enterprises|traders|logistics|trading|imports|exports|finance|services|retail|wholesale|brokers|co|company|hotel|pharma|distributors)\b/i.test(v) && v.length >= 5) type = 'organization'
          if (type) missing.set(v, type)
        }
      }
      if (missing.size === 0) return
      // v3.7.1: was a hard slice(0, 120) — a 2,400-row bank trail materialized
      // only 120 counterparty accounts and the rest of its record edges were
      // dropped for lack of endpoint nodes ("the graph barely has anything").
      // Scales with RJ_MAX_DET_ENTITIES; wiring is idempotent SQLite upserts.
      const matCap = maxDeterministicEntities(content.length)
      const toWire = [...missing.entries()].slice(0, matCap).map(([value, type]) => ({
        type,
        value: value.slice(0, 120),
        context: 'record-edge endpoint (bank narration / CDR row)',
        confidence: 0.7,
      }))
      try {
        const w2 = await wireEntitiesIntoGraph(gdb, caseId, evidenceId, toWire, toWire.length, {
          source: 'deterministic-record',
          defaultConfidence: 0.7,
        })
        for (const r of w2.resolved) {
          const variants = [r.value, r.value.toLowerCase(), r.value.toLowerCase().replace(/[^a-z0-9]/g, '')]
          for (const variant of variants) {
            if (variant && variant.length >= 2 && !recordValueMap.has(variant)) recordValueMap.set(variant, r.entityId)
          }
        }
      } catch (err) {
        console.error('[aiScan] record endpoint materialization failed:', err)
      }
    }
    if (recordEdgeList.length > 0) {
      await gdb.evidenceStage.upsert({
        where: { evidenceId_stage: { evidenceId, stage: 'ai_scan' } },
        update: { state: 'running', detail: `Wiring ${recordEdgeList.length} structured record rows (endpoints + edges)…` },
        create: { evidenceId, stage: 'ai_scan', state: 'running', detail: `Wiring ${recordEdgeList.length} structured record rows…` },
      }).catch(() => undefined)
      await materializeEndpoints()
    }

    // 5a-2. v3.6 — CORROBORATION links: every record-edge endpoint that resolved
    // to an entity created by ANOTHER file must be linked to THIS evidence too,
    // otherwise the node's "evidence files" count (the cross-file corroboration
    // heatmap) never reflects the record rows that also assert it.
    if (recordEdgeList.length > 0) {
      try {
        const endpointIds = new Set<string>()
        for (const e of recordEdgeList) {
          for (const v of [e.from, e.to]) {
            const id =
              recordValueMap.get(v) ??
              recordValueMap.get(v.toLowerCase()) ??
              recordValueMap.get(v.toLowerCase().replace(/[^a-z0-9]/g, ''))
            if (id) endpointIds.add(id)
          }
        }
        for (const entityId of endpointIds) {
          await gdb.entityLink
            .upsert({
              where: { entityId_evidenceId: { entityId, evidenceId } },
              update: {},
              create: { entityId, evidenceId },
            })
            .catch(() => undefined)
        }
      } catch {
        /* corroboration links are best-effort */
      }
    }

    if (recordEdgeList.length > 0) {
      // v3.7.1: count created + merged — a re-uploaded trail (or overlapping
      // export) may merge 100% of its rows onto existing edges; that is still a
      // fully-wired deterministic base, and the fail-soft check below must see
      // it (created alone was 0 and failed the whole scan on model error).
      const wr = await wireDeterministicEdges(
        gdb, caseId, evidenceId, evidence.originalName,
        recordEdgeList,
        recordValueMap,
        'deterministic-record',
        maxDeterministicEntities(content.length),
      )
      recordEdges = wr.created + wr.merged
    }
  }
  try {
    await db.$transaction(
      (tx) => runPhaseAWiring(tx as unknown as PrismaClient),
      { timeout: 600_000, maxWait: 20_000 },
    )
  } catch (txErr) {
    console.warn(
      '[aiScan] batched deterministic wiring failed — retrying row-by-row (idempotent upserts make this safe):',
      txErr instanceof Error ? txErr.message : txErr,
    )
    await runPhaseAWiring(db)
  }

  // 5b. Relationship-table rows → typed edges. The table's entities were
  //     pushed above, so endpoints resolve exactly (pre-resolved ids from
  //     keyToEntityId, value-map fallback for normalization drift).
  //     FULL-FIDELITY MODE: every row is kept — repeated (src,dst,rel) pairs
  //     accumulate on one edge (weight + rows[]), and every dated row becomes
  //     a Timeline event so the relationship chronology is visible.
  let tableEdges = 0
  let tableTimelineEvents = 0
  if (relTable.edges.length > 0) {
    const valueMap = buildValueToEntityId(wired.resolved)
    const resolveId = (value: string, type: string): string | undefined => {
      const candidates = [
        normalizeEntity(type as EntityType, value),
        value.toLowerCase(),
        adhocNorm(value),
      ]
      for (const c of candidates) {
        if (c && c.length >= 2) {
          const id = wired.keyToEntityId.get(`${type}::${c}`)
          if (id) return id
        }
      }
      return undefined
    }
    const wireResult = await wireDeterministicEdges(
      db, caseId, evidenceId, evidence.originalName,
      relTable.edges.map((r) => ({
        from: r.from,
        to: r.to,
        rel: r.rel,
        why: r.why,
        confidence: r.confidence,
        timestamp: r.timestamp,
        locator: r.rowId,
        srcId: resolveId(r.from, r.fromType),
        dstId: resolveId(r.to, r.toType),
        rowId: r.rowId,
        srcTableId: r.srcTableId,
        tgtTableId: r.tgtTableId,
        state: r.state,
        method: r.method,
        evidenceRefs: r.evidenceRefs,
        row: r.row,
      })),
      valueMap,
      'deterministic-reltable',
      maxDeterministicEntities(content.length),
      { mergeRows: true },
    )
    tableEdges = wireResult.created + wireResult.merged

    // Timeline events — one per DATED table row (the export's own event_date
    // column IS the chronology the investigator expects on the timeline).
    // Rescan-safe: table-row events for this evidence are replaced wholesale.
    const datedRows = relTable.edges.filter((r) => r.timestamp)
    if (datedRows.length > 0) {
      try {
        await db.timelineEvent.deleteMany({
          where: { caseId, sourceEvidenceId: evidenceId, kind: 'relationship' },
        })
        const events = datedRows.slice(0, 2000).map((r) => ({
          caseId,
          ts: r.timestamp!.slice(0, 10),
          sourceEvidenceId: evidenceId,
          kind: 'relationship',
          summary: `${r.rowId ? r.rowId + ' · ' : ''}${r.from} —${r.rawRel}→ ${r.to}`.slice(0, 240),
          metadataJson: JSON.stringify({
            tableRow: true,
            rowId: r.rowId ?? null,
            rel: r.rel,
            rawRel: r.rawRel,
            confidence: r.confidence,
            state: r.state ?? null,
            method: r.method ?? null,
            evidenceRefs: r.evidenceRefs ?? null,
            srcTableId: r.srcTableId ?? null,
            tgtTableId: r.tgtTableId ?? null,
            row: r.row,
          }),
        }))
        // Chunked inserts (SQLite variable limits on huge tables).
        for (let i = 0; i < events.length; i += 200) {
          await db.timelineEvent.createMany({ data: events.slice(i, i + 200) })
        }
        tableTimelineEvents = events.length
      } catch (err) {
        console.error('[aiScan] reltable timeline events failed:', err)
      }
    }
  }

  // 6. Deterministic classification (AI may arbitrate/upgrade it later).
  const detClass = classifyDeterministic(evidence.originalName, content, {
    mime: evidence.mime,
  })

  // Compact rel-mix summary for the AI's record-edge exclusion note.
  const relCounts = new Map<string, number>()
  for (const e of relTable.edges) {
    const k = e.rawRel.toUpperCase().replace(/[\s-]+/g, '_')
    relCounts.set(k, (relCounts.get(k) ?? 0) + 1)
  }
  const relMix = [...relCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([t, n]) => `${t} ×${n}`)
    .join(', ')

  return {
    entities: detEntities,
    resolved: wired.resolved,
    linked: wired.linked,
    recordEdges,
    registryEdges,
    tableEdges,
    tableTimelineEvents,
    relTable: relTable.detected
      ? {
          coverage: relTable.coverage,
          digest: relTable.digest,
          edgeCount: relTable.edges.length,
          nonTableText: relTable.nonTableText,
          relMix,
        }
      : null,
    entityTable: entTable.detected
      ? { entities: entTable.entities.length, rows: entTable.rowCount }
      : null,
    classification: {
      classification: detClass.classification,
      confidence: detClass.confidence,
      source: detClass.source,
    },
    aiNoiseTokens: buildAiNoiseTokens(reg.noiseVocabulary, relTable),
  }
}

/**
 * v3.9.1 — tokens the AI sweep must NEVER emit as entities: registry row
 * references (E0001, R0042…) + registry attribute keys/values + relationship-
 * table row/endpoint/evidence refs. Purely deterministic, derived from what
 * the tables themselves declare. (Longest-value-first is irrelevant — exact
 * normalized match only.)
 */
function buildAiNoiseTokens(
  registryNoise: string[] | undefined,
  relTable: { edges: Array<{ rowId?: string; srcTableId?: string; tgtTableId?: string; evidenceRefs?: string[] }> },
): Set<string> {
  const noise = new Set<string>()
  const add = (v: string | undefined): void => {
    const t = (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (t.length >= 2 && t.length <= 60) noise.add(t)
  }
  for (const t of registryNoise ?? []) add(t)
  for (const e of relTable.edges ?? []) {
    add(e.rowId)
    add(e.srcTableId)
    add(e.tgtTableId)
    for (const ev of e.evidenceRefs ?? []) add(ev)
  }
  return noise
}

/**
 * v3.9.1 — filter the AI sweep's entity list against the deterministic noise
 * vocabulary (registry refs + attribute values) and the proper-noun rule:
 * a PERSON/ORGANIZATION value that is a single all-lowercase word ('ridian',
 * 'watchlist') is not a proper noun and cannot be a name. Deterministic
 * entities bypass this entirely (they arrive with their own validation).
 */
/** v3.9.1 — a bare attribute cell ('status=active', 'role=Director'), not an entity name. */
const ATTR_CELL_RE = /^[a-z][a-z0-9_ -]{1,23}==?.{1,60}$/

export function filterRegistryNoiseAi(aiEntities: ScanEntity[], detEntities: ScanEntity[], noise: Set<string>): ScanEntity[] {
  // Real (deterministic) entity values are never suppressible — an attribute
  // value that legitimately names a registry entity (owner=Arjun Sharma)
  // must not kill the entity the AI re-listed from prose.
  const detValues = new Set<string>()
  for (const e of detEntities) detValues.add(e.value.trim().toLowerCase().replace(/\s+/g, ' '))
  const keep: ScanEntity[] = []
  for (const e of aiEntities) {
    const v = e.value.trim()
    const norm = v.toLowerCase().replace(/\s+/g, ' ')
    if (detValues.has(norm)) {
      keep.push(e)
      continue
    }
    if (noise.has(norm)) continue
    // Property CELL re-emitted as an entity ('status=watchlist') — kill it.
    if (ATTR_CELL_RE.test(norm)) continue
    // Proper-noun rule: a PERSON/ORGANIZATION that is one all-lowercase word
    // ('ridian', 'watchlist', 'active') is a fragment, not a name.
    if ((e.type === 'person' || e.type === 'organization') && /^[a-z]{2,20}$/.test(norm)) continue
    keep.push(e)
  }
  return keep
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE B — the AI enrichment (hybrid / turbo)
// ─────────────────────────────────────────────────────────────────────────────

interface TurboChunkOut {
  chunkSummary: string
  keyFacts: string[]
  missedEntities: ScanEntity[]
  connections: ScanStoryConnection[]
  suspiciousIndicators: string[]
  contradictions: unknown[]
  classification?: string
  classificationConfidence?: number
}

/** Manifest line for one entity (compact — value truncated hard). */
function manifestLine(e: ScanEntity): string {
  return `- [${e.type}] ${e.value.slice(0, 48)}`
}

/**
 * Types that must NEVER ride in an AI manifest. In financial registers every
 * row carries a date and an amount, so their digit-strings "appear" in every
 * chunk via containment matching and drown the manifest in useless lines
 * (v3.7.1: a 6,374-entity bank trail emitted a ~30K-char manifest → 38K-char
 * prompt → qwen3:4b watchdog-killed both attempts).
 */
const MANIFEST_SKIP_TYPES = AI_CONTEXTUAL_TYPES

/** Manifest slot priority when the character budget runs short. */
const MANIFEST_TYPE_PRIORITY = new Set([
  'person', 'organization', 'phone', 'account', 'upi', 'email', 'imei',
  'vehicle', 'location', 'wallet', 'device', 'ifsc', 'document_id',
])

/**
 * Manifest share of a prompt budget — keeps EVERY AI call inside the model's
 * measured per-prompt budget no matter how many entities the file produced.
 */
function manifestBudgetFor(maxCharsPerPrompt: number): number {
  return Math.max(2_500, Math.min(6_000, Math.round(maxCharsPerPrompt * 0.4)))
}

export interface ManifestBudgetResult {
  text: string
  included: number
  /** Entities shown vs available — surfaced in strategy notes when truncated. */
  of: number
}

/**
 * Build the "already extracted & saved" entity manifest under a HARD
 * character budget.
 *
 *   - HUBS (persons/organizations, highest confidence first) always lead —
 *     they are the cross-chunk connection endpoints.
 *   - With a `chunk`: locals are entities whose normalized value literally
 *     appears in that chunk (≥4 chars, contextual types excluded) so the
 *     model can attach identifiers to owners without re-extracting them.
 *   - Without a `chunk` (digest / relationship-maker): highest-priority
 *     identifier types by confidence.
 *   - Lines are appended until the budget is exhausted — the prompt can never
 *     blow past the model's window again, regardless of entity count.
 */
export function buildManifestWithinBudget(
  entities: ScanEntity[],
  budgetChars: number,
  chunk?: string,
): ManifestBudgetResult {
  const usable = entities.filter((e) => !MANIFEST_SKIP_TYPES.has(e.type))
  const hubs = usable
    .filter((e) => e.type === 'person' || e.type === 'organization')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))

  let locals: ScanEntity[] = []
  if (chunk) {
    const chunkDigits = chunk.toLowerCase().replace(/[^0-9a-z]/g, '')
    const hubSet = new Set(hubs)
    const localSet = new Set<ScanEntity>()
    for (const e of usable) {
      if (hubSet.size + localSet.size >= 400) break
      if (hubSet.has(e)) continue
      const clean = e.value.toLowerCase().replace(/[^0-9a-z]/g, '')
      if (clean.length >= 4 && chunkDigits.includes(clean)) localSet.add(e)
    }
    locals = [...localSet]
  } else {
    locals = usable
      .filter((e) => e.type !== 'person' && e.type !== 'organization')
      .sort((a, b) => {
        const pa = MANIFEST_TYPE_PRIORITY.has(a.type) ? 0 : 1
        const pb = MANIFEST_TYPE_PRIORITY.has(b.type) ? 0 : 1
        return pa - pb || (b.confidence ?? 0) - (a.confidence ?? 0)
      })
  }

  const lines: string[] = []
  let used = 0
  let included = 0
  const add = (e: ScanEntity): boolean => {
    const line = manifestLine(e)
    if (used + line.length + 1 > budgetChars) return false
    lines.push(line)
    used += line.length + 1
    included += 1
    return true
  }
  for (const h of hubs) if (!add(h)) break
  for (const l of locals) {
    if (used >= budgetChars) break
    add(l)
  }
  return {
    text: lines.length > 0 ? lines.join('\n') : '(empty — regex found no entities in this document)',
    included,
    of: usable.length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.3 tiered model routing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this content read as PROSE (sentences, narrative) rather than a
 * structured register/CDR/table?
 *
 * The FAST tier is for tiny STRUCTURED documents only (routing spec) — a
 * small victim statement or letter is prose whose ENTIRE value is contextual
 * (who did what to whom); sending it to a ≤3B model produces junk summaries
 * and zero relationships. Heuristic: a line is "prose" when it has ≥8 words,
 * no tabs/semicolons and few commas (not a delimited row). ≥40% prose lines →
 * prose document → the standard brain handles it.
 */
export function looksLikeProse(content: string): boolean {
  const lines = content.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  let prose = 0
  for (const l of lines) {
    const words = l.split(/\s+/).length
    const commas = (l.match(/,/g) || []).length
    if (words >= 8 && !/[;\t|]/.test(l) && commas < 3) prose += 1
  }
  return prose / lines.length >= 0.4
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.9 — DETERMINISTIC DOCUMENT-STRUCTURE DETECTION (master prompt §6)
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentStructure {
  kind: 'tabular' | 'narrative' | 'mixed'
  /** 0 = pure narrative, 1 = pure tabular. */
  score: number
  /** Human-readable structural signals that drove the verdict. */
  signals: string[]
}

/**
 * Deterministic tabular-vs-narrative detection — ZERO model calls (master
 * prompt §6: "Avoid wasting model calls simply to classify obviously
 * structured data"). Inspects structural characteristics only:
 *
 *   - delimiter consistency (tab/pipe/semicolon/CSV columns per line)
 *   - repeated column-count patterns across sample lines
 *   - row regularity (line-length coefficient of variation)
 *   - digit density (registers/CDRs/transactions are digit-heavy)
 *
 * Verdict drives the relationship strategy: tabular → deterministic row
 * wiring (relTable), narrative → STANDARD-tier semantic inference (maker).
 */
export function detectDocumentStructure(content: string): DocumentStructure {
  const lines = content.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return { kind: 'narrative', score: 0, signals: ['empty'] }
  const sample = lines.length > 400 ? lines.filter((_, i) => i % Math.ceil(lines.length / 400) === 0) : lines

  const signals: string[] = []
  let structural = 0

  // 1. Delimiter consistency: lines sharing one dominant delimiter (& ≥2 cols).
  const delimiterCounts = new Map<string, number>()
  for (const l of sample) {
    for (const d of ['\t', '|', ';', ',']) {
      const parts = l.split(d).filter((p) => p.trim().length > 0)
      if (parts.length >= 3) delimiterCounts.set(d, (delimiterCounts.get(d) ?? 0) + 1)
    }
  }
  const [bestDelim, bestDelimCount] = [...delimiterCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const delimRatio = bestDelimCount / sample.length
  if (delimRatio >= 0.6) {
    structural += 0.45
    signals.push(`${(delimRatio * 100).toFixed(0)}% of lines split consistently on "${bestDelim === '\t' ? 'TAB' : bestDelim}" into ≥3 fields`)
  }

  // 2. Column-pattern regularity: same field count on most lines.
  if (bestDelim) {
    const colCounts = sample.map((l) => l.split(bestDelim).filter((p) => p.trim()).length)
    const mode = new Map<number, number>()
    for (const c of colCounts) mode.set(c, (mode.get(c) ?? 0) + 1)
    const [modeCols, modeN] = [...mode.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
    if (modeN / sample.length >= 0.7 && modeCols >= 3) {
      structural += 0.3
      signals.push(`${modeCols} columns repeat on ${(modeN / sample.length * 100).toFixed(0)}% of rows`)
    }
  }

  // 3. Row regularity: low variance in line length (registers) vs prose paragraphs.
  const lens = sample.map((l) => l.length)
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
  const cv = mean > 0 ? sd / mean : 1
  if (cv < 0.45 && sample.length >= 8) {
    structural += 0.15
    signals.push(`uniform row lengths (CV ${(cv * 100).toFixed(0)}%)`)
  }

  // 4. Digit density: transaction/CDR/registry lines are digit-dominant.
  const digits = sample.reduce((a, l) => a + (l.match(/\d/g) || []).length, 0)
  const chars = sample.reduce((a, l) => a + l.length, 0)
  const digitRatio = chars > 0 ? digits / chars : 0
  if (digitRatio >= 0.25) {
    structural += 0.1
    signals.push(`${(digitRatio * 100).toFixed(0)}% digit characters`)
  }

  const score = Math.min(1, structural)
  const kind: DocumentStructure['kind'] = score >= 0.6 ? 'tabular' : score <= 0.25 ? 'narrative' : 'mixed'
  if (kind === 'narrative') signals.push(`prose lines dominate (${(looksLikeProse(content) ? 'prose-like' : 'sparse free text')})`)
  return { kind, score: Number(score.toFixed(2)), signals }
}

/**
 * Which tier serves the enrichment pass for THIS document?
 *
 *   FAST       — tiny STRUCTURED documents (registers/CDR snippets/notes):
 *                short delimited rows, no narrative. The deterministic layer
 *                already found most entities; the model only confirms +
 *                fills small gaps. ≤3B models do this as well as 8B ones at
 *                a fraction of the latency.
 *   STANDARD   — the default scan brain (contextual extraction, story
 *                connections): ALL prose — statements, letters, FIRs, chat
 *                narratives — regardless of size. v3.7: small-but-prose docs
 *                used to fall into FAST and come back with junk summaries
 *                and zero relationships.
 *   DEEP       — never the starting tier (7B+ models are slow on consumer
 *                hardware); reserved for ESCALATION when a lower tier cannot
 *                resolve a chunk.
 */
export function pickEnrichmentTier(content: string, detEntityCount: number): ModelTier {
  if (content.length <= 4000 && detEntityCount >= 6 && !looksLikeProse(content)) {
    // Small STRUCTURED doc, dense with regex-findable identifiers → the
    // manifest already carries the extraction; the AI only double-checks.
    return 'fast'
  }
  return 'standard'
}

/**
 * Server-level failure detector: watchdog aborts / timeouts mean the WHOLE
 * server is dead or overloaded — retrying the same chunk on the deep model
 * would just burn another timeout cycle. Model-specific failures (HTTP 5xx,
 * empty/garbled output) DO warrant escalation to the deep tier.
 */
function isServerLevelFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /aborted|timed?\s*out|watchdog/i.test(msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.8 — STAGE 0: FAST ENTITY SWEEP → MERGE COURT → AI RECHECK
//
// The user contract for entity extraction:
//   1. DETERMINISTIC FIRST — regex/registry/row extractors classify into
//      proper classes with zero tokens (Phase A, unchanged).
//   2. FAST SWEEP — the ≤3B model walks the document in SMALL overlapped
//      chunks and lists every entity it sees (single-purpose NER prompt).
//      Chunks overlap so an entity at a boundary is seen TWICE; per-chunk
//      quality gates escalate empty-but-signal-rich chunks to STANDARD.
//   3. MERGE COURT — deterministic code (never a model) reconciles the sweep
//      against the deterministic base: weighted type votes, digit-safe keys,
//      conflict list. Regex stays ground truth for identifiers; the court
//      only ADDS and FLAGS.
//   4. RECHECK — the contested slice ONLY (conflicts + low-confidence
//      additions) goes back to the model for adjudication; corrections and
//      missed critical actors are applied, junk is rejected.
// ─────────────────────────────────────────────────────────────────────────────

/** Bounded-concurrency map — local servers serialize via localCallChain, but
 *  remote endpoints (GLM / OpenAI-compat) genuinely run in parallel. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
}

/** Merge-safe normalization: label prefixes stripped, case/punctuation folded.
 *  Values dominated by digits key on DIGITS ONLY so "A/C 1234567890",
 *  "Acct 1234567890" and "1234567890" are the same entity. */
export function normForMergeKey(value: string): string {
  const v = stripValueLabelPrefix(String(value ?? '').trim()).toLowerCase()
  const digits = v.replace(/\D/g, '')
  if (digits.length >= 4 && digits.length >= v.replace(/[^a-z0-9]/g, '').length / 2) return digits
  return v.replace(/[^a-z0-9\u00c0-\u024f\u0900-\u097f\u4e00-\u9fff]+/g, '')
}

/** Canonical entity-type set the pipeline accepts (AI_TYPE_MAP's value space). */
const CANON_TYPE_SET = new Set(Object.values(AI_TYPE_MAP))

export interface MergeConflict {
  value: string
  detType?: string
  aiType: string
  aiVotes: number
  sample: string
}

export interface MergeCourtResult {
  /** det entities + AI additions (corrections pending recheck). */
  entities: ScanEntity[]
  /** AI-found entities the deterministic layer missed. */
  additions: ScanEntity[]
  /** det entities whose sweep-majority type disagreed with the det type. */
  conflicts: MergeConflict[]
  /** det entities the sweep independently confirmed (quality telemetry). */
  confirmedCount: number
  rawAiCount: number
  /** v3.9: additions gated to status=candidate (below the confirmation
   *  threshold). They are KEPT — never deleted — for review/deeper analysis. */
  candidateCount: number
}

/**
 * THE MERGE COURT — deterministic reconciliation of the fast sweep against
 * the deterministic base. Regex extraction carries weight 5 (identifier
 * formats are unambiguous: a 10-digit string IS a phone/account); each chunk
 * sighting carries weight 1 (+0.5 when the model was ≥0.8 confident).
 * The court never DELETES a deterministic entity; worst case it flags a
 * conflict for the recheck pass.
 */
export function mergeCourt(detEntities: ScanEntity[], aiChunkEntities: ScanEntity[][]): MergeCourtResult {
  interface Entry {
    value: string
    det?: ScanEntity
    votes: Map<string, number>
    sightings: number
    confSum: number
    confN: number
    example?: ScanEntity
  }
  const byKey = new Map<string, Entry>()
  const touch = (e: ScanEntity): Entry => {
    const key = normForMergeKey(e.value)
    let entry = byKey.get(key)
    if (!entry) {
      entry = { value: e.value, votes: new Map(), sightings: 0, confSum: 0, confN: 0 }
      byKey.set(key, entry)
    }
    return entry
  }

  for (const d of detEntities) {
    const entry = touch(d)
    entry.det = d
    entry.votes.set(d.type, (entry.votes.get(d.type) ?? 0) + 5)
  }

  let rawAiCount = 0
  for (const chunk of aiChunkEntities) {
    // Dedupe WITHIN a chunk first (overlap re-shows the same entity twice).
    const seenInChunk = new Set<string>()
    for (const a of chunk) {
      const key = normForMergeKey(a.value)
      if (seenInChunk.has(key)) continue
      seenInChunk.add(key)
      rawAiCount += 1
      const entry = touch(a)
      entry.sightings += 1
      entry.confSum += typeof a.confidence === 'number' ? a.confidence : 0.7
      entry.confN += 1
      const w = 1 + (typeof a.confidence === 'number' && a.confidence >= 0.8 ? 0.5 : 0)
      entry.votes.set(a.type, (entry.votes.get(a.type) ?? 0) + w)
      if (!entry.det && !entry.example) entry.example = a
      // Prefer the LONGEST raw spelling as canonical (full names over fragments).
      if (!entry.det && a.value.length > entry.value.length) entry.value = a.value
    }
  }

  const entities: ScanEntity[] = []
  const additions: ScanEntity[] = []
  const conflicts: MergeConflict[] = []
  let confirmedCount = 0
  let candidateCount = 0

  for (const entry of byKey.values()) {
    let bestType = ''
    let bestW = -1
    let aiBestType = ''
    let aiBestW = -1
    for (const [t, w] of entry.votes) {
      if (w > bestW) { bestW = w; bestType = t }
    }
    for (const [t, w] of entry.votes) {
      if (t !== entry.det?.type && w > aiBestW) { aiBestW = w; aiBestType = t }
    }
    const avgConf = entry.confN > 0 ? entry.confSum / entry.confN : undefined

    if (entry.det) {
      if (entry.sightings > 0) confirmedCount += 1
      // Deterministic entities are ALWAYS confirmed — checksum/domain
      // validation already proved them; AI votes may only adjust confidence.
      entities.push({ ...entry.det, status: 'confirmed', confidence: Math.max(entry.det.confidence ?? 0, avgConf ?? 0) || entry.det.confidence })
      // Conflict: the sweep's NON-det majority outweighs the det vote outright.
      if (entry.det && aiBestType && aiBestW > 5) {
        conflicts.push({
          value: entry.det.value,
          detType: entry.det.type,
          aiType: aiBestType,
          aiVotes: entry.sightings,
          sample: entry.example?.context?.slice(0, 120) ?? '',
        })
      }
    } else {
      const type = CANON_TYPE_SET.has(bestType) ? bestType : (guessEntityType(entry.value) as string)
      if (!type || !CANON_TYPE_SET.has(type)) continue
      // v3.9 CONFIRMATION GATE (master prompt §4): an AI entity becomes
      // confirmed on a single high-confidence reliable mention (≥0.8) or on
      // independent corroboration across ≥2 mentions (overlap dedupe makes
      // these genuine separate sightings). Below the threshold it stays a
      // CANDIDATE — retained, never deleted.
      const corroborated = entry.sightings >= 2
      const highConf = avgConf != null && avgConf >= 0.8
      const status: 'confirmed' | 'candidate' = corroborated || highConf ? 'confirmed' : 'candidate'
      if (status === 'candidate') candidateCount += 1
      const added: ScanEntity = {
        type,
        value: entry.value.slice(0, 120),
        context: entry.example?.context?.slice(0, 160),
        confidence: avgConf != null ? Math.min(1, avgConf) : 0.7,
        status,
      }
      additions.push(added)
      entities.push(added)
    }
  }

  return { entities, additions, conflicts, confirmedCount, rawAiCount, candidateCount }
}

/** Sanitize a raw AI entity list into ScanEntity[] (value/type coercion). */
export function coerceEntityList(raw: unknown): ScanEntity[] {
  if (!Array.isArray(raw)) return []
  const out: ScanEntity[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const value = String(o.value ?? '').trim()
    if (!value || value.length < 2) continue
    let type = String(o.type ?? '').trim().toLowerCase()
    if (!CANON_TYPE_SET.has(type)) type = guessEntityType(value) as string
    if (!type || !CANON_TYPE_SET.has(type)) continue
    out.push({
      type,
      value: value.slice(0, 120),
      context: String(o.context ?? '').slice(0, 160) || undefined,
      confidence: typeof o.confidence === 'number' ? Math.min(1, Math.max(0.1, o.confidence)) : 0.7,
    })
  }
  return out
}

export interface RecheckOutcome {
  corrections: Array<{ value: string; correctType: string; reason: string }>
  rejected: string[]
  missedCritical: ScanEntity[]
}

/** Parse the recheck (stage 0b) JSON payload. Exported for unit tests. */
export function parseRecheckOutput(parsed: Record<string, unknown> | null): RecheckOutcome {
  const out: RecheckOutcome = { corrections: [], rejected: [], missedCritical: [] }
  if (!parsed) return out
  if (Array.isArray(parsed.corrections)) {
    for (const r of parsed.corrections) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const value = String(o.value ?? '').trim()
      let type = String(o.correctType ?? '').trim().toLowerCase()
      if (!value) continue
      if (!CANON_TYPE_SET.has(type)) type = (guessEntityType(value) ?? '') as string
      if (!type || !CANON_TYPE_SET.has(type)) continue
      out.corrections.push({ value, correctType: type, reason: String(o.reason ?? '').slice(0, 120) })
    }
  }
  if (Array.isArray(parsed.rejected)) {
    for (const v of parsed.rejected) {
      const s = String(v ?? '').trim()
      if (s) out.rejected.push(s)
    }
  }
  if (Array.isArray(parsed.missedCritical)) {
    for (const e of coerceEntityList(parsed.missedCritical)) {
      if (e.type === 'person' || e.type === 'organization') out.missedCritical.push(e)
    }
  }
  return out
}

// ── evidence proof gate (v3.8) ──────────────────────────────────────────────

/** Normalize text for verbatim-quote verification (case/punct-insensitive). */
export function normForEvidence(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u0900-\u097f\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let evidenceNormCache: { content: string; norm: string } | null = null

/** Is `quote` VERBATIM present in `content` (modulo case/punctuation)? */
export function verifyEvidenceQuote(quote: string, content: string): boolean {
  const q = normForEvidence(quote)
  if (q.length < 8) return false // <8 normalized chars ≈ <3 words — not a quote
  if (!evidenceNormCache || evidenceNormCache.content !== content) {
    evidenceNormCache = { content, norm: normForEvidence(content) }
  }
  return evidenceNormCache.norm.includes(q)
}

export interface EvidenceGateStats { proven: number; paraphrased: number; dropped: number }

/**
 * EVIDENCE PROOF GATE — every kept connection must be explainable:
 *   - verbatim `evidence` quote verified against the document → PROVEN
 *     (confidence boosted; quote persists as the edge's proof)
 *   - quote present but unverifiable (paraphrase) → kept at reduced
 *     confidence, counted honestly
 *   - neither a usable `why` nor any quote → DISCARDED (no explainable
 *     proof, no edge)
 */
export function applyEvidenceGate(
  connections: ScanStoryConnection[],
  content: string,
): {
  kept: ScanStoryConnection[]
  stats: EvidenceGateStats
} {
  const kept: ScanStoryConnection[] = []
  const stats: EvidenceGateStats = { proven: 0, paraphrased: 0, dropped: 0 }
  for (const c of connections) {
    const quote = String((c as ScanStoryConnection & { evidence?: string }).evidence ?? '').trim()
    const why = String(c.why ?? '').trim()
    if (!quote && !why) {
      stats.dropped += 1
      continue
    }
    if (quote && verifyEvidenceQuote(quote, content)) {
      kept.push({ ...c, evidence: quote, confidence: Math.min(1, (c.confidence ?? 0.8) + 0.1) })
      stats.proven += 1
    } else if (quote && !why) {
      // unprovable quote and nothing else to explain it — discard
      stats.dropped += 1
    } else {
      kept.push({ ...c, confidence: Math.max(0.3, (c.confidence ?? 0.8) * 0.85) })
      stats.paraphrased += 1
    }
  }
  return { kept, stats }
}

/**
 * STAGE 0 driver: fast sweep → merge court → recheck. Fail-soft everywhere —
 * any failure returns null and the pipeline continues on deterministic
 * entities alone (v3.7 behaviour).
 */
export interface SweepResult {
  entities: ScanEntity[]
  strategies: string[]
  usage: TierUsage
  correctionsApplied: number
}

async function runFastEntitySweep(
  evidence: { originalName: string },
  content: string,
  detEntities: ScanEntity[],
  onProgress?: (done: number, total: number) => void,
  aiNoise: Set<string> = new Set(),
): Promise<SweepResult | null> {
  if (content.trim().length < 300) return null
  const { localChatDetailed, getModelProfile, getContentBudgetChars } = await import('@/lib/localAi')
  const tiers = await getTierAssignment()

  const profile = await getModelProfile(false, tiers.fast).catch(() => null)
  const budget = tierContextBudget('fast', profile?.contextTokens ?? null)
  // Hard ceiling = tier token budget (digit-aware char conversion) ∩ the
  // deployment's per-call char budget (12K local default). Reserve covers
  // the NER system prompt + chunk wrapper so the COMPOSED prompt stays inside
  // the fast model's explicit num_ctx window.
  const deployCeil = (await getContentBudgetChars(undefined, tiers.fast)).maxCharsPerPrompt
  const chunkBudgetTokens = Math.min(
    budget.chunkBudgetTokens,
    Math.max(500, Math.floor((deployCeil - FAST_NER_CHUNK_SYSTEM_PROMPT.length - 1_000) / 2)),
  )
  const chunks = planChunksTokenBudget(content, chunkBudgetTokens, budget.overlapChars)

  const usage = emptyTierUsage()
  const perChunk: (ScanEntity[] | undefined)[] = []
  const chunkWrongKeys: Set<string>[] = chunks.map(() => new Set<string>())
  let escalatedChunks = 0
  let recheckedChunks = 0
  let missedRecovered = 0
  let aiRejected = 0
  // Master prompt §3: per-chunk INDEPENDENT recheck is the default.
  // RJ_RECHECK_PASS=contested falls back to the v3.8 contested-slice-only
  // adjudication for very weak hardware.
  const perChunkRecheck = (process.env.RJ_RECHECK_PASS ?? 'chunk').toLowerCase() !== 'contested'

  // Signal heuristic: how many obvious entity-ish tokens a chunk contains
  // (capitalized name pairs + long digit groups). FAST returning ZERO
  // entities on a signal-rich chunk is a miss, not an empty chunk.
  const signalTokens = (t: string) =>
    (t.match(/\b[A-Z][a-z]{2,} [A-Z][a-z]{2,}\b/g) || []).length +
    (t.match(/\b\d{6,}\b/g) || []).length

  // Deterministic entities visible in a chunk (string containment on the
  // raw value — cheap and exact for structured identifiers).
  const detInChunk = (chunk: string): ScanEntity[] => {
    const out: ScanEntity[] = []
    for (const d of detEntities) {
      const v = d.value
      if (v.length >= 4 && chunk.includes(v)) {
        out.push(d)
      } else if (v.length >= 4 && v.toLowerCase() !== v && chunk.toLowerCase().includes(v.toLowerCase())) {
        out.push(d)
      }
      if (out.length >= 120) break
    }
    return out
  }

  await mapWithConcurrency(chunks, 3, async (chunk, i) => {
    const known = detInChunk(chunk)
    const messages = [
      { role: 'system', content: FAST_NER_CHUNK_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Evidence file: ${evidence.originalName}\nCHUNK ${i + 1} OF ${chunks.length}\n\n` +
          knownEntitiesSection(known) +
          `--- CHUNK CONTENT ---\n${chunk}`,
      },
    ] as Parameters<typeof localChatDetailed>[0]
    let ents: ScanEntity[] = []
    try {
      const raw = await localChatDetailed(messages, {
        thinking: false, json: true, maxTokens: budget.maxOutputTokens, model: tiers.fast, tier: 'fast',
      })
      usage.fast += 1
      const parsed = extractJsonObject<Record<string, unknown>>(raw.content)
      ents = filterRegistryNoiseAi(coerceEntityList(parsed?.entities), detEntities, aiNoise)
    } catch {
      // chunk failed on FAST — quality gate may escalate below
    }
    if (ents.length === 0 && signalTokens(chunk) >= 3 && tiers.standard && tiers.standard !== tiers.fast) {
      try {
        const raw = await localChatDetailed(messages, {
          thinking: false, json: true, maxTokens: budget.maxOutputTokens, model: tiers.standard, tier: 'standard',
        })
        usage.standard += 1
        escalatedChunks += 1
        const parsed = extractJsonObject<Record<string, unknown>>(raw.content)
        ents = filterRegistryNoiseAi(coerceEntityList(parsed?.entities), detEntities, aiNoise)
      } catch {
        // both tiers failed this chunk — leave empty
      }
    }

    // ── PASS 3: INDEPENDENT per-chunk verification (master prompt §3) ─────
    // A genuinely SEPARATE model call over the SAME chunk, given the Pass-2
    // output, adversarially auditing it: missed entities + wrong entities.
    if (perChunkRecheck && chunk.trim().length >= 200) {
      try {
        const pass2List = ents
          .slice(0, 120)
          .map((e) => `- [${e.type}] ${e.value}`)
          .join('\n')
        const recheckRaw = await localChatDetailed(
          [
            { role: 'system', content: FAST_RECHECK_CHUNK_SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `Evidence file: ${evidence.originalName}\n` +
                knownEntitiesSection(known) +
                `--- FIRST EXTRACTOR'S LIST ---\n${pass2List || '(empty)'}\n\n--- CHUNK CONTENT ---\n${chunk}`,
            },
          ] as Parameters<typeof localChatDetailed>[0],
          { thinking: false, json: true, maxTokens: 1_500, model: tiers.fast, tier: 'fast' },
        )
        usage.fast += 1
        recheckedChunks += 1
        const verdict = extractJsonObject<Record<string, unknown>>(recheckRaw.content)
        const missed = filterRegistryNoiseAi(coerceEntityList(verdict?.missed), detEntities, aiNoise)
        let recoveredHere = 0
        for (const m of missed) {
          if (!ents.some((e) => normForMergeKey(e.value) === normForMergeKey(m.value))) {
            // Recovered misses enter as SINGLE-SIGHTING AI entities — the
            // merge court gates them (candidate unless corroborated/≥0.8).
            ents.push({ ...m, confidence: Math.min(m.confidence ?? 0.75, 0.85) })
            recoveredHere += 1
          }
        }
        missedRecovered += recoveredHere
        const wrong = Array.isArray(verdict?.wrong) ? verdict.wrong : []
        for (const w of wrong) {
          const val = String((w as Record<string, unknown>)?.value ?? '').trim()
          if (val) {
            chunkWrongKeys[i].add(normForMergeKey(val))
            aiRejected += 1
          }
        }
      } catch {
        // verifier unavailable — Pass-2 output stands
      }
    }

    perChunk[i] = ents
    onProgress?.(perChunk.filter(Array.isArray).length, chunks.length)
  })

  const okChunks = perChunk.filter((x): x is ScanEntity[] => Array.isArray(x))
  if (okChunks.length === 0) return null
  const court = mergeCourt(detEntities, okChunks)

  // Union of per-chunk verifier rejections — applies ONLY to AI entities,
  // NEVER to deterministic ones (master prompt: det entities are ground truth).
  const allWrongKeys = new Set<string>()
  for (const s of chunkWrongKeys) for (const k of s) allWrongKeys.add(k)
  const detKeys = new Set(detEntities.map((d) => normForMergeKey(d.value)))
  if (allWrongKeys.size > 0) {
    const kept: ScanEntity[] = []
    for (const e of court.entities) {
      const k = normForMergeKey(e.value)
      if (allWrongKeys.has(k) && !detKeys.has(k)) continue
      kept.push(e)
    }
    court.entities = kept
  }

  // ── STAGE 0b: recheck the contested slice on the FAST tier ────────────
  let correctionsApplied = 0
  let recheckNote = ''
  const lowConf = court.additions.filter((e) => (e.confidence ?? 1) < 0.65).slice(0, 25)
  const conflictSlice = court.conflicts.slice(0, 25)
  if (conflictSlice.length + lowConf.length > 0) {
    const payload =
      `Document: ${evidence.originalName} (${chunks.length} chunks swept, ${court.rawAiCount} raw sightings)\n\n` +
      (conflictSlice.length
        ? `=== CONTESTED TYPE CONFLICTS (deterministic extractor vs sweep majority) ===\n${conflictSlice
            .map((c) => `- "${c.value}" | deterministic=${c.detType} | sweep=${c.aiType} (${c.aiVotes} sightings)${c.sample ? ` | context: ${c.sample}` : ''}`)
            .join('\n')}\n\n`
        : '') +
      (lowConf.length
        ? `=== LOW-CONFIDENCE ADDITIONS (confirm the type or reject the value) ===\n${lowConf
            .map((e) => `- [${e.type}] "${e.value}" (conf ${((e.confidence ?? 0.5).toFixed(2))})${e.context ? ` | context: ${e.context.slice(0, 100)}` : ''}`)
            .join('\n')}\n\n`
        : '') +
      `Adjudicate: corrections (ONLY when the evidence clearly shows a wrong type), rejected (values that are NOT real entities), missedCritical (persons/organizations the sweep missed entirely). JSON block only.`
    try {
      const raw = await localChatDetailed(
        [
          { role: 'system', content: RECHECK_SYSTEM_PROMPT },
          { role: 'user', content: payload },
        ] as Parameters<typeof localChatDetailed>[0],
        { thinking: false, json: true, maxTokens: 1_200, model: tiers.fast, tier: 'fast' },
      )
      usage.fast += 1
      const outcome = parseRecheckOutput(extractJsonObject<Record<string, unknown>>(raw.content) ?? null)
      const rejectKeys = new Set(outcome.rejected.map(normForMergeKey))
      const correctionByKey = new Map(outcome.corrections.map((c) => [normForMergeKey(c.value), c]))
      const finalEntities: ScanEntity[] = []
      for (const e of court.entities) {
        const key = normForMergeKey(e.value)
        if (rejectKeys.has(key) && !detEntities.some((d) => normForMergeKey(d.value) === key)) continue
        const corr = correctionByKey.get(key)
        if (corr && CANON_TYPE_SET.has(corr.correctType) && corr.correctType !== e.type) {
          finalEntities.push({ ...e, type: corr.correctType })
          correctionsApplied += 1
        } else {
          finalEntities.push(e)
        }
      }
      for (const m of outcome.missedCritical) {
        if (!finalEntities.some((e) => normForMergeKey(e.value) === normForMergeKey(m.value))) {
          finalEntities.push(m)
        }
      }
      court.entities = finalEntities
      recheckNote = `recheck(fast: ${outcome.corrections.length} corrections, ${outcome.rejected.length} rejected, +${outcome.missedCritical.length} critical)`
    } catch {
      // recheck unavailable — merge-court output stands
    }
  }

  const confirmedAi = court.entities.filter((e) => e.status !== 'candidate').length - Math.min(court.confirmedCount, detEntities.length)
  const strategies = [
    `fast-sweep(${chunks.length} chunk${chunks.length > 1 ? 's' : ''} × ≤${chunkBudgetTokens.toLocaleString()} tok (digit-aware), ${budget.overlapChars}-char overlap → ${court.rawAiCount} raw sightings${escalatedChunks ? `, ${escalatedChunks} std escalations` : ''})`,
    perChunkRecheck && recheckedChunks > 0
      ? `pass3-verifier(${recheckedChunks}/${chunks.length} chunks independently rechecked: +${missedRecovered} missed recovered, ${aiRejected} hallucinations flagged)`
      : null,
    `merge-court(${court.confirmedCount}/${detEntities.length} det confirmed, +${confirmedAi > 0 ? confirmedAi : court.additions.length} AI confirmed/corroborated, ${court.candidateCount} candidates KEPT for review, ${court.conflicts.length} conflicts)`,
  ].filter(Boolean) as string[]
  if (recheckNote) strategies.push(recheckNote)

  return { entities: court.entities, strategies, usage, correctionsApplied }
}

/**
 * Run the turbo enrichment pass over the chunked document. Returns the merged
 * AI output — merged IN CODE (no reduce call). Throws when the AI is
 * unreachable so the caller can mark the enrichment failed while keeping the
 * deterministic graph.
 *
 * v3.3: calls are served by the tier model chosen for this document
 * (fast/standard) with a one-shot DEEP escalation per chunk when the tier
 * model fails or emits unparseable JSON (escalate on malformed structured
 * output — never merely because the result is long).
 *
 * v3.4 RELTABLE-DIGEST: when the deterministic layer parsed the document as a
 * relationship table and that table dominates the file (coverage ≥ 70%),
 * there is nothing left for the model to EXTRACT — every entity and every
 * edge is already wired. The pass collapses to ONE compact call over the
 * table digest + entity manifest, asking only for meaning (summary, key
 * facts, indicators, classification). This is the fix for "ingested a big
 * edge list, only a fraction of entities were connected": the fraction
 * problem was the model being asked to re-emit hundreds of JSON objects.
 *
 * v3.4 OUTPUT-AWARE CHUNKING: for dense prose documents the per-chunk manifest
 * itself eats context (≈64 chars/entity), so the chunk size shrinks by the
 * manifest estimate — smaller chunks ⇒ smaller expected output per call ⇒
 * no truncation mid-array (the "fraction of entities" failure for prose).
 */
// ─────────────────────────────────────────────────────────────────────────────
// v3.7 — STAGE-2 RELATIONSHIP MAKER
// ─────────────────────────────────────────────────────────────────────────────

/** Compact numbered manifest line: `[7] person "Ravi Sharma"`. */
function numberedManifestLine(id: number, e: ScanEntity): string {
  return `[${id}] ${e.type} "${e.value.slice(0, 60)}"`
}

/** Max entities offered to the relationship maker (keeps the manifest small). */
// (v3.7.1: the flat 120-entity manifest cap was replaced by a hard character
// budget — see buildNumberedManifest / manifestBudgetFor.)

export interface RelationshipMakerResult {
  connections: ScanStoryConnection[]
  tier: ModelTier
  model: string
  escalated: boolean
  coverageNote: string
  /** v3.8 evidence-gate + chunking telemetry. */
  proven: number
  paraphrased: number
  dropped: number
  chunks: number
  mode: 'prose-ordered' | 'rowwise-patterns' | 'single'
}

/**
 * Resolve one raw maker connection against the numbered manifest.
 *
 * ID-indexed endpoints (fromId/toId) are authoritative — copying a number
 * cannot drift. Value endpoints (from/to) fall back to exact/containment
 * matching against manifest values, so models that ignore the id protocol
 * still contribute edges.
 */
function resolveMakerConnection(
  c: Record<string, unknown>,
  manifest: ScanEntity[],
  indexById: Map<number, ScanEntity>,
): { from: string; to: string } | null {
  const byIndexOrValue = (idRaw: unknown, valRaw: unknown, otherVal: unknown): string | null => {
    // 1. numeric manifest index
    const n = Number(idRaw)
    if (Number.isInteger(n) && indexById.has(n)) return indexById.get(n)!.value
    // 2. string that is bare digits → index
    const s = String(idRaw ?? '').trim()
    if (/^\d+$/.test(s) && indexById.has(parseInt(s, 10))) return indexById.get(parseInt(s, 10))!.value
    // 3. verbatim / cleaned value match against the manifest
    const v = String(valRaw ?? '').trim()
    if (!v) return null
    const lower = v.toLowerCase()
    for (const e of manifest) {
      if (e.value === v || e.value.toLowerCase() === lower) return e.value
    }
    const clean = lower.replace(/[^a-z0-9]/g, '')
    if (clean.length >= 4) {
      for (const e of manifest) {
        const ec = e.value.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (ec.length >= 4 && (ec.includes(clean) || clean.includes(ec))) return e.value
      }
    }
    return otherVal ? String(otherVal).trim() || null : null
  }
  const from = byIndexOrValue(c.fromId, c.from, c.to)
  const to = byIndexOrValue(c.toId, c.to, null)
  if (!from || !to || from === to) return null
  return { from, to }
}

/**
 * Parse the relationship-maker JSON payload into story connections.
 * Exported for unit tests.
 */
export function parseRelationshipMakerOutput(
  parsed: Record<string, unknown> | null,
  manifest: ScanEntity[],
): ScanStoryConnection[] {
  if (!parsed || !Array.isArray(parsed.connections)) return []
  const indexById = new Map<number, ScanEntity>(manifest.map((e, i) => [i + 1, e]))
  const out: ScanStoryConnection[] = []
  const seen = new Set<string>()
  for (const raw of parsed.connections) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const rel = String(c.rel ?? '').trim()
    if (!rel) continue
    const ends = resolveMakerConnection(c, manifest, indexById)
    if (!ends) continue
    const key = `${ends.from}|${ends.to}|${rel}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from: ends.from,
      to: ends.to,
      rel,
      why: String(c.why ?? '').slice(0, 300),
      evidence: String(c.evidence ?? '').trim().slice(0, 400) || undefined,
      confidence: typeof c.confidence === 'number' ? Math.min(1, Math.max(0.1, c.confidence)) : 0.8,
    })
  }
  return out
}

/**
 * Build the numbered manifest for the relationship maker under a HARD
 * character budget (v3.7.1 — was a flat 120-entity cap whose lines alone
 * could exceed the whole prompt budget on identifier-dense files).
 *
 * Hubs (persons/organizations) first — they are the connection endpoints that
 * matter most — then priority identifiers by confidence, until the budget is
 * exhausted. IDs stay contiguous 1..N so fromId/toId references are stable.
 */
function buildNumberedManifest(
  entities: ScanEntity[],
  budgetChars: number,
): { list: ScanEntity[]; text: string } {
  const usable = entities.filter((e) => !MANIFEST_SKIP_TYPES.has(e.type))
  const hubs = usable
    .filter((e) => e.type === 'person' || e.type === 'organization')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  const others = usable
    .filter((e) => e.type !== 'person' && e.type !== 'organization')
    .sort((a, b) => {
      const pa = MANIFEST_TYPE_PRIORITY.has(a.type) ? 0 : 1
      const pb = MANIFEST_TYPE_PRIORITY.has(b.type) ? 0 : 1
      return pa - pb || (b.confidence ?? 0) - (a.confidence ?? 0)
    })
  const list: ScanEntity[] = []
  const lines: string[] = []
  let used = 0
  const add = (e: ScanEntity): boolean => {
    const line = numberedManifestLine(list.length + 1, e)
    if (used + line.length + 1 > budgetChars) return false
    lines.push(line)
    used += line.length + 1
    list.push(e)
    return true
  }
  for (const h of hubs) if (!add(h)) break
  for (const o of others) {
    if (used >= budgetChars) break
    add(o)
  }
  return { list, text: lines.join('\n') }
}

/**
 * Rolling STORY-SO-FAR digest for the prose relationship maker: the actors
 * (manifest hubs) plus the LATEST connections, char-capped with the oldest
 * links evicted first. Chunk N therefore knows the names established in
 * chunk 1 — "the accused", "the deceased", pronouns all resolve.
 */
export function buildRollingDigest(
  manifest: ScanEntity[],
  connections: ScanStoryConnection[],
  capChars: number,
): string {
  const actors = manifest
    .filter((e) => e.type === 'person' || e.type === 'organization')
    .slice(0, 15)
    .map((e) => e.value)
    .join(', ')
  const actorLine = actors ? `ACTORS: ${actors}\n` : ''
  const linkLines: string[] = []
  for (let i = connections.length - 1; i >= 0 && linkLines.length < 12; i--) {
    const c = connections[i]
    linkLines.push(`${c.from} --${c.rel}--> ${c.to}`)
  }
  let text = actorLine + (linkLines.length ? `LINKS:\n${linkLines.join('\n')}` : '')
  if (text.length > capChars) text = text.slice(0, capChars)
  return text
}

/**
 * Frequency digest for ROW-WISE documents: the most frequent participants
 * (by literal occurrences in the content), so the maker can spot structure
 * patterns (funnels, hub accounts, recurring counterparties) without reading
 * every row.
 */
function participantFrequencyDigest(entities: ScanEntity[], content: string, top = 24): string {
  const candidates = entities
    .filter(
      (e) =>
        !AI_CONTEXTUAL_TYPES.has(e.type) &&
        e.type !== 'date' && e.type !== 'amount' && e.type !== 'time' &&
        e.value.length >= 4,
    )
    .slice(0, 150)
  const counted: Array<{ e: ScanEntity; n: number }> = []
  for (const e of candidates) {
    let n = 0
    let idx = content.indexOf(e.value)
    while (idx !== -1 && n < 999) {
      n += 1
      idx = content.indexOf(e.value, idx + e.value.length)
    }
    if (n > 1) counted.push({ e, n })
  }
  counted.sort((a, b) => b.n - a.n)
  if (counted.length === 0) return '(no repeated participants found)'
  return counted
    .slice(0, top)
    .map((c) => `- ${c.e.value} × ${c.n}`)
    .join('\n')
}

/**
 * STAGE 2 — the dedicated relationship maker (v3.7 → v3.8 CHUNKED).
 *
 * Entity extraction is DONE (deterministic regex + stage-0 sweep + stage-1
 * enrichment); this stage does nothing but wire relationships between the
 * canonical entities, using ID-indexed endpoints so weak models cannot typo
 * names.
 *
 * v3.8 DOC-SHAPE ROUTING:
 *   - PROSE (statements, FIRs, letters, chat narratives): the document is
 *     walked IN ORDER in overlapped standard-tier chunks. Each chunk prompt
 *     carries the GLOBAL numbered manifest (stable ids) plus a rolling
 *     STORY-SO-FAR digest, so relationships that SPAN chunks (actor named in
 *     chunk 1, connected in chunk 3) survive. A giant FIR is no longer
 *     truncated to the first ~9K chars — every chunk is wired.
 *   - ROW-WISE (bank statements, CDRs, registers): the deterministic layer
 *     already wired ~80% of the edges from the rows themselves. The maker
 *     makes ONE compact pattern call (frequency digest + row sample) for
 *     what rows cannot express: funnel/structuring patterns, hub accounts,
 *     recurring counterparties. Fast AND smart.
 *
 * EVIDENCE PROOF GATE: every kept connection must be explainable — a
 * verbatim quote verified against the text, or at minimum a concrete "why".
 * Unprovable edges are dropped and counted honestly.
 *
 * Tier policy (routing spec):
 *   - runs on STANDARD, chain-of-thought OFF (structured JSON output);
 *   - when the gate leaves ZERO usable connections on a document with
 *     ≥ 3 entities, escalates ONCE to DEEP with thinking ON — exactly the
 *     "escalation from lower tiers" job of the 7B+ tier. A deep-tier failure
 *     never discards the standard-tier result.
 */
async function runRelationshipMaker(
  evidence: { originalName: string },
  content: string,
  allEntities: ScanEntity[],
  _maxChars: number,
  modelsUsed: TierUsage,
): Promise<RelationshipMakerResult | null> {
  if (allEntities.length < 2) return null
  const { localChatDetailed, getModelProfile } = await import('@/lib/localAi')
  const tiers = await getTierAssignment()

  const stdProfile = await getModelProfile(false, tiers.standard).catch(() => null)
  const stdBudget = tierContextBudget('standard', stdProfile?.contextTokens ?? null)
  // v3.9: FORMAL deterministic structure detection (master prompt §6) —
  // zero model calls. tabular → deterministic row wiring + ONE pattern call;
  // narrative/mixed → ordered chunks with rolling story-so-far.
  const structure = detectDocumentStructure(content)
  const isProse = structure.kind !== 'tabular'

  // The HARD prompt ceiling this deployment allows for one call: the tier's
  // quality-zone budget ∩ the provider's real window budget (12K local
  // default, LOCAL_AI_MAX_INPUT_CHARS-overridable, mock-contract-compatible).
  const { getContentBudgetChars } = await import('@/lib/localAi')
  const stdCeil = Math.min(
    stdBudget.inputChars,
    (await getContentBudgetChars(undefined, tiers.standard)).maxCharsPerPrompt,
  )

  // The GLOBAL manifest is built ONCE — ids stay stable across chunks.
  const manifestBudget = Math.min(3_000, manifestBudgetFor(stdBudget.inputChars))
  const { list: manifest, text: manifestText } = buildNumberedManifest(allEntities, manifestBudget)
  if (manifest.length < 2) return null

  const header =
    `Evidence file: ${evidence.originalName}\n\n` +
    `=== NUMBERED ENTITY MANIFEST (already saved as graph nodes) ===\n${manifestText}\n`
  const evidenceRule = `\n${MAKER_EVIDENCE_RULE}\n`

  let tier: ModelTier = 'standard'
  let model = tiers.standard
  let escalated = false
  let coverageNote = ''
  const connections: ScanStoryConnection[] = []
  const seen = new Set<string>()
  const addAll = (list: ScanStoryConnection[]) => {
    for (const c of list) {
      const key = `${c.from}|${c.to}|${c.rel}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      connections.push(c)
    }
  }

  const runStd = async (userPrompt: string, label: string) => {
    try {
      const raw = await localChatDetailed(
        [
          { role: 'system', content: RELATIONSHIP_MAKER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ] as Parameters<typeof localChatDetailed>[0],
        { thinking: false, json: true, maxTokens: stdBudget.maxOutputTokens, model: tiers.standard, tier: 'standard' },
      )
      modelsUsed.standard += 1
      model = raw.model || model
      const parsed = extractJsonObject<Record<string, unknown>>(raw.content) ?? null
      if (!coverageNote && parsed) coverageNote = String(parsed.coverageNote ?? '').slice(0, 300)
      addAll(parseRelationshipMakerOutput(parsed, manifest))
    } catch (err) {
      console.warn(
        `[aiScan] relationship maker ${label} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  let mode: RelationshipMakerResult['mode'] = 'single'
  let chunkCount = 1

  if (!isProse) {
    // ── ROW-WISE documents: one compact PATTERN call ─────────────────────
    mode = 'rowwise-patterns'
    const freq = participantFrequencyDigest(allEntities, content, 24)
    const rowSample = content.slice(0, 2_000)
    await runStd(
      header +
        `This document is ROW-WISE/STRUCTURED (bank statement, CDR, register; detected deterministically — ${structure.signals.slice(0, 3).join(', ')}). Its rows were parsed deterministically — per-row edges are ALREADY wired in the knowledge graph (~80% of this document's relationships).\n\n=== MOST FREQUENT PARTICIPANTS (by document occurrences) ===\n${freq}\n\n=== ROW SAMPLE (first rows) ===\n${rowSample}\n${evidenceRule}\n` +
        `Add ONLY what individual rows cannot express: recurring counterparties (structuring/funnel patterns), hub accounts routing many rows, identifiers shared across columns (a phone number that also appears as an account holder), cross-sheet links. Respond with the JSON connections block.`,
      'rowwise-patterns',
    )
  } else {
    // ── PROSE documents: IN-ORDER chunks with rolling story-so-far ──────
    mode = 'prose-ordered'
    const rollingReserve = 1_600
    // Reserve covers the system prompt (~2.3K) + per-chunk wrapper + evidence
    // rule so the COMPOSED prompt never exceeds the hard ceiling.
    const systemReserve = RELATIONSHIP_MAKER_SYSTEM_PROMPT.length + 900
    // v3.9 TOKEN-AWARE: the chunk budget is the tier token budget (digit-aware
    // conversion) clamped by the deployment's per-call CHAR ceiling — whichever
    // is smaller. Identifier-heavy prose shrinks first (fail-small).
    const chunkBudgetTokens = Math.min(
      stdBudget.chunkBudgetTokens,
      Math.max(500, Math.floor((stdCeil - manifestText.length - rollingReserve - systemReserve) / 3)),
    )
    const chunkBudget = Math.min(
      charBudgetForTokens(content, chunkBudgetTokens),
      Math.max(3_000, stdCeil - manifestText.length - rollingReserve - systemReserve),
    )
    const chunks = planChunksOverlapped(content, chunkBudget, stdBudget.overlapChars)
    chunkCount = chunks.length
    let rolling = ''
    for (let ci = 0; ci < chunks.length; ci++) {
      const userPrompt =
        header +
        (rolling ? `\n${MAKER_ROLLING_HEADER}\n${rolling}\n` : '') +
        `\n=== DOCUMENT TEXT — CHUNK ${ci + 1} OF ${chunks.length} ===\n${chunks[ci]}\n${evidenceRule}\n` +
        `Wire every relationship this chunk asserts between manifest entities (including, via the story-so-far, actors named in EARLIER chunks). Respond with the JSON connections block.`
      await runStd(userPrompt, `chunk-${ci + 1}`)
      rolling = buildRollingDigest(manifest, connections, rollingReserve)
    }
  }

  // ── EVIDENCE PROOF GATE (v3.8) ──────────────────────────────────────────
  let gated = applyEvidenceGate(connections, content)
  let kept = gated.kept

  // ── DEEP escalation — CoT ON — when the gate left nothing usable ────────
  if (kept.length === 0 && manifest.length >= 3 && tiers.deep && tiers.deep !== tiers.standard) {
    const deepProfile = await getModelProfile(false, tiers.deep).catch(() => null)
    const deepBudget = tierContextBudget('deep', deepProfile?.contextTokens ?? null)
    const deepCeil = Math.min(
      deepBudget.inputChars,
      (await getContentBudgetChars(undefined, tiers.deep)).maxCharsPerPrompt,
    )
    const docBudget = Math.max(3_000, deepCeil - manifestText.length - 2_000)
    const docText = content.length > docBudget ? content.slice(0, docBudget) : content
    try {
      const raw = await localChatDetailed(
        [
          { role: 'system', content: RELATIONSHIP_MAKER_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              header + `\n=== DOCUMENT TEXT ===\n${docText}\n${evidenceRule}\n` +
              `Wire every relationship this document asserts between the manifest entities. Respond with the JSON connections block.`,
          },
        ] as Parameters<typeof localChatDetailed>[0],
        { thinking: true, json: true, maxTokens: 8_000, model: tiers.deep, tier: 'deep' },
      )
      const parsed = extractJsonObject<Record<string, unknown>>(raw.content) ?? null
      const deepConns = parseRelationshipMakerOutput(parsed, manifest)
      const deepGated = applyEvidenceGate(deepConns, content)
      if (deepGated.kept.length > 0 || !coverageNote) {
        kept = deepGated.kept
        gated = deepGated
        coverageNote = parsed ? String(parsed.coverageNote ?? '').slice(0, 300) : coverageNote
      }
      model = raw.model || tiers.deep
      tier = 'deep'
      escalated = true
    } catch {
      // Deep unavailable — keep the standard result (even if empty).
    }
    modelsUsed.deep += 1
  }

  return {
    connections: kept,
    tier,
    model,
    escalated,
    coverageNote,
    proven: gated.stats.proven,
    paraphrased: gated.stats.paraphrased,
    dropped: gated.stats.dropped,
    chunks: chunkCount,
    mode,
  }
}

async function runTurboEnrichment(
  db: PrismaClient,
  evidenceId: string,
  evidence: { originalName: string; mime: string | null; size: number },
  content: string,
  detEntities: ScanEntity[],
  maxCharsPerPrompt: number,
  budget: { provider: string; contextTokens: number },
  relTable: RelTableSummary | null,
): Promise<{
  chunkOuts: TurboChunkOut[]
  model: string
  strategiesUsed: string[]
  modelsUsed: TierUsage
  tier: ModelTier
}> {
  const { localChatDetailed } = await import('@/lib/localAi')
  const { strArray } = await import('@/lib/aiJson')

  const strategiesUsed: string[] = []
  const chunkOuts: TurboChunkOut[] = []
  const modelsUsed = emptyTierUsage()

  const tiers = await getTierAssignment()
  const tier = pickEnrichmentTier(content, detEntities.length)
  const tierModel = tiers[tier]
  const deepModel = tiers.deep
  const canEscalate = deepModel !== tierModel
  let model = tierModel

  // One tier-model call with one-shot deep escalation, shared by the digest
  // path and every chunk. Returns null when the output was unparseable.
  // v3.7.1: per-label output caps — a chunk's expected JSON is small, and on
  // CPU-class hardware every requested token is ~0.15s of worst-case latency.
  const callModel = async (
    label: string,
    messages: Parameters<typeof localChatDetailed>[0],
    maxTokens = 2200,
  ): Promise<{ parsed: Record<string, unknown> | null }> => {
    const callOpts = { thinking: false, json: true, maxTokens, tier } as const
    let raw: Awaited<ReturnType<typeof localChatDetailed>> | null = null
    let parsed: Record<string, unknown> | null = null
    let escalated = false
    try {
      raw = await localChatDetailed(messages, { ...callOpts, model: tierModel })
      parsed = extractJsonObject<Record<string, unknown>>(raw.content) ?? null
    } catch (tierErr) {
      if (!canEscalate || isServerLevelFailure(tierErr)) throw tierErr
      console.warn(
        `[aiScan] ${tier} tier model "${tierModel}" failed on ${label} (${tierErr instanceof Error ? tierErr.message : String(tierErr)}) — escalating to deep model "${deepModel}"`,
      )
    }
    if (!parsed && canEscalate) {
      // Unparseable/empty output on the tier model → one DEEP retry for this
      // unit (a genuinely harder passage, not a slow one). Deep tier policy:
      // chain-of-thought ON — reasoning models untangle hard passages the
      // fast/standard models return garbage for.
      try {
        raw = await localChatDetailed(messages, { ...callOpts, model: deepModel, thinking: true, maxTokens: Math.max(3000, maxTokens), tier: 'deep' })
        parsed = extractJsonObject<Record<string, unknown>>(raw.content) ?? null
        escalated = true
      } catch (deepErr) {
        if (!raw) throw deepErr
      }
    }
    if (escalated) {
      model = deepModel
      modelsUsed.deep += 1
      strategiesUsed.push(`escalated-${label}(→ deep ${deepModel})`)
    } else {
      modelsUsed[tier] += 1
    }
    model = raw?.model || model
    return { parsed }
  }

  const toChunkOut = (parsed: Record<string, unknown>): TurboChunkOut => ({
    chunkSummary: String(parsed.chunkSummary ?? ''),
    keyFacts: strArray(parsed.keyFacts),
    missedEntities: dedupeEntities(Array.isArray(parsed.missedEntities) ? (parsed.missedEntities as ScanEntity[]) : []),
    connections: Array.isArray(parsed.connections) ? (parsed.connections as ScanStoryConnection[]) : [],
    suspiciousIndicators: strArray(parsed.suspiciousIndicators),
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    classification: parsed.classification != null ? String(parsed.classification) : undefined,
    classificationConfidence: typeof parsed.classificationConfidence === 'number' ? parsed.classificationConfidence : undefined,
  })

  // ── RELTABLE-DIGEST fast path ────────────────────────────────────────────
  const digestMode = !!relTable && relTable.coverage >= 0.7 && relTable.edgeCount > 0
  if (digestMode && relTable) {
    // v3.7.1: the manifest rides under a HARD char budget — this digest used
    // to embed the full 550-line manifest (150 hubs + 400 digit-matched
    // locals ≈ 30K chars) and murder small local models on prefill.
    const manifestBudget = manifestBudgetFor(maxCharsPerPrompt)
    const manifest = buildManifestWithinBudget(detEntities, manifestBudget)
    strategiesUsed.push(
      `reltable-digest(1 call — table covers ${Math.round(relTable.coverage * 100)}% of doc, ${relTable.edgeCount} edges + ${detEntities.length} entities pre-wired deterministically; manifest ${manifest.included}/${manifest.of} entities ≤${manifestBudget.toLocaleString()} chars)`,
      `tier-routing(${tier} → ${tierModel}${canEscalate ? `, escalate → ${deepModel}` : ''})`,
    )
    await db.evidenceStage.upsert({
      where: { evidenceId_stage: { evidenceId, stage: 'ai_scan' } },
      update: { state: 'running', detail: `AI digesting relationship table (${tier})…` },
      create: { evidenceId, stage: 'ai_scan', state: 'running', detail: `AI digesting relationship table (${tier})…` },
    }).catch(() => undefined)

    const manifestText = manifest.text
    const messages = [
      { role: 'system', content: TURBO_CHUNK_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Evidence file: ${evidence.originalName}\n` +
          `This document is predominantly a STRUCTURED RELATIONSHIP TABLE. Its rows were parsed deterministically — every entity and every relationship in the table is ALREADY saved in the knowledge graph.\n\n` +
          `=== TABLE DIGEST ===\n${relTable.digest}\n\n` +
          `=== ENTITY MANIFEST (already extracted & saved — do NOT re-list these${manifest.included < manifest.of ? `; ${manifest.of - manifest.included} more omitted for prompt size` : ''}) ===\n${manifestText}\n` +
          (relTable.nonTableText
            ? `\n=== NON-TABLE TEXT (verbatim, outside the table) ===\n${relTable.nonTableText.slice(0, 3000)}\n`
            : '') +
          `\nReturn the JSON digest for the WHOLE document: chunkSummary (what this table establishes for the investigation — the key players and what the relationship pattern suggests), keyFacts, suspiciousIndicators, contradictions, classification. ` +
          `missedEntities and connections MUST be [] unless the non-table text reveals entities or links the table does not contain.`,
      },
    ] as Parameters<typeof localChatDetailed>[0]

    const { parsed } = await callModel('digest', messages, 2500)
    if (!parsed) throw new Error('relationship-table digest call returned unparseable output')
    chunkOuts.push(toChunkOut(parsed))
    return { chunkOuts, model, strategiesUsed, modelsUsed, tier }
  }

  // ── Chunked enrichment (prose documents) ──────────────────────────────────
  // v3.7.1: the per-chunk manifest gets a FIXED char share of the prompt
  // budget (hubs + locals, hard-capped). The old size ESTIMATE assumed
  // entities spread evenly across chunks — in digit-dense financial tables
  // nearly every entity "appears" in every chunk via containment, the real
  // manifest hit 550 lines, and prompts ran 2-3× over budget.
  const manifestBudget = manifestBudgetFor(maxCharsPerPrompt)
  const chunkBudget = Math.max(4_000, maxCharsPerPrompt - manifestBudget)
  const chunks = planChunks(content, chunkBudget)

  strategiesUsed.push(
    `hybrid-enrichment(${chunks.length} chunk${chunks.length > 1 ? 's' : ''} × ≤${chunkBudget.toLocaleString()} chars + manifest ≤${manifestBudget.toLocaleString()} chars, doc=${content.length.toLocaleString()} chars, ${detEntities.length} entities)`,
    `tier-routing(${tier} → ${tierModel}${canEscalate ? `, escalate → ${deepModel}` : ''})`,
  )

  // Record edges the deterministic layer already wired (rel-table rows,
  // CDR/bank/chat records) — the model must NOT restate them as connections.
  const preWired = (relTable?.edgeCount ?? 0)
  const edgeNote =
    preWired > 0 && relTable
      ? `\n=== RECORD EDGES (already extracted & saved from this document's structured rows — do NOT re-list these connections) ===\n${relTable.relMix} (${relTable.edgeCount} table rows already wired as graph edges)\n`
      : ''

  for (let ci = 0; ci < chunks.length; ci++) {
    await db.evidenceStage.upsert({
      where: { evidenceId_stage: { evidenceId, stage: 'ai_scan' } },
      update: { state: 'running', detail: `AI enriching (${tier})… chunk ${ci + 1}/${chunks.length}` },
      create: { evidenceId, stage: 'ai_scan', state: 'running', detail: `AI enriching (${tier})… chunk ${ci + 1}/${chunks.length}` },
    }).catch(() => undefined)

    const manifest = buildManifestWithinBudget(detEntities, manifestBudget, chunks[ci])
    const messages = [
      { role: 'system', content: TURBO_CHUNK_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Evidence file: ${evidence.originalName}\nCHUNK ${ci + 1} OF ${chunks.length}\n\n=== ENTITY MANIFEST (already extracted & saved — do NOT re-list these${manifest.included < manifest.of ? `; ${manifest.of - manifest.included} more omitted for prompt size` : ''}) ===\n${manifest.text}\n${edgeNote}\n--- CHUNK CONTENT ---\n${chunks[ci]}`,
      },
    ] as Parameters<typeof localChatDetailed>[0]

    const { parsed } = await callModel(`chunk-${ci + 1}`, messages)
    if (parsed) chunkOuts.push(toChunkOut(parsed))
  }

  if (chunkOuts.length === 0) throw new Error('all enrichment chunk calls failed')
  return { chunkOuts, model, strategiesUsed, modelsUsed, tier }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph hygiene — heal "0 evidence" nodes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any case entity whose value IS present in THIS evidence's content but which
 * has NO EntityLink rows shows up as a "0 evidence" dead node. Re-anchor
 * those orphans to this evidence. Returns the number of links created.
 */
export async function repairMissingEntityLinks(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  content: string,
): Promise<number> {
  const lowerContent = content.toLowerCase()
  const digitContent = lowerContent.replace(/[^0-9a-z]/g, '')
  const linkedRows = await db.entityLink.findMany({
    where: { evidence: { caseId } },
    select: { entityId: true },
    distinct: ['entityId'],
  })
  const hasAnyLink = new Set(linkedRows.map((l) => l.entityId))
  const orphans = await db.entity.findMany({
    where: { caseId, id: { notIn: [...hasAnyLink] } },
    select: { id: true, value: true, norm: true },
    take: 400,
  })
  let created = 0
  for (const o of orphans) {
    const v = String(o.value ?? '').trim()
    if (v.length < 2) continue
    const mention =
      lowerContent.includes(v.toLowerCase()) ||
      (o.norm && o.norm.length >= 4 && digitContent.includes(o.norm.toLowerCase())) ||
      (() => {
        const digits = v.replace(/[^0-9a-z]/g, '').toLowerCase()
        return digits.length >= 4 && digitContent.includes(digits)
      })()
    if (!mention) continue
    try {
      await db.entityLink.upsert({
        where: { entityId_evidenceId: { entityId: o.id, evidenceId } },
        update: {},
        create: { entityId: o.id, evidenceId },
      })
      created += 1
    } catch (err) {
      console.error('[aiScan] link repair upsert failed:', err)
    }
    if (created >= 100) break
  }
  return created
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────

export interface AiScanRunOptions {
  /** Activity-log actor label. */
  trigger?: string
}

export interface AiScanRunResult {
  scan: ScanResult
  graph: { linked: number; relationships: number; storyLinks: number; repairedLinks: number; purgedMechanical: number }
  aiAvailable: boolean
  crossLinks?: CrossLinkSummary
}

export async function runAiScanForEvidence(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  opts?: AiScanRunOptions,
): Promise<AiScanRunResult> {
  const evidence = await db.evidence.findFirst({ where: { id: evidenceId, caseId } })
  if (!evidence) throw new Error('evidence not found')

  const content = evidence.content ?? ''
  if (!content.trim()) throw new Error('evidence has no text content to scan')

  const mode = getScanMode()

  // Status → running (both the column and the pipeline stage).
  try {
    await db.evidence.update({
      where: { id: evidence.id },
      data: { aiScanStatus: 'running', aiScanError: null },
    })
  } catch (err) {
    if (isRecordGoneError(err)) throw new EvidenceDeletedError(evidence.originalName)
    throw err
  }
  await db.evidenceStage.upsert({
    where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
    update: { state: 'running', detail: 'Extracting deterministic entities…' },
    create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: 'Extracting deterministic entities…' },
  }).catch(() => undefined)

  // Legacy mechanical edges of THIS file never survive a scan.
  const purgedMechanical = await purgeMechanicalEdgesForEvidence(db, caseId, evidence.id)

  const { getContentBudgetChars, localChatDetailed } = await import('@/lib/localAi')
  const { classifyDeterministic, classificationFromAiScan, arbitrateClassification } =
    await import('@/lib/extractors/classify')

  const budget = await getContentBudgetChars(6000)

  let result!: ScanResult
  let aiAvailable = false
  let model = 'deterministic-fallback'
  let finalClass: Awaited<ReturnType<typeof classifyDeterministic>> & { source: string } | null = null

  // ── PHASE A — deterministic base (hybrid + deterministic-only modes) ─────
  let detBase: DeterministicBase | null = null
  const strategiesUsed: string[] = []

  if (mode !== 'ai-only') {
    try {
      detBase = await runDeterministicBase(db, caseId, evidence.id, evidence, content)
      strategiesUsed.push(
        `deterministic-base(${detBase.entities.length} entities, ${detBase.recordEdges} record edges, ${detBase.registryEdges} registry edges${detBase.tableEdges > 0 ? `, ${detBase.tableEdges} rel-table edges` : ''}${detBase.tableTimelineEvents > 0 ? `, ${detBase.tableTimelineEvents} timeline events` : ''})`,
      )
      if (detBase.relTable) {
        strategiesUsed.push(
          `relationship-table(${detBase.relTable.edgeCount} rows parsed directly — ${Math.round(detBase.relTable.coverage * 100)}% of doc, zero AI tokens)`,
        )
      }
      await db.evidenceStage.upsert({
        where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
        update: {
          state: 'running',
          detail: mode === 'deterministic-only'
            ? `Deterministic scan: ${detBase.linked} entities, ${detBase.recordEdges + detBase.registryEdges + detBase.tableEdges} links`
            : `Deterministic base done (${detBase.linked} entities${detBase.tableEdges > 0 ? `, ${detBase.tableEdges} table edges` : ''}) — AI enriching…`,
        },
        create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: `Deterministic base: ${detBase.linked} entities` },
      }).catch(() => undefined)

      // Persist the deterministic classification + a preliminary intel block
      // so the UI has something to show BEFORE the model call finishes.
      const detCountByType = new Map<string, number>()
      for (const e of detBase.entities) detCountByType.set(e.type, (detCountByType.get(e.type) ?? 0) + 1)
      const typeDigest = [...detCountByType.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`)
        .join(', ')
      const preliminary: ScanResult = {
        summary: `Deterministic extraction found ${detBase.entities.length} entities (${typeDigest || 'none'}) and ${detBase.recordEdges + detBase.registryEdges + detBase.tableEdges} links${detBase.tableEdges > 0 ? ` (incl. ${detBase.tableEdges} relationship-table rows read directly${detBase.tableTimelineEvents > 0 ? `, ${detBase.tableTimelineEvents} dated rows on the timeline` : ''})` : ''}.`,
        entities: detBase.entities,
        suspiciousIndicators: [],
        narrative: '',
        suggestedSteps: [],
        confidence: 'LOW',
        aiAvailable: false,
        model: 'deterministic-base',
        scannedAt: new Date().toISOString(),
        classification: detBase.classification.classification,
        classificationConfidence: detBase.classification.confidence,
        classificationSource: detBase.classification.source,
        keyFacts: [],
        contradictions: [],
        deterministicBase: {
          entities: detBase.linked,
          recordEdges: detBase.recordEdges,
          registryEdges: detBase.registryEdges,
          tableEdges: detBase.tableEdges,
          tableTimelineEvents: detBase.tableTimelineEvents,
        },
        engine: {
          provider: budget.provider,
          contextTokens: budget.contextTokens,
          budgetChars: budget.maxCharsPerPrompt,
          chunks: 0,
          strategiesUsed: [...strategiesUsed],
          mode,
        },
      }
      const intelNow = evidence.intelJson
        ? (() => { try { return JSON.parse(evidence.intelJson) as Record<string, unknown> } catch { return {} } })()
        : {}
      const ok = await updateEvidenceSafe(db, evidence.id, {
        intelJson: JSON.stringify({ ...intelNow, aiScan: preliminary }),
        classification: detBase.classification.classification,
        classificationConfidence: detBase.classification.confidence,
        classificationSource: detBase.classification.source,
      })
      if (!ok) throw new EvidenceDeletedError(evidence.originalName)
    } catch (err) {
      if (err instanceof EvidenceDeletedError) throw err
      console.error('[aiScan] deterministic base failed (continuing to AI pass):', err)
      detBase = null
    }
  }

  // ── deterministic-only mode: no AI calls at all ──────────────────────────
  if (mode === 'deterministic-only') {
    if (!detBase) throw new Error('deterministic scan produced no result')
    result = {
      summary: `Deterministic scan: ${detBase.entities.length} entities, ${detBase.recordEdges + detBase.registryEdges + detBase.tableEdges} links wired${detBase.tableEdges > 0 ? ` (incl. ${detBase.tableEdges} relationship-table rows${detBase.tableTimelineEvents > 0 ? `, ${detBase.tableTimelineEvents} timeline events` : ''})` : ''} (AI enrichment disabled via RJ_SCAN_MODE=deterministic-only).`,
      entities: detBase.entities,
      suspiciousIndicators: [],
      narrative: '',
      suggestedSteps: [],
      confidence: 'LOW',
      aiAvailable: false,
      model: 'deterministic-only',
      scannedAt: new Date().toISOString(),
      classification: detBase.classification.classification,
      classificationConfidence: detBase.classification.confidence,
      classificationSource: detBase.classification.source,
      keyFacts: [],
      contradictions: [],
      deterministicBase: {
        entities: detBase.linked,
        recordEdges: detBase.recordEdges,
        registryEdges: detBase.registryEdges,
        tableEdges: detBase.tableEdges,
        tableTimelineEvents: detBase.tableTimelineEvents,
      },
      engine: {
        provider: 'deterministic',
        contextTokens: 0,
        budgetChars: 0,
        chunks: 0,
        strategiesUsed,
        mode,
      },
    }
  }

  try {
    if (!result && mode === 'hybrid' && detBase) {
      // ── PHASE B1 (v3.8) — FAST ENTITY SWEEP → MERGE COURT → RECHECK ────
      // The ≤3B model walks the FULL document in small overlapped chunks
      // (single-purpose NER), a deterministic court reconciles the sightings
      // against the regex base, and a recheck pass adjudicates the contested
      // slice. Skipped for structured-export-dominant docs — relationship
      // TABLES (relTable coverage ≥0.7) and REGISTRY-KEYED annexures (v3.9.2:
      // XML record lists, PDF registries) already state their entities and
      // edges literally; sweeping them again only re-reads what the rows say
      // and adds hallucination surface.
      const relTableDominant = !!(detBase.relTable && detBase.relTable.edgeCount > 0 &&
        (detBase.relTable.coverage >= 0.7 || detBase.relTable.edgeCount >= 20))
      const registryDominant = detBase.registryEdges >= 20
      // v3.10: entity registers (typed inventories) state their entities
      // literally — same rationale as relTable/registry dominance.
      const entityTableDominant = (detBase.entityTable?.entities ?? 0) >= 20
      const structuredDominant = relTableDominant || registryDominant || entityTableDominant
      let sweepEntities = detBase.entities
      let sweepUsage: TierUsage | null = null
      if (!structuredDominant) {
        await db.evidenceStage.upsert({
          where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
          update: { state: 'running', detail: 'Fast-tier entity sweep (stage 0)…' },
          create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: 'Fast-tier entity sweep (stage 0)…' },
        }).catch(() => undefined)
        try {
          const sweep = await runFastEntitySweep(evidence, content, detBase.entities, (done, total) => {
            void db.evidenceStage.upsert({
              where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
              update: { state: 'running', detail: `Entity sweep (fast tier)… chunk ${done}/${total}` },
              create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: `Entity sweep (fast tier)… chunk ${done}/${total}` },
            }).catch(() => undefined)
          }, detBase.aiNoiseTokens)
          if (sweep) {
            sweepEntities = sweep.entities
            sweepUsage = sweep.usage
            strategiesUsed.push(...sweep.strategies)
          }
        } catch (sweepErr) {
          console.warn('[aiScan] fast entity sweep failed (continuing on deterministic entities):', sweepErr)
        }
      } else {
        strategiesUsed.push(
          detBase.entityTable && !detBase.relTable
            ? 'fast-sweep(skipped — entity-register rows parsed deterministically)'
            : 'fast-sweep(skipped — relationship-table rows parsed deterministically)',
        )
      }

      // ── v3.9.2 STRUCTURED EXPORTS — deterministic-complete, skip AI ──────
      // A document whose relationship rows were parsed deterministically
      // (registry-keyed annexure or relationship table, wired in phase A)
      // already states its entities and edges LITERALLY. Re-reading it with
      // the AI only paraphrases the rows into story edges (hallucination
      // surface, minutes of GLM time, precision loss). Complete from the
      // deterministic base alone — the same completion path the fail-soft
      // engine uses, minus the error wording.
      if (structuredDominant) {
        const detEdges = detBase.recordEdges + detBase.registryEdges + detBase.tableEdges
        strategiesUsed.push(
          `structured-export(${detBase.tableEdges > 0 ? `${detBase.tableEdges} relationship-table rows` : ''}${detBase.registryEdges > 0 ? `${detBase.registryEdges > 0 && detBase.tableEdges > 0 ? ' + ' : ''}${detBase.registryEdges} registry rows` : ''} parsed deterministically — AI re-read skipped: rows state their entities and edges literally)`,
        )
        result = {
          summary:
            `Structured export parsed deterministically — ${detBase.linked} entities and ${detEdges} relationships wired from this document's structured rows. ` +
            `Every edge is row-evidenced with provenance; AI re-reading was skipped because the rows already state their entities and relationships literally.`,
          entities: [], // phase A already wired the deterministic entities
          suspiciousIndicators: [],
          narrative: '',
          suggestedSteps: [],
          confidence: 'HIGH',
          aiAvailable: false,
          model: 'deterministic',
          scannedAt: new Date().toISOString(),
          classification: detBase.classification.classification,
          classificationConfidence: detBase.classification.confidence,
          classificationSource: detBase.classification.source,
          keyFacts: [],
          contradictions: [],
          deterministicBase: {
            entities: detBase.linked,
            recordEdges: detBase.recordEdges,
            registryEdges: detBase.registryEdges,
            tableEdges: detBase.tableEdges,
            tableTimelineEvents: detBase.tableTimelineEvents,
          },
          engine: {
            provider: 'deterministic',
            contextTokens: 0,
            budgetChars: 0,
            chunks: 0,
            strategiesUsed: [...strategiesUsed],
            mode: 'deterministic-only',
          },
        }
      }

      // ── PHASE B2 (hybrid) — turbo enrichment over the manifest ────────────
      // v3.3: pick the tier FIRST, then budget chunks against THAT model's
      // window (a ≤3B fast model may have a smaller context than the deep one).
      // (v3.9.2: unreachable for structuredDominant — result already set.)
      if (!result) {
      const tierAssignment = await getTierAssignment()
      const enrichmentTier = pickEnrichmentTier(content, detBase.entities.length)
      const tierBudget = await getContentBudgetChars(6000, tierAssignment[enrichmentTier])
      const { chunkOuts, model: usedModel, strategiesUsed: enrichStrategies, modelsUsed, tier: usedTier } = await runTurboEnrichment(
        db, evidence.id, evidence, content, sweepEntities, tierBudget.maxCharsPerPrompt, tierBudget, detBase.relTable,
      )
      if (sweepUsage) {
        // Fold the stage-0 sweep's model usage into the scan's tier report.
        for (const t of ['fast', 'standard', 'deep'] as const) modelsUsed[t] += sweepUsage[t]
      }
      strategiesUsed.push(...enrichStrategies)
      model = usedModel
      aiAvailable = true

      // Deterministic merge IN CODE — no reduce call, no re-emission.
      // v3.9.1: the enrichment pass re-reads the same registry tables the
      // deterministic layer already parsed — its "missed" entities go through
      // the SAME noise filter as the sweep (row refs + attribute values are
      // properties, not entities).
      const missedEntities = filterRegistryNoiseAi(
        dedupeEntities(chunkOuts.flatMap((c) => c.missedEntities)),
        detBase.entities,
        detBase.aiNoiseTokens,
      )
      const allEntities = dedupeEntities([...sweepEntities, ...missedEntities])
      const connections: ScanStoryConnection[] = []
      const connSeen = new Set<string>()
      for (const c of chunkOuts.flatMap((o) => o.connections)) {
        if (!c || !String(c.from ?? '').trim() || !String(c.to ?? '').trim() || !String(c.rel ?? '').trim()) continue
        const key = `${c.from}|${c.to}|${c.rel}`.toLowerCase()
        if (connSeen.has(key)) continue
        connSeen.add(key)
        connections.push(c)
      }
      const firstClass = chunkOuts.find((c) => c.classification)
      const aiClass = firstClass
        ? classificationFromAiScan({
            classification: firstClass.classification,
            classificationConfidence: firstClass.classificationConfidence,
          })
        : null
      const detClass = detBase.classification as Awaited<ReturnType<typeof classifyDeterministic>>
      finalClass = arbitrateClassification(aiClass ?? detClass, detClass)

      // ── PHASE C — stage-2 RELATIONSHIP MAKER (v3.8: chunked + ordered) ──
      // Entity extraction is complete (regex + stage-0 sweep + stage-1
      // enrichment); now a DEDICATED single-purpose stage wires relationships
      // between the canonical entities via ID-indexed endpoints — prose docs
      // chunk-by-chunk in order with rolling context, row-wise docs as one
      // pattern call. Skipped when the doc was already parsed as a structured
      // relationship table (its rows are wired deterministically).
      // (structuredDominant declared in Phase B1.)
      let relMaker: RelationshipMakerResult | null = null
      if (!structuredDominant && allEntities.length >= 2) {
        await db.evidenceStage.upsert({
          where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
          update: { state: 'running', detail: 'Relationship maker wiring entities (stage 2)…' },
          create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: 'Relationship maker wiring entities (stage 2)…' },
        }).catch(() => undefined)
        try {
          relMaker = await runRelationshipMaker(
            evidence, content, allEntities, tierBudget.maxCharsPerPrompt, modelsUsed,
          )
        } catch (makerErr) {
          console.warn('[aiScan] relationship maker failed (continuing with stage-1 connections):', makerErr)
        }
        if (relMaker) {
          let added = 0
          for (const c of relMaker.connections) {
            const key = `${c.from}|${c.to}|${c.rel}`.toLowerCase()
            if (connSeen.has(key)) continue
            connSeen.add(key)
            connections.push(c)
            added += 1
          }
          strategiesUsed.push(
            `relationship-maker(${relMaker.tier} → ${relMaker.model}${relMaker.escalated ? ', escalated from standard — CoT ON' : ''}; ${relMaker.mode}${relMaker.chunks > 1 ? ` × ${relMaker.chunks} ordered chunks` : ''}; +${added} edges, ${relMaker.proven} evidence-proven${relMaker.paraphrased ? `, ${relMaker.paraphrased} paraphrased` : ''}${relMaker.dropped ? `, ${relMaker.dropped} unproven dropped` : ''}${relMaker.connections.length > 0 && added === 0 ? ' (all corroborated stage-1 edges)' : ''})`,
          )
        }
      }

      result = {
        summary: chunkOuts.map((c) => c.chunkSummary).filter(Boolean).join(' ') ||
          `Hybrid scan complete — ${allEntities.length} entities (${missedEntities.length} added by AI), ${connections.length} story connections.`,
        entities: allEntities,
        suspiciousIndicators: unionStrings(chunkOuts.flatMap((c) => c.suspiciousIndicators), [], 12),
        narrative: chunkOuts.slice(0, 2).map((c) => c.chunkSummary).join(' '),
        suggestedSteps: [],
        confidence: 'MEDIUM',
        aiAvailable: true,
        model,
        scannedAt: new Date().toISOString(),
        keyFacts: unionStrings(chunkOuts.flatMap((c) => c.keyFacts), [], 12),
        contradictions: chunkOuts.flatMap((c) => c.contradictions),
        story: {
          hasStory: connections.length > 0,
          plot: chunkOuts[0]?.chunkSummary?.slice(0, 1200),
          connections: connections.slice(0, 150),
        },
        deterministicBase: {
          entities: detBase.linked,
          recordEdges: detBase.recordEdges,
          registryEdges: detBase.registryEdges,
          tableEdges: detBase.tableEdges,
          tableTimelineEvents: detBase.tableTimelineEvents,
        },
        engine: {
          provider: tierBudget.provider,
          contextTokens: tierBudget.contextTokens,
          budgetChars: tierBudget.maxCharsPerPrompt,
          chunks: chunkOuts.length,
          strategiesUsed,
          mode,
          tier: usedTier,
          modelsUsed,
        },
      }
      result.classification = finalClass.classification
      result.classificationConfidence = finalClass.confidence
      result.classificationSource = finalClass.source
      } // end Phase B2 (guarded v3.9.2 — structured exports complete deterministically)
    } else if (!result) {
      // ── ai-only mode (legacy v3.1) OR hybrid whose deterministic base
      //    failed — full AI re-extraction without a manifest. ───────────────
      const detClass = classifyDeterministic(evidence.originalName, content, {
        mime: evidence.mime,
      })
      if (mode === 'ai-only') strategiesUsed.push('ai-only(full re-extraction)')

      // v3.3: the legacy full-re-extraction path runs on the STANDARD tier
      // model (contextual extraction is its job).
      const standardModel = (await getTierAssignment()).standard
      const stdBudget = await getContentBudgetChars(6000, standardModel)
      if (standardModel !== budget.model) {
        strategiesUsed.push(`tier-routing(standard → ${standardModel})`)
      }

      let chunks = planChunks(content, stdBudget.maxCharsPerPrompt)

      let merged!: Partial<ScanResult> & {
        keyFacts?: unknown[]
        contradictions?: unknown[]
      }
      // Story connections harvested per-chunk (map-reduce fallback when the
      // reduce pass drops the story block).
      let chunkConnections: ScanStoryConnection[] = []

      if (chunks.length === 1) {
        // ── Single-pass: whole document fits the active model's window ──
        strategiesUsed.push(`single-pass(${chunks[0].length.toLocaleString()} chars, ctx=${stdBudget.contextTokens})`)
        try {
          const raw = await localChatDetailed(
            [
              { role: 'system', content: SCAN_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `Evidence file: ${evidence.originalName}\nMIME: ${evidence.mime ?? 'unknown'}\nSize: ${evidence.size} bytes\n\n--- FULL CONTENT ---\n${chunks[0]}`,
              },
            ],
            { temperature: undefined, thinking: false, json: true, maxTokens: 10000, model: standardModel, tier: 'standard' },
          )
          if (!raw.content || !raw.content.trim()) throw new Error('empty response from local AI')
          model = raw.model || model
          aiAvailable = true
          const parsed = extractJsonObject<Record<string, unknown>>(raw.content)
          if (!parsed) {
            result = {
              summary: raw.content.slice(0, 500),
              entities: detBase?.entities ?? [],
              suspiciousIndicators: [],
              narrative: raw.content.slice(0, 1000),
              suggestedSteps: [],
              confidence: 'MEDIUM',
              aiAvailable: true,
              model: `${model} (raw text)`,
              scannedAt: new Date().toISOString(),
              engine: {
                provider: stdBudget.provider,
                contextTokens: stdBudget.contextTokens,
                budgetChars: stdBudget.maxCharsPerPrompt,
                chunks: 1,
                strategiesUsed,
                mode,
                tier: 'standard',
                modelsUsed: { fast: 0, standard: 1, deep: 0 },
              },
            }
          } else {
            merged = parsed as typeof merged
          }
        } catch (singlePassErr) {
          // ── Fail-forward: re-attempt as map-reduce over SMALLER chunks ──
          const fallbackChunkChars = Math.max(4000, Math.floor(stdBudget.maxCharsPerPrompt / 2))
          const rechunked = planChunks(content, fallbackChunkChars)
          if (rechunked.length <= 1) throw singlePassErr
          console.warn(
            `[aiScan] single-pass scan failed (${singlePassErr instanceof Error ? singlePassErr.message : String(singlePassErr)}) — ` +
              `falling back to map-reduce over ${rechunked.length} × ≤${fallbackChunkChars.toLocaleString()}-char chunks`,
          )
          strategiesUsed.push(`single-pass-failed → re-chunk(${rechunked.length} × ≤${fallbackChunkChars.toLocaleString()})`)
          chunks = rechunked
        }
      }

      if (!result && chunks.length > 1) {
        // ── Map-reduce: chunk passes + reduce ──
        strategiesUsed.push(
          `map-reduce(${chunks.length} chunks × ≤${stdBudget.maxCharsPerPrompt.toLocaleString()} chars, doc=${content.length.toLocaleString()} chars)`,
        )
        const chunkOuts: Array<{
          chunkSummary: string
          keyFacts: unknown[]
          entities: ScanEntity[]
          connections?: ScanStoryConnection[]
          suspiciousIndicators: unknown[]
          contradictions: unknown[]
        }> = []
        const { strArray } = await import('@/lib/aiJson')

        for (let ci = 0; ci < chunks.length; ci++) {
          await db.evidenceStage.upsert({
            where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
            update: { state: 'running', detail: `AI analyzing… chunk ${ci + 1}/${chunks.length}` },
            create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: `AI analyzing… chunk ${ci + 1}/${chunks.length}` },
          }).catch(() => undefined)
          const raw = await localChatDetailed(
            [
              { role: 'system', content: CHUNK_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `Evidence file: ${evidence.originalName}\nCHUNK ${ci + 1} OF ${chunks.length}\n\n--- CHUNK CONTENT ---\n${chunks[ci]}`,
              },
            ],
            { thinking: false, json: true, maxTokens: 10000, model: standardModel, tier: 'standard' },
          )
          model = raw.model || model
          aiAvailable = true
          const parsed = extractJsonObject<Record<string, unknown>>(raw.content)
          if (parsed) {
            chunkOuts.push({
              chunkSummary: String(parsed.chunkSummary ?? ''),
              keyFacts: strArray(parsed.keyFacts),
              entities: dedupeEntities(Array.isArray(parsed.entities) ? (parsed.entities as ScanEntity[]) : []),
              connections: Array.isArray(parsed.connections) ? (parsed.connections as ScanStoryConnection[]) : [],
              suspiciousIndicators: strArray(parsed.suspiciousIndicators),
              contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
            })
          }
        }

        if (chunkOuts.length === 0) throw new Error('all chunk scans failed')
        chunkConnections = chunkOuts.flatMap((c) => c.connections ?? [])

        // Reduce: merge digest into the full product.
        const digest = chunkOuts
          .map((c, i) => `CHUNK ${i + 1}: ${c.chunkSummary}\nFacts:\n${c.keyFacts.map((f) => `- ${String(f).slice(0, 220)}`).join('\n')}`)
          .join('\n\n')
        const allEntities = dedupeEntities(chunkOuts.flatMap((c) => c.entities))
        const indicatorPool = unionStrings(
          chunkOuts.flatMap((c) => c.suspiciousIndicators),
          [],
          12,
        )
        const manifest = allEntities
          .slice(0, 400)
          .map((e) => `- [${e.type}] ${e.value}`)
          .join('\n')
        await db.evidenceStage.upsert({
          where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
          update: { state: 'running', detail: `AI analyzing… merging ${chunks.length} chunks` },
          create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'running', detail: `AI analyzing… merging ${chunks.length} chunks` },
        }).catch(() => undefined)
        const reduceRaw = await localChatDetailed(
          [
            { role: 'system', content: SCAN_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `The full "${evidence.originalName}" document was scanned in ${chunks.length} chunks. Below is the merged per-chunk intelligence. Produce the FINAL consolidated report about the whole document.\n\n=== MERGED ENTITY MANIFEST (${allEntities.length}${allEntities.length > 400 ? `, first 400 of ${allEntities.length} shown` : ''}) ===\n${manifest}\n\n=== PER-CHUNK SUMMARIES & FACTS ===\n${digest.slice(0, 24000)}\n\nFINAL-PASS RULES:\n- The manifest above is ALREADY saved as this file's entities. Your "entities" array must contain ONLY critical entities the chunks MISSED (use [] when the manifest is already complete) — do NOT repeat manifest values.\n- Keep the story block: connect the actors ACROSS chunks with the allowed verbs; every connection cites its "why" from the document.\n- Produce exactly the JSON structure requested.`,
            },
          ],
          { thinking: false, maxTokens: 6000, json: true, model: standardModel, tier: 'standard' },
        )
        const reduced = extractJsonObject<Record<string, unknown>>(reduceRaw.content)
        if (reduced) {
          const reducedEntities = Array.isArray(reduced.entities) ? (reduced.entities as ScanEntity[]) : []
          merged = {
            ...reduced,
            entities: dedupeEntities([...allEntities, ...reducedEntities]),
          } as typeof merged
        } else {
          merged = {
            summary: chunkOuts.map((c) => c.chunkSummary).join(' '),
            narrative: '',
            entities: allEntities,
            suspiciousIndicators: indicatorPool,
            suggestedSteps: [],
            confidence: 'MEDIUM',
            keyFacts: unionStrings(chunkOuts.flatMap((c) => c.keyFacts), [], 12),
            contradictions: chunkOuts.flatMap((c) => c.contradictions),
          }
        }
        if (!merged.entities?.length && allEntities.length) {
          merged.entities = allEntities
        }
        if (!merged.suspiciousIndicators?.length && indicatorPool.length) {
          merged.suspiciousIndicators = indicatorPool
        }
      }

      if (!result) {
        // ── Shared single/chunked post-processing ──
        const aiClass = classificationFromAiScan(merged as Record<string, unknown>)
        finalClass = arbitrateClassification(aiClass ?? { ...detClass, source: 'deterministic' }, detClass)
        result = {
          summary: String(merged.summary ?? ''),
          entities: dedupeEntities(Array.isArray(merged.entities) ? (merged.entities as ScanEntity[]) : []),
          suspiciousIndicators: strArrayOf(merged.suspiciousIndicators),
          narrative: String(merged.narrative ?? ''),
          suggestedSteps: strArrayOf(merged.suggestedSteps),
          confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(String(merged.confidence ?? '').toUpperCase())
            ? String(merged.confidence).toUpperCase()
            : 'MEDIUM',
          aiAvailable: true,
          model,
          scannedAt: new Date().toISOString(),
          engine: {
            provider: stdBudget.provider,
            contextTokens: stdBudget.contextTokens,
            budgetChars: stdBudget.maxCharsPerPrompt,
            chunks: chunks.length,
            strategiesUsed,
            mode,
            tier: 'standard',
            modelsUsed: { fast: 0, standard: chunks.length + 1, deep: 0 },
          },
        }
        result.classification = finalClass.classification
        result.classificationConfidence = finalClass.confidence
        result.classificationSource = finalClass.source
        result.keyFacts = strArrayOf(merged.keyFacts)
        result.contradictions = Array.isArray(merged.contradictions) ? merged.contradictions : []
        // Story block — validated & coerced.
        const rawStory = merged.story as Partial<ScanStory> | undefined
        const connSeen = new Set<string>()
        const connections: ScanStoryConnection[] = []
        const pushConn = (c: unknown): void => {
          const cc = c as ScanStoryConnection
          if (!cc || !String(cc.from ?? '').trim() || !String(cc.to ?? '').trim() || !String(cc.rel ?? '').trim()) return
          const key = `${cc.from}|${cc.to}|${cc.rel}`.toLowerCase()
          if (connSeen.has(key)) return
          connSeen.add(key)
          connections.push(cc)
        }
        if (Array.isArray(rawStory?.connections)) {
          for (const c of rawStory!.connections as ScanStoryConnection[]) pushConn(c)
        }
        if (chunks.length > 1) {
          for (const c of chunkConnections) pushConn(c)
        }
        result.story = {
          hasStory: connections.length > 0 || rawStory?.hasStory === true,
          plot: String(rawStory?.plot ?? '').slice(0, 1200) || undefined,
          connections: connections.slice(0, 150),
        }
      }
    }
  } catch (err) {
    if (err instanceof EvidenceDeletedError) throw err
    // ── Enrichment failure: keep the deterministic graph (hybrid) ──────────
    //
    // v3.7.1 FAIL-SOFT: when the deterministic layer already wired structured
    // edges (bank trails / CDRs / relationship tables — the file's ENTIRE
    // evidentiary value), a dead or too-slow model must not mark the whole
    // scan "failed". The scan completes with the deterministic graph plus an
    // honest "AI summary unavailable" note; only files with NO deterministic
    // edges fail hard (nothing else would be on the graph at all).
    const msg = err instanceof Error ? err.message : String(err)
    const detEdges = detBase
      ? detBase.recordEdges + detBase.registryEdges + detBase.tableEdges
      : 0
    const salvage = !!detBase && detEdges > 0
    console.error(
      `[aiScan] AI enrichment failed for "${evidence.originalName}"${detBase ? ' (deterministic base kept)' : ''}:`,
      msg,
      salvage ? '— fail-soft: deterministic edges present, completing scan without AI summary' : '',
    )

    if (salvage && detBase) {
      strategiesUsed.push(
        `enrichment-unavailable(model error — deterministic graph complete: ${detEdges} edges; summary skipped)`,
      )
      result = {
        summary:
          `Deterministic extraction complete — ${detBase.linked} entities and ${detEdges} relationships wired from this file's structured rows` +
          `${detBase.tableEdges > 0 ? ` (incl. ${detBase.tableEdges} table rows read directly)` : ''}. ` +
          `AI summary/indicators unavailable (local model error or timeout); the knowledge graph for this file is unaffected.`,
        entities: [], // det entities are already wired by phase A — no re-wiring
        suspiciousIndicators: [],
        narrative: '',
        suggestedSteps: [],
        confidence: 'LOW',
        aiAvailable: false,
        model: 'deterministic-base (AI enrichment unavailable)',
        scannedAt: new Date().toISOString(),
        classification: detBase.classification.classification,
        classificationConfidence: detBase.classification.confidence,
        classificationSource: detBase.classification.source,
        keyFacts: [],
        contradictions: [],
        enrichmentError: msg.slice(0, 500),
        deterministicBase: {
          entities: detBase.linked,
          recordEdges: detBase.recordEdges,
          registryEdges: detBase.registryEdges,
          tableEdges: detBase.tableEdges,
          tableTimelineEvents: detBase.tableTimelineEvents,
        },
        engine: {
          provider: budget.provider,
          contextTokens: budget.contextTokens,
          budgetChars: budget.maxCharsPerPrompt,
          chunks: 0,
          strategiesUsed: [...strategiesUsed],
          mode,
        },
      }
      // Record the enrichment error next to the deterministic results, mark
      // the scan COMPLETE (graph value is intact), and finish the stage.
      const fresh = await db.evidence
        .findUnique({ where: { id: evidence.id }, select: { intelJson: true } })
        .catch(() => null)
      const intelNow = fresh?.intelJson
        ? (() => { try { return JSON.parse(fresh.intelJson) as Record<string, unknown> } catch { return {} } })()
        : {}
      const prelim = (intelNow.aiScan ?? {}) as Record<string, unknown>
      const ok = await updateEvidenceSafe(db, evidence.id, {
        aiScanStatus: 'complete',
        aiScanError: null,
        aiScanFinishedAt: new Date(),
        intelJson: JSON.stringify({
          ...intelNow,
          aiScan: { ...prelim, enrichmentError: msg.slice(0, 500) },
        }),
      })
      if (!ok) throw new EvidenceDeletedError(evidence.originalName)
      await db.evidenceStage.upsert({
        where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
        update: { state: 'complete', detail: `Deterministic scan complete (${detBase.linked} entities, ${detEdges} edges) — AI summary unavailable (model error/timeout)` },
        create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'complete', detail: `Deterministic scan complete — AI summary unavailable` },
      }).catch(() => undefined)
      const { logActivity } = await import('@/lib/api/helpers')
      await logActivity(
        db, caseId,
        `Scanned "${evidence.originalName}" deterministically — ${detBase.linked} entities, ${detEdges} relationships wired. AI summary unavailable (local model error/timeout): ${msg.slice(0, 140)}`,
      ).catch(() => undefined)
      // NOTE: `result` is set — execution falls through to the shared
      // persistence tail below (intel merge, cross-links), which for this
      // degraded shape is a no-op for entities/story but still runs
      // cross-file linking against the deterministic graph.
    } else {
      if (detBase) {
        // Re-read the row: phase A already wrote the preliminary intel block,
        // and the in-memory `evidence` still holds the pre-scan snapshot.
        const fresh = await db.evidence
          .findUnique({ where: { id: evidence.id }, select: { intelJson: true } })
          .catch(() => null)
        const intelNow = fresh?.intelJson
          ? (() => { try { return JSON.parse(fresh.intelJson) as Record<string, unknown> } catch { return {} } })()
          : {}
        const prelim = (intelNow.aiScan ?? {}) as Record<string, unknown>
        const ok = await updateEvidenceSafe(db, evidence.id, {
          aiScanStatus: 'failed',
          aiScanError: `AI enrichment failed — deterministic results kept. ${msg.slice(0, 380)}`,
          aiScanFinishedAt: new Date(),
          intelJson: JSON.stringify({
            ...intelNow,
            aiScan: { ...prelim, enrichmentError: msg.slice(0, 500) },
          }),
        })
        if (!ok) throw new EvidenceDeletedError(evidence.originalName)
      } else {
        const ok = await updateEvidenceSafe(db, evidence.id, {
          aiScanStatus: 'failed',
          aiScanError: msg.slice(0, 500),
          aiScanFinishedAt: new Date(),
        })
        if (!ok) throw new EvidenceDeletedError(evidence.originalName)
      }
      await db.evidenceStage.upsert({
        where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
        update: { state: 'failed', detail: detBase ? `AI enrichment failed — ${detBase.linked} deterministic entities kept. ${msg.slice(0, 160)}` : msg.slice(0, 300) },
        create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'failed', detail: msg.slice(0, 300) },
      }).catch(() => undefined)
      const { logActivity } = await import('@/lib/api/helpers')
      await logActivity(
        db, caseId,
        detBase
          ? `AI enrichment FAILED for "${evidence.originalName}" — deterministic graph kept (${detBase.linked} entities, ${detBase.recordEdges + detBase.registryEdges} record links). Reason: ${msg.slice(0, 160)}`
          : `AI scan FAILED for "${evidence.originalName}" — no entities wired. Reason: ${msg.slice(0, 160)}`,
      ).catch(() => undefined)
      throw new Error(`AI scan failed: ${msg}`)
    }
  }

  const existingIntel = evidence.intelJson
    ? (() => {
        try { return JSON.parse(evidence.intelJson) as Record<string, unknown> } catch { return {} }
      })()
    : {}

  // Persist classification whenever the AI produced/finalized one.
  if (finalClass && aiAvailable) {
    const ok = await updateEvidenceSafe(db, evidence.id, {
      classification: finalClass.classification,
      classificationConfidence: finalClass.confidence,
      classificationSource: finalClass.source,
    })
    if (!ok) throw new EvidenceDeletedError(evidence.originalName)
  }

  // Persist AI-flagged contradictions.
  const { persistAiContradictions } = await import('@/lib/investigation/contradictionEngine')
  if (aiAvailable && Array.isArray(result.contradictions)) {
    try {
      await persistAiContradictions(db, caseId, evidence.id, result.contradictions)
    } catch {
      /* non-fatal */
    }
  }

  const updatedIntel: Record<string, unknown> = {
    ...existingIntel,
    aiScan: result,
  }

  const ok1 = await updateEvidenceSafe(db, evidence.id, {
    intelJson: JSON.stringify(updatedIntel),
    // v3.6 fix: never overwrite a REAL OCR state ('ocr-complete',
    // 'ocr-failed', …) set by the parser — the old code stomped image/
    // scanned-PDF evidence to 'ai-scanned', hiding the OCR provenance.
    ocrStatus:
      evidence.ocrStatus && evidence.ocrStatus !== 'n/a'
        ? evidence.ocrStatus
        : aiAvailable
          ? 'ai-scanned'
          : (evidence.ocrStatus ?? 'n/a'),
  })
  if (!ok1) throw new EvidenceDeletedError(evidence.originalName)

  // Wire AI-extracted entities + story relationships into the knowledge graph.
  const rawEntities = result.entities as unknown as Array<Record<string, unknown>>
  const storyConnections = (result.story?.connections ?? []).filter(
    (c) => c && String(c.from ?? '').trim() && String(c.to ?? '').trim(),
  )
  let graphWiring = {
    linked: 0, relationships: 0, storyLinks: 0, repairedLinks: 0, purgedMechanical,
  }
  let resolved: WiredEntity[] = []
  if (result.entities.length > 0) {
    try {
      const w = await wireEntitiesIntoGraph(
        db,
        caseId,
        evidence.id,
        rawEntities,
        Math.max(result.entities.length, 24),
        { source: aiAvailable ? 'ai-scan' : 'deterministic-extract', defaultConfidence: 0.75 },
      )
      resolved = w.resolved
      graphWiring.linked = Math.max(w.linked, detBase?.linked ?? 0)
      const s = await wireStoryConnections(
        db, caseId, evidence.id, evidence.originalName,
        storyConnections, resolved, rawEntities,
      )
      graphWiring.storyLinks = s.created
      graphWiring.relationships = s.created + (detBase ? detBase.recordEdges + detBase.registryEdges : 0)
      if (s.skipped > 0) {
        console.warn(
          `[aiScan] story wiring skipped ${s.skipped}/${storyConnections.length} connections (unresolved endpoints/dupes — v3.6 keeps novel evidence-derived verbs, so skips are endpoint/dupe issues only)`,
        )
      }
    } catch (err) {
      if (err instanceof EvidenceDeletedError) throw err
      console.error('[aiScan] graph wiring failed:', err)
    }
  }

  // Degraded (fail-soft) path: entities were wired by phase A and the
  // result carries none, so surface the deterministic wiring numbers and
  // keep cross-file linking alive via the phase-A resolved list.
  if (result.entities.length === 0 && detBase) {
    graphWiring.linked = detBase.linked
    graphWiring.relationships = detBase.recordEdges + detBase.registryEdges + detBase.tableEdges
  }
  const resolvedForCross = resolved.length > 0 ? resolved : (detBase?.resolved ?? [])

  // Graph hygiene — self-healing evidence links (kills "0 evidence" nodes).
  try {
    graphWiring.repairedLinks = await repairMissingEntityLinks(
      db, caseId, evidence.id, content,
    )
  } catch (err) {
    console.error('[aiScan] link repair failed:', err)
  }

  // ── Cross-document "connecting the dots" ──
  // v3.6: Layers 1a/1b of connectScanToCase are DETERMINISTIC (merge
  // detection + alias linking) and now run even when no AI model is
  // reachable — cross-file identity merges are the heart of multi-file
  // network analysis and must not depend on model availability. Only the
  // AI-inference layer (Layer 2) is gated on aiAvailable.
  let crossLinks: CrossLinkSummary | undefined
  if (resolvedForCross.length > 0) {
    try {
      const { connectScanToCase } = await import('@/lib/investigation/crossConnect')
      const cl = await connectScanToCase(db, caseId, evidence.id, evidence.originalName, {
        summary: result.summary,
        narrative: result.narrative,
        keyFacts: result.keyFacts ?? [],
        entities: result.entities.map((e) => ({ type: e.type, value: e.value })),
        suspiciousIndicators: result.suspiciousIndicators,
      }, resolved, { aiEnabled: aiAvailable })
      crossLinks = cl
      updatedIntel.aiScan = {
        ...result,
        crossLinks: {
          mergeEvents: cl.mergeEvents,
          aliasLinks: cl.aliasLinks,
          accepted: cl.accepted,
          rejected: cl.rejected,
          links: cl.links.slice(0, 30),
          mergedWithFiles: cl.mergedWithFiles ?? [],
          caseInterpretation: cl.caseInterpretation,
          newLeads: cl.newLeads ?? [],
          notes: cl.notes,
        },
      }
      const ok2 = await updateEvidenceSafe(db, evidence.id, {
        intelJson: JSON.stringify(updatedIntel),
      })
      if (!ok2) throw new EvidenceDeletedError(evidence.originalName)
    } catch (err) {
      if (err instanceof EvidenceDeletedError) throw err
      console.error('[aiScan] cross-connect failed:', err)
    }
  }

  // ── v3.10 Cross-file reference stitching ────────────────────────────────
  // Multi-file cases reference the same object through different spellings:
  // the master inventory names it ("Rohan Kale", tableId PER-002) while other
  // exports speak only the token ("PER-002"). Deterministic GROUP-BY over the
  // reference tokens merges the fragments — typed/name nodes win over bare
  // id placeholders, edges re-point, evidence links accumulate.
  let stitchStats: { mergedEntities: number; groupsConsidered: number } | undefined
  try {
    const { stitchCaseReferences } = await import('@/lib/investigation/referenceStitch')
    const st = await stitchCaseReferences(db, caseId)
    if (st.mergedEntities > 0) {
      stitchStats = { mergedEntities: st.mergedEntities, groupsConsidered: st.groupsConsidered }
      console.log(
        `[referenceStitch] ${st.mergedEntities} entities merged across ${st.groupsConsidered} reference groups ` +
        `(${st.movedEdges} edges re-pointed, ${st.collapsedEdges} collapsed, ${st.movedLinks} evidence links moved)`,
      )
    }
  } catch (err) {
    console.error('[aiScan] reference stitching failed:', err)
  }

  // ── Finalize status ──
  const ok3 = await updateEvidenceSafe(db, evidence.id, {
    aiScanStatus: 'complete',
    aiScanError: null,
    aiScanFinishedAt: new Date(),
  })
  if (!ok3) throw new EvidenceDeletedError(evidence.originalName)
  await db.evidenceStage.upsert({
    where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'ai_scan' } },
    update: { state: 'complete', detail: `${result.model}${result.engine?.mode ? ` · ${result.engine.mode}` : ''}` },
    create: { evidenceId: evidence.id, stage: 'ai_scan', state: 'complete', detail: result.model },
  }).catch(() => undefined)

  // ── Refresh case analytics with the freshly wired graph ──────────────────
  if (graphWiring.linked > 0 || graphWiring.relationships > 0) {
    try {
      const { runAnalyticsAndPersist } = await import('@/lib/api/helpers')
      await runAnalyticsAndPersist(db, caseId)
    } catch (err) {
      console.error('[aiScan] post-scan analytics refresh failed:', err)
    }
  }

  const { logActivity } = await import('@/lib/api/helpers')
  await logActivity(
    db,
    caseId,
    `AI scanned "${evidence.originalName}" (${opts?.trigger ?? 'manual'}) — ${result.entities.length} entities, ${result.suspiciousIndicators.length} indicators${result.story?.connections?.length ? `, story: ${result.story.connections.length} connections` : ''}, +${graphWiring.linked} graph nodes, +${graphWiring.relationships} links, ${graphWiring.purgedMechanical} mechanical edges purged, ${graphWiring.repairedLinks} links repaired${stitchStats ? `, ${stitchStats.mergedEntities} cross-file reference merges` : ''} [engine: ${result.engine?.mode ?? '?'} · ${result.engine?.provider ?? '?'}${detBase ? `, deterministic base: ${detBase.linked} entities + ${detBase.recordEdges + detBase.registryEdges} record edges` : ''}]`,
  ).catch(() => undefined)

  return { scan: result, graph: graphWiring, aiAvailable, crossLinks }
}

// ─────────────────────────────────────────────────────────────────────────────
// Automatic post-upload trigger — serialized in-process queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local AI servers process one generation at a time, so scans are serialized
 * through a single promise chain. Every scan marks the row queued → running →
 * complete/failed, and the UI polls the evidence list for those statuses.
 */
const scanQueue = new Map<string, Promise<void>>() // caseId → tail promise

export function queueAiScan(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  opts?: AiScanRunOptions,
): void {
  // Escape hatch for deterministic test suites / manual-only deployments:
  // when set, uploads stay in 'pending' until someone presses AI Scan.
  if (process.env.RJ_DISABLE_AUTO_SCAN === '1') return
  const tail = scanQueue.get(caseId) ?? Promise.resolve()
  const run = tail
    .catch(() => undefined)
    .then(async () => {
      // Mark queued immediately so the UI sees the upcoming work.
      await db.evidence.update({
        where: { id: evidenceId },
        data: { aiScanStatus: 'queued', aiScanError: null },
      }).catch(() => undefined)
      try {
        await runAiScanForEvidence(db, caseId, evidenceId, opts)
      } catch (err) {
        if (err instanceof EvidenceDeletedError) {
          // The investigator deleted the file while it was being scanned
          // (common when a slow model made it look stuck) — nothing left to
          // update; abort quietly instead of crashing with Prisma P2025.
          console.log(`[aiScan] ${err.message} — scan aborted`)
          return
        }
        // Status already recorded inside the engine; keep the server alive.
        console.error('[aiScan] queued scan failed:', err instanceof Error ? err.message : err)
      }
    })
  scanQueue.set(caseId, run)
  // Housekeeping: drop the tail once it settles.
  void run.finally(() => {
    if (scanQueue.get(caseId) === run) scanQueue.delete(caseId)
  })
}

/** Purge mechanical CO_OCCURRED edges tied to ONE evidence — runs before
 *  every (re)scan so a re-analyzed file replaces its legacy hairball with the
 *  deliberate connections only. */
async function purgeMechanicalEdgesForEvidence(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
): Promise<number> {
  try {
    const res = await db.relationship.deleteMany({
      where: {
        caseId,
        evidenceId,
        type: 'CO_OCCURRED',
        provenance: { in: [...MECHANICAL_PROVENANCES] },
      },
    })
    if (res.count > 0) {
      console.log(`[aiScan] purged ${res.count} mechanical CO edges for evidence ${evidenceId}`)
    }
    return res.count
  } catch (err) {
    console.error('[aiScan] mechanical edge purge failed:', err)
    return 0
  }
}
