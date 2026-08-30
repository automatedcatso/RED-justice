/**
 * moneyFlow.ts — Money-flow / transaction intelligence.
 *
 * Pure TypeScript analytics operating on a Prisma-shaped `Transaction[]`.
 * No DB calls, no React. Functions never throw on empty input.
 */

import type { Transaction } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** A node in the transaction graph (unique account). */
export interface TxnGraphNode {
  id: string
  account: string
  inVolume: number
  outVolume: number
  inCount: number
  outCount: number
}

/** An aggregated edge A -> B in the transaction graph. */
export interface TxnGraphEdge {
  id: string
  source: string
  target: string
  totalAmount: number
  count: number
  firstDate?: string
  lastDate?: string
  txnIds: string[]
}

/** Output of {@link buildTxnGraph}. */
export interface TxnGraph {
  nodes: TxnGraphNode[]
  edges: TxnGraphEdge[]
}

/** Fan-in / fan-out summary for an account. */
export interface FanStats {
  account: string
  totalIn: number
  countIn: number
  distinctSenders: number
  totalOut: number
  countOut: number
  distinctReceivers: number
}

/** A transfer path = ordered list of transaction ids. */
export type TxnPath = string[]

/** Velocity window result. */
export interface VelocityWindow {
  start: string
  end: string
  count: number
  volume: number
}

/** Recurring transfer detected. */
export interface RecurringTransfer {
  sender: string
  receiver: string
  occurrences: number
  avgAmount: number
  minAmount: number
  maxAmount: number
  txnIds: string[]
}

/** Heuristic unusual sequence. */
export interface UnusualSequence {
  kind: 'rapid_hop' | 'spike' | 'dormant_then_active'
  severity: 'low' | 'medium' | 'high'
  description: string
  txnIds: string[]
  accounts: string[]
}

