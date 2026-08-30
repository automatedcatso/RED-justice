/**
 * patternEngine.ts — Suspicious pattern detection for RED Justice.
 *
 * Pure TypeScript rule-based detector that consumes a {@link PatternContext}
 * (entities, relationships, transactions, communications) and emits a list of
 * {@link Finding} records matching the Prisma `Finding` model.
 *
 * Language policy: findings use phrases like "Suspicious pattern detected" or
 * "Indicator observed" — never "Criminal identified".
 */

import type {
  Communication,
  Entity,
  Relationship,
  Transaction,
} from '@prisma/client'

import {
  betweennessCentrality,
  connectedComponents,
  detectCommunities,
  type GraphInput,
} from './graphAnalytics'
import {
  circularFlows,
  fanIn as txnFanIn,
  fanOut as txnFanOut,
  traceForward,
  unusualSequences,
  velocityAnalysis,
} from './moneyFlow'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Context bundle consumed by the pattern engine. */
export interface PatternContext {
  caseId: string
  entities: Entity[]
  relationships: Relationship[]
  transactions: Transaction[]
  communications?: Communication[]
}

/** Finding shape (matches Prisma `Finding` model). */
export interface Finding {
  id?: string
  caseId: string
  type: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  description: string
  trigger?: string
  entitiesJson?: string
  relationshipsJson?: string
  transactionsJson?: string
  supportingEvidence?: string
  reviewStatus?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Identifier-type categories used by SHARED_* detectors. */
const PHONE_TYPES = new Set(['phone', 'mobile', 'telephone'])
const DEVICE_TYPES = new Set(['device', 'imei', 'device_id'])
const IP_TYPES = new Set(['ip', 'ipv4', 'ipv6', 'ip_address'])
const ACCOUNT_TYPES = new Set(['account', 'bank_account', 'wallet'])
const PERSON_TYPES = new Set(['person', 'individual', 'suspect', 'individuals'])

/** Lowercase type-check helper. */
function isType(types: Set<string>, t: string | null | undefined): boolean {
  if (!t) return false
  return types.has(t.toLowerCase())
}

/** Parse a timestamp string. Returns null if unparseable. */
function parseTs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Get amount from a transaction (0 if absent). */
function amt(t: Transaction): number {
  return typeof t.amount === 'number' && Number.isFinite(t.amount) ? t.amount : 0
}

/** Sender account accessor. */
function senderOf(t: Transaction): string | null {
  return t.senderAccount ?? null
}
function receiverOf(t: Transaction): string | null {
  return t.receiverAccount ?? null
}

/**
 * Build undirected neighbor map for entities using relationships.
 * Returns Map<entityId, Set<entityId>>.
 */
function neighborMap(ctx: PatternContext): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const e of ctx.entities) map.set(e.id, new Set())
  for (const r of ctx.relationships) {
    if (r.srcId === r.dstId) continue
    if (!map.has(r.srcId)) map.set(r.srcId, new Set())
    if (!map.has(r.dstId)) map.set(r.dstId, new Set())
    map.get(r.srcId)!.add(r.dstId)
    map.get(r.dstId)!.add(r.srcId)
  }
  return map
}

