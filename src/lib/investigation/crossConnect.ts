/**
 * crossConnect.ts — Cross-document "connecting the dots" engine.
 *
 * Called after a file's AI scan (and AFTER aiEntities→graph wiring), this
 * engine grows the case graph across file boundaries:
 *
 *   LAYER 1a — MERGE-EVENT DETECTION (deterministic)
 *     The scan route already reuses/merges AI-extracted entities into the
 *     case graph by normalized identity. Here we DETECT which of those
 *     entities were already known from EARLIER evidence — each such overlap
 *     is a "dot connected" between files, reported so investigators can see
 *     exactly which facts tie documents together.
 *
 *   LAYER 1b — ALIAS LINKING (deterministic)
 *     Fuzzy name resolution ("Rahul" ⊂ "Rahul Sharma", "M/s Globex Traders"
 *     ≈ "Globex Trad"). When two DISTINCT entities refer to the same actor,
 *     a SHARED_IDENTIFIER alias edge is created between their ids.
 *
 *   LAYER 2 — AI CROSS-DOCUMENT INFERENCE
 *     The model receives THIS file's key facts plus a compact roster of the
 *     existing case entities and proposes cross-document relationships
 *     constrained to roster ids. Each proposal carries rationale +
 *     confidence; results are validated against real roster ids, de-duped,
 *     and persisted with provenance 'ai-crosslink'.
 */

import type { PrismaClient } from '@prisma/client'
import { extractJsonObject } from '@/lib/aiJson'
import { normalizeAiRelVerb } from './relVocabulary'

export interface CrossLinkRecord {
  src: string
  dst: string
  type: string
  method: 'fuzzy-identity' | 'ai-crosslink'
  rationale?: string
  confidence?: number
}

export interface CrossLinkSummary {
  /** Entities of this file already known from earlier evidence (dot joins). */
  mergeEvents: number
  aliasLinks: number
  aiProposals: number
  accepted: number
  rejected: number
  links: CrossLinkRecord[]
  mergedWithFiles?: string[]
  notes: string[]
  caseInterpretation?: string
  newLeads?: string[]
}

/** Entity types whose identity = normalized value. */
const NAME_TYPES = new Set(['person', 'organization'])

function tokens(name: string): Set<string> {
  return new Set(
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  )
}

