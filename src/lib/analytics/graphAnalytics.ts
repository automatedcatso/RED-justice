/**
 * graphAnalytics.ts — Pure TypeScript graph analytics for the SQLite-backed
 * knowledge graph used by RED Justice.
 *
 * All functions are pure: they accept an in-memory {@link GraphInput} and return
 * plain data. No DB calls, no React, no globals. Functions never throw on empty
 * input — they return empty arrays / empty maps instead.
 *
 * Algorithms:
 *   - Betweenness  : Brandes (Dijkstra-weighted accumulation, undirected).
 *   - PageRank     : iterative with dangling-node redistribution.
 *   - Communities  : Label Propagation (LPA), deterministic tie-break by id.
 *   - Components   : union-find (undirected).
 *   - Paths        : BFS (unweighted, undirected).
 *
 * Complexity: O(V*E) or better for every exported function.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** A node in the analytical graph. */
export interface GraphNode {
  id: string
  type: string
  label: string
  value?: string
}

/** A directed edge in the analytical graph. */
export interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
  weight: number
  amount?: number
  timestamp?: string
}

/** Input graph: a collection of nodes and edges. */
export interface GraphInput {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Options for PageRank. */
export interface PageRankOptions {
  /** Damping factor (default 0.85). */
  damping?: number
  /** Maximum iterations (default 100). */
  iterations?: number
  /** Convergence tolerance on L1 norm (default 1e-6). */
  tolerance?: number
}

/** Options for computeAll. */
export interface ComputeAllOptions extends PageRankOptions {
  /** Number of top-by-betweenness nodes to treat as bridges. Default 5. */
  topBridges?: number
}

/** A community of nodes returned by {@link detectCommunities}. */
export interface Community {
  label: string
  members: string[]
}

/** Full analytics snapshot. */
export interface ComputeAllResult {
  degree: Record<string, number>
  inDegree: Record<string, number>
  outDegree: Record<string, number>
  betweenness: Record<string, number>
  closeness: Record<string, number>
  pagerank: Record<string, number>
  communities: Community[]
  components: string[][]
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Adjacency list mapping nodeId -> list of { neighborId, weight }. */
type Adjacency = Map<string, Array<{ to: string; weight: number }>>

const EPS = 1e-12

/**
 * Build an undirected adjacency list from edges. Each edge contributes both
 * directions; weights are taken from {@link GraphEdge.weight} (defaults to 1).
 * Self-loops are dropped.
 */
function buildAdjacency(g: GraphInput): Adjacency {
  const adj: Adjacency = new Map()
  for (const n of g.nodes) adj.set(n.id, [])
  for (const e of g.edges) {
    if (e.source === e.target) continue
    const w = Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1
    if (!adj.has(e.source)) adj.set(e.source, [])
    if (!adj.has(e.target)) adj.set(e.target, [])
    adj.get(e.source)!.push({ to: e.target, weight: w })
    adj.get(e.target)!.push({ to: e.source, weight: w })
  }
  return adj
}

/** Build a directed adjacency list (source -> target only). */
function buildDirectedAdjacency(g: GraphInput): Adjacency {
  const adj: Adjacency = new Map()
  for (const n of g.nodes) adj.set(n.id, [])
  for (const e of g.edges) {
    if (e.source === e.target) continue
    const w = Number.isFinite(e.weight) && e.weight > 0 ? e.weight : 1
    if (!adj.has(e.source)) adj.set(e.source, [])
    if (!adj.has(e.target)) adj.set(e.target, [])
    adj.get(e.source)!.push({ to: e.target, weight: w })
  }
  return adj
}

/** Validate / clamp a numeric value into the 0..1 range. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

// ─────────────────────────────────────────────────────────────────────────────
// Degree centrality
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the in-degree of every node (number of incoming directed edges).
 * Returns a map nodeId -> count.
 */
export function inDegree(g: GraphInput): Record<string, number> {
  const result: Record<string, number> = {}
  for (const n of g.nodes) result[n.id] = 0
  for (const e of g.edges) {
    if (e.source === e.target) continue
    result[e.target] = (result[e.target] ?? 0) + 1
  }
  return result
}

/**
 * Compute the out-degree of every node (number of outgoing directed edges).
 * Returns a map nodeId -> count.
 */
export function outDegree(g: GraphInput): Record<string, number> {
  const result: Record<string, number> = {}
  for (const n of g.nodes) result[n.id] = 0
  for (const e of g.edges) {
    if (e.source === e.target) continue
    result[e.source] = (result[e.source] ?? 0) + 1
  }
  return result
}

/**
 * Compute total (in+out) degree centrality per node, normalized to 0..1.
 * Normalization factor is 2*(n-1) — the maximum possible total degree in a
 * directed graph on n nodes. Empty/single-node graphs yield 0 for every node.
 */
export function degreeCentrality(g: GraphInput): Record<string, number> {
  const ind = inDegree(g)
  const out = outDegree(g)
  const n = g.nodes.length
  const denom = n > 1 ? 2 * (n - 1) : 1
  const result: Record<string, number> = {}
  for (const node of g.nodes) {
    const total = (ind[node.id] ?? 0) + (out[node.id] ?? 0)
    result[node.id] = clamp01(total / denom)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Betweenness centrality — Brandes (weighted, undirected)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute betweenness centrality using Brandes' algorithm adapted for weighted
 * undirected graphs (Dijkstra-based accumulation). Edge distance is taken as
 * `1 / weight` so higher weight ⇒ stronger tie ⇒ lower traversal cost.
 *
 * Returns a map nodeId -> betweenness score (un-normalized sum over all pairs,
 * divided by 2 because every undirected path is counted once per direction).
 *
 * @param g Input graph.
 */
export function betweennessCentrality(g: GraphInput): Record<string, number> {
  const adj = buildAdjacency(g)
  const nodes = g.nodes.map((n) => n.id)
  const CB: Record<string, number> = {}
  for (const v of nodes) CB[v] = 0

  for (const s of nodes) {
    // Stack of nodes in order of non-increasing distance from s.
    const S: string[] = []
    // P[w] = list of predecessors on shortest paths from s to w.
    const P = new Map<string, string[]>()
    // sigma[t] = number of shortest paths s -> t.
    const sigma: Record<string, number> = {}
    // dist[t] = shortest distance from s to t (Infinity if unreachable).
    const dist: Record<string, number> = {}
    for (const v of nodes) {
      P.set(v, [])
      sigma[v] = 0
      dist[v] = Infinity
    }
    sigma[s] = 1
    dist[s] = 0

    // Min-heap of (dist, node). Implemented as a binary heap.
    const heap = new MinHeap<string>()
    heap.push(0, s)

    while (heap.size > 0) {
      const { dist: dv, value: v } = heap.pop()
      // Stale entry — skip (we never decrease-key, we re-push).
      if (dv > dist[v]) continue
      S.push(v)
      for (const { to: w, weight } of adj.get(v) ?? []) {
        const edgeDist = 1 / weight
        const newDist = dist[v] + edgeDist
        if (newDist < dist[w] - EPS) {
          // Found a shorter path to w.
          dist[w] = newDist
          sigma[w] = sigma[v]
          P.set(w, [v])
          heap.push(newDist, w)
        } else if (Math.abs(newDist - dist[w]) <= EPS) {
          // Equal-length path — accumulate.
          sigma[w] += sigma[v]
          P.get(w)!.push(v)
        }
      }
    }

    // Dependency accumulation.
    const delta: Record<string, number> = {}
    for (const v of nodes) delta[v] = 0
    while (S.length > 0) {
      const w = S.pop()!
      for (const v of P.get(w) ?? []) {
        const denom = sigma[w] || 1
        delta[v] += (sigma[v] / denom) * (1 + delta[w])
      }
      if (w !== s) {
        CB[w] = (CB[w] ?? 0) + delta[w]
      }
    }
  }

  // Undirected graph: every pair counted twice — halve.
  for (const v of nodes) CB[v] = CB[v] / 2
  return CB
}

// ─────────────────────────────────────────────────────────────────────────────
// Closeness centrality — harmonic mean (BFS, unweighted, undirected)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute harmonic closeness centrality: `sum(1 / dist(s, t))` for every
 * reachable t != s, normalized by (n-1). Unreachable nodes contribute 0.
 *
 * Uses BFS so distances are hop counts (unweighted).
 */
export function closenessCentrality(g: GraphInput): Record<string, number> {
  const adj = buildAdjacency(g)
  const nodes = g.nodes.map((n) => n.id)
  const n = nodes.length
  const denom = n > 1 ? n - 1 : 1
  const result: Record<string, number> = {}
  for (const s of nodes) {
    const dist = new Map<string, number>()
    dist.set(s, 0)
    const queue: string[] = [s]
    let head = 0
    let sum = 0
    while (head < queue.length) {
      const v = queue[head++]
      const dv = dist.get(v)!
      for (const { to: w } of adj.get(v) ?? []) {
        if (!dist.has(w)) {
          dist.set(w, dv + 1)
          sum += 1 / (dv + 1)
          queue.push(w)
        }
      }
    }
    result[s] = clamp01(sum / denom)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// PageRank — iterative with dangling-node redistribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute PageRank iteratively. Handles dangling nodes (those with no out
 * edges) by redistributing their rank uniformly across all nodes.
 *
 * Defaults: damping=0.85, iterations=100, tolerance=1e-6.
 */
export function pageRank(
  g: GraphInput,
  opts: PageRankOptions = {},
): Record<string, number> {
  const damping = opts.damping ?? 0.85
  const maxIter = opts.iterations ?? 100
  const tol = opts.tolerance ?? 1e-6

  const adj = buildDirectedAdjacency(g)
  const nodes = g.nodes.map((n) => n.id)
  const n = nodes.length
  const result: Record<string, number> = {}
  if (n === 0) return result

  let pr: Record<string, number> = {}
  for (const v of nodes) pr[v] = 1 / n

  const outDeg: Record<string, number> = {}
  for (const v of nodes) outDeg[v] = (adj.get(v)?.length ?? 0)

  for (let iter = 0; iter < maxIter; iter++) {
    const next: Record<string, number> = {}
    for (const v of nodes) next[v] = 0

    // Sum dangling rank.
    let danglingSum = 0
    for (const v of nodes) {
      if (outDeg[v] === 0) danglingSum += pr[v]
    }

    const base = (1 - damping) / n + (damping * danglingSum) / n

    // Distribute from each non-dangling node.
    for (const v of nodes) {
      const outs = adj.get(v) ?? []
      if (outs.length === 0) continue
      const share = (damping * pr[v]) / outs.length
      for (const { to: w } of outs) {
        next[w] += share
      }
    }
    for (const v of nodes) next[v] += base

    // Convergence check (L1 norm).
    let l1 = 0
    for (const v of nodes) l1 += Math.abs(next[v] - pr[v])
    pr = next
    if (l1 < tol) break
  }

  for (const v of nodes) result[v] = pr[v]
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Connected components (union-find, undirected)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find connected components treating the graph as undirected.
 * Returns an array of node-id arrays.
 */
export function connectedComponents(g: GraphInput): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let cur = x
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur) ?? cur
      parent.set(cur, parent.get(p) ?? p)
      cur = p
    }
    return cur
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const n of g.nodes) parent.set(n.id, n.id)
  for (const e of g.edges) {
    if (e.source === e.target) continue
    if (!parent.has(e.source)) parent.set(e.source, e.source)
    if (!parent.has(e.target)) parent.set(e.target, e.target)
    union(e.source, e.target)
  }
  const groups = new Map<string, string[]>()
  for (const n of g.nodes) {
    const r = find(n.id)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(n.id)
  }
  return Array.from(groups.values()).sort((a, b) => b.length - a.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shortest path (BFS, unweighted, undirected)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the shortest path between two nodes via BFS (treats the graph as
 * undirected and unweighted). Returns an array of node ids from src to dst,
 * or `null` if no path exists.
 */
export function shortestPath(
  g: GraphInput,
  srcId: string,
  dstId: string,
): string[] | null {
  if (srcId === dstId) {
    const has = g.nodes.some((n) => n.id === srcId)
    return has ? [srcId] : null
  }
  const adj = buildAdjacency(g)
  if (!adj.has(srcId) || !adj.has(dstId)) return null

  const prev = new Map<string, string | null>()
  prev.set(srcId, null)
  const queue: string[] = [srcId]
  let head = 0
  while (head < queue.length) {
    const v = queue[head++]
    if (v === dstId) break
    for (const { to: w } of adj.get(v) ?? []) {
      if (!prev.has(w)) {
        prev.set(w, v)
        queue.push(w)
      }
    }
  }
  if (!prev.has(dstId)) return null
  const path: string[] = []
  let cur: string | null = dstId
  while (cur !== null) {
    path.unshift(cur)
    cur = prev.get(cur) ?? null
  }
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-path enumeration (bounded DFS) — Explain Connection engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enumerate up to `maxPaths` simple (loop-free) paths between two nodes,
 * each at most `maxHops` edges long. Deterministic: neighbors are explored
 * in adjacency insertion order and the collection stops once maxPaths are
 * found. Shortest paths naturally dominate because we iterate hop-by-hop
 * with a depth budget.
 *
 * This is the core of "Explain Connection": instead of a single shortest
 * path, investigators see ALL meaningful corridors between two entities
 * (up to 4), e.g.:
 *   A ─ USED ─ Phone1 ─ LOGGED_IN ─ Account B
 *   A ─ VISITED ─ LocX  ·  B ─ VISITED ─ LocX
 */
export function enumeratePaths(
  g: GraphInput,
  srcId: string,
  dstId: string,
  opts?: { maxPaths?: number; maxHops?: number },
): string[][] {
  const maxPaths = Math.max(1, Math.min(opts?.maxPaths ?? 4, 8))
  const maxHops = Math.max(1, Math.min(opts?.maxHops ?? 5, 7))
  if (srcId === dstId) return g.nodes.some((n) => n.id === srcId) ? [[srcId]] : []

  const adj = buildAdjacency(g)
  if (!adj.has(srcId) || !adj.has(dstId)) return []

  const results: string[][] = []
  const visited = new Set<string>([srcId])
  const stack: string[] = [srcId]

  const dfs = (node: string, depth: number) => {
    if (results.length >= maxPaths) return
    if (depth === maxHops) return
    for (const { to: next } of adj.get(node) ?? []) {
      if (results.length >= maxPaths) return
      if (visited.has(next)) continue
      // Prune: never wander beyond dst at final allowed hop unless it IS dst.
      visited.add(next)
      stack.push(next)
      if (next === dstId) {
        results.push([...stack])
      } else {
        dfs(next, depth + 1)
      }
      stack.pop()
      visited.delete(next)
    }
  }

  dfs(srcId, 0)

  // Stable ordering: fewest hops first, then lexicographic for determinism.
  results.sort((a, b) => a.length - b.length || a.join('>').localeCompare(b.join('>')))
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// k-hop neighbors (BFS to depth k, undirected)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the set of node ids within k hops of `nodeId` (exclusive of `nodeId`
 * itself). Uses BFS on the undirected graph.
 */
export function kHopNeighbors(
  g: GraphInput,
  nodeId: string,
  k: number,
): Set<string> {
  const result = new Set<string>()
  if (k <= 0) return result
  const adj = buildAdjacency(g)
  if (!adj.has(nodeId)) return result
  const dist = new Map<string, number>()
  dist.set(nodeId, 0)
  const queue: string[] = [nodeId]
  let head = 0
  while (head < queue.length) {
    const v = queue[head++]
    const dv = dist.get(v)!
    if (dv >= k) continue
    for (const { to: w } of adj.get(v) ?? []) {
      if (!dist.has(w)) {
        dist.set(w, dv + 1)
        result.add(w)
        queue.push(w)
      }
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Community detection — Label Propagation (deterministic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect communities using the Label Propagation Algorithm (LPA).
 *
 * Deterministic: nodes are processed in ascending id order, and ties between
 * equally-frequent neighbor labels are broken by choosing the smallest label
 * (lexicographic string comparison). Iterates until labels stabilise or
 * `maxIters` is reached (default 10).
 *
 * Returns an array of `{ label, members }` sorted by community size descending.
 */
export function detectCommunities(
  g: GraphInput,
  maxIters = 10,
): Community[] {
  const adj = buildAdjacency(g)
  const nodes = g.nodes.map((n) => n.id).sort()
  if (nodes.length === 0) return []

  // Initial label: each node is its own community.
  const label = new Map<string, string>()
  for (const v of nodes) label.set(v, v)

  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false
    for (const v of nodes) {
      const counts = new Map<string, number>()
      for (const { to: w } of adj.get(v) ?? []) {
        const lw = label.get(w)
        if (lw === undefined) continue
        counts.set(lw, (counts.get(lw) ?? 0) + 1)
      }
      if (counts.size === 0) continue
      // Find max count, tie-break by lowest label string.
      let bestLabel = ''
      let bestCount = -1
      const sortedLabels = Array.from(counts.keys()).sort()
      for (const cand of sortedLabels) {
        const c = counts.get(cand)!
        if (c > bestCount) {
          bestCount = c
          bestLabel = cand
        }
      }
      if (bestLabel && label.get(v) !== bestLabel) {
        label.set(v, bestLabel)
        changed = true
      }
    }
    if (!changed) break
  }

  const groups = new Map<string, string[]>()
  for (const v of nodes) {
    const l = label.get(v)!
    if (!groups.has(l)) groups.set(l, [])
    groups.get(l)!.push(v)
  }
  return Array.from(groups.entries())
    .map(([lbl, members]) => ({
      label: lbl,
      members: members.sort(),
    }))
    .sort((a, b) => b.members.length - a.members.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// Subgraph extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ego network of `nodeId` — the induced subgraph on all nodes within
 * `radius` hops (inclusive of `nodeId`).
 */
export function egoNetwork(
  g: GraphInput,
  nodeId: string,
  radius: number,
): GraphInput {
  const neighbors = kHopNeighbors(g, nodeId, radius)
  const nodeSet = new Set<string>([nodeId, ...neighbors])
  return extractSubgraph(g, nodeSet)
}

/**
 * Extract the induced subgraph on the given set of node ids. Keeps only edges
 * whose both endpoints are in the set.
 */
export function extractSubgraph(
  g: GraphInput,
  nodeIds: Iterable<string>,
): GraphInput {
  const keep = new Set<string>()
  for (const id of nodeIds) keep.add(id)
  const nodes = g.nodes.filter((n) => keep.has(n.id))
  const edges = g.edges.filter(
    (e) => keep.has(e.source) && keep.has(e.target),
  )
  return { nodes, edges }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge nodes & central actors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identify "bridge" nodes — high-betweenness nodes whose removal would tend to
 * fragment the network. We use betweenness as the proxy: returns the top-N
 * nodes ranked by betweenness (default N = 5, capped at graph size).
 *
 * @param g Input graph.
 * @param topN Number of bridge nodes to return (default 5).
 */
export function bridgeNodes(g: GraphInput, topN = 5): string[] {
  const cb = betweennessCentrality(g)
  return Object.entries(cb)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, topN))
    .map(([id]) => id)
}

/**
 * Rank the most central actors by combining degree, betweenness, and PageRank
 * (each normalized to 0..1, equal weights). Returns the top-N entity ids with
 * their combined score, descending.
 *
 * @param g Input graph.
 * @param topN Number of actors to return (default 10).
 */
export function centralActors(
  g: GraphInput,
  topN = 10,
): Array<{ id: string; score: number }> {
  const deg = degreeCentrality(g)
  const bet = betweennessCentrality(g)
  const pr = pageRank(g)

  // Normalize betweenness and pagerank into 0..1 by dividing by max.
  const maxBet = Math.max(EPS, ...Object.values(bet))
  const maxPr = Math.max(EPS, ...Object.values(pr))

  const scored = g.nodes.map((n) => {
    const d = deg[n.id] ?? 0
    const b = (bet[n.id] ?? 0) / maxBet
    const p = (pr[n.id] ?? 0) / maxPr
    const score = (d + b + p) / 3
    return { id: n.id, score: clamp01(score) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, topN))
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAll — single pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all standard graph analytics in one pass: degree (in/out/total),
 * betweenness, closeness, pagerank, communities, and connected components.
 *
 * @param g Input graph.
 * @param opts Optional PageRank / bridge parameters.
 */
export function computeAll(
  g: GraphInput,
  opts: ComputeAllOptions = {},
): ComputeAllResult {
  const degree = degreeCentrality(g)
  const ind = inDegree(g)
  const out = outDegree(g)
  const betweenness = betweennessCentrality(g)
  const closeness = closenessCentrality(g)
  const pr = pageRank(g, opts)
  const communities = detectCommunities(g)
  const components = connectedComponents(g)
  return {
    degree,
    inDegree: ind,
    outDegree: out,
    betweenness,
    closeness,
    pagerank: pr,
    communities,
    components,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: binary min-heap (used by Brandes-Dijkstra)
// ─────────────────────────────────────────────────────────────────────────────

class MinHeap<T> {
  private keys: number[] = []
  private values: T[] = []
  size = 0

  push(key: number, value: T): void {
    this.keys.push(key)
    this.values.push(value)
    this.size++
    let i = this.size - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { dist: number; value: T } {
    const topKey = this.keys[0]
    const topVal = this.values[0]
    const lastKey = this.keys.pop()!
    const lastVal = this.values.pop()!
    this.size--
    if (this.size > 0) {
      this.keys[0] = lastKey
      this.values[0] = lastVal
      let i = 0
      const n = this.size
      while (true) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let smallest = i
        if (l < n && this.keys[l] < this.keys[smallest]) smallest = l
        if (r < n && this.keys[r] < this.keys[smallest]) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return { dist: topKey, value: topVal }
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i]
    this.keys[i] = this.keys[j]
    this.keys[j] = k
    const v = this.values[i]
    this.values[i] = this.values[j]
    this.values[j] = v
  }
}
