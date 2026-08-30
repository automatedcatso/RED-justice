/**
 * gapEngine.ts — Investigation Gap Engine.
 *
 * Instead of only reporting findings, RED Justice identifies MISSING
 * evidence / unknown links and tells the investigator what information is
 * still required to resolve a hypothesis.
 *
 * Gap families:
 *   - missing_source:    derived data exists without its natural source doc
 *                        (e.g. transactions but no bank_statement evidence,
 *                        communications but no CDR / chat export).
 *   - unlinked_entity:   entities observed in evidence but with zero graph
 *                        relationships (mentioned but not connected).
 *   - thin_evidence:     entities/relationships resting on a single weak
 *                        source (observed state, no corroboration).
 *   - unresolved_conflicts: open contradictions blocking conclusions.
 *   - hypothesis_gaps:   hypotheses with no verification runs / no support.
 *   - record_quality:    transactions missing UTR, communications missing
 *                        timestamps, persons without any identifier links.
 */

import type { PrismaClient } from '@prisma/client'
import { CLASS_LABELS, type EvidenceClass } from '@/lib/extractors/classify'

export interface Gap {
  id: string
  family: 'missing_source' | 'unlinked_entity' | 'thin_evidence' | 'unresolved_conflicts' | 'hypothesis_gaps' | 'record_quality'
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  recommendation: string
  relatedIds: string[]
}

export interface GapReport {
  gaps: Gap[]
  total: number
  byFamily: Record<string, number>
  bySeverity: Record<string, number>
  coverage: {
    evidenceByClass: Record<string, number>
    hasTransactions: boolean
    hasCommunications: boolean
    hasSourceFor: Record<string, boolean>
  }
}

