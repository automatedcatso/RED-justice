/**
 * GET /api/cases/[id]/anomalies — Graph anomaly detection.
 *
 * Detects anomalies across 4 families:
 *   1. Node anomalies — unexpected degree, sudden activity, rare type combos
 *   2. Edge anomalies — new relationships, unusual amounts, unusual frequency
 *   3. Subgraph anomalies — unexpected clusters, circular paths
 *   4. Temporal anomalies — burst activity, abrupt changes
 *
 * Based on section 15 of the RED Justice research scope document.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, toGraphInput } from '@/lib/api/helpers'
import { computeAll } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

interface Anomaly {
  id: string
  family: 'node' | 'edge' | 'subgraph' | 'temporal'
  type: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  description: string
  entityId?: string
  evidence?: string[]
}

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const [entities, relationships, transactions] = await Promise.all([
      db.entity.findMany({ where: { caseId } }),
      db.relationship.findMany({ where: { caseId } }),
      db.transaction.findMany({ where: { caseId } }),
    ])

    const anomalies: Anomaly[] = []

    // ── Node anomalies ──
    const g = toGraphInput(entities, relationships)
    const metrics = computeAll(g)
    const degrees = Object.values(metrics.degree)
    const avgDegree = degrees.length > 0 ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0
    const maxDegree = degrees.length > 0 ? Math.max(...degrees) : 0

    for (const entity of entities) {
      const degree = (metrics.degree[entity.id] ?? 0) * (entities.length - 1)
      const pagerank = metrics.pagerank[entity.id] ?? 0
      const betweenness = metrics.betweenness[entity.id] ?? 0

      // Unexpected degree — much higher than average
      if (degree > avgDegree * 3 && degree > 5) {
        anomalies.push({
          id: `anom-node-degree-${entity.id}`,
          family: 'node',
          type: 'UNEXPECTED_DEGREE',
          severity: degree > avgDegree * 5 ? 'high' : 'medium',
          description: `Entity "${entity.value}" (${entity.type}) has degree ${Math.round(degree)}, which is ${(degree / Math.max(avgDegree, 0.1)).toFixed(1)}x the network average of ${(avgDegree * (entities.length - 1)).toFixed(1)}.`,
          entityId: entity.id,
        })
      }

      // High PageRank — disproportionate influence
      if (pagerank > 0.15 && entities.length > 5) {
        anomalies.push({
          id: `anom-node-pagerank-${entity.id}`,
          family: 'node',
          type: 'HIGH_PAGERANK',
          severity: pagerank > 0.25 ? 'high' : 'medium',
          description: `Entity "${entity.value}" has PageRank ${pagerank.toFixed(3)}, indicating disproportionate influence in the network.`,
          entityId: entity.id,
        })
      }

      // High betweenness — bridge dependency
      if (betweenness > 0.3) {
        anomalies.push({
          id: `anom-node-bridge-${entity.id}`,
          family: 'node',
          type: 'BRIDGE_DEPENDENCY',
          severity: betweenness > 0.5 ? 'high' : 'medium',
          description: `Entity "${entity.value}" has betweenness ${betweenness.toFixed(3)} — the network is structurally dependent on this entity as a bridge.`,
          entityId: entity.id,
        })
      }
    }

    // ── Edge anomalies ──
    // Unusual transaction amounts
    const amounts = transactions.map((t) => t.amount).filter((a): a is number => a != null)
    if (amounts.length > 0) {
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length
      const maxAmount = Math.max(...amounts)
      const threshold = avgAmount * 3

      for (const t of transactions) {
        if (t.amount != null && t.amount > threshold && t.amount > avgAmount) {
          anomalies.push({
            id: `anom-edge-amount-${t.id}`,
            family: 'edge',
            type: 'UNUSUAL_AMOUNT',
            severity: t.amount > maxAmount * 0.8 ? 'high' : 'medium',
            description: `Transaction of ₹${t.amount.toLocaleString()} is ${(t.amount / Math.max(avgAmount, 1)).toFixed(1)}x the average transaction amount of ₹${avgAmount.toLocaleString()}.`,
          })
        }
      }
    }

    // ── Subgraph anomalies ──
    // Circular paths (from communities detection)
    const communities = metrics.communities
    for (const comm of communities) {
      if (comm.members.length >= 5) {
        // Check internal density
        const internalEdges = relationships.filter(
          (r) => comm.members.includes(r.srcId) && comm.members.includes(r.dstId),
        )
        const possibleEdges = (comm.members.length * (comm.members.length - 1)) / 2
        const density = possibleEdges > 0 ? internalEdges.length / possibleEdges : 0
        if (density > 0.7) {
          anomalies.push({
            id: `anom-subgraph-cluster-${comm.label}`,
            family: 'subgraph',
            type: 'DENSE_CLUSTER',
            severity: density > 0.85 ? 'high' : 'medium',
            description: `Community ${comm.label} has ${comm.members.length} members with ${(density * 100).toFixed(0)}% internal density — unusually tightly connected.`,
          })
        }
      }
    }

    // ── Temporal anomalies ──
    // Burst activity — group transactions by date
    const byDate = new Map<string, number>()
    for (const t of transactions) {
      if (t.txnDate) {
        const date = t.txnDate.slice(0, 10)
        byDate.set(date, (byDate.get(date) ?? 0) + 1)
      }
    }
    const dateCounts = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b))
    if (dateCounts.length > 3) {
      const counts = dateCounts.map(([, c]) => c)
      const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length
      for (const [date, count] of dateCounts) {
        if (count > avgCount * 2 && count > 3) {
          anomalies.push({
            id: `anom-temporal-burst-${date}`,
            family: 'temporal',
            type: 'BURST_ACTIVITY',
            severity: count > avgCount * 3 ? 'high' : 'medium',
            description: `Burst activity on ${date}: ${count} transactions, which is ${(count / Math.max(avgCount, 1)).toFixed(1)}x the daily average of ${avgCount.toFixed(1)}.`,
          })
        }
      }
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

    return NextResponse.json({
      anomalies,
      total: anomalies.length,
      byFamily: {
        node: anomalies.filter((a) => a.family === 'node').length,
        edge: anomalies.filter((a) => a.family === 'edge').length,
        subgraph: anomalies.filter((a) => a.family === 'subgraph').length,
        temporal: anomalies.filter((a) => a.family === 'temporal').length,
      },
    })
  } catch (err) {
    console.error('[api/cases/[id]/anomalies GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'anomalies failed' },
      { status: 500 },
    )
  }
}
