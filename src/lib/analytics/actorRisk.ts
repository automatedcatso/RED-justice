/**
 * actorRisk.ts — Actor risk prioritization for RED Justice.
 *
 * Pure TypeScript computation that turns the analytical graph metrics, the
 * detected suspicious patterns, and the raw transaction context into a single
 * 0..100 risk score per entity, plus a breakdown of contributing components
 * and human-readable strings explaining the score.
 *
 * No DB calls, no React. Never throws on empty input.
 */

import type { Entity, Relationship, Transaction } from '@prisma/client'

import {
  betweennessCentrality,
  degreeCentrality,
  pageRank,
  type ComputeAllResult,
  type GraphInput,
} from './graphAnalytics'
import { aggregateStats, fanIn, fanOut, velocityAnalysis } from './moneyFlow'
import type { Finding, PatternContext } from './patternEngine'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Risk score for one entity. */
export interface ActorRiskScore {
  entityId: string
  /** Final 0..100 risk score. */
  score: number
  /** Named components, each in 0..100. */
  components: Record<string, number>
  /** Human-readable explanation strings. */
  contributors: string[]
}

/** Optional precomputed analytics input. */
export interface AnalyticsInput {
  /** Precomputed graph metrics (betweenness, degree, pagerank, communities...). */
  metrics?: ComputeAllResult
  /** Precomputed findings (so we don't re-detect). */
  findings?: Finding[]
}

/** Default component weights (sum to 1.0). */
export const DEFAULT_COMPONENT_WEIGHTS: Record<string, number> = {
  networkCentrality: 0.13,
  degree: 0.08,
  txnVolume: 0.15,
  txnVelocity: 0.1,
  linkedEntities: 0.08,
  suspiciousPatterns: 0.15,
  communityPosition: 0.05,
  bridgeScore: 0.08,
  sharedIds: 0.06,
  temporalCorrelation: 0.05,
  evidenceConfidence: 0.07,
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000

const ACCOUNT_TYPES = new Set(['account', 'bank_account', 'wallet'])
const PERSON_TYPES = new Set(['person', 'individual', 'suspect'])
/**
 * Entity types that can rank as "suspicious actors". People and organizations
 * are actors; mule accounts/wallets act as money handlers; phones/emails/
 * UPI handles act as communication identities; vehicles are physical actors.
 * Reference material (IFSC codes, document ids, IPs, URLs, locations) is
 * excluded — those belong to findings, not the actor leaderboard.
 */
const ACTOR_ELIGIBLE_TYPES = new Set([
  'person',
  'individual',
  'suspect',
  'organization',
  'organisation',
  'account',
  'bank_account',
  'wallet',
  'upi',
  'phone',
  'email',
  'vehicle',
  'social',
  'device',
])
const IDENTIFIER_TYPES = new Set([
  'phone',
  'mobile',
  'telephone',
  'device',
  'imei',
  'device_id',
  'ip',
  'ipv4',
  'ipv6',
  'ip_address',
  'email',
])

function isType(types: Set<string>, t: string | null | undefined): boolean {
  if (!t) return false
  return types.has(t.toLowerCase())
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function amt(t: Transaction): number {
  return typeof t.amount === 'number' && Number.isFinite(t.amount)
    ? t.amount
    : 0
}

function senderOf(t: Transaction): string | null {
  return t.senderAccount ?? null
}
function receiverOf(t: Transaction): string | null {
  return t.receiverAccount ?? null
}

/** Build undirected neighbor map: entityId -> Set<entityId>. */
function neighborMap(
  entities: Entity[],
  relationships: Relationship[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const e of entities) map.set(e.id, new Set())
  for (const r of relationships) {
    if (r.srcId === r.dstId) continue
    if (!map.has(r.srcId)) map.set(r.srcId, new Set())
    if (!map.has(r.dstId)) map.set(r.dstId, new Set())
    map.get(r.srcId)!.add(r.dstId)
    map.get(r.dstId)!.add(r.srcId)
  }
  return map
}

/**
 * Resolve the set of account values (string account numbers) linked to an
 * entity — directly if it's an account entity, or via 1-hop neighbors if it's
 * a person/identifier that links to accounts.
 */
function accountValuesFor(
  entity: Entity,
  neighbors: Map<string, Set<string>>,
  entityById: Map<string, Entity>,
): Set<string> {
  const out = new Set<string>()
  if (isType(ACCOUNT_TYPES, entity.type)) {
    // An ACCOUNT's transactions are its own. v3.7.1: inheriting account-type
    // NEIGHBORS' values here made every counterparty account in a bank trail
    // "own" the hub account — every one of thousands of transactions then
    // attributed to hundreds of entities, and the temporal-correlation pass
    // combusted (≥1.1 billion pair increments = minutes of blocked event
    // loop, app frozen for every request).
    out.add(entity.value)
    if (entity.norm) out.add(entity.norm)
    return out
  }
  for (const nId of neighbors.get(entity.id) ?? []) {
    const n = entityById.get(nId)
    if (!n) continue
    if (isType(ACCOUNT_TYPES, n.type)) {
      out.add(n.value)
      if (n.norm) out.add(n.norm)
    }
  }
  return out
}

/** Clamp to 0..100. */
function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(100, x))
}

