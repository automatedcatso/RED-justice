/**
 * api/helpers.ts — Shared utilities for the RED Justice App Router API layer.
 *
 * - Build a PatternContext from a case's DB rows (single round-trip per type).
 * - Persist Findings with deterministic dedup (caseId + type + trigger + entitiesJson hash).
 * - Persist ActorRisk rows (upsert by caseId + entityId).
 * - Persist Communities + CommunityMembers.
 * - Convert Prisma rows → analytics GraphInput.
 * - Resolve a case by either `id` (cuid) or `uid` (RED-YYYY-NNN).
 *
 * No React, no client-side imports.
 */
import type {
  Communication,
  Entity,
  Relationship,
  Transaction,
} from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

import { createHash } from 'crypto'

import {
  computeAll,
  type ComputeAllResult,
  type GraphInput,
  type GraphNode,
  type GraphEdge,
  type Community,
  centralActors,
  bridgeNodes,
} from '@/lib/analytics'
import {
  detectPatterns,
  type PatternContext,
  type Finding as PatternFinding,
} from '@/lib/analytics/patternEngine'
import {
  computeActorRisk,
  type ActorRiskScore,
} from '@/lib/analytics/actorRisk'

// ─────────────────────────────────────────────────────────────────────────────
// Case resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a case by either its primary `id` (cuid) or its human-readable `uid`
 * (e.g. "RED-2025-001"). Returns the row's `id` (cuid) or null if not found.
 */