/** Build a GraphInput from the context (entities + relationships). */
function buildGraph(ctx: PatternContext): GraphInput {
  return {
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
}

/**
 * Find the entity id of an `account` whose value (or norm) matches the given
 * account string. Returns the first match or null.
 */
function findAccountEntity(ctx: PatternContext, account: string | null): string | null {
  if (!account) return null
  for (const e of ctx.entities) {
    if (isType(ACCOUNT_TYPES, e.type)) {
      if (e.value === account || e.norm === account) return e.id
    }
  }
  return null
}

/**
 * Find entity ids of all accounts whose value (or norm) matches the given
 * account string. Returns [] if none.
 */
function findAccountEntities(ctx: PatternContext, account: string | null): string[] {
  if (!account) return []
  const out: string[] = []
  for (const e of ctx.entities) {
    if (isType(ACCOUNT_TYPES, e.type)) {
      if (e.value === account || e.norm === account) out.push(e.id)
    }
  }
  return out
}

/** JSON-stringify helper for safe output. */
function jsonSafe(arr: string[]): string | undefined {
  return arr.length === 0 ? undefined : JSON.stringify(arr)
}

// ─────────────────────────────────────────────────────────────────────────────
// Detectors
// ─────────────────────────────────────────────────────────────────────────────

/** HIGH_FAN_IN — account receiving from many distinct senders (>= 5). */
function detectHighFanIn(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const receivers = new Map<string, Set<string>>()
  const txByReceiver = new Map<string, Set<string>>()
  for (const t of ctx.transactions) {
    const r = receiverOf(t)
    const s = senderOf(t)
    if (!r || !s) continue
    if (!receivers.has(r)) receivers.set(r, new Set())
    receivers.get(r)!.add(s)
    if (!txByReceiver.has(r)) txByReceiver.set(r, new Set())
    txByReceiver.get(r)!.add(t.id)
  }
  for (const [account, senders] of receivers.entries()) {
    if (senders.size < 5) continue
    const entityIds = findAccountEntities(ctx, account)
    out.push({
      caseId: ctx.caseId,
      type: 'HIGH_FAN_IN',
      severity: senders.size >= 10 ? 'high' : 'medium',
      confidence: Math.min(0.95, 0.5 + senders.size * 0.05),
      description: `Suspicious pattern detected: account ${account} received funds from ${senders.size} distinct senders, indicating possible layering or aggregation.`,
      trigger: `distinct_senders=${senders.size}`,
      entitiesJson: jsonSafe(entityIds),
      transactionsJson: jsonSafe(Array.from(txByReceiver.get(account) ?? [])),
      reviewStatus: 'new',
    })
  }
  return out
}

/** HIGH_FAN_OUT — account sending to many distinct receivers (>= 5). */
function detectHighFanOut(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const senders = new Map<string, Set<string>>()
  const txBySender = new Map<string, Set<string>>()
  for (const t of ctx.transactions) {
    const s = senderOf(t)
    const r = receiverOf(t)
    if (!r || !s) continue
    if (!senders.has(s)) senders.set(s, new Set())
    senders.get(s)!.add(r)
    if (!txBySender.has(s)) txBySender.set(s, new Set())
    txBySender.get(s)!.add(t.id)
  }
  for (const [account, receivers] of senders.entries()) {
    if (receivers.size < 5) continue
    const entityIds = findAccountEntities(ctx, account)
    out.push({
      caseId: ctx.caseId,
      type: 'HIGH_FAN_OUT',
      severity: receivers.size >= 10 ? 'high' : 'medium',
      confidence: Math.min(0.95, 0.5 + receivers.size * 0.05),
      description: `Suspicious pattern detected: account ${account} sent funds to ${receivers.size} distinct receivers, indicating possible fan-out distribution.`,
      trigger: `distinct_receivers=${receivers.size}`,
      entitiesJson: jsonSafe(entityIds),
      transactionsJson: jsonSafe(Array.from(txBySender.get(account) ?? [])),
      reviewStatus: 'new',
    })
  }
  return out
}

/** CIRCULAR_TXNS — circular flow detected. */
function detectCircularTxns(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const cycles = circularFlows(ctx.transactions, 5)
  for (const cycle of cycles) {
    const accounts = new Set<string>()
    const txIds = new Set<string>(cycle)
    for (const txnId of cycle) {
      const t = ctx.transactions.find((x) => x.id === txnId)
      if (!t) continue
      const s = senderOf(t)
      const r = receiverOf(t)
      if (s) accounts.add(s)
      if (r) accounts.add(r)
    }
    const entityIds: string[] = []
    for (const a of accounts) entityIds.push(...findAccountEntities(ctx, a))
    out.push({
      caseId: ctx.caseId,
      type: 'CIRCULAR_TXNS',
      severity: 'high',
      confidence: 0.85,
      description: `Suspicious pattern detected: circular money flow involving ${accounts.size} accounts and ${cycle.length} transactions.`,
      trigger: `cycle_length=${cycle.length}`,
      entitiesJson: jsonSafe(entityIds),
      transactionsJson: jsonSafe(Array.from(txIds)),
      reviewStatus: 'new',
    })
  }
  return out
}

/** RAPID_HOPPING — short time between hops in a multi-hop chain (< 1h). */
function detectRapidHopping(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const seqs = unusualSequences(ctx.transactions).filter(
    (s) => s.kind === 'rapid_hop',
  )
  for (const s of seqs) {
    const entityIds: string[] = []
    for (const a of s.accounts) entityIds.push(...findAccountEntities(ctx, a))
    out.push({
      caseId: ctx.caseId,
      type: 'RAPID_HOPPING',
      severity: s.severity,
      confidence: 0.7,
      description: `Suspicious pattern detected: ${s.description}.`,
      trigger: 'rapid_hop<1h',
      entitiesJson: jsonSafe(entityIds),
      transactionsJson: jsonSafe(s.txnIds),
      reviewStatus: 'new',
    })
  }
  return out
}

/** SHARED_PHONE / SHARED_DEVICE / SHARED_IP — shared identifier linking multiple actors. */
function detectSharedIdentifiers(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const neighbors = neighborMap(ctx)
  const entityById = new Map(ctx.entities.map((e) => [e.id, e]))

  const check = (
    typeSet: Set<string>,
    findingType: string,
    label: string,
  ) => {
    for (const e of ctx.entities) {
      if (!isType(typeSet, e.type)) continue
      const nb = neighbors.get(e.id) ?? new Set<string>()
      // Count distinct persons or accounts linked.
      const linkedActors: string[] = []
      for (const nId of nb) {
        const n = entityById.get(nId)
        if (!n) continue
        if (isType(PERSON_TYPES, n.type) || isType(ACCOUNT_TYPES, n.type)) {
          linkedActors.push(n.id)
        }
      }
      if (linkedActors.length < 2) continue
      const relIds = ctx.relationships
        .filter((r) => r.srcId === e.id || r.dstId === e.id)
        .map((r) => r.id)
      out.push({
        caseId: ctx.caseId,
        type: findingType,
        severity: linkedActors.length >= 4 ? 'high' : 'medium',
        confidence: Math.min(0.95, 0.55 + linkedActors.length * 0.08),
        description: `Suspicious pattern detected: ${label} ${e.value} is linked to ${linkedActors.length} distinct person/account entities, indicating possible aliasing.`,
        trigger: `linked_actors=${linkedActors.length}`,
        entitiesJson: jsonSafe([e.id, ...linkedActors]),
        relationshipsJson: jsonSafe(relIds),
        reviewStatus: 'new',
      })
    }
  }

  check(PHONE_TYPES, 'SHARED_PHONE', 'phone')
  check(DEVICE_TYPES, 'SHARED_DEVICE', 'device')
  check(IP_TYPES, 'SHARED_IP', 'IP address')
  return out
}

/** TXN_SPIKE — transaction count in a day >> 7-day average. */
function detectTxnSpike(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  // Bucket by account & day.
  const byAccountDay = new Map<string, Map<string, number>>()
  const byAccount = new Map<string, Transaction[]>()
  for (const t of ctx.transactions) {
    const s = senderOf(t)
    if (!s) continue
    if (!byAccount.has(s)) byAccount.set(s, [])
    byAccount.get(s)!.push(t)
    const d = (t.txnDate ?? '').slice(0, 10)
    if (!d) continue
    if (!byAccountDay.has(s)) byAccountDay.set(s, new Map())
    const m = byAccountDay.get(s)!
    m.set(d, (m.get(d) ?? 0) + 1)
  }
  for (const [account, days] of byAccountDay.entries()) {
    const counts = Array.from(days.values()).sort((a, b) => a - b)
    const avg =
      counts.length === 0
        ? 0
        : counts.reduce((a, b) => a + b, 0) / counts.length
    for (const [day, count] of days.entries()) {
      if (avg <= 0) continue
      if (count >= 5 && count >= avg * 3) {
        const entityIds = findAccountEntities(ctx, account)
        const txIds = (byAccount.get(account) ?? [])
          .filter((t) => (t.txnDate ?? '').slice(0, 10) === day)
          .map((t) => t.id)
        out.push({
          caseId: ctx.caseId,
          type: 'TXN_SPIKE',
          severity: count >= avg * 5 ? 'high' : 'medium',
          confidence: 0.75,
          description: `Suspicious pattern detected: account ${account} had ${count} transactions on ${day}, ${(count / avg).toFixed(1)}x its daily average of ${avg.toFixed(1)}.`,
          trigger: `day=${day};count=${count};avg=${avg.toFixed(2)}`,
          entitiesJson: jsonSafe(entityIds),
          transactionsJson: jsonSafe(txIds),
          reviewStatus: 'new',
        })
      }
    }
  }
  return out
}

/** VELOCITY_ANOMALY — txn velocity exceeds threshold in a window. */
function detectVelocityAnomaly(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  // Collect all unique sender accounts.
  const accounts = new Set<string>()
  for (const t of ctx.transactions) {
    const s = senderOf(t)
    if (s) accounts.add(s)
  }
  for (const account of accounts) {
    const windows = velocityAnalysis(ctx.transactions, account, 7)
    for (const w of windows) {
      if (w.count >= 15) {
        const entityIds = findAccountEntities(ctx, account)
        out.push({
          caseId: ctx.caseId,
          type: 'VELOCITY_ANOMALY',
          severity: w.count >= 30 ? 'high' : 'medium',
          confidence: 0.7,
          description: `Suspicious pattern detected: account ${account} had ${w.count} transactions in a 7-day window starting ${w.start}, suggesting anomalous velocity.`,
          trigger: `window=7d;count=${w.count}`,
          entitiesJson: jsonSafe(entityIds),
          reviewStatus: 'new',
        })
        break // one finding per account is enough
      }
    }
  }
  return out
}

/** DORMANT_ACTIVATION — account inactive 30+ days then sudden activity. */
function detectDormantActivation(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  const seqs = unusualSequences(ctx.transactions).filter(
    (s) => s.kind === 'dormant_then_active',
  )
  for (const s of seqs) {
    const entityIds: string[] = []
    for (const a of s.accounts) entityIds.push(...findAccountEntities(ctx, a))
    out.push({
      caseId: ctx.caseId,
      type: 'DORMANT_ACTIVATION',
      severity: s.severity,
      confidence: 0.75,
      description: `Suspicious pattern detected: ${s.description}.`,
      trigger: 'dormant>=30d;burst<24h',
      entitiesJson: jsonSafe(entityIds),
      transactionsJson: jsonSafe(s.txnIds),
      reviewStatus: 'new',
    })
  }
  return out
}

/** BRIDGE_ENTITY — high betweenness entity connecting otherwise-disconnected clusters. */
function detectBridgeEntity(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  if (ctx.entities.length < 4) return out
  const graph = buildGraph(ctx)
  const betweenness = betweennessCentrality(graph)
  const baseComponents = connectedComponents(graph)
  // Rank nodes by betweenness.
  const ranked = Object.entries(betweenness)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, Math.min(5, Math.ceil(ranked.length * 0.1)))
  // Verify that removing each top node actually increases components.
  for (const [entityId, score] of top) {
    const subgraph: GraphInput = {
      nodes: graph.nodes.filter((n) => n.id !== entityId),
      edges: graph.edges.filter(
        (e) => e.source !== entityId && e.target !== entityId,
      ),
    }
    const newComponents = connectedComponents(subgraph)
    if (newComponents.length > baseComponents.length) {
      const entity = ctx.entities.find((e) => e.id === entityId)
      const relIds = ctx.relationships
        .filter((r) => r.srcId === entityId || r.dstId === entityId)
        .map((r) => r.id)
      out.push({
        caseId: ctx.caseId,
        type: 'BRIDGE_ENTITY',
        severity: score > 5 ? 'high' : 'medium',
        confidence: 0.8,
        description: `Suspicious pattern detected: entity ${entity?.value ?? entityId} acts as a bridge between ${newComponents.length - baseComponents.length} disconnected cluster(s); removal fragments the network.`,
        trigger: `betweenness=${score.toFixed(2)};fragment_delta=${newComponents.length - baseComponents.length}`,
        entitiesJson: jsonSafe([entityId]),
        relationshipsJson: jsonSafe(relIds),
        reviewStatus: 'new',
      })
    }
  }
  return out
}

