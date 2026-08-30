/**
 * roleInference.ts — Structural role inference for graph entities.
 *
 * Infers possible structural roles (hub, bridge, broker, coordinator, etc.)
 * from graph features rather than arbitrary AI guesses. All roles are
 * labelled as **hypotheses**, not factual criminal classifications.
 *
 * Based on section 12 of the RED Justice research scope document.
 */

export interface RoleMetrics {
  degree: number
  betweenness: number
  closeness: number
  pagerank: number
  crossCommunityEdges: number
  shortestPathParticipation: number
  inDegree: number
  outDegree: number
}

export interface RoleHypothesis {
  role: string
  confidence: number // 0-1
  supportingMetrics: string[]
  description: string
}

export type RoleType =
  | 'HUB'
  | 'BRIDGE'
  | 'BROKER'
  | 'COORDINATOR'
  | 'RECEIVER'
  | 'DISTRIBUTOR'
  | 'PERIPHERAL'
  | 'ISOLATED'
  | 'FINANCIAL_INTERMEDIARY'
  | 'COMMUNITY_LEADER'

const ROLE_DESCRIPTIONS: Record<RoleType, string> = {
  HUB: 'High degree centrality — this entity has many direct connections, suggesting a central coordination point.',
  BRIDGE: 'High betweenness — this entity connects otherwise disconnected groups, making it structurally critical.',
  BROKER: 'High cross-community edges — this entity mediates between different communities.',
  COORDINATOR: 'High PageRank + high degree — this entity is both well-connected and influential.',
  RECEIVER: 'High in-degree, low out-degree — this entity receives more than it sends.',
  DISTRIBUTOR: 'High out-degree, low in-degree — this entity sends to many others.',
  PERIPHERAL: 'Low degree, low betweenness — this entity is on the edge of the network.',
  ISOLATED: 'Degree 0 or 1 — this entity has minimal connections.',
  FINANCIAL_INTERMEDIARY: 'High transaction volume + high betweenness — this entity acts as a money pass-through.',
  COMMUNITY_LEADER: 'Highest centrality within its community — this entity dominates its local cluster.',
}

/**
 * Infer structural roles from graph metrics.
 * Returns an array of role hypotheses sorted by confidence (descending).
 */