/**
 * Fuzzy name similarity — token-set ratio with containment bonus.
 * Designed for aliases like "Rahul" vs "Rahul Sharma".
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  const union = new Set([...ta, ...tb]).size
  if (!union) return 0
  let jaccard = inter / union
  // Containment: single-token alias of a multi-token name.
  const smaller = Math.min(ta.size, tb.size)
  const larger = Math.max(ta.size, tb.size)
  if (inter === smaller && smaller < larger) jaccard = Math.max(jaccard, 0.72 + 0.05 * inter)
  // Same initials + one token equal helps short forms ("r kumar"/"rahul kumar").
  return Math.min(1, jaccard)
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1a — merge-event detection
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedScanEntity {
  inputIndex: number
  entityId: string
  value: string
}

async function detectMergeEvents(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  resolved: ResolvedScanEntity[],
): Promise<{ merges: number; files: string[] }> {
  const fileSet = new Map<string, true>()
  let merges = 0
  for (const r of resolved.slice(0, 60)) {
    try {
      const others = await db.entityLink.findMany({
        where: { entityId: r.entityId, evidenceId: { not: evidenceId } },
        select: { evidenceId: true },
        take: 8,
      })
      if (others.length > 0) {
        merges += 1
        for (const o of others) fileSet.set(o.evidenceId, true)
      }
    } catch {
      /* non-fatal */
    }
  }
  const fileRows =
    fileSet.size > 0
      ? await db.evidence.findMany({
          where: { id: { in: [...fileSet.keys()] }, caseId },
          select: { originalName: true },
        })
      : []
  return { merges, files: fileRows.map((f) => f.originalName) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1b — alias linking between distinct entities
// ─────────────────────────────────────────────────────────────────────────────

async function linkAliases(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  resolved: ResolvedScanEntity[],
  summary: CrossLinkSummary,
): Promise<number> {
  const scanNameEntities = resolved.filter((r) => r.value.length >= 4)
  if (!scanNameEntities.length) return 0

  const candidates = await db.entity.findMany({
    where: { caseId, type: { in: [...NAME_TYPES] } },
    select: { id: true, type: true, value: true },
    take: 4000,
  })
  const candById = new Map(candidates.map((c) => [c.id, c]))

  const existingEdges = await db.relationship.findMany({
    where: { caseId, type: 'SHARED_IDENTIFIER' },
    select: { srcId: true, dstId: true, metadataJson: true },
    take: 6000,
  })
  const edgeSet = new Set(existingEdges.map((e) => `${e.srcId}|${e.dstId}`))

  let created = 0
  for (const s of scanNameEntities) {
    const sVal = s.value
    const sInfo = candById.get(s.entityId)
    if (!sInfo) continue
    for (const c of candidates) {
      if (c.id === s.entityId || c.type !== sInfo.type) continue
      const sim = nameSimilarity(sVal, c.value)
      const threshold = Math.min(sVal.length, c.value.length) <= 6 ? 0.78 : 0.7
      if (sim < threshold) continue
      const [a, b] = [s.entityId, c.id].sort()
      if (edgeSet.has(`${a}|${b}`)) continue

      // Verify the pair is not already directly adjacent by another edge.
      const adjacency = await db.relationship.count({
        where: { caseId, OR: [{ srcId: a, dstId: b }, { srcId: b, dstId: a }] },
      })
      if (adjacency > 0) continue

      try {
        await db.relationship.create({
          data: {
            caseId,
            srcId: a,
            dstId: b,
            type: 'SHARED_IDENTIFIER',
            weight: 1,
            confidence: sim,
            evidenceRef: evidenceName,
            evidenceId,
            provenance: 'alias-resolution',
            extractionMethod: 'hybrid',
            metadataJson: JSON.stringify({
              kind: 'name-alias',
              similarity: Number(sim.toFixed(3)),
              note: `"${sVal}" and "${c.value}" appear to denote the same ${sInfo.type}`,
            }),
          },
        })
        edgeSet.add(`${a}|${b}`)
        created += 1
        summary.links.push({
          src: sVal,
          dst: c.value,
          type: 'SHARED_IDENTIFIER',
          method: 'fuzzy-identity',
          rationale: `Alias/variant of the same ${sInfo.type} (similarity ${sim.toFixed(2)})`,
          confidence: sim,
        })
        summary.aliasLinks = created
      } catch (err) {
        console.error('[crossConnect] alias link failed:', err)
      }
    }
  }
  return created
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — AI cross-document inference
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ROSTER = 150

type ChatFn = (
  messages: Array<{ role: string; content: string }>,
  options?: { temperature?: number; maxTokens?: number; thinking?: boolean; json?: boolean; model?: string },
) => Promise<string>

async function aiCrossConnect(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  scanDigest: {
    summary: string
    narrative: string
    keyFacts: string[]
    entities: Array<{ type: string; value: string }>
    suspiciousIndicators: string[]
  },
  chatFn: ChatFn,
): Promise<CrossLinkSummary> {
  const out: CrossLinkSummary = {
    mergeEvents: 0,
    aliasLinks: 0,
    aiProposals: 0,
    accepted: 0,
    rejected: 0,
    links: [],
    notes: [],
  }

  const existingEntities = await db.entity.findMany({
    where: { caseId },
    select: { id: true, type: true, value: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_ROSTER,
  })

  if (existingEntities.length === 0) {
    out.notes.push('Case has no prior entities yet — nothing to connect against.')
    return out
  }

  // v3.7.1: the roster is char-budgeted. cuid ids alone are ~25 chars/entity;
  // 150 uncapped lines pushed this prompt to 18K+ chars and watchdog-killed
  // small local models on exactly the big-case files that need cross-linking.
  const ROSTER_CHAR_BUDGET = 6_000
  const rosterLines: string[] = []
  let rosterUsed = 0
  const rosterKeep: typeof existingEntities = []
  for (const e of existingEntities) {
    const line = `${rosterKeep.length + 1}. [${e.type}] "${e.value}" id=${e.id}`
    if (rosterUsed + line.length + 1 > ROSTER_CHAR_BUDGET) break
    rosterLines.push(line)
    rosterUsed += line.length + 1
    rosterKeep.push(e)
  }
  const roster = rosterLines.join('\n')
  if (rosterKeep.length < existingEntities.length) {
    out.notes.push(`roster capped at ${rosterKeep.length}/${existingEntities.length} entities for prompt budget`)
  }
  // The id map must match the roster actually shown.
  const rosterEntities = rosterKeep

  const priorEvidence = await db.evidence.findMany({
    where: { caseId, id: { not: evidenceId } },
    select: { originalName: true, classification: true },
    take: 25,
  })

  // v3.7.1: every digest section is length-capped — long AI summaries used
  // to add several K chars on top of the roster and push this prompt past
  // every local-model budget.
  const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n)
  const prompt = `You are connecting an investigation case's dots. A NEW evidence file was just analyzed; infer how it CONNECTS to what the case already knows.
Respond in ENGLISH only, whatever language the evidence uses.

=== NEW EVIDENCE: "${evidenceName}" ===
Summary: ${clip(scanDigest.summary, 800)}
Narrative: ${clip(scanDigest.narrative, 400)}
Key facts:
${(scanDigest.keyFacts.length ? scanDigest.keyFacts.slice(0, 8) : ['(none)']).map((f) => `- ${clip(f, 160)}`).join('\n')}
Suspicious indicators:
${(scanDigest.suspiciousIndicators.length ? scanDigest.suspiciousIndicators.slice(0, 8) : ['(none)']).map((f) => `- ${clip(f, 160)}`).join('\n')}
Extracted entities:
${scanDigest.entities
  .slice(0, 20)
  .map((e) => `- [${e.type}] ${clip(e.value, 60)}`)
  .join('\n') || '(none)'}

=== ALREADY-KNOWN CASE ENTITIES (roster${rosterKeep.length < existingEntities.length ? ` — first ${rosterKeep.length} of ${existingEntities.length}` : ''}) ===
${roster}

=== OTHER EVIDENCE FILES IN CASE ===
${priorEvidence.slice(0, 12).map((e) => `- ${clip(e.originalName, 60)} (${e.classification ?? 'unclassified'})`).join('\n') || '(none)'}

RULES
1. Propose only connections SUPPORTED by explicit facts in the new evidence. Never speculate without citing the supporting fact in the rationale.
2. targetId MUST be copied verbatim from the roster ids above. Do NOT invent ids.
3. rel must be a lowercase_snake_case verb. PREFER one of: relates_to | transferred_money | communicated_with | same_identity | located_at | owns_account | worked_for | director_of | called | used_vehicle | traveled_with | identified_by | member_of | related_to | studied_at | registered_at | owns | uses | employs | controls. If the evidence asserts a MORE SPECIFIC relationship (e.g. laundered_money_for, supplied_drugs_to, recruited_by, harboured), use that exact specific verb instead — specificity is intelligence.
4. sourceValue must be the NEW-evidence value that connects to the target.
5. If nothing genuinely connects, return {"links": []}.

Respond EXACTLY in this JSON structure (no preamble):
\`\`\`json
{
  "caseInterpretation": "2-4 sentences: how this new file fits into the overall case picture",
  "links": [
    { "targetId": "roster-id", "rel": "relates_to", "sourceValue": "new-evidence value", "rationale": "why these connect, citing specifics", "confidence": 0.8 }
  ],
  "newLeads": ["optional investigative lead suggested by combining facts"],
  "overallConfidence": "LOW|MEDIUM|HIGH"
}
\`\`\``

  let parsed: Record<string, unknown> | undefined
  try {
    const raw = await chatFn(
      [
        {
          role: 'system',
          content:
            'You are a meticulous financial-crime analyst. You only state connections supported by the provided evidence, you always answer in exactly the requested JSON format, and you always write field values in ENGLISH.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.25, maxTokens: 2600, thinking: false, json: true },
    )
    parsed = extractJsonObject<Record<string, unknown>>(raw)
  } catch (err) {
    out.notes.push(`AI cross-link call failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return out
  }

  if (!parsed) {
    out.notes.push('AI cross-link response could not be parsed as JSON.')
    return out
  }

  // v3.6 dynamic vocabulary: known AI verbs map to canonical types; novel
  // well-formed verbs (evidence-specific, e.g. supplied_drugs_to) are KEPT
  // as first-class edge types instead of being dropped.
  const VALID_RELS: Record<string, string> = {
    relates_to: 'RELATES_TO',
    transferred_money: 'TRANSFERRED_TO',
    communicated_with: 'COMMUNICATED_WITH',
    same_identity: 'SHARED_IDENTIFIER',
    located_at: 'LOCATED_AT',
    owns_account: 'CONTROLS_ACCOUNT',
  }

  const proposals = Array.isArray(parsed.links) ? (parsed.links as Array<Record<string, unknown>>) : []
  out.aiProposals = proposals.length
  const rosterIds = new Map(rosterEntities.map((e) => [e.id, e]))
  const existingEdges = await db.relationship.findMany({
    where: { caseId },
    select: { srcId: true, dstId: true, type: true },
    take: 5000,
  })
  const edgeSet = new Set(existingEdges.map((e) => `${e.srcId}|${e.dstId}|${e.type}`))

  for (const p of proposals.slice(0, 20)) {
    try {
      const targetId = String(p.targetId ?? '')
      const relKey = String(p.rel ?? '').toLowerCase()
      const srcValue = String(p.sourceValue ?? p.value ?? '').trim()
      const rationale = String(p.rationale ?? '').slice(0, 280)
      const conf = typeof p.confidence === 'number' ? Math.min(1, Math.max(0, p.confidence)) : 0.55
      const target = rosterIds.get(targetId)
      if (!target || !srcValue) {
        out.rejected += 1
        continue
      }
      // v3.6: normalize through the dynamic vocabulary — curated verbs above,
      // then the shared AI synonym map, then novel well-formed verbs KEPT.
      const relType = VALID_RELS[relKey] ?? normalizeAiRelVerb(relKey).type
      // Resolve sourceValue to an entity: exact → insensitive → fuzzy → create.
      const cleanNorm = srcValue.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
      let srcEntityId: string | null = null
      const normHit = await db.entity.findFirst({
        where: {
          caseId,
          OR: [
            { norm: srcValue.toLowerCase() },
            { value: srcValue },
            { value: cleanNorm || undefined },
          ],
        },
        select: { id: true },
      })
      if (normHit) srcEntityId = normHit.id
      else if (cleanNorm) {
        for (const e of existingEntities) {
          if (nameSimilarity(cleanNorm, e.value) >= 0.75) {
            srcEntityId = e.id
            break
          }
        }
      }
      if (!srcEntityId) {
        const created = await db.entity.create({
          data: {
            caseId,
            type: guessEntityType(srcValue),
            value: srcValue.slice(0, 120),
            norm: cleanNorm.replace(/[^a-z0-9]/g, '').slice(0, 80) || srcValue.toLowerCase().slice(0, 80),
            label: srcValue.slice(0, 60),
            confidence: 0.7,
            metadataJson: JSON.stringify({ source: 'ai-crosslink' }),
          },
          select: { id: true },
        })
        await db.entityLink.upsert({
          where: { entityId_evidenceId: { entityId: created.id, evidenceId } },
          update: {},
          create: { entityId: created.id, evidenceId },
        })
        srcEntityId = created.id
      }
      if (srcEntityId === target.id) {
        out.rejected += 1
        continue
      }
      // PRESERVE the AI's direction: sourceValue --rel--> targetId.
      const dirKey = `${srcEntityId}|${target.id}|${relType}`
      const revKey = `${target.id}|${srcEntityId}|${relType}`
      if (srcEntityId !== target.id && !edgeSet.has(dirKey) && !edgeSet.has(revKey)) {
        await db.relationship.create({
          data: {
            caseId,
            srcId: srcEntityId,
            dstId: target.id,
            type: relType,
            weight: 1,
            confidence: conf,
            evidenceRef: evidenceName,
            evidenceId,
            provenance: 'ai-crosslink',
            extractionMethod: 'ai',
            metadataJson: JSON.stringify({ rationale }),
          },
        })
        edgeSet.add(dirKey)
        out.accepted += 1
        out.links.push({
          src: srcValue,
          dst: target.value,
          type: relType,
          method: 'ai-crosslink',
          rationale,
          confidence: conf,
        })
      } else {
        out.rejected += 1
      }
    } catch (err) {
      console.error('[crossConnect] proposal persist failed:', err)
      out.rejected += 1
    }
  }

  if (typeof parsed.caseInterpretation === 'string' && parsed.caseInterpretation.trim()) {
    out.caseInterpretation = parsed.caseInterpretation.trim()
  }
  const leads = Array.isArray(parsed.newLeads) ? parsed.newLeads.map(String).filter(Boolean).slice(0, 5) : []
  if (leads.length) out.newLeads = leads
  const oc = String(parsed.overallConfidence ?? '').toUpperCase()
  if (['LOW', 'MEDIUM', 'HIGH'].includes(oc)) {
    ;(out as CrossLinkSummary & { overallConfidence?: string }).overallConfidence = oc
  }

  return out
}

function guessEntityType(value: string): string {
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return 'email'
  if (/@[a-z]{2,}\b/i.test(value)) return 'upi'
  if (/^0x[0-9a-f]+$/i.test(value)) return 'wallet'
  if (/^\+?\d[\d\s-]{7,}$/.test(value.trim())) return 'phone'
  if (/^\d{9,18}$/.test(value)) return 'account'
  if (/\.(com|net|org|in|io)$/i.test(value)) return 'domain'
  return 'other'
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point used by the scan route
// ─────────────────────────────────────────────────────────────────────────────

export async function connectScanToCase(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  evidenceName: string,
  scanResult: {
    summary: string
    narrative?: string
    keyFacts?: unknown[]
    entities: Array<{ type: string; value: string }>
    suspiciousIndicators?: unknown[]
  },
  resolvedEntities: ResolvedScanEntity[],
  opts?: { aiEnabled?: boolean },
): Promise<CrossLinkSummary> {
  const summary: CrossLinkSummary = {
    mergeEvents: 0,
    aliasLinks: 0,
    aiProposals: 0,
    accepted: 0,
    rejected: 0,
    links: [],
    notes: [],
  }

  // Layer 1a — merge events (which entities were already known).
  try {
    const l1a = await detectMergeEvents(db, caseId, evidenceId, resolvedEntities)
    summary.mergeEvents = l1a.merges
    if (l1a.files.length) summary.mergedWithFiles = l1a.files
  } catch (err) {
    summary.notes.push(`Merge detection failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // Layer 1b — alias edges.
  try {
    await linkAliases(db, caseId, evidenceId, evidenceName, resolvedEntities, summary)
  } catch (err) {
    summary.notes.push(`Alias linking failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // Layer 2 — AI inference.
  // v3.6: Layers 1a/1b above are DETERMINISTIC (merge detection + alias
  // linking) and run whether or not a model is reachable; only Layer 2 needs
  // AI, so it is skipped cleanly when no model is available instead of
  // burning a timeout cycle on a dead endpoint.
  try {
    const aiEnabled = opts?.aiEnabled !== false
    const priorCount = aiEnabled ? await db.entity.count({ where: { caseId } }) : 0
    if (aiEnabled && priorCount > 0 && scanResult.entities.length > 0) {
      const { localChat } = await import('@/lib/localAi')
      // v3.3 tier routing: cross-document inference is structured JSON work
      // over an entity roster → STANDARD tier, chain-of-thought off.
      const { modelForTier } = await import('@/lib/modelTiers')
      const standardModel = await modelForTier('standard')
      const l2 = await aiCrossConnect(
        db,
        caseId,
        evidenceId,
        evidenceName,
        {
          summary: scanResult.summary,
          narrative: scanResult.narrative ?? '',
          keyFacts: (scanResult.keyFacts ?? []).map(String),
          entities: scanResult.entities.map((e) => ({ type: e.type, value: e.value })),
          suspiciousIndicators: (scanResult.suspiciousIndicators ?? []).map(String),
        },
        (messages, options) => localChat(messages, { ...options, model: standardModel }),
      )
      summary.aiProposals = l2.aiProposals
      summary.accepted = l2.accepted
      summary.rejected = l2.rejected
      summary.links.push(...l2.links)
      summary.notes.push(...l2.notes)
      if (l2.caseInterpretation) summary.caseInterpretation = l2.caseInterpretation
      if (l2.newLeads?.length) summary.newLeads = l2.newLeads
    }
  } catch (err) {
    summary.notes.push(`AI cross-link pass failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  return summary
}
