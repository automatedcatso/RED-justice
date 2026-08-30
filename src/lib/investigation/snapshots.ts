/**
 * snapshots.ts — Graph Snapshot Comparison.
 *
 * Captures the case network state at a point in time T (nodes, edges,
 * communities, centrality ranks) and diffs two snapshots T1 vs T2:
 *   - added / removed relationships
 *   - added / removed entities
 *   - emerging / dissolved communities
 *   - changed central actors (rank movement)
 *
 * Edge identity is structural: srcNorm|type|dstNorm (not DB ids), so a
 * re-extraction that rebuilds the graph still diffs correctly.
 */

import type { PrismaClient } from '@prisma/client'
import { buildPatternContext, toGraphInput } from '@/lib/api/helpers'
import { computeAll } from '@/lib/analytics/graphAnalytics'

export interface SnapshotEdge {
  key: string
  src: string
  dst: string
  type: string
  weight: number
}

export interface SnapshotNode {
  key: string
  type: string
  value: string
  degree: number
  pagerank: number
}

export interface SnapshotData {
  nodes: SnapshotNode[]
  edges: SnapshotEdge[]
  communities: Array<{ label: string; members: string[] }>
  central: string[]
}

export async function captureSnapshot(
  db: PrismaClient,
  caseId: string,
): Promise<{ data: SnapshotData; nodesCount: number; edgesCount: number }> {
  const ctx = await buildPatternContext(db, caseId)
  if (!ctx) {
    return { data: { nodes: [], edges: [], communities: [], central: [] }, nodesCount: 0, edgesCount: 0 }
  }
  const g = toGraphInput(ctx.entities, ctx.relationships)
  const metrics = computeAll(g)

  const valueOf = new Map(ctx.entities.map((e) => [e.id, e.value]))
  const typeOf = new Map(ctx.entities.map((e) => [e.id, e.type]))

  const nodes: SnapshotNode[] = g.nodes.map((n) => ({
    key: `${n.type}|${(n.value ?? n.label ?? n.id).toLowerCase()}`,
    type: n.type,
    value: n.value ?? n.label ?? n.id,
    degree: metrics.degree[n.id] ?? 0,
    pagerank: metrics.pagerank[n.id] ?? 0,
  }))

  const edges: SnapshotEdge[] = g.edges.map((e) => ({
    key: `${typeOf.get(e.source) ?? '?'}|${(valueOf.get(e.source) ?? e.source).toLowerCase()}|${e.type}|${typeOf.get(e.target) ?? '?'}|${(valueOf.get(e.target) ?? e.target).toLowerCase()}`,
    src: valueOf.get(e.source) ?? e.source,
    dst: valueOf.get(e.target) ?? e.target,
    type: e.type,
    weight: e.weight ?? 1,
  }))
  const communities = metrics.communities.map((c) => ({
    label: c.label ?? 'community',
    members: c.members.map((m) => valueOf.get(m) ?? m).slice(0, 50),
  }))

  const central = Object.entries(metrics.pagerank)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => `${typeOf.get(id)}|${(valueOf.get(id) ?? id).toLowerCase()}`)

  return {
    data: { nodes, edges, communities, central },
    nodesCount: nodes.length,
    edgesCount: edges.length,
  }
}

export interface SnapshotDiff {
  addedEdges: SnapshotEdge[]
  removedEdges: SnapshotEdge[]
  addedNodes: SnapshotNode[]
  removedNodes: SnapshotNode[]
  emergingCommunities: string[]
  dissolvedCommunities: string[]
  centralRise: Array<{ key: string; from: number; to: number }>
  centralFall: Array<{ key: string; from: number; to: number }>
  summary: {
    edgesAdded: number
    edgesRemoved: number
    nodesAdded: number
    nodesRemoved: number
    communitiesEmerging: number
    communitiesDissolved: number
    centralChanged: number
  }
}

export function compareSnapshots(a: SnapshotData, b: SnapshotData): SnapshotDiff {
  const aEdges = new Map(a.edges.map((e) => [e.key, e]))
  const bEdges = new Map(b.edges.map((e) => [e.key, e]))
  const aNodes = new Map(a.nodes.map((n) => [n.key, n]))
  const bNodes = new Map(b.nodes.map((n) => [n.key, n]))

  const addedEdges = b.edges.filter((e) => !aEdges.has(e.key))
  const removedEdges = a.edges.filter((e) => !bEdges.has(e.key))
  const addedNodes = b.nodes.filter((n) => !aNodes.has(n.key))
  const removedNodes = a.nodes.filter((n) => !bNodes.has(n.key))

  const aComLabels = new Set(a.communities.map((c) => c.members.slice().sort().join('~')))
  const bComLabels = new Set(b.communities.map((c) => c.members.slice().sort().join('~')))
  const emerging = Array.from(bComLabels).filter((c) => !aComLabels.has(c)).length
  const dissolved = Array.from(aComLabels).filter((c) => !bComLabels.has(c)).length

  const aCentralRank = new Map(a.central.map((k, i) => [k, i]))
  const bCentralRank = new Map(b.central.map((k, i) => [k, i]))
  const centralRise: SnapshotDiff['centralRise'] = []
  const centralFall: SnapshotDiff['centralFall'] = []
  for (const [k, bRank] of bCentralRank) {
    const aRank = aCentralRank.get(k)
    if (aRank === undefined) {
      centralRise.push({ key: k, from: a.central.length, to: bRank })
    } else if (bRank < aRank) {
      centralRise.push({ key: k, from: aRank, to: bRank })
    } else if (bRank > aRank) {
      centralFall.push({ key: k, from: aRank, to: bRank })
    }
  }
  for (const [k, aRank] of aCentralRank) {
    if (!bCentralRank.has(k)) centralFall.push({ key: k, from: aRank, to: b.central.length })
  }

  return {
    addedEdges,
    removedEdges,
    addedNodes,
    removedNodes,
    emergingCommunities: b.communities.filter((c) => !aComLabels.has(c.members.slice().sort().join('~'))).map((c) => c.label),
    dissolvedCommunities: a.communities.filter((c) => !bComLabels.has(c.members.slice().sort().join('~'))).map((c) => c.label),
    centralRise,
    centralFall,
    summary: {
      edgesAdded: addedEdges.length,
      edgesRemoved: removedEdges.length,
      nodesAdded: addedNodes.length,
      nodesRemoved: removedNodes.length,
      communitiesEmerging: emerging,
      communitiesDissolved: dissolved,
      centralChanged: centralRise.length + centralFall.length,
    },
  }
}
