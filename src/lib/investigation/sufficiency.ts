/**
 * sufficiency.ts — Evidence Sufficiency Scoring.
 *
 * A finding (or hypothesis) receives a 0-100 sufficiency score based on:
 *   - independent source count (distinct evidence FILES, not just records)
 *   - source quality (classified evidence types carry reliability weights:
 *     bank_statement/FIR/CDR are primary records; screenshots/paste are weaker)
 *   - corroboration (entities involved corroborated by ≥2 sources)
 *   - contradiction penalty (open contradictions touching involved records)
 *   - provenance completeness (evidenceRef / extractionMethod / locator set)
 *
 * This is deliberately NOT an AI confidence score — every component is
 * computed from auditable record structure.
 *
 * Bands: 0-24 insufficient · 25-49 partial · 50-74 sufficient · 75-100 strong
 */

import type { PrismaClient } from '@prisma/client'

export interface SufficiencyBreakdown {
  independentSources: number
  sourceQuality: number // 0..1 average quality of the sources
  corroboration: number // 0..1
  contradictionPenalty: number // 0..0.4
  provenance: number // 0..1
}

export interface SufficiencyScore extends SufficiencyBreakdown {
  score: number // 0..100
  band: 'insufficient' | 'partial' | 'sufficient' | 'strong'
  reasons: string[]
}

/** Reliability weight by evidence classification (primary records highest). */
const SOURCE_QUALITY: Record<string, number> = {
  bank_statement: 1.0,
  fir: 0.95,
  cdr: 0.9,
  court_document: 0.9,
  contract: 0.85,
  invoice: 0.8,
  property_document: 0.85,
  id_document: 0.9,
  ledger: 0.8,
  whatsapp_chat: 0.7,
  email: 0.7,
  travel_record: 0.75,
  medical_record: 0.75,
  receipt: 0.65,
  social_media: 0.5,
  screenshot: 0.45,
  other: 0.5,
}

export function band(score: number): 'insufficient' | 'partial' | 'sufficient' | 'strong' {
  if (score >= 75) return 'strong'
  if (score >= 50) return 'sufficient'
  if (score >= 25) return 'partial'
  return 'insufficient'
}

/**
 * Score one finding. `finding.supportingEvidence` may hold evidence ids/names;
 * involved entities are resolved to their evidence links for independent
 * source counting.
 */