/** TIGHT_CLUSTER — small community with very high internal density. */
function detectTightCluster(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  if (ctx.entities.length < 3) return out
  const graph = buildGraph(ctx)
  const communities = detectCommunities(graph)
  for (const c of communities) {
    if (c.members.length < 3 || c.members.length > 10) continue
    const memberSet = new Set(c.members)
    const internalEdges = ctx.relationships.filter(
      (r) => memberSet.has(r.srcId) && memberSet.has(r.dstId),
    )
    const maxEdges = (c.members.length * (c.members.length - 1)) / 2
    const density = maxEdges === 0 ? 0 : internalEdges.length / maxEdges
    if (density >= 0.7) {
      const relIds = internalEdges.map((r) => r.id)
      out.push({
        caseId: ctx.caseId,
        type: 'TIGHT_CLUSTER',
        severity: 'medium',
        confidence: 0.7,
        description: `Suspicious pattern detected: tight cluster of ${c.members.length} entities with internal density ${(density * 100).toFixed(0)}% — possible coordinated cell.`,
        trigger: `size=${c.members.length};density=${density.toFixed(2)}`,
        entitiesJson: jsonSafe(c.members),
        relationshipsJson: jsonSafe(relIds),
        reviewStatus: 'new',
      })
    }
  }
  return out
}

