/**
 * analytics/index.ts — Barrel re-export for the RED Justice analytics engines.
 *
 * Submodules:
 *   - graphAnalytics : graph-level metrics (centrality, communities, paths).
 *   - moneyFlow      : transaction-graph intelligence & money-flow tracing.
 *   - patternEngine  : suspicious-pattern rule detectors.
 *   - actorRisk      : actor risk scoring & prioritization.
 *
 * Everything in here is pure TypeScript — no DB calls, no React.
 */

// ── graphAnalytics ──────────────────────────────────────────────────────────
export type {
  GraphNode,
  GraphEdge,
  GraphInput,
  PageRankOptions,
  ComputeAllOptions,
  Community,
  ComputeAllResult,
} from './graphAnalytics'
export {
  degreeCentrality,
  inDegree,
  outDegree,
  betweennessCentrality,
  closenessCentrality,
  pageRank,
  connectedComponents,
  shortestPath,
  kHopNeighbors,
  detectCommunities,
  egoNetwork,
  extractSubgraph,
  bridgeNodes,
  centralActors,
  computeAll,
} from './graphAnalytics'

// ── moneyFlow ───────────────────────────────────────────────────────────────
export type {
  TxnGraphNode,
  TxnGraphEdge,
  TxnGraph,
  FanStats,
  TxnPath,
  VelocityWindow,
  RecurringTransfer,
  UnusualSequence,
  AggregateStats,
} from './moneyFlow'
export {
  buildTxnGraph,
  traceForward,
  traceBackward,
  fanIn,
  fanOut,
  circularFlows,
  velocityAnalysis,
  recurringTransfers,
  unusualSequences,
  aggregateStats,
  multiHopPath,
} from './moneyFlow'

// ── patternEngine ───────────────────────────────────────────────────────────
export type { PatternContext, Finding } from './patternEngine'
export { detectPatterns, findingsOfType } from './patternEngine'

// ── actorRisk ───────────────────────────────────────────────────────────────
export type {
  ActorRiskScore,
  AnalyticsInput,
} from './actorRisk'
export {
  computeActorRisk,
  topActorsByRisk,
  DEFAULT_COMPONENT_WEIGHTS,
} from './actorRisk'
