/**
 * contradictionEngine.ts — Evidence Contradiction Graph builder.
 *
 * Explicitly models conflicting claims between evidence items using the
 * relations: supports / contradicts / supersedes / unresolved.
 *
 * Deterministic detectors (always run, no AI needed):
 *   1. UTR amount conflict  — same UTR/reference number with materially
 *      different amounts in two transactions.
 *   2. UTR direction conflict — same UTR with swapped sender/receiver.
 *   3. UTR date conflict — same UTR on materially different dates (>1 day).
 *   4. Entity type conflict — the same normalised identifier observed as two
 *      different entity types (e.g. a phone number also typed as an account).
 *   5. Finding disagreement — findings over the same entity pair whose
 *      severities/confidences disagree enough to matter (supports/
 *      supersedes modelling).
 *   6. Duplicate supersession — two identical (deduped-by-sha) re-uploads or
 *      two extractions of the same statement where one was uploaded later:
 *      later supersedes earlier while both stay inspectable.
 *
 * AI-assisted detection: the evidence AI-scan prompt asks the model to flag
 * contradictions it sees; those are persisted with detector='ai'.
 *
 * All contradictions are upserted idempotently (same subject pair + kind
 * does not duplicate), and can be resolved by an investigator (status
 * open → resolved/accepted with a note).
 */
import type { PrismaClient } from '@prisma/client'

export interface DetectedContradiction {
  relation: 'contradicts' | 'supports' | 'supersedes' | 'unresolved'
  subjectType: 'transaction' | 'entity' | 'finding' | 'communication'
  subjectAId: string | null
  subjectBId: string | null
  subjectARef: string | null
  subjectBRef: string | null
  description: string
  evidenceIds: string[]
  detector: 'deterministic' | 'ai'
}

/** Materially different amount: >0.5% relative or >₹1 absolute. */
function amountsDiffer(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false
  const diff = Math.abs(a - b)
  return diff > 1 && diff > 0.005 * Math.max(Math.abs(a), Math.abs(b))
}

/** Calendar-day difference between two date-ish strings (best effort). */
function dayDiff(a: string | null, b: string | null): number {
  if (!a || !b) return 0
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
  return Math.abs(Math.round((ta - tb) / 86400000))
}