/** TEMPORAL_SYNC — multiple entities active within very short windows repeatedly. */
function detectTemporalSync(ctx: PatternContext): Finding[] {
  const out: Finding[] = []
  // Group txns by account -> [timestamps]
  const byAccount = new Map<string, number[]>()
  for (const t of ctx.transactions) {
    const s = senderOf(t)
    if (!s) continue
    const ts = parseTs(t.txnDate)
    if (ts === null) continue
    if (!byAccount.has(s)) byAccount.set(s, [])
    byAccount.get(s)!.push(ts)
  }
  // For each pair of accounts, count days where both had activity within 1h.
  const accounts = Array.from(byAccount.keys()).sort()
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const a = accounts[i]
      const b = accounts[j]
      const timesA = byAccount.get(a)!.sort((x, y) => x - y)
      const timesB = byAccount.get(b)!.sort((x, y) => x - y)
      let iA = 0
      let iB = 0
      let coOccur = 0
      let lastDay = -1
      while (iA < timesA.length && iB < timesB.length) {
        const diff = Math.abs(timesA[iA] - timesB[iB])
        if (diff <= HOUR_MS) {
          const day = Math.floor(timesA[iA] / DAY_MS)
          if (day !== lastDay) {
            coOccur += 1
            lastDay = day
          }
          iA += 1
          iB += 1
        } else if (timesA[iA] < timesB[iB]) {
          iA += 1
        } else {
          iB += 1
        }
      }
      if (coOccur >= 3) {
        const eA = findAccountEntities(ctx, a)
        const eB = findAccountEntities(ctx, b)
        const entityIds = [...eA, ...eB]
        const txIds = ctx.transactions
          .filter(
            (t) => senderOf(t) === a || senderOf(t) === b,
          )
          .map((t) => t.id)
        out.push({
          caseId: ctx.caseId,
          type: 'TEMPORAL_SYNC',
          severity: coOccur >= 5 ? 'high' : 'medium',
          confidence: 0.65,
          description: `Suspicious pattern detected: accounts ${a} and ${b} had activity within 1 hour of each other on ${coOccur} distinct days, suggesting coordinated behaviour.`,
          trigger: `co_occurrences=${coOccur};window=1h`,
          entitiesJson: jsonSafe(entityIds),
          transactionsJson: jsonSafe(txIds),
          reviewStatus: 'new',
        })
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect suspicious patterns in a case. Runs all 13 rule-based detectors and
 * returns the combined list of findings.
 *
 * Detectors:
 *   HIGH_FAN_IN, HIGH_FAN_OUT, CIRCULAR_TXNS, RAPID_HOPPING,
 *   SHARED_PHONE, SHARED_DEVICE, SHARED_IP, TXN_SPIKE,
 *   VELOCITY_ANOMALY, DORMANT_ACTIVATION, BRIDGE_ENTITY,
 *   TIGHT_CLUSTER, TEMPORAL_SYNC
 *
 * @param ctx Pattern context — entities, relationships, transactions, communications.
 */
export function detectPatterns(ctx: PatternContext): Finding[] {
  if (!ctx || !ctx.caseId) return []
  const findings: Finding[] = []
  try {
    findings.push(...detectHighFanIn(ctx))
    findings.push(...detectHighFanOut(ctx))
    findings.push(...detectCircularTxns(ctx))
    findings.push(...detectRapidHopping(ctx))
    findings.push(...detectSharedIdentifiers(ctx))
    findings.push(...detectTxnSpike(ctx))
    findings.push(...detectVelocityAnomaly(ctx))
    findings.push(...detectDormantActivation(ctx))
    findings.push(...detectBridgeEntity(ctx))
    findings.push(...detectTightCluster(ctx))
    findings.push(...detectTemporalSync(ctx))
  } catch (err) {
    console.error('[patternEngine] detectPatterns failed:', err)
  }
  return findings
}

/**
 * Convenience: get only the findings of a specific type (e.g. for triage views).
 */
export function findingsOfType(findings: Finding[], type: string): Finding[] {
  return findings.filter((f) => f.type === type)
}