export async function resolveCaseId(
  db: PrismaClient,
  idOrUid: string,
): Promise<string | null> {
  if (!idOrUid) return null
  // Try by id first.
  const byId = await db.case.findUnique({
    where: { id: idOrUid },
    select: { id: true },
  })
  if (byId) return byId.id
  // Then by uid.
  const byUid = await db.case.findUnique({
    where: { uid: idOrUid },
    select: { id: true },
  })
  return byUid?.id ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern context builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a {@link PatternContext} for a case: fetch entities, relationships,
 * transactions, communications in a single round-trip per type.
 */
export async function buildPatternContext(
  db: PrismaClient,
  caseId: string,
): Promise<PatternContext | null> {
  const exists = await db.case.findUnique({
    where: { id: caseId },
    select: { id: true },
  })
  if (!exists) return null

  const [entities, relationships, transactions, communications] =
    await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
      db.transaction.findMany({ where: { caseId } }),
      db.communication.findMany({ where: { caseId } }),
    ])

  return {
    caseId,
    entities: entities as Entity[],
    relationships: relationships as Relationship[],
    transactions: transactions as Transaction[],
    communications: communications as Communication[],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a list of Prisma entities + relationships into a GraphInput.
 *  Accepts structural subsets of the Prisma rows so partial selects and
 *  composed objects also work. */
export function toGraphInput(
  entities: Array<Pick<Entity, 'id' | 'type' | 'value'> & Partial<Pick<Entity, 'label'>>>,
  relationships: Array<Pick<Relationship, 'id' | 'srcId' | 'dstId' | 'type' | 'weight'> & Partial<Pick<Relationship, 'amount' | 'timestamp'>>>,
): GraphInput {
  const nodes: GraphNode[] = entities.map((e) => ({
    id: e.id,
    type: e.type,
    label: e.label ?? e.value,
    value: e.value,
  }))
  const edges: GraphEdge[] = relationships
    .filter((r) => r.srcId !== r.dstId)
    .map((r) => ({
      id: r.id,
      source: r.srcId,
      target: r.dstId,
      type: r.type,
      weight: typeof r.weight === 'number' && r.weight > 0 ? r.weight : 1,
      amount: r.amount ?? undefined,
      timestamp: r.timestamp ?? undefined,
    }))
  return { nodes, edges }
}

/**
 * Compute degree for every node given a GraphInput (in + out). Used by the
 * /graph endpoint to expose a per-node degree for visualization.
 */
export function computeDegrees(
  g: GraphInput,
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const n of g.nodes) result[n.id] = 0
  for (const e of g.edges) {
    if (e.source === e.target) continue
    result[e.source] = (result[e.source] ?? 0) + 1
    result[e.target] = (result[e.target] ?? 0) + 1
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings persistence (dedup)
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic hash for a Finding's dedup key. */
export function findingDedupKey(f: {
  type: string
  trigger?: string | null
  entitiesJson?: string | null
}): string {
  const base = `${f.type}|${f.trigger ?? ''}|${f.entitiesJson ?? ''}`
  return createHash('sha256').update(base).digest('hex').slice(0, 16)
}

/**
 * Persist a batch of Findings. Skips any finding whose dedup key already
 * exists for the case (so re-runs don't duplicate).
 *
 * @returns `{ created, skipped, total }`
 */
export async function persistFindings(
  db: PrismaClient,
  caseId: string,
  findings: PatternFinding[],
): Promise<{ created: number; skipped: number; total: number }> {
  if (findings.length === 0) return { created: 0, skipped: 0, total: 0 }

  // Fetch existing dedup keys for the case.
  const existing = await db.finding.findMany({
    where: { caseId },
    select: { type: true, trigger: true, entitiesJson: true },
  })
  const existingKeys = new Set<string>()
  for (const f of existing) {
    existingKeys.add(
      findingDedupKey({
        type: f.type,
        trigger: f.trigger ?? undefined,
        entitiesJson: f.entitiesJson ?? undefined,
      }),
    )
  }

  let created = 0
  let skipped = 0
  for (const f of findings) {
    const key = findingDedupKey(f)
    if (existingKeys.has(key)) {
      skipped += 1
      continue
    }
    try {
      await db.finding.create({
        data: {
          caseId,
          type: f.type,
          severity: f.severity,
          confidence: f.confidence,
          description: f.description,
          trigger: f.trigger ?? null,
          entitiesJson: f.entitiesJson ?? null,
          relationshipsJson: f.relationshipsJson ?? null,
          transactionsJson: f.transactionsJson ?? null,
          supportingEvidence: f.supportingEvidence ?? null,
          reviewStatus: f.reviewStatus ?? 'new',
        },
      })
      existingKeys.add(key)
      created += 1
    } catch (err) {
      console.error('[api] persistFindings: insert failed:', err)
      skipped += 1
    }
  }
  return { created, skipped, total: findings.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// ActorRisk persistence (upsert by caseId + entityId)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist ActorRisk rows by upserting on (caseId, entityId). Replaces any
 * existing rows for the case before inserting fresh scores. Returns count.
 */
export async function persistActorRisks(
  db: PrismaClient,
  caseId: string,
  scores: ActorRiskScore[],
): Promise<{ updated: number; total: number }> {
  if (scores.length === 0) {
    // Still wipe prior rows so the case reflects "no high-risk actors".
    await db.actorRisk.deleteMany({ where: { caseId } }).catch(() => {})
    return { updated: 0, total: 0 }
  }
  // Wipe prior rows to keep the leaderboard deterministic.
  await db.actorRisk.deleteMany({ where: { caseId } }).catch(() => {})
  let updated = 0
  for (const s of scores) {
    try {
      await db.actorRisk.create({
        data: {
          caseId,
          entityId: s.entityId,
          score: s.score,
          componentsJson: JSON.stringify(s.components ?? {}),
          contributorsJson: JSON.stringify(s.contributors ?? []),
        },
      })
      updated += 1
    } catch (err) {
      console.error('[api] persistActorRisks: insert failed:', err)
    }
  }
  return { updated, total: scores.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Communities persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist communities + members. Wipes prior rows for the case first.
 * Computes central/bridge actors and per-community transaction volume.
 */
export async function persistCommunities(
  db: PrismaClient,
  caseId: string,
  communities: Community[],
  ctx: PatternContext,
  metrics: ComputeAllResult,
): Promise<{ created: number; totalMembers: number }> {
  await db.communityMember.deleteMany({
    where: { community: { caseId } },
  }).catch(() => {})
  await db.community.deleteMany({ where: { caseId } }).catch(() => {})

  const entityById = new Map(ctx.entities.map((e) => [e.id, e]))
  const bridges = new Set(bridgeNodes(toGraphInput(ctx.entities, ctx.relationships), 10))
  const centrals = new Set(
    centralActors(toGraphInput(ctx.entities, ctx.relationships), 50).map((c) => c.id),
  )
  const findingsByEntity = new Map<string, number>()
  for (const f of (await db.finding.findMany({
    where: { caseId },
    select: { entitiesJson: true },
  }))) {
    try {
      const ids = JSON.parse(f.entitiesJson ?? '[]')
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string') {
            findingsByEntity.set(id, (findingsByEntity.get(id) ?? 0) + 1)
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  let created = 0
  let totalMembers = 0
  for (const [idx, c] of communities.entries()) {
    // Singleton "communities" (1 member) are noise — LPA emits one per
    // isolated node. Persisting them produced useless C-2..C-10 cards in
    // the UI. Only real 2+ member groups are kept.
    if (c.members.length < 2) continue
    const memberSet = new Set(c.members)
    // Type breakdown.
    const typeCounts: Record<string, number> = {}
    for (const id of c.members) {
      const e = entityById.get(id)
      if (!e) continue
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
    }
    const dominantTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `${t}(${n})`)
      .join(',')

    // Internal/external relationships.
    const internalRels = ctx.relationships.filter(
      (r) => memberSet.has(r.srcId) && memberSet.has(r.dstId),
    ).length
    const externalRels = ctx.relationships.filter(
      (r) => memberSet.has(r.srcId) !== memberSet.has(r.dstId),
    ).length

    // Transaction volume touching community accounts.
    const accountValuesInCommunity = new Set<string>()
    for (const id of c.members) {
      const e = entityById.get(id)
      if (!e) continue
      if (
        e.type === 'account' ||
        e.type === 'wallet' ||
        e.type === 'upi'
      ) {
        accountValuesInCommunity.add(e.value)
        if (e.norm) accountValuesInCommunity.add(e.norm)
      }
    }
    let txVolume = 0
    let suspiciousCount = 0
    for (const t of ctx.transactions) {
      const s = t.senderAccount ?? ''
      const r = t.receiverAccount ?? ''
      if (accountValuesInCommunity.has(s) || accountValuesInCommunity.has(r)) {
        txVolume += typeof t.amount === 'number' ? t.amount : 0
      }
    }
    for (const id of c.members) {
      suspiciousCount += findingsByEntity.get(id) ?? 0
    }

    const centralActorsInComm = c.members.filter((id) => centrals.has(id))
    const bridgeActorsInComm = c.members.filter((id) => bridges.has(id))

    const community = await db.community.create({
      data: {
        caseId,
        label: `community-${idx + 1}`,
        size: c.members.length,
        dominantTypes,
        transactionVolume: txVolume,
        internalRels,
        externalRels,
        centralActorsJson: JSON.stringify(centralActorsInComm),
        bridgeActorsJson: JSON.stringify(bridgeActorsInComm),
        suspiciousPatterns: suspiciousCount,
        metadataJson: JSON.stringify({ typeBreakdown: typeCounts }),
      },
    })
    for (const entityId of c.members) {
      try {
        await db.communityMember.create({
          data: {
            communityId: community.id,
            entityId,
          },
        })
        totalMembers += 1
      } catch (err) {
        // Likely a FK constraint (entityId not in DB) — skip.
        console.error('[api] persistCommunities: member insert failed:', err)
      }
    }
    created += 1
  }
  return { created, totalMembers }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full analytics run + persist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run pattern detection + actor risk scoring + community detection on a case
 * and persist all of them. Used by /api/cases/[id]/patterns/run
 * + /api/cases/[id]/actors/run.
 *
 * Returns counts of what was persisted.
 */
export async function runAnalyticsAndPersist(
  db: PrismaClient,
  caseId: string,
  opts: { persistFindings?: boolean; persistActors?: boolean; persistCommunities?: boolean } = {},
): Promise<{
  findings: { created: number; skipped: number; total: number }
  actors: { updated: number; total: number }
  communities: { created: number; totalMembers: number }
  metrics: ComputeAllResult
}> {
  const ctx = await buildPatternContext(db, caseId)
  if (!ctx) {
    return {
      findings: { created: 0, skipped: 0, total: 0 },
      actors: { updated: 0, total: 0 },
      communities: { created: 0, totalMembers: 0 },
      metrics: {
        degree: {},
        inDegree: {},
        outDegree: {},
        betweenness: {},
        closeness: {},
        pagerank: {},
        communities: [],
        components: [],
      },
    }
  }

  const graph = toGraphInput(ctx.entities, ctx.relationships)
  const metrics = computeAll(graph)

  let findings = detectPatterns(ctx)
  // v3.7.1: a 500-row bank trail detonated 2,804 findings (per-row pattern
  // pairs); persisting thousands of rows one-by-one after every scan wasted
  // minutes and drowned the Findings panel. Keep the most severe 500 — the
  // UI shows a ranked list anyway.
  if (findings.length > 500) {
    const sevRank = (s: unknown): number => (s === 'high' ? 3 : s === 'medium' ? 2 : 1)
    findings = [...findings]
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 500)
    console.log(`[analytics] pattern findings capped to top 500 by severity`)
  }
  const actorScores = computeActorRisk(ctx, {
    metrics,
    findings,
  })

  const persistFindingsFlag = opts.persistFindings ?? true
  const persistActorsFlag = opts.persistActors ?? true
  const persistCommunitiesFlag = opts.persistCommunities ?? true

  const fResult = persistFindingsFlag
    ? await persistFindings(db, caseId, findings)
    : { created: 0, skipped: 0, total: findings.length }
  const aResult = persistActorsFlag
    ? await persistActorRisks(db, caseId, actorScores)
    : { updated: 0, total: actorScores.length }
  const cResult = persistCommunitiesFlag
    ? await persistCommunities(db, caseId, metrics.communities, ctx, metrics)
    : { created: 0, totalMembers: 0 }

  return { findings: fResult, actors: aResult, communities: cResult, metrics }
}

// ─────────────────────────────────────────────────────────────────────────────
// Network analytics cache (in-memory, keyed by caseId + content hash)
// ─────────────────────────────────────────────────────────────────────────────

interface NetworkCacheEntry {
  caseId: string
  contentHash: string
  result: ComputeAllResult
  bridges: string[]
  centralActorsList: Array<{ entityId: string; score: number }>
  computedAt: number
}

const networkCache = new Map<string, NetworkCacheEntry>()

/** Hash the case content (entities/relationships/transactions counts). */
export async function hashCaseContent(
  db: PrismaClient,
  caseId: string,
): Promise<string> {
  const [entityCount, relCount, txnCount, findingCount] = await Promise.all([
    db.entity.count({ where: { caseId } }),
    db.relationship.count({ where: { caseId } }),
    db.transaction.count({ where: { caseId } }),
    db.finding.count({ where: { caseId } }),
  ])
  return createHash('sha1')
    .update(`${caseId}|${entityCount}|${relCount}|${txnCount}|${findingCount}`)
    .digest('hex')
}

/** Get or compute the full network analytics snapshot for a case. */
export async function getOrComputeNetwork(
  db: PrismaClient,
  caseId: string,
): Promise<{
  metrics: ComputeAllResult
  bridges: string[]
  centralActorsList: Array<{ entityId: string; score: number }>
}> {
  const hash = await hashCaseContent(db, caseId)
  const cacheKey = `${caseId}`
  const cached = networkCache.get(cacheKey)
  if (cached && cached.contentHash === hash) {
    return {
      metrics: cached.result,
      bridges: cached.bridges,
      centralActorsList: cached.centralActorsList,
    }
  }

  const ctx = await buildPatternContext(db, caseId)
  if (!ctx) {
    return {
      metrics: {
        degree: {},
        inDegree: {},
        outDegree: {},
        betweenness: {},
        closeness: {},
        pagerank: {},
        communities: [],
        components: [],
      },
      bridges: [],
      centralActorsList: [],
    }
  }
  const graph = toGraphInput(ctx.entities, ctx.relationships)
  const metrics = computeAll(graph)
  const bridges = bridgeNodes(graph, 10)
  const centralActorsList = centralActors(graph, 20).map((c) => ({
    entityId: c.id,
    score: c.score,
  }))

  networkCache.set(cacheKey, {
    caseId,
    contentHash: hash,
    result: metrics,
    bridges,
    centralActorsList,
    computedAt: Date.now(),
  })

  return { metrics, bridges, centralActorsList }
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity log helper
// ─────────────────────────────────────────────────────────────────────────────

/** Append a short activity-log entry for the case (no-op if caseId is null). */
export async function logActivity(
  db: PrismaClient,
  caseId: string | null,
  msg: string,
): Promise<void> {
  try {
    await db.activityLog.create({
      data: { caseId, msg },
    })
  } catch (err) {
    console.error('[api] logActivity failed:', err)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-N helpers for analytics maps
// ─────────────────────────────────────────────────────────────────────────────

/** Take the top-N entries from a record (object) by value, descending. */
export function topNFromRecord(
  rec: Record<string, number>,
  n: number,
): Array<{ id: string; score: number }> {
  return Object.entries(rec)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, n))
}