export function inferRoles(metrics: RoleMetrics): RoleHypothesis[] {
  const hypotheses: RoleHypothesis[] = []

  // HUB: degree in top quartile
  if (metrics.degree >= 10) {
    const conf = Math.min(1, metrics.degree / 20)
    hypotheses.push({
      role: 'HUB',
      confidence: conf,
      supportingMetrics: [
        `Degree: ${metrics.degree}`,
        `PageRank: ${metrics.pagerank.toFixed(3)}`,
      ],
      description: ROLE_DESCRIPTIONS.HUB,
    })
  }

  // BRIDGE: high betweenness
  if (metrics.betweenness >= 0.3) {
    const conf = Math.min(1, metrics.betweenness / 0.8)
    hypotheses.push({
      role: 'BRIDGE',
      confidence: conf,
      supportingMetrics: [
        `Betweenness: ${metrics.betweenness.toFixed(3)}`,
        `Shortest-path participation: ${(metrics.shortestPathParticipation * 100).toFixed(0)}%`,
      ],
      description: ROLE_DESCRIPTIONS.BRIDGE,
    })
  }

  // BROKER: high cross-community edges
  if (metrics.crossCommunityEdges >= 3) {
    const conf = Math.min(1, metrics.crossCommunityEdges / 8)
    hypotheses.push({
      role: 'BROKER',
      confidence: conf,
      supportingMetrics: [
        `Cross-community edges: ${metrics.crossCommunityEdges}`,
        `Betweenness: ${metrics.betweenness.toFixed(3)}`,
      ],
      description: ROLE_DESCRIPTIONS.BROKER,
    })
  }

  // COORDINATOR: high PageRank + high degree
  if (metrics.pagerank >= 0.05 && metrics.degree >= 8) {
    const conf = Math.min(1, (metrics.pagerank * 10 + metrics.degree) / 30)
    hypotheses.push({
      role: 'COORDINATOR',
      confidence: conf,
      supportingMetrics: [
        `PageRank: ${metrics.pagerank.toFixed(3)}`,
        `Degree: ${metrics.degree}`,
        `Closeness: ${metrics.closeness.toFixed(3)}`,
      ],
      description: ROLE_DESCRIPTIONS.COORDINATOR,
    })
  }

  // RECEIVER: high in-degree, low out-degree
  if (metrics.inDegree >= 5 && metrics.outDegree <= 2) {
    const conf = Math.min(1, metrics.inDegree / 10)
    hypotheses.push({
      role: 'RECEIVER',
      confidence: conf,
      supportingMetrics: [
        `In-degree: ${metrics.inDegree}`,
        `Out-degree: ${metrics.outDegree}`,
      ],
      description: ROLE_DESCRIPTIONS.RECEIVER,
    })
  }

  // DISTRIBUTOR: high out-degree, low in-degree
  if (metrics.outDegree >= 5 && metrics.inDegree <= 2) {
    const conf = Math.min(1, metrics.outDegree / 10)
    hypotheses.push({
      role: 'DISTRIBUTOR',
      confidence: conf,
      supportingMetrics: [
        `Out-degree: ${metrics.outDegree}`,
        `In-degree: ${metrics.inDegree}`,
      ],
      description: ROLE_DESCRIPTIONS.DISTRIBUTOR,
    })
  }

  // FINANCIAL_INTERMEDIARY: high betweenness + (placeholder for txn volume)
  if (metrics.betweenness >= 0.2 && metrics.degree >= 5) {
    const conf = Math.min(1, metrics.betweenness)
    hypotheses.push({
      role: 'FINANCIAL_INTERMEDIARY',
      confidence: conf,
      supportingMetrics: [
        `Betweenness: ${metrics.betweenness.toFixed(3)}`,
        `Degree: ${metrics.degree}`,
      ],
      description: ROLE_DESCRIPTIONS.FINANCIAL_INTERMEDIARY,
    })
  }

  // COMMUNITY_LEADER: high closeness within community
  if (metrics.closeness >= 0.5 && metrics.degree >= 5) {
    const conf = Math.min(1, metrics.closeness)
    hypotheses.push({
      role: 'COMMUNITY_LEADER',
      confidence: conf,
      supportingMetrics: [
        `Closeness: ${metrics.closeness.toFixed(3)}`,
        `Degree: ${metrics.degree}`,
      ],
      description: ROLE_DESCRIPTIONS.COMMUNITY_LEADER,
    })
  }

  // PERIPHERAL: low degree + low betweenness
  if (metrics.degree <= 3 && metrics.betweenness < 0.1) {
    hypotheses.push({
      role: 'PERIPHERAL',
      confidence: 0.8,
      supportingMetrics: [
        `Degree: ${metrics.degree}`,
        `Betweenness: ${metrics.betweenness.toFixed(3)}`,
      ],
      description: ROLE_DESCRIPTIONS.PERIPHERAL,
    })
  }

  // ISOLATED: degree 0 or 1
  if (metrics.degree <= 1) {
    hypotheses.push({
      role: 'ISOLATED',
      confidence: 0.9,
      supportingMetrics: [
        `Degree: ${metrics.degree}`,
      ],
      description: ROLE_DESCRIPTIONS.ISOLATED,
    })
  }

  // Sort by confidence descending.
  hypotheses.sort((a, b) => b.confidence - a.confidence)

  // Return top 3 hypotheses.
  return hypotheses.slice(0, 3)
}

/**
 * Get a human-readable summary of the top role hypothesis.
 */
export function getRoleSummary(hypotheses: RoleHypothesis[]): string {
  if (hypotheses.length === 0) return 'No role hypothesis — insufficient data.'
  const top = hypotheses[0]
  return `Possible role: ${top.role} (confidence ${(top.confidence * 100).toFixed(0)}%)`
}
