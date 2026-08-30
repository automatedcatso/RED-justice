/**
 * decisions.ts — Investigator Decision Record service (architecture §18).
 *
 * Every human decision becomes structured intelligence:
 *   WHO (actor) · WHAT (action) · WHEN (at) · CASE · OBJECT ·
 *   BEFORE state → AFTER state · REASON · evidence relied upon
 *
 * The AI layer learns from authorized case decisions through this ledger —
 * not from hidden conversational context.
 */

import type { PrismaClient } from '@prisma/client'

export interface DecisionInput {
  caseId: string
  action: string
  objectType: string
  objectRef?: string | null
  objectLabel?: string | null
  beforeState?: string | null
  afterState?: string | null
  reason?: string | null
  actor?: string | null
  evidence?: Array<{ evidenceId: string; name?: string; locator?: string }> | null
  metadata?: Record<string, unknown> | null
}

/** Sequential DEC-xxxxxx reference, per-case monotonic. */
async function nextDecisionUid(db: PrismaClient, caseId: string): Promise<string> {
  const count = await db.decisionRecord.count({ where: { caseId } })
  let n = count + 1
  // Guard against collisions after deletions by probing upward.
  for (;;) {
    const uid = `DEC-${String(n).padStart(6, '0')}`
    const exists = await db.decisionRecord.findUnique({ where: { uid }, select: { id: true } })
    if (!exists) return uid
    n += 1
  }
}

export async function recordDecision(db: PrismaClient, input: DecisionInput) {
  try {
    const uid = await nextDecisionUid(db, input.caseId)
    return await db.decisionRecord.create({
      data: {
        uid,
        caseId: input.caseId,
        actor: input.actor?.trim() || 'investigator',
        action: input.action,
        objectType: input.objectType,
        objectRef: input.objectRef ?? null,
        objectLabel: input.objectLabel?.slice(0, 240) ?? null,
        beforeState: input.beforeState ?? null,
        afterState: input.afterState ?? null,
        reason: input.reason?.slice(0, 2000) ?? null,
        evidenceJson: input.evidence ? JSON.stringify(input.evidence) : null,
        metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    })
  } catch (err) {
    // A failed decision record must never break the underlying operation —
    // but it must be loud in logs so audit gaps are visible.
    console.error('[decisions] recordDecision failed:', err)
    return null
  }
}

export interface AuditEvent {
  kind: 'decision' | 'custody' | 'activity' | 'stage'
  ref: string
  at: string
  actor: string | null
  action: string
  objectLabel: string | null
  detail: string | null
  before: string | null
  after: string | null
}

/**
 * Unified tamper-evident-style audit feed: decision records ∪ chain of
 * custody ∪ activity log ∪ processing stages, newest first.
 */
export async function buildAuditFeed(
  db: PrismaClient,
  caseId: string,
  opts?: { limit?: number; kind?: string },
): Promise<AuditEvent[]> {
  const limit = Math.min(opts?.limit ?? 300, 1000)
  const events: AuditEvent[] = []

  const [decisions, custody, activities] = await Promise.all([
    db.decisionRecord.findMany({ where: { caseId }, orderBy: { at: 'desc' }, take: limit }),
    db.chainOfCustody.findMany({
      where: { evidence: { caseId } },
      orderBy: { at: 'desc' },
      take: limit,
      include: { evidence: { select: { id: true, originalName: true } } },
    }),
    db.activityLog.findMany({ where: { caseId }, orderBy: { at: 'desc' }, take: limit }),
  ])

  for (const d of decisions) {
    events.push({
      kind: 'decision',
      ref: d.uid,
      at: d.at.toISOString(),
      actor: d.actor,
      action: d.action,
      objectLabel: d.objectLabel,
      detail: d.reason,
      before: d.beforeState,
      after: d.afterState,
    })
  }
  for (const c of custody) {
    events.push({
      kind: 'custody',
      ref: c.id.slice(-8),
      at: c.at.toISOString(),
      actor: c.actor,
      action: c.action,
      objectLabel: c.evidence.originalName,
      detail: c.sha256 ? `sha256 ${c.sha256.slice(0, 12)}…` : null,
      before: null,
      after: null,
    })
  }
  for (const a of activities) {
    events.push({
      kind: 'activity',
      ref: a.id.slice(-8),
      at: a.at.toISOString(),
      actor: 'system',
      action: 'log',
      objectLabel: null,
      detail: a.msg,
      before: null,
      after: null,
    })
  }

  events.sort((x, y) => y.at.localeCompare(x.at))
  return (opts?.kind && opts.kind !== 'all' ? events.filter((e) => e.kind === opts.kind) : events).slice(0, limit)
}