/** Compute percentile rank of a value in a sorted-ascending list (0..1). */
function percentile(sortedAsc: number[], value: number): number {
  if (sortedAsc.length === 0) return 0
  let count = 0
  for (const v of sortedAsc) {
    if (v < value) count += 1
  }
  return count / sortedAsc.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute actor risk scores for every entity in the context.
 *
 * @param ctx Pattern context (entities, relationships, transactions, etc).
 * @param analytics Optional precomputed graph metrics & findings. If omitted,
 *                  they are computed internally.
 * @param weights Optional custom component weights (defaults to
 *                {@link DEFAULT_COMPONENT_WEIGHTS}).
 */
export function computeActorRisk(
  ctx: PatternContext,
  analytics?: AnalyticsInput,
  weights: Record<string, number> = DEFAULT_COMPONENT_WEIGHTS,
): ActorRiskScore[] {
  if (!ctx || ctx.entities.length === 0) return []

  // Build graph and metrics if not supplied.
  const graph: GraphInput = {
    nodes: ctx.entities.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label ?? e.value,
      value: e.value,
    })),
    edges: ctx.relationships.map((r) => ({
      id: r.id,
      source: r.srcId,
      target: r.dstId,
      type: r.type,
      weight: typeof r.weight === 'number' && r.weight > 0 ? r.weight : 1,
      amount: r.amount ?? undefined,
      timestamp: r.timestamp ?? undefined,
    })),
  }

  const metrics =
    analytics?.metrics ??
    {
      degree: degreeCentrality(graph),
      inDegree: {},
      outDegree: {},
      betweenness: betweennessCentrality(graph),
      closeness: {},
      pagerank: pageRank(graph),
      communities: [],
      components: [],
    }

  const findings = analytics?.findings ?? []

  const neighbors = neighborMap(ctx.entities, ctx.relationships)
  const entityById = new Map(ctx.entities.map((e) => [e.id, e]))

  // Pre-compute per-entity account value sets.
  const accountValuesByEntity = new Map<string, Set<string>>()
  for (const e of ctx.entities) {
    accountValuesByEntity.set(e.id, accountValuesFor(e, neighbors, entityById))
  }

  // Reverse index: account value -> entity ids (for transaction attribution).
  const accountValueToEntities = new Map<string, Set<string>>()
  for (const e of ctx.entities) {
    for (const v of accountValuesByEntity.get(e.id) ?? []) {
      if (!accountValueToEntities.has(v))
        accountValueToEntities.set(v, new Set())
      accountValueToEntities.get(v)!.add(e.id)
    }
  }

  // Pre-compute betweenness max & sorted list for percentiles.
  const betValues = Object.values(metrics.betweenness)
  const maxBet = Math.max(1e-9, ...betValues)
  const sortedBetAsc = [...betValues].sort((a, b) => a - b)

  // Pre-compute degree max for normalisation.
  const degValues = Object.values(metrics.degree)
  const maxDeg = Math.max(1e-9, ...degValues)

  // Pre-compute total txn volume across the case (for log scaling).
  const stats = aggregateStats(ctx.transactions)
  const maxVolume = Math.max(1, stats.totalVolume)

  // Pre-compute entity -> set of txn ids touching its accounts.
  const txnsByEntity = new Map<string, Set<string>>()
  for (const t of ctx.transactions) {
    const s = senderOf(t)
    const r = receiverOf(t)
    const involved = new Set<string>()
    if (s) for (const eId of accountValueToEntities.get(s) ?? []) involved.add(eId)
    if (r) for (const eId of accountValueToEntities.get(r) ?? []) involved.add(eId)
    for (const eId of involved) {
      if (!txnsByEntity.has(eId)) txnsByEntity.set(eId, new Set())
      txnsByEntity.get(eId)!.add(t.id)
    }
  }

  // Pre-compute entity -> count of findings mentioning it.
  const findingsByEntity = new Map<string, Finding[]>()
  for (const f of findings) {
    let ids: string[] = []
    if (f.entitiesJson) {
      try {
        const parsed = JSON.parse(f.entitiesJson)
        if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === 'string')
      } catch {
        /* ignore */
      }
    }
    for (const id of ids) {
      if (!findingsByEntity.has(id)) findingsByEntity.set(id, [])
      findingsByEntity.get(id)!.push(f)
    }
  }

  // Pre-compute identifier entities that are shared (link >=2 actors).
  const sharedIdentifiers = new Set<string>()
  for (const e of ctx.entities) {
    if (!isType(IDENTIFIER_TYPES, e.type)) continue
    const nb = neighbors.get(e.id) ?? new Set<string>()
    let actorCount = 0
    for (const nId of nb) {
      const n = entityById.get(nId)
      if (!n) continue
      if (isType(PERSON_TYPES, n.type) || isType(ACCOUNT_TYPES, n.type)) {
        actorCount += 1
      }
    }
    if (actorCount >= 2) sharedIdentifiers.add(e.id)
  }

  // Pre-compute bridge nodes (top 10% by betweenness).
  const rankedBet = Object.entries(metrics.betweenness)
    .sort((a, b) => b[1] - a[1])
  const topK = Math.max(1, Math.ceil(ctx.entities.length * 0.1))
  const bridgeEntityIds = new Set(rankedBet.slice(0, topK).map(([id]) => id))

  // Pre-compute "central" nodes: top 20% by degree centrality.
  const rankedDeg = Object.entries(metrics.degree).sort((a, b) => b[1] - a[1])
  const topDegK = Math.max(1, Math.ceil(ctx.entities.length * 0.2))
  const centralEntityIds = new Set(rankedDeg.slice(0, topDegK).map(([id]) => id))

  // Pre-compute temporal correlations per entity: number of distinct days the
  // entity had a transaction within 1h of another entity's transaction.
  const temporalByEntity = new Map<string, number>()
  // Index: list of {ts, entityId} sorted by ts.
  type TsRec = { ts: number; entityId: string }
  const tsRecs: TsRec[] = []
  for (const t of ctx.transactions) {
    const ts = parseTs(t.txnDate)
    if (ts === null) continue
    const s = senderOf(t)
    const r = receiverOf(t)
    const eIds = new Set<string>()
    if (s) for (const eId of accountValueToEntities.get(s) ?? []) eIds.add(eId)
    if (r) for (const eId of accountValueToEntities.get(r) ?? []) eIds.add(eId)
    for (const eId of eIds) tsRecs.push({ ts, entityId: eId })
  }
  tsRecs.sort((a, b) => a.ts - b.ts)
  // v3.7.1 safety valve: the inner window scan is O(pairs) and bursts of
  // same-timestamp records (bulk ledger imports) are quadratic. 64 neighbours
  // per record is plenty for a correlation COUNT.
  for (let i = 0; i < tsRecs.length; i++) {
    let inner = 0
    for (let j = i + 1; j < tsRecs.length; j++) {
      if (tsRecs[j].ts - tsRecs[i].ts > HOUR_MS) break
      if (++inner > 64) break
      const a = tsRecs[i].entityId
      const b = tsRecs[j].entityId
      if (a === b) continue
      temporalByEntity.set(a, (temporalByEntity.get(a) ?? 0) + 1)
      temporalByEntity.set(b, (temporalByEntity.get(b) ?? 0) + 1)
    }
  }

  // Aggregate stats: total volume / max volume per entity.
  const volumeByEntity = new Map<string, number>()
  for (const t of ctx.transactions) {
    const a = amt(t)
    const s = senderOf(t)
    const r = receiverOf(t)
    const eIds = new Set<string>()
    if (s) for (const eId of accountValueToEntities.get(s) ?? []) eIds.add(eId)
    if (r) for (const eId of accountValueToEntities.get(r) ?? []) eIds.add(eId)
    for (const eId of eIds) {
      volumeByEntity.set(eId, (volumeByEntity.get(eId) ?? 0) + a)
    }
  }

  const results: ActorRiskScore[] = []
  for (const e of ctx.entities) {
    // Actor eligibility: pure reference identifiers (IFSC, document ids,
    // IPs, domains, locations) are GRAPH EVIDENCE, not "suspicious actors".
    // Scoring them used to surface IFSC codes in the Top-Actors panel.
    if (!isType(ACTOR_ELIGIBLE_TYPES, e.type)) continue
    const components: Record<string, number> = {}
    const contributors: string[] = []

    // 1. networkCentrality — betweenness / max betweenness * 100
    const bet = metrics.betweenness[e.id] ?? 0
    const networkCentrality = clamp100((bet / maxBet) * 100)
    components.networkCentrality = networkCentrality
    if (networkCentrality >= 50) {
      contributors.push(`High betweenness (${(bet / maxBet).toFixed(2)})`)
    }

    // 2. degree centrality * 100
    const deg = metrics.degree[e.id] ?? 0
    const degScore = clamp100(deg * 100)
    components.degree = degScore
    if (degScore >= 50) {
      contributors.push(`High degree centrality (${deg.toFixed(2)})`)
    }

    // 3. txnVolume — log-scaled total amount
    const vol = volumeByEntity.get(e.id) ?? 0
    const txnVolume = clamp100(
      vol <= 0 ? 0 : (Math.log10(1 + vol) / Math.log10(1 + maxVolume)) * 100,
    )
    components.txnVolume = txnVolume
    if (txnVolume >= 50) {
      contributors.push(`High transaction volume (₹${vol.toFixed(0)})`)
    }

    // 4. txnVelocity — max window count from velocityAnalysis (across this entity's accounts)
    let maxWin = 0
    for (const acc of accountValuesByEntity.get(e.id) ?? []) {
      const v = velocityAnalysis(ctx.transactions, acc, 7)
      for (const w of v) maxWin = Math.max(maxWin, w.count)
    }
    const txnVelocity = clamp100(Math.min(1, maxWin / 20) * 100)
    components.txnVelocity = txnVelocity
    if (txnVelocity >= 50) {
      contributors.push(`High transaction velocity (${maxWin} in 7d window)`)
    }

    // 5. linkedEntities — distinct neighbors count
    const linkedCount = neighbors.get(e.id)?.size ?? 0
    const linkedEntities = clamp100(Math.min(1, linkedCount / 20) * 100)
    components.linkedEntities = linkedEntities
    if (linkedEntities >= 5) {
      contributors.push(`Connected to ${linkedCount} entities`)
    }

    // 6. suspiciousPatterns — count of findings involving this entity
    const findingCount = findingsByEntity.get(e.id)?.length ?? 0
    const suspiciousPatterns = clamp100(Math.min(1, findingCount / 5) * 100)
    components.suspiciousPatterns = suspiciousPatterns
    if (findingCount > 0) {
      contributors.push(`Appears in ${findingCount} suspicious flow${findingCount === 1 ? '' : 's'}`)
    }

    // 7. communityPosition — 1 if bridge, 0.5 if central, 0 otherwise
    let communityPositionValue = 0
    if (bridgeEntityIds.has(e.id)) communityPositionValue = 1
    else if (centralEntityIds.has(e.id)) communityPositionValue = 0.5
    components.communityPosition = clamp100(communityPositionValue * 100)
    if (communityPositionValue === 1) {
      contributors.push('Bridge position between communities')
    } else if (communityPositionValue === 0.5) {
      contributors.push('Central position in its community')
    }

    // 8. bridgeScore — betweenness percentile
    const bridgeScore = clamp100(
      percentile(sortedBetAsc, bet) * 100,
    )
    components.bridgeScore = bridgeScore
    if (bridgeScore >= 80) {
      contributors.push(`Top ${(100 - bridgeScore).toFixed(0)}% by betweenness`)
    }

    // 9. sharedIds — count of shared identifiers linked to this entity
    let sharedIdCount = 0
    for (const nId of neighbors.get(e.id) ?? []) {
      if (sharedIdentifiers.has(nId)) sharedIdCount += 1
    }
    const sharedIds = clamp100(Math.min(1, sharedIdCount / 5) * 100)
    components.sharedIds = sharedIds
    if (sharedIdCount > 0) {
      contributors.push(`Shares ${sharedIdCount} identifier${sharedIdCount === 1 ? '' : 's'} with other entities`)
    }

    // 10. temporalCorrelation — count of co-occurring event pairings
    const corr = temporalByEntity.get(e.id) ?? 0
    const temporalCorrelation = clamp100(Math.min(1, corr / 10) * 100)
    components.temporalCorrelation = temporalCorrelation
    if (temporalCorrelation >= 50) {
      contributors.push(`${corr} temporal co-occurrences with other entities`)
    }

    // 11. evidenceConfidence — avg confidence of supporting evidence
    // Use the entity's own confidence plus the confidence of findings it
    // appears in.
    const confidences: number[] = []
    if (typeof e.confidence === 'number' && Number.isFinite(e.confidence)) {
      confidences.push(e.confidence)
    }
    for (const f of findingsByEntity.get(e.id) ?? []) {
      if (typeof f.confidence === 'number' && Number.isFinite(f.confidence)) {
        confidences.push(f.confidence)
      }
    }
    const avgConf =
      confidences.length === 0
        ? 0
        : confidences.reduce((a, b) => a + b, 0) / confidences.length
    components.evidenceConfidence = clamp100(avgConf * 100)
    if (avgConf < 0.5 && confidences.length > 0) {
      contributors.push(`Low evidence confidence (${(avgConf * 100).toFixed(0)}%)`)
    }

    // Weighted sum.
    let score = 0
    for (const [key, w] of Object.entries(weights)) {
      score += (components[key] ?? 0) * w
    }
    score = clamp100(score)

    results.push({
      entityId: e.id,
      score,
      components,
      contributors,
    })
  }

  // Sort by score descending.
  results.sort((a, b) => b.score - a.score)
  return results
}

/**
 * Convenience: get the top N actors by risk.
 */
export function topActorsByRisk(
  scores: ActorRiskScore[],
  topN = 10,
): ActorRiskScore[] {
  return scores.slice(0, Math.max(0, topN))
}