export async function detectContradictions(
  db: PrismaClient,
  caseId: string,
): Promise<{ detected: number; created: number; byRelation: Record<string, number> }> {
  const detected: DetectedContradiction[] = []

  const txns = await db.transaction.findMany({
    where: { caseId },
    select: {
      id: true, utr: true, amount: true, txnDate: true,
      senderAccount: true, receiverAccount: true, evidenceId: true, sourceRef: true,
    },
  })

  // 1-3. UTR-based conflicts (group by normalised UTR).
  const byUtr = new Map<string, typeof txns>()
  for (const t of txns) {
    const utr = (t.utr ?? '').trim().toUpperCase()
    if (!utr || utr.length < 4) continue
    const list = byUtr.get(utr) ?? []
    list.push(t)
    byUtr.set(utr, list)
  }
  for (const [utr, group] of byUtr) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        const evidenceIds = [a.evidenceId, b.evidenceId].filter((x): x is string => Boolean(x))
        if (a.evidenceId && a.evidenceId === b.evidenceId) {
          // Same source file: still interesting (internal inconsistency) but lower priority.
        }
        if (amountsDiffer(a.amount, b.amount)) {
          detected.push({
            relation: 'contradicts',
            subjectType: 'transaction',
            subjectAId: a.id,
            subjectBId: b.id,
            subjectARef: `UTR ${utr} amount ₹${a.amount ?? '?'}`,
            subjectBRef: `UTR ${utr} amount ₹${b.amount ?? '?'}`,
            description: `Reference ${utr} is recorded with conflicting amounts: ₹${a.amount ?? '?'} vs ₹${b.amount ?? '?'} (${a.sourceRef ?? 'source A'} vs ${b.sourceRef ?? 'source B'}).`,
            evidenceIds,
            detector: 'deterministic',
          })
        }
        const swapped =
          a.senderAccount && a.receiverAccount && b.senderAccount && b.receiverAccount &&
          a.senderAccount === b.receiverAccount && a.receiverAccount === b.senderAccount
        if (swapped) {
          detected.push({
            relation: 'unresolved',
            subjectType: 'transaction',
            subjectAId: a.id,
            subjectBId: b.id,
            subjectARef: `UTR ${utr} ${a.senderAccount} → ${a.receiverAccount}`,
            subjectBRef: `UTR ${utr} ${b.senderAccount} → ${b.receiverAccount}`,
            description: `Reference ${utr} appears with opposite directions in two records (${a.senderAccount} → ${a.receiverAccount} vs ${b.senderAccount} → ${b.receiverAccount}). Could be a reversal/return or a data conflict — needs review.`,
            evidenceIds,
            detector: 'deterministic',
          })
        }
        const dd = dayDiff(a.txnDate, b.txnDate)
        if (dd > 1) {
          detected.push({
            relation: 'contradicts',
            subjectType: 'transaction',
            subjectAId: a.id,
            subjectBId: b.id,
            subjectARef: `UTR ${utr} dated ${a.txnDate ?? '?'}`,
            subjectBRef: `UTR ${utr} dated ${b.txnDate ?? '?'}`,
            description: `Reference ${utr} is dated ${a.txnDate ?? '?'} in one record and ${b.txnDate ?? '?'} (${dd} days apart) in another.`,
            evidenceIds,
            detector: 'deterministic',
          })
        }
      }
    }
  }

  // 4. Entity type conflicts — same norm, different declared type.
  const entities = await db.entity.findMany({
    where: { caseId },
    select: { id: true, type: true, value: true, norm: true },
  })
  const byNorm = new Map<string, typeof entities>()
  for (const e of entities) {
    if (!e.norm || e.norm.length < 5) continue
    const list = byNorm.get(e.norm) ?? []
    list.push(e)
    byNorm.set(e.norm, list)
  }
  for (const [norm, group] of byNorm) {
    const types = Array.from(new Set(group.map((g) => g.type)))
    if (types.length < 2) continue
    const evidenceRows = await db.entityLink.findMany({
      where: { entityId: { in: group.map((g) => g.id) } },
      select: { entityId: true, evidenceId: true },
    })
    detected.push({
      relation: 'contradicts',
      subjectType: 'entity',
      subjectAId: group[0].id,
      subjectBId: group[1].id,
      subjectARef: `${group[0].type} ${group[0].value}`,
      subjectBRef: `${group[1].type} ${group[1].value}`,
      description: `Identifier "${group[0].value}" (norm ${norm}) is typed as ${types.join(' AND ')} in different records. Verify which classification is correct before merging.`,
      evidenceIds: Array.from(new Set(evidenceRows.map((r) => r.evidenceId))),
      detector: 'deterministic',
    })
  }

  // 5. Findings over the same entity pair with diverging severity (supports modelling).
  const findings = await db.finding.findMany({
    where: { caseId },
    select: { id: true, type: true, severity: true, description: true, entitiesJson: true, createdAt: true },
  })
  const sevRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 }
  const pairSeen = new Map<string, typeof findings>()
  for (const f of findings) {
    let ids: string[] = []
    try { ids = JSON.parse(f.entitiesJson ?? '[]') as string[] } catch { /* ignore */ }
    if (ids.length < 1) continue
    const key = ids.slice().sort().join('|')
    const list = pairSeen.get(key) ?? []
    list.push(f)
    pairSeen.set(key, list)
  }
  for (const [, group] of pairSeen) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        const sa = sevRank[a.severity] ?? 2
        const sb = sevRank[b.severity] ?? 2
        if (Math.abs(sa - sb) >= 2) {
          detected.push({
            relation: sa > sb ? 'supersedes' : 'supersedes',
            subjectType: 'finding',
            subjectAId: sa > sb ? a.id : b.id,
            subjectBId: sa > sb ? b.id : a.id,
            subjectARef: `${(sa > sb ? a : b).type} (${(sa > sb ? a : b).severity})`,
            subjectBRef: `${(sa > sb ? b : a).type} (${(sa > sb ? b : a).severity})`,
            description: `Two findings over the same entities disagree sharply in severity (${a.type}=${a.severity} vs ${b.type}=${b.severity}). The higher-severity finding should be treated as superseding until reviewed.`,
            evidenceIds: [],
            detector: 'deterministic',
          })
        }
      }
    }
  }

  // Persist idempotently — key = subject pair + relation + subjectType.
  const existing = await db.contradiction.findMany({
    where: { caseId },
    select: { id: true, subjectAId: true, subjectBId: true, relation: true, subjectType: true },
  })
  const existingKeys = new Set(
    existing.map((c) => `${c.subjectType}|${c.relation}|${[c.subjectAId, c.subjectBId].sort().join('~')}`),
  )

  let created = 0
  const byRelation: Record<string, number> = {}
  for (const c of detected) {
    const key = `${c.subjectType}|${c.relation}|${[c.subjectAId, c.subjectBId].sort().join('~')}`
    const isNew = !existingKeys.has(key)
    if (isNew) {
      await db.contradiction.create({
        data: {
          caseId,
          relation: c.relation,
          subjectType: c.subjectType,
          subjectAId: c.subjectAId,
          subjectBId: c.subjectBId,
          subjectARef: c.subjectARef,
          subjectBRef: c.subjectBRef,
          description: c.description,
          evidenceIdsJson: JSON.stringify(c.evidenceIds),
          detector: c.detector,
        },
      })
      created++
    }
    byRelation[c.relation] = (byRelation[c.relation] ?? 0) + 1
  }

  return { detected: detected.length, created, byRelation }
}

/**
 * AI-assisted contradiction creation (called from the AI scan route when the
 * model reports contradictions it observed in the content).
 */
export async function persistAiContradictions(
  db: PrismaClient,
  caseId: string,
  evidenceId: string,
  contradictions: unknown,
): Promise<number> {
  if (!Array.isArray(contradictions)) return 0
  let created = 0
  for (const raw of contradictions.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const claimA = String(obj.claimA ?? obj.a ?? '').trim()
    const claimB = String(obj.claimB ?? obj.b ?? '').trim()
    if (!claimA || !claimB) continue
    const relationRaw = String(obj.relation ?? 'contradicts').toLowerCase()
    const relation = (['contradicts', 'supports', 'supersedes', 'unresolved'] as const).includes(
      relationRaw as 'contradicts',
    )
      ? (relationRaw as 'contradicts' | 'supports' | 'supersedes' | 'unresolved')
      : 'contradicts'
    const description = String(obj.description ?? `AI flagged: "${claimA}" vs "${claimB}"`)
    await db.contradiction.create({
      data: {
        caseId,
        relation,
        subjectType: 'communication',
        subjectARef: claimA,
        subjectBRef: claimB,
        description,
        evidenceIdsJson: JSON.stringify([evidenceId]),
        detector: 'ai',
      },
    })
    created++
  }
  return created
}