export async function scoreFinding(
  db: PrismaClient,
  caseId: string,
  finding: {
    id: string
    entitiesJson?: string | null
    supportingEvidence?: string | null
    transactionsJson?: string | null
  },
): Promise<SufficiencyScore> {
  const reasons: string[] = []

  // Collect involved entity ids.
  let entityIds: string[] = []
  try { entityIds = JSON.parse(finding.entitiesJson ?? '[]') as string[] } catch { /* ignore */ }

  // Evidence ids from supportingEvidence (may be JSON array of ids or names).
  const evidenceIdSet = new Set<string>()
  try {
    const se = JSON.parse(finding.supportingEvidence ?? '[]') as unknown
    if (Array.isArray(se)) for (const s of se) if (typeof s === 'string') evidenceIdSet.add(s)
  } catch { /* ignore */ }

  // Evidence through entities.
  let entityEvidence: Array<{ evidenceId: string | null }> = []
  if (entityIds.length > 0) {
    entityEvidence = await db.entityLink.findMany({
      where: { entityId: { in: entityIds } },
      select: { evidenceId: true },
    })
    for (const r of entityEvidence) if (r.evidenceId) evidenceIdSet.add(r.evidenceId)
  }

  // Evidence through transactions.
  let txnIds: string[] = []
  try { txnIds = JSON.parse(finding.transactionsJson ?? '[]') as string[] } catch { /* ignore */ }
  if (txnIds.length > 0) {
    const txRows = await db.transaction.findMany({
      where: { id: { in: txnIds } },
      select: { evidenceId: true },
    })
    for (const t of txRows) if (t.evidenceId) evidenceIdSet.add(t.evidenceId)
  }

  const evidenceIds = Array.from(evidenceIdSet)
  const evidenceRows = evidenceIds.length
    ? await db.evidence.findMany({
        where: { id: { in: evidenceIds }, caseId },
        select: { id: true, classification: true, ocrStatus: true },
      })
    : []

  // 1. Independent sources (distinct files), diminishing returns.
  const independentSources = evidenceRows.length
  let sourceScore = 0
  if (independentSources === 1) { sourceScore = 0.3; reasons.push('single source only') }
  else if (independentSources === 2) { sourceScore = 0.6; reasons.push('2 independent sources') }
  else if (independentSources === 3) { sourceScore = 0.8; reasons.push('3 independent sources') }
  else if (independentSources >= 4) { sourceScore = 1.0; reasons.push(`${independentSources} independent sources`) }

  // 2. Source quality (avg classification weight).
  const qualities = evidenceRows.map((e) => SOURCE_QUALITY[e.classification ?? 'other'] ?? 0.5)
  const sourceQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0.25
  if (qualities.length && sourceQuality >= 0.8) reasons.push('primary-record sources (statement/FIR/CDR class)')
  if (qualities.length && sourceQuality < 0.5) reasons.push('weak source classes (screenshot/social)')

  // 3. Corroboration: entities seen in ≥2 distinct evidence files.
  let corroboration = 0
  if (entityIds.length > 0) {
    const links = await db.entityLink.findMany({
      where: { entityId: { in: entityIds } },
      select: { entityId: true, evidenceId: true },
    })
    const perEntity = new Map<string, Set<string>>()
    for (const l of links) {
      if (!l.evidenceId) continue
      const set = perEntity.get(l.entityId) ?? new Set<string>()
      set.add(l.evidenceId)
      perEntity.set(l.entityId, set)
    }
    let corroborated = 0
    for (const e of entityIds) if ((perEntity.get(e)?.size ?? 0) >= 2) corroborated++
    corroboration = corroborated / entityIds.length
    if (corroboration >= 0.5) reasons.push(`${corroborated}/${entityIds.length} entities corroborated across files`)
  }

  // 4. Contradiction penalty: open contradictions whose evidence overlaps.
  const contradictions = await db.contradiction.findMany({
    where: { caseId, status: 'open' },
    select: { id: true, evidenceIdsJson: true, subjectAId: true, subjectBId: true },
  })
  const entitySet = new Set(entityIds)
  const touching = contradictions.filter((c) => {
    if (c.subjectAId && entitySet.has(c.subjectAId)) return true
    if (c.subjectBId && entitySet.has(c.subjectBId)) return true
    try {
      const ids = JSON.parse(c.evidenceIdsJson ?? '[]') as string[]
      return ids.some((x) => evidenceIdSet.has(x))
    } catch {
      return false
    }
  })
  const contradictionPenalty = Math.min(0.4, touching.length * 0.15)
  if (touching.length > 0) reasons.push(`${touching.length} open contradiction(s) overlap this finding`)

  // 5. Provenance completeness (does the finding carry its own citations).
  const hasCitations = (finding.supportingEvidence ?? '').length > 2
  const provenance = hasCitations ? 1 : entityEvidence.length > 0 ? 0.7 : 0.3
  if (!hasCitations) reasons.push('finding carries no direct evidence citations')

  const raw =
    100 *
    (0.3 * sourceScore +
      0.25 * sourceQuality +
      0.2 * corroboration +
      0.15 * provenance +
      0.1) * // base credit for deterministically-detected structure
    (1 - contradictionPenalty)

  const score = Math.max(0, Math.min(100, Math.round(raw)))

  return {
    score,
    band: band(score),
    independentSources,
    sourceQuality: Math.round(sourceQuality * 100) / 100,
    corroboration: Math.round(corroboration * 100) / 100,
    contradictionPenalty: Math.round(contradictionPenalty * 100) / 100,
    provenance: Math.round(provenance * 100) / 100,
    reasons,
  }
}
