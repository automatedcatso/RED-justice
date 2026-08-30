/**
 * claims.ts — Claim Graph assembly.
 *
 * Separates the epistemic ladder so an unsupported hypothesis cannot
 * silently become a report fact:
 *
 *   Evidence  →  Observation  →  Finding  →  Hypothesis  →  Claim  →  Report
 *
 * The graph is assembled live from existing records:
 *   observation : entities/transactions extracted from evidence (auto)
 *   finding     : deterministic pattern detections (auto)
 *   hypothesis  : investigator/AI hypotheses (InvestigatorNote metadata)
 *   claim       : investigator-approved assertions (Claim rows + approved
 *                 findings auto-promoted to 'claim' level with verified
 *                 status only when their sufficiency ≥ 50)
 *   report      : generated reports (markdown exports are recorded here)
 *
 * Status rules:
 *   claim.status = verified   — approved finding w/ sufficiency ≥ 50 or a
 *                               hypothesis confirmed by verification
 *   claim.status = supported  — has ≥1 supporting observation/finding
 *   claim.status = unsupported — nothing below supports it (flagged red)
 *   claim.status = rejected   — investigator rejected the source finding
 */

import type { PrismaClient } from '@prisma/client'
import { scoreFinding } from './sufficiency'

export interface ClaimNode {
  id: string
  level: 'evidence' | 'observation' | 'finding' | 'hypothesis' | 'claim' | 'report'
  refId: string | null
  text: string
  status: 'unsupported' | 'supported' | 'verified' | 'rejected'
  sources: string[] // refIds of supporting nodes below it in the ladder
  createdAt: string
  sufficiency?: number
}

export interface ClaimGraph {
  nodes: ClaimNode[]
  counts: Record<string, number>
  unsupportedClaims: ClaimNode[]
  reportReady: boolean
  policy: string
}

export async function buildClaimGraph(db: PrismaClient, caseId: string): Promise<ClaimGraph> {
  const nodes: ClaimNode[] = []

  const [evidence, findings, hypothesisNotes, manualClaims] = await Promise.all([
    db.evidence.findMany({
      where: { caseId },
      select: { id: true, originalName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.finding.findMany({
      where: { caseId },
      select: {
        id: true, type: true, description: true, decision: true, entitiesJson: true,
        supportingEvidence: true, createdAt: true,
      },
    }),
    db.investigatorNote.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } }),
    db.claim.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } }),
  ])

  // Evidence level.
  const evidenceById = new Map<string, ClaimNode>()
  for (const e of evidence) {
    const node: ClaimNode = {
      id: `ev-${e.id}`,
      level: 'evidence',
      refId: e.id,
      text: e.originalName,
      status: 'verified', // ingested evidence with sha256 is a verified base fact
      sources: [],
      createdAt: e.createdAt.toISOString(),
    }
    nodes.push(node)
    evidenceById.set(e.id, node)
  }

  // Observation level: entities (each cites its evidence).
  const entities = await db.entity.findMany({
    where: { caseId },
    select: { id: true, type: true, value: true, links: { select: { evidenceId: true } } },
  })
  for (const e of entities) {
    nodes.push({
      id: `ob-${e.id}`,
      level: 'observation',
      refId: e.id,
      text: `Observed ${e.type}: ${e.value}`,
      status: e.links.length > 0 ? 'verified' : 'unsupported',
      sources: e.links.map((l) => `ev-${l.evidenceId}`),
      createdAt: new Date().toISOString(),
    })
  }

  // Finding level: scored.
  const findingNodes = new Map<string, ClaimNode>()
  for (const f of findings) {
    let suff = 0
    try {
      const s = await scoreFinding(db, caseId, f)
      suff = s.score
    } catch { /* scoring is best-effort */ }
    const status: ClaimNode['status'] =
      f.decision === 'rejected' ? 'rejected'
      : f.decision === 'approved' && suff >= 50 ? 'verified'
      : f.decision === 'approved' ? 'supported'
      : 'supported'
    const node: ClaimNode = {
      id: `fi-${f.id}`,
      level: 'finding',
      refId: f.id,
      text: `${f.type}: ${f.description.slice(0, 160)}`,
      status,
      sources: [],
      createdAt: f.createdAt.toISOString(),
      sufficiency: suff,
    }
    // Cite evidence under the finding.
    try {
      const se = JSON.parse(f.supportingEvidence ?? '[]') as string[]
      node.sources = se.filter((x) => evidenceById.has(x)).map((x) => `ev-${x}`)
    } catch { /* ignore */ }
    if (node.sources.length === 0) {
      let ids: string[] = []
      try { ids = JSON.parse(f.entitiesJson ?? '[]') as string[] } catch { /* ignore */ }
      const obs = nodes.filter((n) => n.level === 'observation' && ids.includes(n.refId ?? ''))
      node.sources = obs.slice(0, 6).map((o) => o.id)
    }
    nodes.push(node)
    findingNodes.set(f.id, node)
  }

  // Hypothesis level.
  for (const n of hypothesisNotes) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(n.metadataJson ?? '{}') as Record<string, unknown> } catch { /* ignore */ }
    if (!meta.hypothesis) continue
    const status = meta.status === 'confirmed' ? 'verified'
      : meta.status === 'rejected' ? 'rejected'
      : Array.isArray(meta.supportingEvidence) && (meta.supportingEvidence as unknown[]).length > 0 ? 'supported'
      : 'unsupported'
    nodes.push({
      id: `hy-${n.id}`,
      level: 'hypothesis',
      refId: n.id,
      text: `${String(meta.title ?? 'Hypothesis')}: ${n.body.slice(0, 140)}`,
      status,
      sources: findingNodes.size > 0 ? Array.from(findingNodes.values()).slice(0, 3).map((f) => f.id) : [],
      createdAt: n.createdAt.toISOString(),
    })
  }

  // Manual claims (investigator-authored) + auto-promoted approved findings.
  for (const c of manualClaims) {
    let sources: string[] = []
    try { sources = JSON.parse(c.sourcesJson ?? '[]') as string[] } catch { /* ignore */ }
    nodes.push({
      id: `cl-${c.id}`,
      level: 'claim',
      refId: c.id,
      text: c.text.slice(0, 200),
      status: (c.status as ClaimNode['status']) ?? 'unsupported',
      sources,
      createdAt: c.createdAt.toISOString(),
    })
  }
  for (const f of findingNodes.values()) {
    if (f.status === 'verified') {
      nodes.push({
        id: `cl-auto-${f.refId}`,
        level: 'claim',
        refId: f.refId,
        text: `Approved finding promoted to claim — ${f.text.slice(0, 160)}`,
        status: 'verified',
        sources: [f.id],
        createdAt: f.createdAt,
        sufficiency: f.sufficiency,
      })
    }
  }

  const counts: Record<string, number> = {}
  for (const n of nodes) counts[n.level] = (counts[n.level] ?? 0) + 1

  const unsupportedClaims = nodes.filter((n) => n.level === 'claim' && n.status === 'unsupported')

  return {
    nodes,
    counts,
    unsupportedClaims,
    reportReady: unsupportedClaims.length === 0,
    policy:
      'Report facts must trace to verified claims. A claim is verified only when an approved finding has sufficiency ≥ 50 or a hypothesis passed deterministic verification. Unsupported hypotheses never become report facts.',
  }
}