export async function computeGaps(db: PrismaClient, caseId: string): Promise<GapReport> {
  const gaps: Gap[] = []

  const [evidence, entities, relationships, txns, comms, contradictions, hypothesisNotes] = await Promise.all([
    db.evidence.findMany({
      where: { caseId },
      select: { id: true, classification: true, originalName: true, classificationConfidence: true },
    }),
    db.entity.findMany({
      where: { caseId },
      select: { id: true, type: true, value: true, label: true, confidence: true },
    }),
    db.relationship.findMany({
      where: { caseId },
      select: { srcId: true, dstId: true },
    }),
    db.transaction.findMany({
      where: { caseId },
      select: { id: true, utr: true, evidenceId: true },
    }),
    db.communication.findMany({
      where: { caseId },
      select: { id: true, timestamp: true, evidenceId: true },
    }),
    db.contradiction.findMany({
      where: { caseId, status: 'open' },
      select: { id: true, description: true, relation: true },
    }),
    db.investigatorNote.findMany({ where: { caseId }, select: { id: true, metadataJson: true, createdAt: true } }),
  ])

  // Evidence coverage by class.
  const evidenceByClass: Record<string, number> = {}
  for (const e of evidence) {
    const cls = e.classification ?? 'other'
    evidenceByClass[cls] = (evidenceByClass[cls] ?? 0) + 1
  }

  const hasClass = (cls: EvidenceClass) => (evidenceByClass[cls] ?? 0) > 0

  // ── missing_source ──────────────────────────────────────────────────────
  if (txns.length > 0 && !hasClass('bank_statement') && !hasClass('ledger')) {
    gaps.push({
      id: 'gap-missing-bank-statement',
      family: 'missing_source',
      severity: 'high',
      title: 'Transactions exist without a bank statement source',
      description: `${txns.length} transactions were extracted, but no evidence item is classified as bank_statement or ledger. The provenance chain for money-flow conclusions is incomplete.`,
      recommendation: 'Obtain and upload the underlying bank statement(s) / ledger so every transaction traces to its source record.',
      relatedIds: txns.slice(0, 5).map((t) => t.id),
    })
  }
  if (entities.some((e) => e.type === 'phone') && !hasClass('cdr')) {
    gaps.push({
      id: 'gap-missing-cdr',
      family: 'missing_source',
      severity: 'high',
      title: 'Phone identifiers exist without call detail records',
      description: `Phone numbers were observed in evidence, but no CDR is ingested. Call-pattern analysis (who called whom, when, tower location) is currently impossible.`,
      recommendation: 'Request CDR/tower dump for the phones of interest covering the relevant period.',
      relatedIds: entities.filter((e) => e.type === 'phone').slice(0, 5).map((e) => e.id),
    })
  }
  if (entities.some((e) => e.type === 'person') && !hasClass('id_document')) {
    gaps.push({
      id: 'gap-missing-id',
      family: 'missing_source',
      severity: 'medium',
      title: 'Persons observed without identity documents',
      description: `${entities.filter((e) => e.type === 'person').length} person entities are inferred from names in evidence, but no ID document (Aadhaar/PAN/passport) is present to anchor identity attributes.`,
      recommendation: 'Collect KYC/ID copies for the key suspects to firm up identity resolution.',
      relatedIds: entities.filter((e) => e.type === 'person').slice(0, 5).map((e) => e.id),
    })
  }
  if (comms.length > 0 && !hasClass('whatsapp_chat') && !hasClass('cdr')) {
    gaps.push({
      id: 'gap-missing-chat-source',
      family: 'missing_source',
      severity: 'medium',
      title: 'Communications extracted without a chat/CDR source',
      description: `${comms.length} communications were extracted but no evidence is classified as whatsapp_chat or CDR — the communication records may be incomplete.`,
      recommendation: 'Upload the native chat exports / CDRs the extracts were derived from.',
      relatedIds: [],
    })
  }
  if (evidence.some((e) => e.classification === 'screenshot' || (e.classification == null && e.originalName.match(/\.(png|jpe?g|webp)$/i)))) {
    gaps.push({
      id: 'gap-ocr-screenshots',
      family: 'missing_source',
      severity: 'medium',
      title: 'Image evidence requires OCR',
      description: 'One or more image files (screenshots/photos) are ingested without machine-readable text. Their content is not searchable and not graph-extracted.',
      recommendation: 'Run OCR on image evidence (or paste the visible text via "Paste text") so the content enters the pipeline.',
      relatedIds: evidence
        .filter((e) => e.classification === 'screenshot')
        .slice(0, 5)
        .map((e) => e.id),
    })
  }

  // ── unlinked_entity ────────────────────────────────────────────────────
  const connected = new Set<string>()
  for (const r of relationships) {
    connected.add(r.srcId)
    connected.add(r.dstId)
  }
  const unlinked = entities.filter((e) => !connected.has(e.id) && !['date', 'amount'].includes(e.type))
  if (unlinked.length > 0) {
    gaps.push({
      id: 'gap-unlinked-entities',
      family: 'unlinked_entity',
      severity: unlinked.length > 20 ? 'high' : 'medium',
      title: `${unlinked.length} entities are observed but not connected`,
      description: `These identifiers appear in evidence but have zero graph relationships: ${unlinked.slice(0, 8).map((e) => `${e.type}:${e.value}`).join(', ')}${unlinked.length > 8 ? '…' : ''}. Unknown links may be hiding between them.`,
      recommendation: 'Search for these identifiers across other evidence, check the Cross-Case Collision explorer, and consider co-occurrence re-extraction.',
      relatedIds: unlinked.slice(0, 10).map((e) => e.id),
    })
  }

  // ── thin_evidence ──────────────────────────────────────────────────────
  const evidencePerEntity = new Map<string, number>()
  const links = await db.entityLink.findMany({
    where: { entityId: { in: entities.map((e) => e.id) } },
    select: { entityId: true },
  })
  for (const l of links) {
    evidencePerEntity.set(l.entityId, (evidencePerEntity.get(l.entityId) ?? 0) + 1)
  }
  const thin = entities.filter(
    (e) => (evidencePerEntity.get(e.id) ?? 0) <= 1 && (e.confidence ?? 1) < 0.8 && !['date', 'amount'].includes(e.type),
  )
  if (thin.length > 0) {
    gaps.push({
      id: 'gap-thin-evidence',
      family: 'thin_evidence',
      severity: 'medium',
      title: `${thin.length} entities rest on thin evidence`,
      description: `Entities seen in only one file with sub-0.8 extraction confidence (e.g. ${thin.slice(0, 5).map((e) => e.value).join(', ')}). Any conclusion built on them alone is fragile.`,
      recommendation: 'Corroborate these identifiers with a second independent source before using them in reports.',
      relatedIds: thin.slice(0, 10).map((e) => e.id),
    })
  }

  // ── unresolved_conflicts ───────────────────────────────────────────────
  if (contradictions.length > 0) {
    gaps.push({
      id: 'gap-open-contradictions',
      family: 'unresolved_conflicts',
      severity: 'high',
      title: `${contradictions.length} open contradictions`,
      description: `Unresolved conflicts between evidence records are blocking confident conclusions (e.g. ${contradictions[0].description.slice(0, 120)}).`,
      recommendation: 'Review each contradiction in Patterns → Contradictions and resolve/accept with a note.',
      relatedIds: contradictions.slice(0, 10).map((c) => c.id),
    })
  }

  // ── hypothesis_gaps ────────────────────────────────────────────────────
  const hypotheses = hypothesisNotes
    .map((n) => {
      try {
        const meta = JSON.parse(n.metadataJson ?? '{}') as Record<string, unknown>
        return meta.hypothesis ? { id: n.id, meta } : null
      } catch {
        return null
      }
    })
    .filter((x): x is { id: string; meta: Record<string, unknown> } => x !== null)
  const unverified = hypotheses.filter(
    (h) => !h.meta.verification || (h.meta.status !== 'confirmed' && h.meta.status !== 'rejected'),
  )
  if (unverified.length > 0) {
    gaps.push({
      id: 'gap-unverified-hypotheses',
      family: 'hypothesis_gaps',
      severity: 'medium',
      title: `${unverified.length} hypotheses are unverified`,
      description: 'Hypotheses without a verification run cannot advance to claims. Run the deterministic verification (Hypotheses → Verify) to convert them into supported/rejected knowledge.',
      recommendation: 'Run verification on each hypothesis; for rejected ones record why.',
      relatedIds: unverified.slice(0, 10).map((h) => h.id),
    })
  }

  // ── record_quality ─────────────────────────────────────────────────────
  const missingUtr = txns.filter((t) => !t.utr)
  if (missingUtr.length > 0 && txns.length > 0 && missingUtr.length / txns.length > 0.2) {
    gaps.push({
      id: 'gap-txns-missing-utr',
      family: 'record_quality',
      severity: 'low',
      title: `${missingUtr.length}/${txns.length} transactions lack a reference number`,
      description: 'Transactions without UTR/reference cannot be cross-matched between statements or used in contradiction detection.',
      recommendation: 'Check the source statements for reference columns; re-upload with complete columns if possible.',
      relatedIds: missingUtr.slice(0, 5).map((t) => t.id),
    })
  }
  const commsNoTs = comms.filter((c) => !c.timestamp)
  if (comms.length > 0 && commsNoTs.length / comms.length > 0.3) {
    gaps.push({
      id: 'gap-comms-missing-timestamps',
      family: 'record_quality',
      severity: 'low',
      title: `${commsNoTs.length}/${comms.length} communications have no timestamp`,
      description: 'Without timestamps, communications cannot participate in temporal analysis or playback.',
      recommendation: 'Verify the chat export format includes timestamps; re-export if needed.',
      relatedIds: [],
    })
  }

  const byFamily: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  for (const g of gaps) {
    byFamily[g.family] = (byFamily[g.family] ?? 0) + 1
    bySeverity[g.severity] = (bySeverity[g.severity] ?? 0) + 1
  }

  return {
    gaps,
    total: gaps.length,
    byFamily,
    bySeverity,
    coverage: {
      evidenceByClass,
      hasTransactions: txns.length > 0,
      hasCommunications: comms.length > 0,
      hasSourceFor: Object.fromEntries(
        Object.entries(evidenceByClass).map(([k, v]) => [k, v > 0]),
      ),
    },
  }
}

/** Human label helper for the UI. */
export function gapClassLabel(cls: string): string {
  return (CLASS_LABELS as Record<string, string>)[cls] ?? cls
}