/** Aggregated transaction statistics. */
export interface AggregateStats {
  totalVolume: number
  totalCount: number
  meanAmount: number
  medianAmount: number
  maxAmount: number
  minAmount: number
  byBank: Record<string, { count: number; volume: number }>
  byUpi: Record<string, { count: number; volume: number }>
  byMerchant: Record<string, { count: number; volume: number }>
  byIfsc: Record<string, { count: number; volume: number }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a transaction date string into a timestamp (ms since epoch). */
function parseTs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** Sort transactions chronologically (by txnDate if present, else createdAt). */
function sortByDate(txns: Transaction[]): Transaction[] {
  return [...txns].sort((a, b) => {
    const ta = parseTs(a.txnDate) ?? parseTs(a.createdAt?.toISOString?.()) ?? 0
    const tb = parseTs(b.txnDate) ?? parseTs(b.createdAt?.toISOString?.()) ?? 0
    return ta - tb
  })
}

/** Get amount (default 0). */
function amt(t: Transaction): number {
  return typeof t.amount === 'number' && Number.isFinite(t.amount)
    ? t.amount
    : 0
}

/** Get account key (sender / receiver). */
function senderOf(t: Transaction): string | null {
  return t.senderAccount ?? null
}
function receiverOf(t: Transaction): string | null {
  return t.receiverAccount ?? null
}

/** Build a forward adjacency (sender -> [txns]) and reverse adjacency. */
function buildAdjacencies(txns: Transaction[]): {
  forward: Map<string, Transaction[]>
  reverse: Map<string, Transaction[]>
} {
  const forward = new Map<string, Transaction[]>()
  const reverse = new Map<string, Transaction[]>()
  for (const t of txns) {
    const s = senderOf(t)
    const r = receiverOf(t)
    if (s) {
      if (!forward.has(s)) forward.set(s, [])
      forward.get(s)!.push(t)
    }
    if (r) {
      if (!reverse.has(r)) reverse.set(r, [])
      reverse.get(r)!.push(t)
    }
  }
  return { forward, reverse }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTxnGraph — aggregate transactions into account-level graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a transaction graph where nodes are unique accounts and edges are
 * aggregated A -> B transfers (sum of amounts, count, and first/last dates).
 */
export function buildTxnGraph(txns: Transaction[]): TxnGraph {
  const nodeMap = new Map<string, TxnGraphNode>()
  const edgeMap = new Map<string, TxnGraphEdge>()

  const ensureNode = (acc: string) => {
    if (!nodeMap.has(acc)) {
      nodeMap.set(acc, {
        id: acc,
        account: acc,
        inVolume: 0,
        outVolume: 0,
        inCount: 0,
        outCount: 0,
      })
    }
    return nodeMap.get(acc)!
  }

  for (const t of txns) {
    const s = senderOf(t)
    const r = receiverOf(t)
    const a = amt(t)
    if (s) {
      const n = ensureNode(s)
      n.outVolume += a
      n.outCount += 1
    }
    if (r) {
      const n = ensureNode(r)
      n.inVolume += a
      n.inCount += 1
    }
    if (s && r && s !== r) {
      const key = `${s}->${r}`
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          id: key,
          source: s,
          target: r,
          totalAmount: 0,
          count: 0,
          txnIds: [],
        })
      }
      const e = edgeMap.get(key)!
      e.totalAmount += a
      e.count += 1
      e.txnIds.push(t.id)
      const ts = t.txnDate
      if (ts) {
        if (!e.firstDate || ts < e.firstDate) e.firstDate = ts
        if (!e.lastDate || ts > e.lastDate) e.lastDate = ts
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace forward / backward — DFS along transfer direction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trace all forward paths from `account` (DFS following sender -> receiver).
 * Each path is a list of transaction ids. Maximum depth is `maxHops`.
 *
 * Visited-account tracking prevents revisiting within a single path, so cycles
 * are not infinite. Each distinct transaction sequence is returned once.
 */
export function traceForward(
  txns: Transaction[],
  account: string,
  maxHops: number,
): TxnPath[] {
  const { forward } = buildAdjacencies(txns)
  const results: TxnPath[] = []
  if (maxHops <= 0 || !forward.has(account)) return results

  const dfs = (cur: string, path: TxnPath, visited: Set<string>) => {
    if (path.length >= maxHops) {
      if (path.length > 0) results.push([...path])
      return
    }
    const out = forward.get(cur) ?? []
    if (out.length === 0 && path.length > 0) {
      results.push([...path])
      return
    }
    for (const t of out) {
      const r = receiverOf(t)
      if (!r) continue
      if (visited.has(r)) {
        // Cycle — record the path leading up to it.
        if (path.length > 0) results.push([...path, t.id])
        continue
      }
      visited.add(r)
      path.push(t.id)
      dfs(r, path, visited)
      path.pop()
      visited.delete(r)
    }
  }

  dfs(account, [], new Set([account]))
  return results
}

/**
 * Trace all backward paths ending at `account` (DFS following receiver ->
 * sender). Each path is a list of transaction ids in chronological direction
 * (oldest to newest).
 */
export function traceBackward(
  txns: Transaction[],
  account: string,
  maxHops: number,
): TxnPath[] {
  const { reverse } = buildAdjacencies(txns)
  const results: TxnPath[] = []
  if (maxHops <= 0 || !reverse.has(account)) return results

  const dfs = (cur: string, path: TxnPath, visited: Set<string>) => {
    if (path.length >= maxHops) {
      if (path.length > 0) results.push([...path])
      return
    }
    const inb = reverse.get(cur) ?? []
    if (inb.length === 0 && path.length > 0) {
      results.push([...path])
      return
    }
    for (const t of inb) {
      const s = senderOf(t)
      if (!s) continue
      if (visited.has(s)) {
        if (path.length > 0) results.push([t.id, ...path])
        continue
      }
      visited.add(s)
      path.unshift(t.id)
      dfs(s, path, visited)
      path.shift()
      visited.delete(s)
    }
  }

  dfs(account, [], new Set([account]))
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan-in / Fan-out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute fan-in statistics for `account`: total amount, count, and number of
 * distinct senders.
 */
export function fanIn(txns: Transaction[], account: string): FanStats {
  let totalIn = 0
  let countIn = 0
  const senders = new Set<string>()
  for (const t of txns) {
    if (receiverOf(t) === account) {
      totalIn += amt(t)
      countIn += 1
      const s = senderOf(t)
      if (s) senders.add(s)
    }
  }
  return {
    account,
    totalIn,
    countIn,
    distinctSenders: senders.size,
    totalOut: 0,
    countOut: 0,
    distinctReceivers: 0,
  }
}

/**
 * Compute fan-out statistics for `account`: total amount, count, and number of
 * distinct receivers.
 */
export function fanOut(txns: Transaction[], account: string): FanStats {
  let totalOut = 0
  let countOut = 0
  const receivers = new Set<string>()
  for (const t of txns) {
    if (senderOf(t) === account) {
      totalOut += amt(t)
      countOut += 1
      const r = receiverOf(t)
      if (r) receivers.add(r)
    }
  }
  return {
    account,
    totalIn: 0,
    countIn: 0,
    distinctSenders: 0,
    totalOut,
    countOut,
    distinctReceivers: receivers.size,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Circular flows — DFS cycle detection A -> B -> ... -> A
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect circular flows in the transaction graph — chains of transfers that
 * return to the originating account, up to `maxDepth` hops.
 *
 * Returns an array of cycles; each cycle is a list of transaction ids forming
 * the loop. Each cycle is reported once (canonicalised by smallest account id).
 */
export function circularFlows(txns: Transaction[], maxDepth = 5): TxnPath[] {
  const { forward } = buildAdjacencies(txns)
  const results: TxnPath[] = []
  const seen = new Set<string>()

  const sortedAccounts = Array.from(forward.keys()).sort()
  for (const start of sortedAccounts) {
    const dfs = (cur: string, path: TxnPath, visited: Set<string>) => {
      if (path.length >= maxDepth) return
      for (const t of forward.get(cur) ?? []) {
        const r = receiverOf(t)
        if (!r) continue
        if (r === start && path.length >= 1) {
          // Cycle closed.
          const cycle = [...path, t.id]
          const key = cycle.slice().sort().join('|')
          if (!seen.has(key)) {
            seen.add(key)
            results.push(cycle)
          }
          continue
        }
        if (visited.has(r)) continue
        visited.add(r)
        path.push(t.id)
        dfs(r, path, visited)
        path.pop()
        visited.delete(r)
      }
    }
    dfs(start, [], new Set([start]))
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Velocity analysis — sliding window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute transaction velocity for `account` over a sliding window of
 * `windowDays` days. Returns windows anchored at each txn timestamp, with the
 * count and total volume of transactions within [t, t + windowDays).
 */
export function velocityAnalysis(
  txns: Transaction[],
  account: string,
  windowDays = 7,
): VelocityWindow[] {
  const mine = txns.filter(
    (t) => senderOf(t) === account || receiverOf(t) === account,
  )
  const sorted = sortByDate(mine)
  const results: VelocityWindow[] = []
  const windowMs = windowDays * DAY_MS
  for (let i = 0; i < sorted.length; i++) {
    const startT = parseTs(sorted[i].txnDate)
    if (startT === null) continue
    const endT = startT + windowMs
    let count = 0
    let volume = 0
    for (let j = i; j < sorted.length; j++) {
      const tj = parseTs(sorted[j].txnDate)
      if (tj === null) continue
      if (tj >= endT) break
      count += 1
      volume += amt(sorted[j])
    }
    results.push({
      start: sorted[i].txnDate!,
      end: new Date(endT).toISOString(),
      count,
      volume,
    })
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Recurring transfers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect recurring transfers from `account` — repeated A -> B transfers whose
 * amounts are within 20% of each other and occur at least twice.
 */
export function recurringTransfers(
  txns: Transaction[],
  account: string,
): RecurringTransfer[] {
  const byPair = new Map<string, Transaction[]>()
  for (const t of txns) {
    if (senderOf(t) !== account) continue
    const r = receiverOf(t)
    if (!r) continue
    const key = `${account}->${r}`
    if (!byPair.has(key)) byPair.set(key, [])
    byPair.get(key)!.push(t)
  }
  const results: RecurringTransfer[] = []
  for (const [key, list] of byPair.entries()) {
    if (list.length < 2) continue
    const amounts = list.map(amt)
    const min = Math.min(...amounts)
    const max = Math.max(...amounts)
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    // Within 20% of each other (or all zero).
    const spread = avg === 0 ? 0 : (max - min) / avg
    if (spread > 0.2) continue
    const [s, r] = key.split('->')
    results.push({
      sender: s,
      receiver: r,
      occurrences: list.length,
      avgAmount: avg,
      minAmount: min,
      maxAmount: max,
      txnIds: list.map((t) => t.id),
    })
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Unusual sequences — heuristics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect unusual transaction sequences heuristically:
 *   - `rapid_hop`:   transfer chain hops of < 1 hour between legs.
 *   - `spike`:       a single transaction amount >> 7-day average for that account.
 *   - `dormant_then_active`: account inactive for 30+ days then suddenly active
 *                            within a 24-hour window.
 */
export function unusualSequences(txns: Transaction[]): UnusualSequence[] {
  const results: UnusualSequence[] = []
  const sorted = sortByDate(txns)
  if (sorted.length === 0) return results

  // ── rapid_hop: detect consecutive transactions on the same day with < 1h gaps.
  const HOUR_MS = 60 * 60 * 1000
  const byAccount = new Map<string, Transaction[]>()
  for (const t of sorted) {
    const s = senderOf(t)
    if (s) {
      if (!byAccount.has(s)) byAccount.set(s, [])
      byAccount.get(s)!.push(t)
    }
  }
  for (const [acc, list] of byAccount.entries()) {
    for (let i = 1; i < list.length; i++) {
      const a = parseTs(list[i - 1].txnDate)
      const b = parseTs(list[i].txnDate)
      if (a === null || b === null) continue
      if (b - a < HOUR_MS && b - a >= 0) {
        const nextReceiver = receiverOf(list[i])
        if (nextReceiver && nextReceiver !== acc) {
          results.push({
            kind: 'rapid_hop',
            severity: 'medium',
            description: `Account ${acc} executed transfers within ${(b - a) / 60000 | 0} minutes of each other`,
            txnIds: [list[i - 1].id, list[i].id],
            accounts: [acc, nextReceiver],
          })
        }
      }
    }
  }

  // ── spike: amount > 5x the 7-day moving average for that account.
  const SEVEN_DAYS = 7 * DAY_MS
  for (const [acc, list] of byAccount.entries()) {
    for (let i = 0; i < list.length; i++) {
      const ti = parseTs(list[i].txnDate)
      if (ti === null) continue
      let sum = 0
      let cnt = 0
      for (let j = Math.max(0, i - 30); j < i; j++) {
        const tj = parseTs(list[j].txnDate)
        if (tj === null) continue
        if (ti - tj <= SEVEN_DAYS) {
          sum += amt(list[j])
          cnt += 1
        }
      }
      if (cnt < 3) continue
      const avg = sum / cnt
      const a = amt(list[i])
      if (avg > 0 && a > 5 * avg) {
        results.push({
          kind: 'spike',
          severity: 'high',
          description: `Transaction of ${a.toFixed(2)} is ${((a / avg)).toFixed(1)}x the recent average for account ${acc}`,
          txnIds: [list[i].id],
          accounts: [acc],
        })
      }
    }
  }

  // ── dormant_then_active: 30+ days gap, then 2+ txns within 24h.
  const DAY_MS_LOCAL = DAY_MS
  for (const [acc, list] of byAccount.entries()) {
    const ts = list
      .map((t) => ({ t, ms: parseTs(t.txnDate) }))
      .filter((x) => x.ms !== null) as Array<{ t: Transaction; ms: number }>
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i].ms - ts[i - 1].ms
      if (gap >= 30 * DAY_MS_LOCAL) {
        // Look ahead: is the next txn within 24h of ts[i]?
        if (i + 1 < ts.length && ts[i + 1].ms - ts[i].ms < DAY_MS_LOCAL) {
          results.push({
            kind: 'dormant_then_active',
            severity: 'high',
            description: `Account ${acc} was dormant for ${(gap / DAY_MS_LOCAL) | 0} days, then suddenly active with multiple transfers within 24h`,
            txnIds: [ts[i - 1].t.id, ts[i].t.id, ts[i + 1].t.id],
            accounts: [acc],
          })
          i += 1 // Skip ahead to avoid duplicate detection.
        }
      }
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute aggregate transaction statistics: total volume / count, mean,
 * median, min, max, and breakdowns by bank, UPI, merchant, and IFSC.
 */
export function aggregateStats(txns: Transaction[]): AggregateStats {
  const amounts = txns.map(amt)
  const totalVolume = amounts.reduce((a, b) => a + b, 0)
  const totalCount = amounts.length
  const sorted = [...amounts].sort((a, b) => a - b)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[(sorted.length - 1) / 2]

  const byBank: AggregateStats['byBank'] = {}
  const byUpi: AggregateStats['byUpi'] = {}
  const byMerchant: AggregateStats['byMerchant'] = {}
  const byIfsc: AggregateStats['byIfsc'] = {}

  const bump = (
    bucket: Record<string, { count: number; volume: number }>,
    key: string | null | undefined,
    a: number,
  ) => {
    if (!key) return
    if (!bucket[key]) bucket[key] = { count: 0, volume: 0 }
    bucket[key].count += 1
    bucket[key].volume += a
  }

  for (const t of txns) {
    const a = amt(t)
    bump(byBank, t.bank, a)
    bump(byUpi, t.upi, a)
    bump(byMerchant, t.merchant, a)
    bump(byIfsc, t.ifsc, a)
  }

  return {
    totalVolume,
    totalCount,
    meanAmount: totalCount === 0 ? 0 : totalVolume / totalCount,
    medianAmount: median,
    maxAmount: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    minAmount: sorted.length === 0 ? 0 : sorted[0],
    byBank,
    byUpi,
    byMerchant,
    byIfsc,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-hop path — shortest transfer chain src -> dst
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the shortest transfer chain from `srcAccount` to `dstAccount` via BFS
 * on the directed transaction graph. Returns the ordered list of transaction
 * ids forming the chain, or `null` if no path exists within `maxHops`.
 */
export function multiHopPath(
  txns: Transaction[],
  srcAccount: string,
  dstAccount: string,
  maxHops = 5,
): TxnPath | null {
  if (srcAccount === dstAccount) return []
  const { forward } = buildAdjacencies(txns)
  if (!forward.has(srcAccount)) return null

  const prev = new Map<string, { account: string; txnId: string } | null>()
  prev.set(srcAccount, null)
  const queue: Array<{ account: string; depth: number }> = [
    { account: srcAccount, depth: 0 },
  ]
  let head = 0
  while (head < queue.length) {
    const { account, depth } = queue[head++]
    if (depth >= maxHops) continue
    for (const t of forward.get(account) ?? []) {
      const r = receiverOf(t)
      if (!r) continue
      if (prev.has(r)) continue
      prev.set(r, { account, txnId: t.id })
      if (r === dstAccount) {
        // Reconstruct.
        const path: string[] = []
        let cur: { account: string; txnId: string } | null = {
          account,
          txnId: t.id,
        }
        while (cur !== null) {
          path.unshift(cur.txnId)
          cur = prev.get(cur.account) ?? null
        }
        return path
      }
      queue.push({ account: r, depth: depth + 1 })
    }
  }
  return null
}
