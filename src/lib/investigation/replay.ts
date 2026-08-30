/**
 * replay.ts — Investigation Replay.
 *
 * Reconstructs HOW a finding was produced as an ordered, auditable trace:
 *   evidence ingested → extraction → entity resolution → graph query →
 *   analytics → AI interpretation → decision record → final report usage.
 *
 * Every step cites concrete records (ids + timestamps) so the finding can be
 * independently re-derived — the investigation equivalent of a reproducible
 * build log.
 */

import type { PrismaClient } from '@prisma/client'

export interface ReplayStep {
  stage: string
  at: string | null
  title: string
  detail: string
  refs: string[]
}

interface ReplayEvidence {
  id: string
  name: string
  at: Date
  sha256: string
  classification: string | null
}

export interface ReplayTrace {
  findingId: string
  steps: ReplayStep[]
  integrity: {
    allSourcesPresent: boolean
    missing: string[]
  }
}

export async function buildFindingReplay(
  db: PrismaClient,
  caseId: string,
  findingId: string,
): Promise<ReplayTrace | null> {
  const finding = await db.finding.findFirst({
    where: { id: findingId, caseId },
  })
  if (!finding) return null

  const steps: ReplayStep[] = []
  const missing: string[] = []

  // Parse involved records.
  let entityIds: string[] = []
  let relIds: string[] = []
  let txnIds: string[] = []
  try { entityIds = JSON.parse(finding.entitiesJson ?? '[]') as string[] } catch { /* ignore */ }
  try { relIds = JSON.parse(finding.relationshipsJson ?? '[]') as string[] } catch { /* ignore */ }
  try { txnIds = JSON.parse(finding.transactionsJson ?? '[]') as string[] } catch { /* ignore */ }
  let evidenceIds: string[] = []
  try { evidenceIds = JSON.parse(finding.supportingEvidence ?? '[]') as string[] } catch { /* ignore */ }

  // ── Stage 1: evidence ingestion ──
  const evidenceRows = await db.evidence.findMany({
    where: { id: { in: evidenceIds } },
    select: { id: true, originalName: true, createdAt: true, sha256: true, classification: true },
  })
  // Also pull evidence through entities and transactions.
  const entityLinks = entityIds.length
    ? await db.entityLink.findMany({
        where: { entityId: { in: entityIds } },
        select: { evidenceId: true, evidence: { select: { id: true, originalName: true, createdAt: true, sha256: true, classification: true } } },
      })
    : []
  const allEvidence = new Map<string, ReplayEvidence>()
  for (const e of evidenceRows) {
    allEvidence.set(e.id, { id: e.id, name: e.originalName, at: e.createdAt, sha256: e.sha256, classification: e.classification })
  }
  for (const l of entityLinks) {
    if (l.evidence && !allEvidence.has(l.evidence.id)) {
      allEvidence.set(l.evidence.id, {
        id: l.evidence.id,
        name: l.evidence.originalName,
        at: l.evidence.createdAt,
        sha256: l.evidence.sha256,
        classification: l.evidence.classification,
      })
    }
  }
  if (txnIds.length > 0) {
    const txnRows = await db.transaction.findMany({
      where: { id: { in: txnIds } },
      select: { evidenceId: true, evidence: { select: { id: true, originalName: true, createdAt: true, sha256: true, classification: true } } },
    })
    for (const t of txnRows) {
      if (t.evidence && !allEvidence.has(t.evidence.id)) {
        allEvidence.set(t.evidence.id, {
          id: t.evidence.id,
          name: t.evidence.originalName,
          at: t.evidence.createdAt,
          sha256: t.evidence.sha256,
          classification: t.evidence.classification,
        })
      }
    }
  }

  if (allEvidence.size > 0) {
    const evList = Array.from(allEvidence.values()).sort((a, b) => a.at.getTime() - b.at.getTime())
    steps.push({
      stage: 'evidence_ingested',
      at: evList[0].at.toISOString(),
      title: `Evidence ingested (${evList.length} file${evList.length === 1 ? '' : 's'})`,
      detail: evList.map((e) => `${e.name} — sha256 ${e.sha256.slice(0, 12)}…${e.classification ? ` [${e.classification}]` : ''}`).join(' · '),
      refs: evList.map((e) => e.id),
    })
  } else {
    missing.push('evidence')
  }

  // ── Stage 2: extraction ──
  const txnRows = txnIds.length
    ? await db.transaction.findMany({
        where: { id: { in: txnIds } },
        select: { id: true, sourceRef: true, createdAt: true, utr: true, amount: true },
      })
    : []
  const extractionRefs = txnRows.map((t) => t.sourceRef ?? t.id).slice(0, 8)
  steps.push({
    stage: 'extraction',
    at: finding.createdAt.toISOString(),
    title: 'Level-0 deterministic extraction',
    detail:
      `Regex extractors ran over each ingested file: ${entityIds.length} entities, ${txnIds.length} transactions and ${relIds.length} relationships referenced by this finding were produced by entityExtract/txnExtract/commExtract.` +
      (extractionRefs.length ? ` Source locators: ${extractionRefs.join(', ')}.` : ''),
    refs: txnIds.slice(0, 10),
  })

  // ── Stage 3: entity resolution ──
  const entityRows = entityIds.length
    ? await db.entity.findMany({
        where: { id: { in: entityIds } },
        select: { id: true, value: true, type: true, resolvedToId: true, createdAt: true },
      })
    : []
  const merged = entityRows.filter((e) => e.resolvedToId)
  steps.push({
    stage: 'entity_resolution',
    at: finding.createdAt.toISOString(),
    title: 'Entity normalisation + resolution',
    detail:
      `Identifiers were normalised (norm = lowercase alphanum) and deduplicated on (case, type, norm): ${entityRows.slice(0, 6).map((e) => `${e.type}:${e.value}`).join(', ')}${entityRows.length > 6 ? '…' : ''}` +
      (merged.length > 0 ? ` ${merged.length} of them are merge aliases pointing at surviving entities.` : ' No merges involved.'),
    refs: entityIds.slice(0, 10),
  })

  // ── Stage 4: graph construction ──
  const relRows = relIds.length
    ? await db.relationship.findMany({
        where: { id: { in: relIds } },
        select: { id: true, type: true, weight: true, confidence: true, evidenceRef: true },
      })
    : []
  steps.push({
    stage: 'graph_query',
    at: finding.createdAt.toISOString(),
    title: 'SQLite-backed graph layer query',
    detail:
      relRows.length > 0
        ? `Relationships used: ${relRows.slice(0, 6).map((r) => `${r.type}(w=${r.weight}, conf=${r.confidence.toFixed(2)})`).join(', ')}${relRows.length > 6 ? '…' : ''}`
        : 'The rule evaluated entity/transaction aggregates rather than individual relationships.',
    refs: relIds.slice(0, 10),
  })

  // ── Stage 5: analytics ──
  steps.push({
    stage: 'analytics',
    at: finding.createdAt.toISOString(),
    title: `Deterministic pattern rule — ${finding.type}`,
    detail: `Rule trigger: ${finding.trigger ?? finding.description} Severity=${finding.severity}, confidence=${finding.confidence.toFixed(2)}. This step is pure TypeScript analytics (patternEngine.ts) — no AI involved.`,
    refs: [finding.id],
  })

  // ── Stage 6: AI interpretation (if a scan touched the source evidence) ──
  const aiScanned = Array.from(allEvidence.values()).filter((e) => e.classification !== null)
  if (aiScanned.length > 0 || allEvidence.size > 0) {
    const evidWithIntel = await db.evidence.findMany({
      where: { id: { in: Array.from(allEvidence.keys()) }, ocrStatus: 'ai-scanned' },
      select: { id: true, originalName: true },
    })
    steps.push({
      stage: 'ai_interpretation',
      at: null,
      title: evidWithIntel.length > 0 ? 'AI scan available on source evidence' : 'No AI interpretation involved',
      detail:
        evidWithIntel.length > 0
          ? `The AI evidence scanner also read ${evidWithIntel.map((e) => e.originalName).join(', ')}. Its narrative is advisory only — this finding stands on deterministic analysis.`
          : 'This finding was produced purely by deterministic analysis; no AI model participated.',
      refs: evidWithIntel.map((e) => e.id),
    })
  }

  // ── Stage 7: decision record ──
  steps.push({
    stage: 'decision_record',
    at: finding.decidedAt ? finding.decidedAt.toISOString() : null,
    title: finding.decision ? `Investigator decision: ${finding.decision}` : 'Awaiting investigator decision',
    detail: finding.decision
      ? `Decision "${finding.decision}" recorded${finding.decidedBy ? ` by ${finding.decidedBy}` : ''}${finding.decisionNote ? ` — note: ${finding.decisionNote}` : ''}.`
      : 'This finding has not been approved/rejected yet. Until a decision is recorded it cannot enter the claim graph as verified knowledge.',
    refs: [finding.id],
  })

  // ── Stage 8: report usage ──
  steps.push({
    stage: 'report',
    at: null,
    title: finding.decision === 'approved' ? 'Eligible for reports' : 'Excluded from confident reporting',
    detail:
      finding.decision === 'approved'
        ? 'Approved findings appear in generated reports with their full provenance chain.'
        : 'Only approved findings become report facts; this finding will be listed as unapproved.',
    refs: [],
  })

  return {
    findingId,
    steps,
    integrity: {
      allSourcesPresent: missing.length === 0,
      missing,
    },
  }
}
