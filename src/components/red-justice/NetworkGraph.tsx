'use client'

/**
 * NetworkGraph.tsx — flagship interactive SVG-based graph visualization for
 * RED Justice.
 *
 * Features:
 *   - Pure-SVG + React + Tailwind rendering (NO external graph libraries).
 *   - Force-directed layout implemented in TypeScript (degree-normalized
 *     springs + Coulomb repulsion + center gravity + collision separation).
 *   - Pan & zoom (wheel + drag) with click+drag node repositioning (pins node).
 *   - Reset view / Fit to graph / Refresh / Re-run layout toolbar buttons.
 *   - FOCUS MODE: dim everything except the selected node's neighborhood,
 *     with a 1–3 hop depth selector (toolbar + side panel).
 *   - Hover-neighbor emphasis: hovering a node softly highlights its direct
 *     neighbors and incident edges.
 *   - Client-side ego isolation ("show ONLY this ego network") + Esc to clear.
 *   - Pin / Unpin individual node, Unpin all; camera jump-to-node; clickable
 *     Top Hubs leaderboard in the legend.
 *   - Multi-select entity-type & relationship-type filter chips.
 *   - Search box that dims non-matching nodes.
 *   - "Hide isolated" toggle.
 *   - Hover tooltips, edge hover highlighting, hover-selected stroke glow.
 *   - Side panel with expand-neighbors / ego-network / shortest-path actions.
 *   - Bottom-left legend, top-right count badges, "Showing N of M" progressive
 *     loading badge, empty-state guidance.
 *
 * Performance:
 *   - Positions stored in a ref (mutated during drag without state churn).
 *   - GraphContent subtree wrapped in React.memo with a custom comparator that
 *     intentionally excludes `selectedNodeId` so opening the side panel does
 *     NOT re-render the SVG nodes/edges.
 *   - Selection visuals rendered in a tiny separate <SelectionOverlay>.
 *   - Drag updates throttled via requestAnimationFrame.
 *   - Force layout is O(n²) per tick; ~280 ticks at n=120 (~250ms).
 */

import * as React from 'react'
import {
  Search,
  Maximize2,
  RotateCcw,
  RefreshCw,
  Network,
  X,
  ChevronRight,
  Zap,
  GitFork,
  Spline,
  Eye,
  EyeOff,
  Flame,
  Play,
  Pause,
  FileSearch,
  Link2,
  Crosshair,
  Pin,
  PinOff,
  Crown,
  Waypoints,
  Layers3,
  Loader2,
  Sparkles,
  Eraser,
  MoreHorizontal,
} from 'lucide-react'

import {
  api,
  type ExplainConnectionResult,
} from '@/lib/api-client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/hooks/use-toast'
import { useGraphRefresh, notifyGraphUpdated } from '@/hooks/use-graph-refresh'
import { cn } from '@/lib/utils'
import { relRenderHint } from '@/lib/investigation/relVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphNodeView {
  id: string
  type: string
  label: string
  value?: string
  degree?: number
  // Confidence-aware / evidence-heatmap fields (from /graph API)
  evidenceCount?: number
  evidenceFiles?: number
  verState?: 'observed' | 'corroborated' | 'inferred' | 'uncertain'
  /** v3.5: the source export's own IDs for this node (E0001 …). */
  tableIds?: string[]
}

/** v3.5: one verbatim source-table row asserting an edge. */
export interface GraphEdgeRowView {
  rowId?: string
  srcTableId?: string
  tgtTableId?: string
  state?: string
  method?: string
  evidenceRefs?: string[]
  timestamp?: string
  row?: Record<string, string>
}

export interface GraphEdgeView {
  id: string
  source: string
  target: string
  type: string
  weight: number
  amount?: number
  timestamp?: string
  // Per-edge evidence provenance
  evidenceId?: string
  evidenceRef?: string
  evidenceClassification?: string
  locator?: string
  provenance?: string
  extractionMethod?: string
  confidence?: number
  verState?: 'observed' | 'corroborated' | 'inferred' | 'uncertain'
  // Why-connected explanation (v2.2)
  rationale?: string
  sharedEvidence?: number
  why?: string
  t?: string
  createdAt?: string
  // v3.5 full-fidelity table rows (deterministic-reltable edges)
  rows?: GraphEdgeRowView[]
  tableRowCount?: number
  state?: string
}

interface NetworkGraphProps {
  caseId: string
  height?: number // default 600
  /** Called when the investigator opens the source evidence of an edge. */
  onOpenEvidence?: (evidenceId: string) => void
}

/**
 * AI link explanation response shape (v3) — from POST /links/explain.
 */
interface AiLinkExplanationView {
  explanation: string
  aiAvailable: boolean
  model: string
  heuristicWhy: string
  sharedEvidence: { count: number; files: string[] }
  excerpts: Array<{ evidenceName: string; snippets: string[] }>
}

/**
 * Display-level declutter for hairball cases. One bank statement can spawn
 * hundreds of pairwise CO_OCCURRED edges (every entity × every entity in the
 * file), rendering as a solid gray knot around the graph core — users read
 * this as "nodes are still clustered" even when the layout spread them.
 *
 * This pass keeps EVERY semantically-typed edge (TRANSFERRED_TO,
 * SHARED_IDENTIFIER, …) and caps CO_OCCURRED to the strongest few PER NODE
 * once the total explodes past a threshold. Database data is untouched;
 * only the current visual pass is reduced.
 */
export function pruneCoOccurredForDisplay(
  edges: GraphEdgeView[],
): { edges: GraphEdgeView[]; hidden: number } {
  const CO_THRESHOLD = 150
  const PER_NODE_CAP = 5
  const coCount = edges.reduce((a, e) => (e.type === 'CO_OCCURRED' ? a + 1 : a), 0)
  if (coCount <= CO_THRESHOLD) return { edges, hidden: 0 }

  const rankedCo = edges
    .filter((e) => e.type === 'CO_OCCURRED')
    .sort(
      (a, b) =>
        (b.weight ?? 1) * 10 + Math.min(5, (b.confidence ?? 0.7) * 5) -
        ((a.weight ?? 1) * 10 + Math.min(5, (a.confidence ?? 0.7) * 5)),
    )
  const perNodeCount = new Map<string, number>()
  const keep = new Set<string>()
  for (const e of rankedCo) {
    const ca = perNodeCount.get(e.source) ?? 0
    const cb = perNodeCount.get(e.target) ?? 0
    if (ca >= PER_NODE_CAP || cb >= PER_NODE_CAP) continue
    perNodeCount.set(e.source, ca + 1)
    perNodeCount.set(e.target, cb + 1)
    keep.add(e.id)
  }
  let hidden = 0
  const out = edges.filter((e) => {
    if (e.type !== 'CO_OCCURRED') return true
    if (keep.has(e.id)) return true
    hidden += 1
    return false
  })
  return { edges: out, hidden }
}

interface Transform {
  tx: number
  ty: number
  scale: number
}

interface PositionedNode {
  x: number
  y: number
  vx: number
  vy: number
  pinned: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic color palette — Tailwind hex colors by entity type
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  person: '#ef4444',
  organization: '#f97316',
  account: '#14b8a6',
  upi: '#06b6d4',
  phone: '#84cc16',
  email: '#22c55e',
  ip: '#a855f7',
  url: '#ec4899',
  domain: '#ec4899',
  wallet: '#eab308',
  vehicle: '#64748b',
  date: '#94a3b8',
  amount: '#94a3b8',
}
const DEFAULT_TYPE_COLOR = '#0ea5e9'

function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? DEFAULT_TYPE_COLOR
}

function radiusFor(degree?: number): number {
  const d = Math.max(0, degree ?? 0)
  return Math.max(6, Math.min(16, 6 + Math.sqrt(d) * 2))
}

/** Evidence-heatmap node color: red (speculative) → amber (single source) → green (corroborated). */
function heatmapColor(n: GraphNodeView): string {
  const files = n.evidenceFiles ?? 0
  if (files === 0) return '#ef4444' // red — no direct evidence link
  if (files === 1) return '#f59e0b' // amber — single source
  if (files === 2) return '#84cc16' // lime — two sources
  return '#10b981' // emerald — strongly corroborated
}

const VERSTATE_COLOR: Record<string, string> = {
  corroborated: '#10b981',
  observed: '#0ea5e9',
  inferred: '#a855f7',
  uncertain: '#ef4444',
}

const VERSTATE_LABEL: Record<string, string> = {
  corroborated: 'Corroborated (≥2 sources)',
  observed: 'Observed (1 source)',
  inferred: 'Inferred (co-occurrence/derived)',
  uncertain: 'Uncertain (<0.5 confidence)',
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

// ─────────────────────────────────────────────────────────────────────────────
// Force-directed layout
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG so layouts are reproducible across re-renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Force-directed layout — d3-force-inspired simulation.
 *
 * Why the previous version clustered connected nodes into a central knot:
 *   attraction was applied PER EDGE at a fixed strength, so a hub with 20
 *   incident links received 20× the inward pull of its leaves and dragged its
 *   entire neighborhood into a dense ball. The fix is degree normalization:
 *   each edge's spring strength is divided by the smaller endpoint degree, so
 *   every node receives roughly CONSTANT total inward pull no matter how many
 *   edges it has. This is exactly how d3-force defaults behave, and it is the
 *   single most important anti-clustering rule.
 *
 * Also:
 *   - Components are initialized on separate arcs of a large circle so they
 *     start apart instead of interleaved.
 *   - Collision separation runs from ~15% progress (not half) with pins kept.
 *   - Final normalization scales by the P92 radius instead of the raw bounding
 *     box, so a handful of far-flung/isolated outliers can no longer shrink
 *     the connected core into a barely-visible blob.
 */
function runForceLayout(
  nodes: GraphNodeView[],
  edges: GraphEdgeView[],
  iterations?: number,
  existing?: Map<string, PositionedNode>,
): Map<string, PositionedNode> {
  const pos = new Map<string, PositionedNode>()
  const n = nodes.length
  if (n === 0) return pos

  const rand = mulberry32(0x5eed)
  // Adaptive iteration count for larger graphs.
  if (!iterations || iterations <= 0) {
    iterations = n <= 120 ? 280 : n <= 250 ? 200 : 150
  }

  // ── Component labeling (union-find over valid edges) ──
  const idxOf = new Map<string, number>()
  for (let i = 0; i < n; i++) idxOf.set(nodes[i].id, i)
  const compParent = new Int32Array(n).map((_, i) => i)
  const findC = (i: number): number => {
    while (compParent[i] !== i) {
      compParent[i] = compParent[compParent[i]]
      i = compParent[i]
    }
    return i
  }
  const unionC = (a: number, b: number) => {
    const ra = findC(a)
    const rb = findC(b)
    if (ra !== rb) compParent[ra] = rb
  }

  const validEdges: Array<{ s: string; t: string; w: number }> = []
  for (const e of edges) {
    const si = idxOf.get(e.source)
    const ti = idxOf.get(e.target)
    if (si === undefined || ti === undefined || si === ti) continue
    unionC(si, ti)
    validEdges.push({ s: e.source, t: e.target, w: Math.max(1, e.weight ?? 1) })
  }
  const nComponents = new Set<Int32Array[number] | number>(
    Array.from({ length: n }, (_, i) => findC(i)),
  ).size

  // ── Initial placement ──
  // Put each component on its own arc of a big circle; nodes inside a
  // component spread on a small circle around their component's anchor.
  const initRadius = Math.max(340, Math.sqrt(n) * 85)
  const compAnchorAngle = new Map<number, number>()
  {
    let cIdx = 0
    for (let i = 0; i < n; i++) {
      const root = findC(i)
      if (!compAnchorAngle.has(root)) {
        compAnchorAngle.set(root, (cIdx / Math.max(1, nComponents)) * Math.PI * 2 + rand() * 0.35)
        cIdx++
      }
    }
  }
  const compMemberIdx = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const node = nodes[i]
    const ex = existing?.get(node.id)
    if (ex) {
      pos.set(node.id, { x: ex.x, y: ex.y, vx: 0, vy: 0, pinned: ex.pinned })
      continue
    }
    const root = findC(i)
    const mIdx = compMemberIdx.get(root) ?? 0
    compMemberIdx.set(root, mIdx + 1)
    const anchor = compAnchorAngle.get(root)!
    const localR = 14 * Math.sqrt(Math.max(1, mIdx))
    const angle = anchor + mIdx * 2.399963 // golden-angle spiral inside component
    pos.set(node.id, {
      x: Math.cos(anchor) * initRadius + Math.cos(angle) * localR,
      y: Math.sin(anchor) * initRadius + Math.sin(angle) * localR,
      vx: 0,
      vy: 0,
      pinned: false,
    })
  }

  // ── Degrees within THIS subgraph (for strength normalization) ──
  const deg = new Float64Array(n)
  for (const { s, t } of validEdges) {
    deg[idxOf.get(s)!]++
    deg[idxOf.get(t)!]++
  }

  // Force parameters — see docblock.
  // DENSITY-AWARE ideal distance: clique-heavy cases (bank statements produce
  // pairwise CO_OCCURRED cliques of 20+ members) cannot spread at the base k —
  // every member pulls on every other member simultaneously. Scaling k by
  // sqrt(avgDegree) gives dense graphs proportionally more room so they stop
  // collapsing into a central knot.
  const avgDeg = n > 0 ? (2 * validEdges.length) / n : 0
  const densityBoost = Math.min(1.8, Math.sqrt(Math.max(1, avgDeg / 3)))
  const k =
    Math.max(130, Math.min(280, Math.sqrt((900 * 900) / Math.max(n, 8)) * densityBoost))
  const chargeStrength = k * k * 0.9 // Coulomb-style repulsion ∝ k²
  const linkBase = 0.42 // base spring strength before degree normalization
  const damping = 0.62 // velocity decay per tick (d3's velocityDecay ≈ 0.4..0.7)
  const gravity = 0.006 // gentle centering (lower ⇒ less central crowding)
  const maxDisplacement = Math.min(k * 0.45, 70)

  // Per-node minimum separation for the deterministic collision pass.
  const minSep = new Float64Array(n)
  for (let i = 0; i < n; i++) minSep[i] = radiusFor(nodes[i].degree) * 2 + 10

  for (let iter = 0; iter < iterations!; iter++) {
    const t01 = iter / iterations!
    const alpha = Math.pow(1 - t01, 1.5) * 0.9 + 0.03
    const fxArr = new Float64Array(n)
    const fyArr = new Float64Array(n)

    // Repulsion — all pairs, softened Coulomb.
    for (let i = 0; i < n; i++) {
      const pa = pos.get(nodes[i].id)!
      for (let j = i + 1; j < n; j++) {
        const pb = pos.get(nodes[j].id)!
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = rand() - 0.5
          dy = rand() - 0.5
          d2 = dx * dx + dy * dy + 0.05
        }
        const force = chargeStrength / (d2 + 25)
        const d = Math.sqrt(d2)
        const ux = (dx / d) * force
        const uy = (dy / d) * force
        fxArr[i] += ux
        fyArr[i] += uy
        fxArr[j] -= ux
        fyArr[j] -= uy
      }
    }

    // Attraction — springs toward ideal length k, DEGREE-NORMALIZED.
    // Hub endpoints get proportionally weaker per-edge pull ⇒ no knot.
    for (const { s, t, w } of validEdges) {
      const pa = pos.get(s)!
      const pb = pos.get(t)!
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const wEff = Math.min(2, 1 + Math.log2(Math.max(1, w)) * 0.35)
      const sDeg = deg[idxOf.get(s)!] || 1
      const tDeg = deg[idxOf.get(t)!] || 1
      const strength = linkBase / Math.sqrt(sDeg * tDeg) * wEff
      const force = (d - k) * strength
      const ux = (dx / d) * force
      const uy = (dy / d) * force
      fxArr[idxOf.get(s)!] += ux
      fyArr[idxOf.get(s)!] += uy
      fxArr[idxOf.get(t)!] -= ux
      fyArr[idxOf.get(t)!] -= uy
    }

    // Integrate: gravity + velocity decay + displacement cap.
    for (let i = 0; i < n; i++) {
      const p = pos.get(nodes[i].id)!
      if (p.pinned) continue
      fxArr[i] -= p.x * gravity
      fyArr[i] -= p.y * gravity
      p.vx = (p.vx * damping + fxArr[i]) * alpha
      p.vy = (p.vy * damping + fyArr[i]) * alpha
      const vmag = Math.hypot(p.vx, p.vy)
      if (vmag > maxDisplacement) {
        p.vx = (p.vx / vmag) * maxDisplacement
        p.vy = (p.vy / vmag) * maxDisplacement
      }
      p.x += p.vx
      p.y += p.vy
      if (!isFinite(p.x)) p.x = (rand() - 0.5) * 400
      if (!isFinite(p.y)) p.y = (rand() - 0.5) * 400
    }

    // Hard collision pass — runs from 15% onward every iteration.
    if (iter >= iterations! * 0.15) {
      for (let i = 0; i < n; i++) {
        const pi = pos.get(nodes[i].id)!
        for (let j = i + 1; j < n; j++) {
          const pj = pos.get(nodes[j].id)!
          let dx = pi.x - pj.x
          let dy = pi.y - pj.y
          let d = Math.sqrt(dx * dx + dy * dy)
          const need = minSep[i] + minSep[j]
          if (d >= need) continue
          if (d < 0.01) {
            dx = rand() - 0.5
            dy = rand() - 0.5
            d = Math.sqrt(dx * dx + dy * dy) || 0.02
          }
          const push = need - d
          const ux = dx / d
          const uy = dy / d
          const piPinned = pi.pinned
          const pjPinned = pj.pinned
          if (piPinned && pjPinned) continue
          if (piPinned) {
            pj.x -= ux * push
            pj.y -= uy * push
          } else if (pjPinned) {
            pi.x += ux * push
            pi.y += uy * push
          } else {
            pi.x += ux * push * 0.5
            pi.y += uy * push * 0.5
            pj.x -= ux * push * 0.5
            pj.y -= uy * push * 0.5
          }
        }
      }
    }
  }

  // ── Normalization: center at centroid, scale by P92 radius.
  // The old raw-bounding-box scaling let even ONE isolated outlier dictate the
  // zoom factor and shrink the entire connected core to a blob. Scaling by the
  // P92 radius makes the core fill the box; rare outliers may land slightly
  // outside it (pan/zoom/Fit handle that gracefully).
  {
    const pts: Array<{ x: number; y: number }> = []
    for (const [, p] of pos) {
      if (isFinite(p.x) && isFinite(p.y)) pts.push({ x: p.x, y: p.y })
    }
    if (pts.length > 0) {
      let cx = 0
      let cy = 0
      for (const q of pts) {
        cx += q.x
        cy += q.y
      }
      cx /= pts.length
      cy /= pts.length
      const radii = pts.map((q) => Math.hypot(q.x - cx, q.y - cy)).sort((a, b) => a - b)
      const p92idx = Math.min(radii.length - 1, Math.ceil(radii.length * 0.92))
      const rRef = Math.max(60, radii[p92idx])
      const targetRadius = 380 // maps core into a 600-box with label headroom
      const scale = Math.min(4, Math.max(0.25, targetRadius / rRef))
      for (const [, p] of pos) {
        p.x = (p.x - cx) * scale
        p.y = (p.y - cy) * scale
      }
    }
  }

  return pos
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphContent — the memoised SVG subtree that renders edges + nodes.
// Intentionally does NOT receive `selectedNodeId` so selecting a node opens
// the side panel without re-rendering the whole graph.
// ─────────────────────────────────────────────────────────────────────────────

interface GraphContentProps {
  nodes: GraphNodeView[]
  edges: GraphEdgeView[]
  positions: Map<string, PositionedNode>
  positionVersion: number
  hoveredNodeId: string | null
  hoveredEdgeId: string | null
  pathNodes: Set<string> | null
  pathEdges: Set<string> | null
  matchedNodeIds: Set<string> | null
  showHeatmap: boolean
  selectedEdgeId: string | null
  /** Focus mode: only these nodes are emphasized, everything else dims hard. */
  focusNodeIds: Set<string> | null
  focusEdgeIds: Set<string> | null
  /**
   * Direct neighbors of the SELECTED node — softly highlighted even when
   * focus mode is off, so "which nodes connect to this one" is answered at a
   * glance while the rest of the graph stays visible.
   */
  selectedNeighborIds: Set<string> | null
  selectedNodeIdForLinks: string | null
  onNodeMouseDown: (e: React.MouseEvent, nodeId: string) => void
  onNodeMouseEnter: (nodeId: string) => void
  onNodeMouseLeave: () => void
  onEdgeMouseEnter: (edgeId: string) => void
  onEdgeMouseLeave: () => void
  onEdgeMouseDown: (e: React.MouseEvent, edgeId: string) => void
}

function GraphContent(props: GraphContentProps) {
  const {
    nodes,
    edges,
    positions,
    positionVersion,
    hoveredNodeId,
    hoveredEdgeId,
    pathNodes,
    pathEdges,
    matchedNodeIds,
    showHeatmap,
    selectedEdgeId,
    focusNodeIds,
    focusEdgeIds,
    selectedNeighborIds,
    selectedNodeIdForLinks,
    onNodeMouseDown,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onEdgeMouseEnter,
    onEdgeMouseLeave,
    onEdgeMouseDown,
  } = props
  // positionVersion is used by the memo comparator, not inside this body.
  void positionVersion

  // Build node-id → node map for radius lookup.
  const nodeById = React.useMemo(() => {
    const m = new Map<string, GraphNodeView>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  // Hovered edge endpoints (to highlight both endpoints).
  const hoveredEdgeEndpoints = React.useMemo(() => {
    if (!hoveredEdgeId) return null
    const e = edges.find((ee) => ee.id === hoveredEdgeId)
    if (!e) return null
    return { source: e.source, target: e.target }
  }, [hoveredEdgeId, edges])

  // Direct neighbors of the hovered node — softly emphasized while hovering.
  const hoveredNeighbors = React.useMemo(() => {
    if (!hoveredNodeId) return null
    const s = new Set<string>()
    for (const e of edges) {
      if (e.source === hoveredNodeId) s.add(e.target)
      else if (e.target === hoveredNodeId) s.add(e.source)
    }
    return s
  }, [hoveredNodeId, edges])

  const focusActive = !!focusNodeIds

  // Edges
  const edgeEls: React.ReactNode[] = []
  for (const e of edges) {
    const a = positions.get(e.source)
    const b = positions.get(e.target)
    if (!a || !b) continue

    const aR = radiusFor(nodeById.get(e.source)?.degree)
    const bR = radiusFor(nodeById.get(e.target)?.degree)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
    const ux = dx / dist
    const uy = dy / dist
    // Shorten the line so the arrow tip sits just outside the target node.
    const x1 = a.x + ux * (aR + 2)
    const y1 = a.y + uy * (aR + 2)
    const x2 = b.x - ux * (bR + 2)
    const y2 = b.y - uy * (bR + 2)

    const baseOpacity = 0.2 + Math.min(e.weight / 5, 0.6)
    const isHovered = hoveredEdgeId === e.id
    const isSelected = selectedEdgeId === e.id
    const isPath = pathEdges?.has(e.id) ?? false
    const isEndpointHovered = hoveredEdgeEndpoints
      ? hoveredEdgeEndpoints.source === e.source ||
        hoveredEdgeEndpoints.target === e.source ||
        hoveredEdgeEndpoints.source === e.target ||
        hoveredEdgeEndpoints.target === e.target
      : false
    // Incident to the currently hovered NODE — soft emphasis even without
    // focusing the edge itself.
    const touchesHoveredNode =
      hoveredNodeId !== null && (e.source === hoveredNodeId || e.target === hoveredNodeId)
    // Incident to the SELECTED node or its direct neighbors — persistent
    // connection emphasis tied to the current selection (no mode needed).
    const touchesSelection =
      (selectedNodeIdForLinks !== null &&
        (e.source === selectedNodeIdForLinks || e.target === selectedNodeIdForLinks)) ||
      (selectedNeighborIds !== null &&
        ((selectedNeighborIds.has(e.source) && selectedNeighborIds.has(e.target)) ||
          e.source === selectedNodeIdForLinks ||
          e.target === selectedNodeIdForLinks))
    // Focus-mode relevance: only edges inside the focused neighborhood stay lit.
    const focusLit = !focusActive || (focusEdgeIds?.has(e.id) ?? false)
    const inFocusCore = focusLit && !!focusEdgeIds?.has(e.id)

    let stroke = '#64748b'
    let strokeWidth = 1
    let strokeDasharray: string | undefined
    let markerEnd: string | undefined
    if (showHeatmap && e.verState) {
      // Evidence-heatmap mode: edge color encodes the confidence state.
      stroke = VERSTATE_COLOR[e.verState] ?? stroke
      if (e.verState === 'uncertain') strokeDasharray = '3 3'
      if (e.verState === 'inferred') strokeDasharray = '6 3'
      if (e.type === 'TRANSFERRED_TO') markerEnd = 'url(#rj-arrow)'
      strokeWidth = e.verState === 'corroborated' ? 1.8 : 1
    } else {
      // v3.6 — DYNAMIC relationship colors: every edge type gets its
      // deterministic color from the shared vocabulary (curated colors for
      // core types, stable palette colors for novel evidence-derived types
      // like SUPPLIED_DRUGS_TO or LAUNDERED_MONEY_FOR so new intelligence is
      // visually distinct instead of collapsing into generic slate gray).
      const hint = relRenderHint(e.type)
      stroke = hint.color
      strokeWidth = e.type === 'CO_OCCURRED' ? 0.8 : 1.2
      if (hint.arrow) {
        markerEnd = 'url(#rj-arrow)'
        if (e.type !== 'CO_OCCURRED') strokeWidth = Math.max(strokeWidth, 1.4)
      }
      if (hint.dashed) strokeDasharray = '4 3'
    }
    if (isPath) {
      stroke = '#f59e0b'
      strokeWidth = 3
      markerEnd = undefined
      strokeDasharray = undefined
    } else if (inFocusCore) {
      // Focused neighborhood edge — keep type color but stronger.
      strokeWidth += 0.8
    } else if (isSelected) {
      strokeWidth += 1.5
    } else if (touchesSelection) {
      // Selection-linked edge — teal like money-flow highlight family, dimmer
      // than hover so it reads as contextual rather than active.
      stroke = '#14b8a6'
      strokeWidth += 0.7
    } else if (isHovered) {
      strokeWidth += 1
    }
    let finalOpacity = isPath
      ? 1
      : isSelected || inFocusCore
        ? 1
        : isHovered || isEndpointHovered
          ? Math.min(1, baseOpacity + 0.3)
          : touchesHoveredNode
            ? Math.min(1, baseOpacity + 0.25)
            : baseOpacity
    if (touchesSelection && !isPath && !inFocusCore) {
      finalOpacity = Math.max(finalOpacity, Math.min(1, baseOpacity + 0.35))
    }
    if (!focusLit && !isPath) finalOpacity *= 0.1

    edgeEls.push(
      <g key={`e-${e.id}`}>
        {/* invisible thicker hit-area */}
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="transparent"
          strokeWidth={Math.max(8, strokeWidth + 4)}
          style={{ cursor: 'pointer' }}
          onMouseEnter={() => {
            onEdgeMouseEnter(e.id)
          }}
          onMouseLeave={onEdgeMouseLeave}
          onMouseDown={(ev) => onEdgeMouseDown(ev, e.id)}
        />
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeOpacity={finalOpacity}
          strokeDasharray={strokeDasharray}
          markerEnd={markerEnd}
          style={{
            transition: 'stroke-width 150ms ease, stroke-opacity 150ms ease',
            pointerEvents: 'none',
          }}
        />
      </g>,
    )
  }

  // Nodes
  const nodeEls: React.ReactNode[] = []
  for (const n of nodes) {
    const p = positions.get(n.id)
    if (!p) continue
    const r = radiusFor(n.degree)
    const color = showHeatmap ? heatmapColor(n) : colorFor(n.type)
    const isHovered = hoveredNodeId === n.id
    const isPath = pathNodes?.has(n.id) ?? false
    const isMatched = !matchedNodeIds || matchedNodeIds.has(n.id)
    // Neighbor-of-hovered node gets a soft emphasis ring + brighter stroke.
    const isHoverNeighbor = !isHovered && (hoveredNeighbors?.has(n.id) ?? false)
    // Neighbor-of-SELECTED node — persistent “connected to selection” cue
    // (distinct teal ring vs the amber hover ring).
    const isSelectedNeighbor =
      !isHovered && !isPath && (selectedNeighborIds?.has(n.id) ?? false)
    // Focus-mode membership.
    const isFocusRoot = focusActive && focusNodeIds!.has(n.id)
    let dimOpacity = isMatched ? 1 : 0.2
    if (
      focusActive &&
      !isFocusRoot &&
      dimOpacity > 0.07 &&
      !(selectedNeighborIds?.has(n.id) ?? false)
    ) {
      dimOpacity = 0.07
    } else if (!focusActive && isSelectedNeighbor) {
      dimOpacity = 1 // never let soft matching dim a connected neighbor
    }
    const label = truncate(n.label || n.value || n.id, 14)
    const showLabel =
      isHovered || isPath || (!!focusNodeIds?.has(n.id) && !!matchedNodeIds?.has(n.id)) ||
      (focusActive && isFocusRoot) ||
      isSelectedNeighbor

    nodeEls.push(
      <g
        key={`n-${n.id}`}
        transform={`translate(${p.x},${p.y})`}
        style={{ cursor: 'grab', opacity: dimOpacity }}
        onMouseDown={(ev) => onNodeMouseDown(ev, n.id)}
        onMouseEnter={() => onNodeMouseEnter(n.id)}
        onMouseLeave={onNodeMouseLeave}
      >
        {(isHovered || isPath || isHoverNeighbor || isSelectedNeighbor) && (
          <circle
            r={r + 6}
            fill={isPath ? '#f59e0b' : isSelectedNeighbor ? '#14b8a6' : color}
            opacity={isHoverNeighbor ? 0.16 : isSelectedNeighbor ? 0.22 : 0.25}
            style={{ pointerEvents: 'none' }}
          />
        )}
        <circle
          r={r}
          fill={color}
          stroke={
            isPath
              ? '#f59e0b'
              : isSelectedNeighbor
                ? '#14b8a6aa'
                : isHoverNeighbor
                  ? '#f59e0b99'
                  : 'currentColor'
          }
          strokeWidth={isHovered ? 3 : isPath ? 2.5 : isSelectedNeighbor ? 2.3 : isHoverNeighbor ? 2.2 : 1.5}
          className="text-background"
          style={{
            transition: 'stroke-width 150ms ease, r 150ms ease',
          }}
        />
        {showHeatmap && (n.evidenceFiles ?? 0) >= 2 && (
          <circle
            r={r - 3.5}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.55}
            strokeWidth={1}
            style={{ pointerEvents: 'none' }}
          />
        )}
        <text
          y={r + (showLabel ? 14 : 12)}
          textAnchor="middle"
          fontSize={showLabel ? 11 : 9}
          fill="currentColor"
          className="text-foreground select-none"
          style={{
            pointerEvents: 'none',
            opacity: showLabel ? 0.95 : 0.4,
            transition: 'opacity 150ms ease',
          }}
        >
          {label}
        </text>
      </g>,
    )
  }

  return (
    <>
      <g className="rj-edges">{edgeEls}</g>
      <g className="rj-nodes">{nodeEls}</g>
    </>
  )
}

const GraphContentMemo = React.memo(GraphContent, (prev, next) => {
  return (
    prev.nodes === next.nodes &&
    prev.edges === next.edges &&
    prev.positions === next.positions &&
    prev.positionVersion === next.positionVersion &&
    prev.hoveredNodeId === next.hoveredNodeId &&
    prev.hoveredEdgeId === next.hoveredEdgeId &&
    prev.pathNodes === next.pathNodes &&
    prev.pathEdges === next.pathEdges &&
    prev.matchedNodeIds === next.matchedNodeIds &&
    prev.showHeatmap === next.showHeatmap &&
    prev.selectedEdgeId === next.selectedEdgeId &&
    prev.focusNodeIds === next.focusNodeIds &&
    prev.focusEdgeIds === next.focusEdgeIds &&
    prev.selectedNeighborIds === next.selectedNeighborIds &&
    prev.selectedNodeIdForLinks === next.selectedNodeIdForLinks &&
    prev.onNodeMouseDown === next.onNodeMouseDown &&
    prev.onNodeMouseEnter === next.onNodeMouseEnter &&
    prev.onNodeMouseLeave === next.onNodeMouseLeave &&
    prev.onEdgeMouseEnter === next.onEdgeMouseEnter &&
    prev.onEdgeMouseLeave === next.onEdgeMouseLeave &&
    prev.onEdgeMouseDown === next.onEdgeMouseDown
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// EdgeRowsSection — v3.5 full-fidelity table rows on the edge provenance panel.
// Renders EVERY verbatim source row asserting the selected edge (its own
// relationship_id, endpoint IDs, types, date, evidence refs, state,
// confidence, extraction method — the entire export row, key by key).
// ─────────────────────────────────────────────────────────────────────────────

function EdgeRowsSection({ rows }: { rows: GraphEdgeRowView[] }) {
  const [expanded, setExpanded] = React.useState(false)
  if (rows.length === 0) return null
  const visible = expanded ? rows : rows.slice(0, 1)
  return (
    <>
      <Separator className="my-1.5" />
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Source table rows
        </div>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-amber-500">
          {rows.length} row{rows.length > 1 ? 's' : ''}
        </span>
      </div>
      <div className="space-y-1.5">
        {visible.map((r, i) => (
          <div key={r.rowId ?? i} className="rounded border border-border/60 bg-muted/10 p-1.5">
            {r.rowId && (
              <div className="mb-1 font-mono text-[10px] font-semibold text-amber-500">
                {r.rowId}
              </div>
            )}
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px] leading-snug">
              {Object.entries(r.row ?? {}).map(([k, v]) => (
                <React.Fragment key={k}>
                  <span className="whitespace-nowrap text-muted-foreground">{k}</span>
                  <span className="break-all text-foreground/90">{v}</span>
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
        {rows.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-full text-[10px] text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show fewer rows' : `Show all ${rows.length} rows`}
          </Button>
        )}
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectionOverlay — tiny SVG group rendered on top of the graph to indicate
// the selected node. Re-renders independently of GraphContent.
// ─────────────────────────────────────────────────────────────────────────────

interface SelectionOverlayProps {
  node: GraphNodeView | null
  position: PositionedNode | undefined
  positionVersion: number
}

function SelectionOverlay({ node, position, positionVersion }: SelectionOverlayProps) {
  void positionVersion
  if (!node || !position) return null
  const r = radiusFor(node.degree)
  const color = colorFor(node.type)
  return (
    <g
      transform={`translate(${position.x},${position.y})`}
      style={{ pointerEvents: 'none' }}
    >
      <circle r={r + 10} fill={color} opacity={0.12} />
      <circle r={r + 4} fill="none" stroke={color} strokeWidth={3} opacity={0.7} />
      <circle r={r + 4} fill="none" stroke="#ffffff" strokeWidth={1} opacity={0.9} />
    </g>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function NetworkGraph({ caseId, height = 600, onOpenEvidence }: NetworkGraphProps) {
  const { toast } = useToast()
  // ─── Data state ───
  const [nodes, setNodes] = React.useState<GraphNodeView[]>([])
  const [edges, setEdges] = React.useState<GraphEdgeView[]>([])
  const [meta, setMeta] = React.useState<{
    totalEntities: number
    totalRelationships: number
  } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // ─── Interaction state ───
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = React.useState<string | null>(null)
  const [transform, setTransform] = React.useState<Transform>({
    tx: 0,
    ty: 0,
    scale: 1,
  })
  const [pathHighlight, setPathHighlight] = React.useState<{
    nodes: Set<string>
    edges: Set<string>
  } | null>(null)
  const [showPathPicker, setShowPathPicker] = React.useState(false)
  const [pathPickerQuery, setPathPickerQuery] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [renderVersion, setRenderVersion] = React.useState(0)

  // ─── Evidence heatmap / playback / edge provenance state ───
  const [showHeatmap, setShowHeatmap] = React.useState(false)
  const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null)
  /** CO_OCCURRED links hidden by display-level decluttering (0 = full view). */
  const [declutteredHidden, setDeclutteredHidden] = React.useState(0)
  const [playbackT, setPlaybackT] = React.useState<string | null>(null)
  const [playing, setPlaying] = React.useState(false)
  // Inline deep-explain for the currently clicked edge (v2.2).
  const [edgeExplain, setEdgeExplain] = React.useState<ExplainConnectionResult | null>(null)
  const [edgeExplainBusy, setEdgeExplainBusy] = React.useState(false)
  const [edgeExplainError, setEdgeExplainError] = React.useState<string | null>(null)
  // AI link explanation for the clicked edge (v3.0) — auto-loads the local
  // AI's narrative "why connected" answer grounded in document excerpts.
  const [edgeAi, setEdgeAi] = React.useState<AiLinkExplanationView | null>(null)
  const [edgeAiBusy, setEdgeAiBusy] = React.useState(false)
  // Legacy mechanical-content purge (v3 graph hygiene).
  const [purgeBusy, setPurgeBusy] = React.useState(false)

  // ─── Focus / highlight state ───
  // Focus mode: dim everything except the selected node's neighborhood.
  const [focusEnabled, setFocusEnabled] = React.useState(false)
  const [focusDepth, setFocusDepth] = React.useState<1 | 2 | 3>(1)
  // Ego view: hide everything except the root's neighborhood (client-side).
  const [egoIsolate, setEgoIsolate] = React.useState<{
    rootId: string
    depth: number
  } | null>(null)

  // ─── Explain Connection (architecture §27 killer interaction) ───
  // Pick node A, then node B → deterministic multi-path explanation with
  // sufficiency scoring, contradiction scan and an Evidence Contract.
  const [explainActive, setExplainActive] = React.useState(false)
  const [explainSrcId, setExplainSrcId] = React.useState<string | null>(null)
  const [explainBusy, setExplainBusy] = React.useState(false)
  const [explainResult, setExplainResult] = React.useState<ExplainConnectionResult | null>(null)
  const [explainError, setExplainError] = React.useState<string | null>(null)
  // Refs mirror pick state inside long-lived drag/click closures.
  const explainActiveRef = React.useRef(false)
  const explainSrcRef = React.useRef<string | null>(null)

  // ─── Graph completeness controls ───
  // Contextual entity types (date/amount) are hidden server-side by default;
  // the fetch cap keeps monster cases responsive. Both are overridable here.
  const [includeContextualNodes, setIncludeContextualNodes] = React.useState(false)
  const [loadLimitOverride, setLoadLimitOverride] = React.useState<number | null>(null)

  // ─── Filter state ───
  const [entityTypeFilter, setEntityTypeFilter] = React.useState<Set<string>>(
    new Set(),
  )
  const [relTypeFilter, setRelTypeFilter] = React.useState<Set<string>>(new Set())
  const [search, setSearch] = React.useState('')
  const [hideIsolated, setHideIsolated] = React.useState(false)

  // ─── Left control panel (merged filters + legend) ───
  // Accordion sections: "Search & Filters" open by default; playback and
  // legend stay collapsed until the investigator needs them.
  const [panelOpen, setPanelOpen] = React.useState<string[]>(['filters'])

  // Toggles that reveal a legend (heatmap) auto-open the legend section.
  React.useEffect(() => {
    if (showHeatmap) {
      setPanelOpen((prev) => (prev.includes('legend') ? prev : [...prev, 'legend']))
    }
  }, [showHeatmap])

  // ─── Refs ───
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const positionsRef = React.useRef<Map<string, PositionedNode>>(new Map())
  const transformRef = React.useRef<Transform>({ tx: 0, ty: 0, scale: 1 })
  const dragStateRef = React.useRef<{
    mode: 'pan' | 'node' | null
    nodeId?: string
    startClientX: number
    startClientY: number
    startTx: number
    startTy: number
    moved: boolean
  }>({
    mode: null,
    startClientX: 0,
    startClientY: 0,
    startTx: 0,
    startTy: 0,
    moved: false,
  })
  const rafRef = React.useRef<number | null>(null)
  const bumpRender = React.useCallback(() => setRenderVersion((v) => v + 1), [])

  // Bump render whenever pinned-state changes need reflecting (Unpin all UI).
  const pinnedCount = React.useMemo(() => {
    void renderVersion
    let c = 0
    for (const [, p] of positionsRef.current) if (p.pinned) c++
    return c
  }, [renderVersion, nodes])

  // Keep transformRef in sync with state (for use in event handlers).
  React.useEffect(() => {
    transformRef.current = transform
  }, [transform])

  // ─── Fit to graph ───
  // Computes the REAL bounding box of node positions (plus node radius +
  // label padding) and derives a scale that fits the whole graph inside the
  // visible container. The old fixed `scale = 1.5` pushed large graphs off
  // the viewport and left collapsed clusters microscopic.
  const fitToGraph = React.useCallback(
    (
      nodeList: GraphNodeView[],
      posMap: Map<string, PositionedNode>,
    ) => {
      if (nodeList.length === 0) {
        setTransform({ tx: 0, ty: 0, scale: 1 })
        return
      }
      // Get container dimensions with fallbacks.
      const cw = containerRef.current?.clientWidth || 800
      const ch = containerRef.current?.clientHeight || height || 600

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const nd of nodeList) {
        const p = posMap.get(nd.id)
        if (!p || !isFinite(p.x) || !isFinite(p.y)) continue
        const pad = radiusFor(nd.degree) + 14 // room for the node + its label
        if (p.x - pad < minX) minX = p.x - pad
        if (p.y - pad < minY) minY = p.y - pad
        if (p.x + pad > maxX) maxX = p.x + pad
        if (p.y + pad > maxY) maxY = p.y + pad
      }
      if (!isFinite(minX) || !isFinite(maxX)) {
        setTransform({ tx: cw / 2, ty: ch / 2, scale: 1 })
        return
      }
      const bw = Math.max(1, maxX - minX)
      const bh = Math.max(1, maxY - minY)
      // Fit inside the viewport with a 4% margin; clamp so the graph is
      // neither gigantic nor invisible.
      const fitScale = Math.min(cw / bw, ch / bh) * 0.96
      const scale = Math.max(0.15, Math.min(2.5, fitScale))
      setTransform({
        tx: cw / 2 - ((minX + maxX) / 2) * scale,
        ty: ch / 2 - ((minY + maxY) / 2) * scale,
        scale,
      })
    },
    [height],
  )

  // ─── Fetch graph data ───
  const fetchGraph = React.useCallback(
    async (override?: { limit?: number; includeContextual?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const effLimit = override?.limit ?? loadLimitOverride ?? 200
      const effCtx = override?.includeContextual ?? includeContextualNodes
      const res = await fetch(
        `/api/cases/${encodeURIComponent(caseId)}/graph?limit=${effLimit}${effCtx ? '&includeContextual=1' : ''}`,
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const fetchedNodes: GraphNodeView[] = data.nodes ?? []
      const rawFetchedEdges: GraphEdgeView[] = data.edges ?? []
      const pruned = pruneCoOccurredForDisplay(rawFetchedEdges)
      setDeclutteredHidden(pruned.hidden)
      const fetchedEdges = pruned.edges
      setNodes(fetchedNodes)
      setEdges(fetchedEdges)
      setMeta({
        totalEntities: data.meta?.totalEntities ?? fetchedNodes.length,
        totalRelationships:
          data.meta?.totalRelationships ?? fetchedEdges.length,
      })
      positionsRef.current = runForceLayout(fetchedNodes, fetchedEdges)
      bumpRender()
      setSelectedNodeId(null)
      setPathHighlight(null)
      setEntityTypeFilter(new Set())
      setRelTypeFilter(new Set())
      setSearch('')
      setHideIsolated(false)
      setSelectedEdgeId(null)
      setPlaybackT(null)
      setPlaying(false)
      setEgoIsolate(null)
      // Fit to graph — try multiple times to handle container not being
      // laid out yet. The last attempt (300ms) is a safety net.
      const doFit = () => fitToGraph(fetchedNodes, positionsRef.current)
      requestAnimationFrame(doFit)
      requestAnimationFrame(() => requestAnimationFrame(doFit))
      setTimeout(doFit, 100)
      setTimeout(doFit, 300)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load graph')
      setNodes([])
      setEdges([])
      setMeta(null)
    } finally {
      setLoading(false)
    }
  }, [caseId, bumpRender, fitToGraph, includeContextualNodes, loadLimitOverride])

  React.useEffect(() => {
    void fetchGraph()
  }, [fetchGraph])

  // ─── v3: auto-refresh when the automatic AI pipeline finishes scanning ───
  // EvidenceView dispatches 'rj:graph-updated' once the AI queue drains so
  // the graph immediately shows the new AI entities and story connections.
  useGraphRefresh(() => {
    void fetchGraph()
  })

  // ─── v3: AI link explanation — auto-load on edge selection ───
  // Clicking an edge asks the local AI WHY the two nodes are connected;
  // the answer is grounded in the relationship rationale + real document
  // excerpts and falls back to the deterministic sentence when offline.
  React.useEffect(() => {
    if (!selectedEdgeId) {
      setEdgeAi(null)
      setEdgeAiBusy(false)
      return
    }
    const edge = edges.find((e) => e.id === selectedEdgeId)
    if (!edge) {
      setEdgeAi(null)
      return
    }
    let cancelled = false
    setEdgeAiBusy(true)
    setEdgeAi(null)
    api
      .explainLink(caseId, edge.source, edge.target, edge.type)
      .then((res) => {
        if (!cancelled) setEdgeAi(res)
      })
      .catch(() => {
        if (!cancelled) setEdgeAi(null)
      })
      .finally(() => {
        if (!cancelled) setEdgeAiBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedEdgeId, caseId, edges])

  // ─── ResizeObserver: re-fit when container gets proper dimensions ───
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let firstResize = true
    const ro = new ResizeObserver(() => {
      // On first resize, the container gets its real dimensions — re-fit.
      // On subsequent resizes, only re-fit if the user hasn't manually
      // panned/zoomed (transform is still the initial state).
      if (firstResize && el.clientWidth > 0 && nodes.length > 0) {
        firstResize = false
        fitToGraph(nodes, positionsRef.current)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [nodes, fitToGraph])

  // ─── Re-run force layout (Layout button) ───
  const rerunLayout = React.useCallback(() => {
    positionsRef.current = runForceLayout(
      nodes,
      edges,
      undefined,
      positionsRef.current,
    )
    bumpRender()
    requestAnimationFrame(() => fitToGraph(nodes, positionsRef.current))
  }, [nodes, edges, bumpRender, fitToGraph])

  // ─── Reset view ───
  const resetView = React.useCallback(() => {
    // Reset to center the graph in the viewport.
    fitToGraph(nodes, positionsRef.current)
  }, [nodes, fitToGraph])

  // ─── Fit to current graph ───
  const fitCurrent = React.useCallback(() => {
    fitToGraph(nodes, positionsRef.current)
  }, [nodes, fitToGraph])

  // ─── screenToSvg helper ───
  const screenToSvg = React.useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (clientX - rect.left - t.tx) / t.scale,
      y: (clientY - rect.top - t.ty) / t.scale,
    }
  }, [])

  // ─── Wheel zoom (native non-passive listener so we can preventDefault) ───
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const t = transformRef.current
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      // Allow the full fit range (fit can legitimately choose < 0.8 for
      // large graphs) — the old 0.8 floor made zoom-out jump the graph.
      const newScale = Math.max(0.1, Math.min(4.0, t.scale * factor))
      // Keep the world point under the cursor stationary.
      const wx = (mx - t.tx) / t.scale
      const wy = (my - t.ty) / t.scale
      let ntx = mx - wx * newScale
      let nty = my - wy * newScale
      // Clamp pan so the graph can never be zoomed/pushed fully off-screen.
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of positionsRef.current.values()) {
        if (!isFinite(p.x) || !isFinite(p.y)) continue
        if (p.x - 24 < minX) minX = p.x - 24
        if (p.y - 24 < minY) minY = p.y - 24
        if (p.x + 24 > maxX) maxX = p.x + 24
        if (p.y + 24 > maxY) maxY = p.y + 24
      }
      if (isFinite(minX) && isFinite(maxX)) {
        ntx = Math.min(Math.max(ntx, 60 - maxX * newScale), rect.width - 60 - minX * newScale)
        nty = Math.min(Math.max(nty, 60 - maxY * newScale), rect.height - 60 - minY * newScale)
      }
      setTransform({
        tx: ntx,
        ty: nty,
        scale: newScale,
      })
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [])

  // ─── Background mouse down (start pan) ───
  const onSvgMouseDown = React.useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragStateRef.current = {
      mode: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
      moved: false,
    }
  }, [])

  // ─── Node mouse down (start drag) ───
  const onNodeMouseDown = React.useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      if (e.button !== 0) return
      e.stopPropagation()
      dragStateRef.current = {
        mode: 'node',
        nodeId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTx: 0,
        startTy: 0,
        moved: false,
      }
    },
    [],
  )

  // ─── Global mousemove + mouseup (pan & drag) ───
  // Computes the bounding box of all node positions (± margin) in svg space.
  const graphBounds = React.useCallback(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const nd of nodes) {
      const p = positionsRef.current.get(nd.id)
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue
      const m = radiusFor(nd.degree) + 16
      if (p.x - m < minX) minX = p.x - m
      if (p.y - m < minY) minY = p.y - m
      if (p.x + m > maxX) maxX = p.x + m
      if (p.y + m > maxY) maxY = p.y + m
    }
    if (!isFinite(minX) || !isFinite(maxX)) return null
    return { minX, minY, maxX, maxY }
  }, [nodes])

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const ds = dragStateRef.current
      if (!ds.mode) return
      const dx = e.clientX - ds.startClientX
      const dy = e.clientY - ds.startClientY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true

      if (ds.mode === 'pan') {
        const cw = containerRef.current?.clientWidth || 800
        const ch = containerRef.current?.clientHeight || height || 600
        const b = graphBounds()
        let ntx = ds.startTx + dx
        let nty = ds.startTy + dy
        if (b) {
          // Keep at least a 60px sliver of the graph inside the viewport —
          // the user can never lose the network off-screen.
          const s = transformRef.current.scale
          ntx = Math.min(Math.max(ntx, 60 - b.maxX * s), cw - 60 - b.minX * s)
          nty = Math.min(Math.max(nty, 60 - b.maxY * s), ch - 60 - b.minY * s)
        }
        setTransform((t) => ({
          ...t,
          tx: ntx,
          ty: nty,
        }))
      } else if (ds.mode === 'node' && ds.nodeId) {
        const { x, y } = screenToSvg(e.clientX, e.clientY)
        const p = positionsRef.current.get(ds.nodeId)
        if (p) {
          // Clamp the dragged node to the visible viewport so nodes can
          // never be dropped outside the black window.
          const cw = containerRef.current?.clientWidth || 800
          const ch = containerRef.current?.clientHeight || height || 600
          const t = transformRef.current
          const nd = nodes.find((q) => q.id === ds.nodeId)
          const m = radiusFor(nd?.degree) + 4
          const xMin = (0 - t.tx) / t.scale + m
          const xMax = (cw - t.tx) / t.scale - m
          const yMin = (0 - t.ty) / t.scale + m
          const yMax = (ch - t.ty) / t.scale - m
          p.x = Math.min(Math.max(x, xMin), Math.max(xMin, xMax))
          p.y = Math.min(Math.max(y, yMin), Math.max(yMin, yMax))
          p.vx = 0
          p.vy = 0
          p.pinned = true
          if (rafRef.current == null) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null
              bumpRender()
            })
          }
        }
      }
    }
    const onUp = () => {
      const ds = dragStateRef.current
      if (!ds.mode) return
      const wasMoved = ds.moved
      const wasPan = ds.mode === 'pan'
      const wasNode = ds.mode === 'node'
      const draggedId = ds.nodeId
      dragStateRef.current = {
        ...ds,
        mode: null,
        moved: false,
      }
      if (!wasMoved) {
        if (wasPan) {
          // Background click without drag — clear selection.
          setSelectedNodeId(null)
          setSelectedEdgeId(null)
        } else if (wasNode && draggedId) {
          // Explain Connection picking intercepts plain node clicks first;
          // fall back to normal selection when the router says unhandled.
          if (!nodeClickRouterRef.current(draggedId)) {
            // Node click without drag — select it.
            setSelectedNodeId(draggedId)
            setSelectedEdgeId(null)
          }
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [screenToSvg, bumpRender, graphBounds, nodes, height])

  // ─── Node hover handlers ───
  const onNodeMouseEnter = React.useCallback((nodeId: string) => {
    setHoveredNodeId(nodeId)
  }, [])
  const onNodeMouseLeave = React.useCallback(() => {
    setHoveredNodeId(null)
  }, [])

  // ─── Edge hover handlers ───
  const onEdgeMouseEnter = React.useCallback((edgeId: string) => {
    setHoveredEdgeId(edgeId)
  }, [])
  const onEdgeMouseLeave = React.useCallback(() => {
    setHoveredEdgeId(null)
  }, [])
  // Edge click — select it and open the provenance panel (resets any
  // previous inline deep-explain so the new edge starts clean).
  const onEdgeMouseDown = React.useCallback(
    (e: React.MouseEvent, edgeId: string) => {
      if (e.button !== 0) return
      e.stopPropagation()
      setSelectedEdgeId((prev) => {
        if (prev !== edgeId) {
          setEdgeExplain(null)
          setEdgeExplainError(null)
          setEdgeExplainBusy(false)
        }
        return edgeId
      })
      setSelectedNodeId(null)
    },
    [],
  )

  // Deep-explain for the clicked edge — same deterministic engine as the
  // Explain Connection mode, but sourced directly from the edge endpoints
  // and rendered inline inside the provenance panel (not persisted).
  const runEdgeExplain = React.useCallback(async () => {
    const edge = edges.find((e) => e.id === selectedEdgeId)
    if (!edge || edgeExplainBusy) return
    setEdgeExplainBusy(true)
    setEdgeExplainError(null)
    try {
      const res = await api.explainConnection(caseId, edge.source, edge.target, { persist: false })
      setEdgeExplain(res)
    } catch (err) {
      setEdgeExplain(null)
      setEdgeExplainError(err instanceof Error ? err.message : 'explain failed')
    } finally {
      setEdgeExplainBusy(false)
    }
  }, [caseId, edges, selectedEdgeId, edgeExplainBusy])

  // ─── v3 graph hygiene: purge legacy MECHANICAL content ───
  // Pre-v3 cases can still carry the old deterministic proximity mesh
  // (CO_OCCURRED hairballs) and orphan regex entities. v3 never creates
  // them; this one-click cleanup removes history. AI-authored edges are
  // never touched.
  const handlePurgeMechanical = React.useCallback(async () => {
    if (purgeBusy) return
    if (
      !confirm(
        'Purge legacy MECHANICAL graph content?\n\n' +
          '• Old proximity CO_OCCURRED links (the "row-wise" hairball mesh)\n' +
          '• Orphan entities with no evidence links and no relationships\n\n' +
          'AI-authored connections and their endpoints are NEVER touched.',
      )
    )
      return
    setPurgeBusy(true)
    try {
      const r = await api.purgeMechanicalLinks(caseId)
      await fetchGraph()
      notifyGraphUpdated({ reason: 'purge-mechanical' })
      toast({
        title: 'Legacy mechanical content purged',
        description: `${r.deletedEdges ?? 0} mechanical links and ${r.deletedOrphans ?? 0} orphan entities removed. Only AI-authored connections remain.`,
      })
    } catch (err) {
      toast({
        title: 'Purge failed',
        description: err instanceof Error ? err.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setPurgeBusy(false)
    }
  }, [caseId, fetchGraph, purgeBusy, toast])

  // ─── Temporal Network Playback ───
  // Sorted unique edge timestamps define the playback timeline.
  const playbackTimes = React.useMemo(() => {
    const ts = edges
      .map((e) => e.t ?? e.timestamp ?? e.createdAt)
      .filter((x): x is string => Boolean(x))
      .sort()
    return Array.from(new Set(ts))
  }, [edges])

  React.useEffect(() => {
    if (!playing || playbackTimes.length === 0) return
    const idx = playbackT ? playbackTimes.findIndex((t) => t >= playbackT) : -1
    const nextIdx = idx + 1
    if (nextIdx >= playbackTimes.length) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => {
      setPlaybackT(playbackTimes[nextIdx])
      bumpRender()
    }, 500)
    return () => clearTimeout(timer)
  }, [playing, playbackT, playbackTimes, bumpRender])

  const playbackIndex = playbackT
    ? playbackTimes.findIndex((t) => t >= playbackT)
    : -1

  // ─── Master adjacency map (over the FULL loaded graph, not filters) ───
  const masterAdjacency = React.useMemo(() => {
    const m = new Map<string, Set<string>>()
    const ensure = (id: string) => {
      if (!m.has(id)) m.set(id, new Set())
    }
    for (const n of nodes) ensure(n.id)
    for (const e of edges) {
      if (e.source === e.target) continue
      ensure(e.source)
      ensure(e.target)
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [nodes, edges])

  /** BFS neighborhood up to `depth` hops from root over the master graph. */
  const collectNeighborhood = React.useCallback(
    (rootId: string, depth: number): { nodeIds: Set<string>; edgeIds: Set<string> } => {
      const nodeIds = new Set<string>([rootId])
      let frontier = new Set<string>([rootId])
      for (let d = 0; d < depth; d++) {
        const next = new Set<string>()
        for (const id of frontier) {
          for (const nb of masterAdjacency.get(id) ?? []) {
            if (!nodeIds.has(nb)) {
              nodeIds.add(nb)
              next.add(nb)
            }
          }
        }
        frontier = next
        if (frontier.size === 0) break
      }
      const edgeIds = new Set<string>()
      for (const e of edges) {
        if (nodeIds.has(e.source) && nodeIds.has(e.target)) edgeIds.add(e.id)
      }
      return { nodeIds, edgeIds }
    },
    [masterAdjacency, edges],
  )

  // ─── Ego isolation (client-side view filter) ───
  const egoNeighborhood = React.useMemo(() => {
    if (!egoIsolate) return null
    return collectNeighborhood(egoIsolate.rootId, egoIsolate.depth)
  }, [egoIsolate, collectNeighborhood])
  const egoIds = React.useMemo(
    () => egoNeighborhood?.nodeIds ?? null,
    [egoNeighborhood],
  )

  // ─── Visible nodes / edges (filtering) ───
  const playbackFilteredEdges = React.useMemo(() => {
    if (!playbackT) return edges
    return edges.filter((e) => {
      const t = e.t ?? e.timestamp ?? e.createdAt
      return !t || t <= playbackT // edges with unknown time always show
    })
  }, [edges, playbackT])

  const visibleNodes = React.useMemo(() => {
    let result = nodes
    if (entityTypeFilter.size > 0) {
      result = result.filter((n) => entityTypeFilter.has(n.type))
    }
    if (hideIsolated) {
      result = result.filter((n) => (n.degree ?? 0) > 0)
    }
    if (egoIds) {
      result = result.filter((n) => egoIds.has(n.id))
    }
    if (playbackT) {
      // During playback a node is visible once at least one of its edges has appeared.
      const activeIds = new Set<string>()
      for (const e of playbackFilteredEdges) {
        activeIds.add(e.source)
        activeIds.add(e.target)
      }
      result = result.filter((n) => activeIds.has(n.id))
    }
    return result
  }, [nodes, entityTypeFilter, hideIsolated, egoIds, playbackT, playbackFilteredEdges])

  const visibleNodeIds = React.useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes],
  )

  const visibleEdges = React.useMemo(() => {
    let result = playbackFilteredEdges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    )
    if (relTypeFilter.size > 0) {
      result = result.filter((e) => relTypeFilter.has(e.type))
    }
    return result
  }, [playbackFilteredEdges, visibleNodeIds, relTypeFilter])

  // ─── Search match set (null = no search active) ───
  const searchLower = search.trim().toLowerCase()
  const matchedNodeIds = React.useMemo(() => {
    if (!searchLower) return null
    const s = new Set<string>()
    for (const n of visibleNodes) {
      const label = (n.label ?? '').toLowerCase()
      const value = (n.value ?? '').toLowerCase()
      const id = (n.id ?? '').toLowerCase()
      if (
        label.includes(searchLower) ||
        value.includes(searchLower) ||
        id.includes(searchLower)
      ) {
        s.add(n.id)
      }
    }
    return s
  }, [visibleNodes, searchLower])

  // ─── Focus highlight sets (when enabled + a node is selected) ───
  const focusSets = React.useMemo(() => {
    if (!focusEnabled || !selectedNodeId || !nodes.some((q) => q.id === selectedNodeId)) {
      return null
    }
    return collectNeighborhood(selectedNodeId, focusDepth)
  }, [focusEnabled, selectedNodeId, focusDepth, collectNeighborhood, nodes])

  // ─── Direct neighbors of the SELECTED node (always-on connection cue) ───
  // Computed over the VISIBLE edge list so filters are respected. Returns
  // null when nothing is selected so the memo comparator stays cheap.
  const selectedNeighborIds = React.useMemo(() => {
    if (!selectedNodeId) return null
    const s = new Set<string>()
    for (const e of visibleEdges) {
      if (e.source === selectedNodeId) s.add(e.target)
      else if (e.target === selectedNodeId) s.add(e.source)
    }
    return s.size > 0 ? s : null
  }, [selectedNodeId, visibleEdges])

  // ─── Selected node lookup ───
  const selectedNode = React.useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )
  const selectedEdge = React.useMemo(
    () => edges.find((e) => e.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  )
  const selectedPosition = React.useMemo(
    () => (selectedNodeId ? positionsRef.current.get(selectedNodeId) : undefined),
    [selectedNodeId, renderVersion],
  )

  // ─── Esc key clears selection / path / ego view / explain mode ───
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      setSelectedNodeId(null)
      setSelectedEdgeId(null)
      setPathHighlight(null)
      setShowPathPicker(false)
      setEgoIsolate(null)
      setExplainActive(false)
      explainActiveRef.current = false
      setExplainSrcId(null)
      explainSrcRef.current = null
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ─── Explain Connection engine call ───
  const runExplain = React.useCallback(
    async (srcId: string, dstId: string, persist = false) => {
      setExplainBusy(true)
      setExplainError(null)
      try {
        const res = await api.explainConnection(caseId, srcId, dstId, { persist })
        setExplainResult(res)
        // Light up all enumerated corridors using the existing path highlight.
        const pnodes = new Set<string>()
        const pedges = new Set<string>()
        const pairs = new Set(res.paths.flatMap((p) => p.nodes.slice(0, -1).map((n, i) => [n, p.nodes[i + 1]].sort().join('~'))))
        for (const p of res.paths) for (const n of p.nodes) pnodes.add(n)
        for (const e of edges) {
          if (pairs.has([e.source, e.target].sort().join('~'))) pedges.add(e.id)
        }
        setPathHighlight(pnodes.size > 0 ? { nodes: pnodes, edges: pedges } : null)
      } catch (err) {
        setExplainError(err instanceof Error ? err.message : 'explain-connection failed')
        setExplainResult(null)
      } finally {
        setExplainBusy(false)
      }
    },
    [caseId, edges],
  )

  /** Toolbar toggle: entering resets any prior pick/result. */
  const toggleExplainMode = React.useCallback(() => {
    setExplainActive((v) => {
      const next = !v
      explainActiveRef.current = next
      if (!next) {
        setExplainSrcId(null)
        explainSrcRef.current = null
      }
      return next
    })
    if (!explainActive) {
      setExplainResult(null)
      setExplainError(null)
      setPathHighlight(null)
      setSelectedEdgeId(null)
    }
  }, [explainActive])

  /** Node click router while Explain Connection picking is armed. */
  const handleExplainPick = React.useCallback(
    (nodeId: string): boolean => {
      if (!explainActiveRef.current) return false
      const src = explainSrcRef.current
      if (!src || src === nodeId) {
        if (src === nodeId) {
          setExplainSrcId(null)
          explainSrcRef.current = null
          setSelectedNodeId(null)
          return true
        }
        setExplainSrcId(nodeId)
        explainSrcRef.current = nodeId
        // NO side panel here — opening the details drawer would cover parts of
        // the canvas and make picking B frustrating. The toolbar chip + ring
        // on the picked node is the only feedback.
        setSelectedNodeId(nodeId)
        return true
      }
      const dst = nodeId
      setExplainSrcId(null)
      explainSrcRef.current = null
      // Drop any transient selection so the right-side drawer never fights
      // with the result panel.
      setSelectedNodeId(null)
      void runExplain(src, dst)
      return true
    },
    [runExplain],
  )
  /** Latest pick router for long-lived drag/click closures (avoids stale deps). */
  const nodeClickRouterRef = React.useRef<(nodeId: string) => boolean>(() => false)
  React.useEffect(() => {
    nodeClickRouterRef.current = handleExplainPick
  }, [handleExplainPick])


  // ─── Camera helpers ───
  /** Pan the camera so `nodeId` sits centered at the current zoom. */
  const centerCameraOn = React.useCallback(
    (nodeId: string) => {
      const p = positionsRef.current.get(nodeId)
      if (!p) return
      const cw = containerRef.current?.clientWidth || 800
      const ch = containerRef.current?.clientHeight || height || 600
      const t = transformRef.current
      const scale = Math.max(t.scale, 1.1)
      let ntx = cw / 2 - p.x * scale
      let nty = ch / 2 - p.y * scale
      const b = graphBounds()
      if (b) {
        ntx = Math.min(Math.max(ntx, 60 - b.maxX * scale), cw - 60 - b.minX * scale)
        nty = Math.min(Math.max(nty, 60 - b.maxY * scale), ch - 60 - b.minY * scale)
      }
      setTransform({ tx: ntx, ty: nty, scale })
    },
    [height, graphBounds],
  )

  const selectAndCenter = React.useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId)
      setSelectedEdgeId(null)
      centerCameraOn(nodeId)
    },
    [centerCameraOn],
  )

  // ─── Top hub list (degree-ranked quick-jump) ───
  const topHubs = React.useMemo(() => {
    return [...nodes]
      .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
      .slice(0, 5)
      .filter((n) => (n.degree ?? 0) > 0)
  }, [nodes])

  // ─── Action handlers (Expand / Ego / Shortest-path) ───
  const applyExpansion = React.useCallback(
    async (
      endpoint: string,
      body: Record<string, unknown>,
      busyLabel: string,
    ) => {
      if (!selectedNodeId) return
      setBusy(busyLabel)
      setError(null)
      try {
        const res = await fetch(
          `/api/cases/${encodeURIComponent(caseId)}/${endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b?.error || `HTTP ${res.status}`)
        }
        const data = await res.json()
        const subNodes: GraphNodeView[] = data.subgraph?.nodes ?? data.nodes ?? []
        const subEdges: GraphEdgeView[] = data.subgraph?.edges ?? data.edges ?? []
        const existingNodeIds = new Set(nodes.map((n) => n.id))
        const newNodes = subNodes.filter((n) => !existingNodeIds.has(n.id))
        const existingEdgeIds = new Set(edges.map((e) => e.id))
        const newEdges = subEdges.filter((e) => !existingEdgeIds.has(e.id))
        if (newNodes.length > 0 || newEdges.length > 0) {
          const mergedNodes = [...nodes, ...newNodes]
          const mergedEdges = [...edges, ...newEdges]
          setNodes(mergedNodes)
          setEdges(mergedEdges)
          positionsRef.current = runForceLayout(
            mergedNodes,
            mergedEdges,
            undefined,
            positionsRef.current,
          )
          bumpRender()
          requestAnimationFrame(() =>
            fitToGraph(mergedNodes, positionsRef.current),
          )
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operation failed')
      } finally {
        setBusy(null)
      }
    },
    [caseId, nodes, edges, selectedNodeId, bumpRender, fitToGraph],
  )

  const expandNeighbors = React.useCallback(() => {
    if (!selectedNodeId) return
    void applyExpansion(
      'graph/khop',
      { entityId: selectedNodeId, k: 1 },
      'Expanding neighbors…',
    )
  }, [selectedNodeId, applyExpansion])

  const expandEgo = React.useCallback(() => {
    if (!selectedNodeId) return
    void applyExpansion(
      'graph/ego',
      { entityId: selectedNodeId, radius: 2 },
      'Loading ego network…',
    )
  }, [selectedNodeId, applyExpansion])

  const computeShortestPath = React.useCallback(
    async (dstId: string) => {
      if (!selectedNodeId) return
      setBusy('Computing shortest path…')
      setError(null)
      setPathHighlight(null)
      setShowPathPicker(false)
      try {
        const res = await fetch(
          `/api/cases/${encodeURIComponent(caseId)}/graph/shortest-path`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ srcId: selectedNodeId, dstId }),
          },
        )
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b?.error || `HTTP ${res.status}`)
        }
        const data = await res.json()
        const path: string[] | null = data.path
        if (path && path.length > 0) {
          const nodeSet = new Set(path)
          const matchedEdgeIds = new Set<string>()
          for (let i = 0; i < path.length - 1; i++) {
            const a = path[i]
            const b = path[i + 1]
            for (const e of edges) {
              if (
                (e.source === a && e.target === b) ||
                (e.source === b && e.target === a)
              ) {
                matchedEdgeIds.add(e.id)
              }
            }
          }
          // Also accept any edges the API directly returned.
          const apiEdges: GraphEdgeView[] = data.edges ?? []
          for (const e of apiEdges) matchedEdgeIds.add(e.id)
          setPathHighlight({ nodes: nodeSet, edges: matchedEdgeIds })
        } else {
          setError('No path found between these entities')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Path computation failed')
      } finally {
        setBusy(null)
      }
    },
    [caseId, selectedNodeId, edges],
  )

  // ─── Type counts for filter chips & legend ───
  const entityTypes = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [nodes])

  const relTypes = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of edges) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [edges])

  const toggleEntityTypeFilter = React.useCallback((t: string) => {
    setEntityTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }, [])

  const toggleRelTypeFilter = React.useCallback((t: string) => {
    setRelTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }, [])

  // ─── Hover tooltip data ───
  const hoveredNode = React.useMemo(
    () => (hoveredNodeId ? nodes.find((n) => n.id === hoveredNodeId) : null),
    [hoveredNodeId, nodes],
  )
  const hoveredPos = React.useMemo(() => {
    if (!hoveredNodeId) return null
    const p = positionsRef.current.get(hoveredNodeId)
    if (!p) return null
    return {
      x: p.x * transform.scale + transform.tx,
      y: p.y * transform.scale + transform.ty,
    }
  }, [hoveredNodeId, transform, renderVersion])

  // ─── Path picker candidate list ───
  const pathPickerCandidates = React.useMemo(() => {
    const q = pathPickerQuery.trim().toLowerCase()
    const out: GraphNodeView[] = []
    for (const n of nodes) {
      if (n.id === selectedNodeId) continue
      if (
        q &&
        !(
          (n.label ?? '').toLowerCase().includes(q) ||
          (n.value ?? '').toLowerCase().includes(q) ||
          (n.id ?? '').toLowerCase().includes(q)
        )
      )
        continue
      out.push(n)
      if (out.length >= 30) break
    }
    return out
  }, [nodes, pathPickerQuery, selectedNodeId])

  // ─── Render ───
  const positions = positionsRef.current
  const isEmpty = nodes.length === 0 && !loading && !error
  const showingPartial =
    meta && meta.totalEntities > nodes.length

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-xl border bg-card"
      style={{ height }}
    >
      {/* Top-left toolbar — wrapper is click-transparent so it never blocks
          node drags underneath; only the visible cards capture events.
          Decluttered (v3.2): five visible controls (Reset · Fit · Refresh ·
          Explain · More); secondary actions moved into the More dropdown. */}
      <div className="pointer-events-none absolute left-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 [&>*]:pointer-events-auto">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={resetView}
            title="Reset view"
            aria-label="Reset view"
            disabled={loading}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={fitCurrent}
            title="Fit to graph"
            aria-label="Fit to graph"
            disabled={loading || nodes.length === 0}
          >
            <Maximize2 className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => void fetchGraph()}
            title="Refresh graph data"
            aria-label="Refresh graph data"
            disabled={loading}
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <div className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          <Button
            size="sm"
            variant={explainActive ? 'default' : 'outline'}
            className="h-8"
            onClick={toggleExplainMode}
            disabled={explainBusy}
            title="Explain Connection — pick two nodes to see all graph paths between them with evidence sufficiency, contradictions and an Evidence Contract"
          >
            <Waypoints className="size-3.5" />
            {explainBusy ? 'Explaining…' : 'Explain'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                title="More controls"
                aria-label="More graph controls"
                aria-haspopup="menu"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem
                onClick={rerunLayout}
                disabled={loading || nodes.length === 0}
              >
                <Network className="mr-2 size-3.5" />
                Re-run force layout
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void handlePurgeMechanical()}
                disabled={purgeBusy || loading}
                title="Graph hygiene — purge legacy MECHANICAL links (pre-v3 proximity mesh + orphan entities). AI-authored connections are never touched."
              >
                <Eraser className={`mr-2 size-3.5 ${purgeBusy ? 'animate-pulse' : ''}`} />
                Clean legacy links…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setHideIsolated((v) => !v)}>
                {hideIsolated ? (
                  <Eye className="mr-2 size-3.5" />
                ) : (
                  <EyeOff className="mr-2 size-3.5" />
                )}
                {hideIsolated ? 'Show isolated nodes' : 'Hide isolated nodes'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowHeatmap((v) => !v)}>
                <Flame className="mr-2 size-3.5" />
                {showHeatmap ? 'Disable evidence heatmap' : 'Evidence heatmap'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFocusEnabled((v) => !v)}>
                <Crosshair className="mr-2 size-3.5" />
                {focusEnabled ? 'Disable focus mode' : 'Focus mode (select a node)'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  const next = !includeContextualNodes
                  setIncludeContextualNodes(next)
                  void fetchGraph({ includeContextual: next })
                }}
                title={includeContextualNodes
                  ? 'Hide date / amount contextual clutter again'
                  : 'Also load date/amount nodes extracted from evidence'}
              >
                <Layers3 className="mr-2 size-3.5" />
                {includeContextualNodes ? 'Hide contextual nodes' : 'Include date / amount nodes'}
              </DropdownMenuItem>
              {meta && meta.totalEntities > nodes.length && (
                <DropdownMenuItem
                  disabled={loading}
                  onClick={() => {
                    const target = Math.min(meta.totalEntities, 2000)
                    setLoadLimitOverride(target)
                    void fetchGraph({ limit: target })
                  }}
                  title={`Currently showing ${nodes.length} of ${meta.totalEntities} case entities — load every one of them`}
                >
                  <Layers3 className="mr-2 size-3.5" />
                  Load all {meta.totalEntities} entities
                </DropdownMenuItem>
              )}
              {pinnedCount > 0 && (
                <DropdownMenuItem
                  onClick={() => {
                    for (const [, p] of positionsRef.current) {
                      if (!p.pinned) continue
                      p.pinned = false
                      p.vx = 0
                      p.vy = 0
                    }
                    bumpRender()
                  }}
                  title="Release all pinned/dragged nodes so layout can move them again"
                >
                  <PinOff className="mr-2 size-3.5" />
                  Unpin all ({pinnedCount})
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Explain Connection pick-state chip */}
        {explainActive && (
          <div className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
            {explainSrcId ? (
              <>
                <span className="font-mono">A</span>
                <ChevronRight className="size-3" />
                <span>B — click the second node</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="ml-1 size-5"
                  onClick={() => {
                    setExplainSrcId(null)
                    explainSrcRef.current = null
                  }}
                  title="Clear first pick"
                >
                  <X className="size-3" />
                </Button>
              </>
            ) : (
              <span>Pick node A…</span>
            )}
          </div>
        )}

        {/* Focus neighborhood-depth selector */}
        {focusEnabled && (
          <div
            className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
            title="Neighborhood depth for focus highlighting"
          >
            {[1, 2, 3].map((d) => (
              <button
                key={`hop-${d}`}
                type="button"
                onClick={() => setFocusDepth(d as 1 | 2 | 3)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                  focusDepth === d
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {d}-hop
              </button>
            ))}
          </div>
        )}

        {/* ── Merged control panel: search + type/relationship filters +
              legend + temporal playback, folded into accordions so the left
              overlay reads as ONE compact panel instead of a stack of walls.
              The node-type list doubles as the color legend (dot) and filter
              (checkbox) with a live count badge. ── */}
        <div className="w-[248px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border bg-background/95 text-xs shadow-sm backdrop-blur">
          <Accordion type="multiple" value={panelOpen} onValueChange={setPanelOpen}>
            <AccordionItem value="filters" className="border-b">
              <AccordionTrigger className="gap-1.5 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:no-underline [&_svg]:size-3.5 [&_svg]:translate-y-0">
                <Search className="size-3.5 shrink-0" aria-hidden />
                Search &amp; Filters
                {entityTypeFilter.size > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-auto mr-1 h-4 px-1 font-mono text-[9px] normal-case"
                  >
                    {entityTypeFilter.size} on
                  </Badge>
                )}
              </AccordionTrigger>
              <AccordionContent className="px-2.5 pb-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="Dim non-matching nodes…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-7 text-xs"
                    aria-label="Search nodes by label or value"
                  />
                </div>
                {entityTypes.length > 0 && (
                  <div className="mt-2 max-h-52 space-y-0.5 overflow-y-auto pr-0.5">
                    {entityTypes.map(([t, count]) => {
                      const active = entityTypeFilter.has(t)
                      const color = colorFor(t)
                      return (
                        <label
                          key={`ef-${t}`}
                          title={
                            active
                              ? `Showing only ${t} — click to show all types again`
                              : `Click to filter to only ${t}`
                          }
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent',
                            active && 'bg-accent',
                          )}
                        >
                          <Checkbox
                            checked={active}
                            onCheckedChange={() => toggleEntityTypeFilter(t)}
                            className="size-3.5"
                          />
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <span className="flex-1 truncate capitalize">{t}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {count}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
                {entityTypeFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setEntityTypeFilter(new Set())}
                    className="mt-1.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Clear type filter
                  </button>
                )}
              </AccordionContent>
            </AccordionItem>

            {relTypes.length > 0 && (
              <AccordionItem value="rels" className="border-b">
                <AccordionTrigger className="gap-1.5 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:no-underline [&_svg]:size-3.5 [&_svg]:translate-y-0">
                  <GitFork className="size-3.5 shrink-0" aria-hidden />
                  Relationships
                  {relTypeFilter.size > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-auto mr-1 h-4 px-1 font-mono text-[9px] normal-case"
                    >
                      {relTypeFilter.size} on
                    </Badge>
                  )}
                </AccordionTrigger>
                <AccordionContent className="px-2.5 pb-2">
                  <div className="max-h-44 space-y-0.5 overflow-y-auto pr-0.5">
                    {relTypes.map(([t, count]) => {
                      const active = relTypeFilter.has(t)
                      return (
                        <label
                          key={`rf-${t}`}
                          title={
                            active
                              ? `Showing only ${t} — click to show all relationships again`
                              : `Click to filter to only ${t}`
                          }
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent',
                            active && 'bg-accent',
                          )}
                        >
                          <Checkbox
                            checked={active}
                            onCheckedChange={() => toggleRelTypeFilter(t)}
                            className="size-3.5"
                          />
                          <span className="flex-1 truncate">
                            {t.replace(/_/g, ' ').toLowerCase()}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {count}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  {relTypeFilter.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setRelTypeFilter(new Set())}
                      className="mt-1.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Clear relationship filter
                    </button>
                  )}
                </AccordionContent>
              </AccordionItem>
            )}

            {playbackTimes.length > 1 && (
              <AccordionItem value="playback" className="border-b">
                <AccordionTrigger className="gap-1.5 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:no-underline [&_svg]:size-3.5 [&_svg]:translate-y-0">
                  <Play className="size-3.5 shrink-0" aria-hidden />
                  Temporal Playback
                  {playbackT && (
                    <Badge
                      variant="outline"
                      className="ml-auto mr-1 h-4 px-1 font-mono text-[9px] normal-case"
                    >
                      {new Date(playbackT).toLocaleDateString('en-IN', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </Badge>
                  )}
                </AccordionTrigger>
                <AccordionContent className="px-2.5 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={playing ? 'default' : 'outline'}
                      className="h-7"
                      onClick={() => {
                        if (playbackT == null) {
                          // Start from the beginning.
                          setPlaybackT(playbackTimes[0])
                          setPlaying(true)
                          return
                        }
                        setPlaying((v) => !v)
                      }}
                      title="Replay how the network formed over time"
                      disabled={loading}
                    >
                      {playing ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {playing ? 'Pause' : 'Replay'}
                    </Button>
                    {playbackT && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={() => {
                          setPlaybackT(null)
                          setPlaying(false)
                        }}
                        title="Show full graph (all times)"
                      >
                        <X className="size-3.5" />
                        Full graph
                      </Button>
                    )}
                    <Badge
                      variant="outline"
                      className="ml-auto shrink-0 font-mono text-[9px]"
                    >
                      {playbackT
                        ? `step ${playbackIndex + 1}/${playbackTimes.length}`
                        : `${playbackTimes.length} steps`}
                    </Badge>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, playbackTimes.length - 1)}
                    value={playbackIndex >= 0 ? playbackIndex : playbackTimes.length - 1}
                    onChange={(e) => {
                      setPlaying(false)
                      const idx = parseInt(e.target.value, 10)
                      setPlaybackT(idx >= playbackTimes.length - 1 ? null : playbackTimes[idx])
                    }}
                    className="mt-1.5 w-full accent-[#ef4444]"
                    title="Scrub through network formation time"
                    aria-label="Scrub through network formation time"
                  />
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {playbackT
                      ? new Date(playbackT).toLocaleDateString('en-IN', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })
                      : 'All time — replay to watch the network form'}
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}

            <AccordionItem value="legend">
              <AccordionTrigger className="gap-1.5 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:no-underline [&_svg]:size-3.5 [&_svg]:translate-y-0">
                <Crown className="size-3.5 shrink-0" aria-hidden />
                Legend &amp; Hubs
              </AccordionTrigger>
              <AccordionContent className="px-2.5 pb-2">
                {showHeatmap ? (
                  <div className="flex flex-col gap-1">
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Evidence heatmap
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: '#10b981' }} />
                      Corroborated (2+ files)
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: '#84cc16' }} />
                      Two sources
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
                      Single source
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: '#ef4444' }} />
                      Speculative
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Node colors
                    </div>
                    <div className="text-[10px] leading-snug text-muted-foreground">
                      Entity-type colors are shown next to each type in
                      Search &amp; Filters — the list doubles as the legend.
                    </div>
                  </div>
                )}
                <div className="mt-1.5 border-t pt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  Edge states: <span style={{ color: '#10b981' }}>■</span> corroborated ·{' '}
                  <span style={{ color: '#0ea5e9' }}>■</span> observed ·{' '}
                  <span style={{ color: '#a855f7' }}>■</span> inferred ·{' '}
                  <span style={{ color: '#ef4444' }}>■</span> uncertain
                </div>
                {topHubs.length > 0 && (
                  <div className="mt-1.5 border-t pt-1.5">
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Crown className="size-3" />
                      Top hubs · click to jump
                    </div>
                    <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                      {topHubs.map((h) => (
                        <button
                          key={`hub-${h.id}`}
                          type="button"
                          onClick={() => selectAndCenter(h.id)}
                          className={cn(
                            'flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-accent',
                            h.id === selectedNodeId && 'bg-accent',
                          )}
                          title={`Center camera on ${h.label || h.value || h.id}`}
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: colorFor(h.type) }}
                          />
                          <span className="flex-1 truncate">{truncate(h.label || h.value || h.id, 16)}</span>
                          <span className="font-mono text-muted-foreground">{h.degree ?? 0}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* Ego view indicator chip */}
        {egoIsolate && (
          <div className="flex items-center gap-1.5 rounded-lg border border-sky-800/50 bg-sky-950/40 px-2 py-1 shadow-sm backdrop-blur">
            <Crosshair className="size-3 text-sky-300" />
            <span className="max-w-[220px] truncate text-[11px] text-sky-100">
              Ego view ·{' '}
              {nodes.find((n) => n.id === egoIsolate.rootId)?.label ||
                nodes.find((n) => n.id === egoIsolate.rootId)?.value ||
                'node'}{' '}
              ({egoIsolate.depth}-hop, {egoIds?.size ?? 0} nodes)
            </span>
            <button
              type="button"
              className="ml-auto rounded px-1 text-sky-300 hover:text-sky-100"
              onClick={() => setEgoIsolate(null)}
              title="Exit ego view (Esc)"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* Top-right: count badges (click-transparent wrapper) */}
      <div className="pointer-events-none absolute right-3 top-3 z-30 flex flex-col items-end gap-1.5 [&>*]:pointer-events-auto">
        {meta && (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">
              {nodes.length} nodes · {edges.length} edges
            </Badge>
            {showingPartial && (
              <Badge
                variant="outline"
                className="font-mono text-amber-700 dark:text-amber-400"
              >
                Showing {nodes.length} of {meta.totalEntities}
              </Badge>
            )}
            {declutteredHidden > 0 && (
              <Badge
                variant="outline"
                className="font-mono text-muted-foreground"
                title={`Display decluttering hid ${declutteredHidden} low-weight co-occurrence links so the structure stays readable. All typed edges (money, identifiers) are always shown.`}
              >
                −{declutteredHidden} clutter links
              </Badge>
            )}
          </div>
        )}
        {transform.scale !== 1 && (
          <Badge variant="outline" className="font-mono text-xs">
            {Math.round(transform.scale * 100)}%
          </Badge>
        )}
      </div>

      {/* SVG canvas */}
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        className="block touch-none select-none overflow-hidden"
        style={{ overflow: 'hidden' }}
        onMouseDown={onSvgMouseDown}
      >
        <defs>
          <marker
            id="rj-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#14b8a6" />
          </marker>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="transparent" />
        <g
          transform={`translate(${transform.tx},${transform.ty}) scale(${transform.scale})`}
        >
          {nodes.length > 0 && (
            <>
              <GraphContentMemo
                nodes={visibleNodes}
                edges={visibleEdges}
                positions={positions}
                positionVersion={renderVersion}
                hoveredNodeId={hoveredNodeId}
                hoveredEdgeId={hoveredEdgeId}
                pathNodes={pathHighlight?.nodes ?? null}
                pathEdges={pathHighlight?.edges ?? null}
                matchedNodeIds={matchedNodeIds}
                showHeatmap={showHeatmap}
                selectedEdgeId={selectedEdgeId}
                focusNodeIds={focusSets?.nodeIds ?? null}
                focusEdgeIds={focusSets?.edgeIds ?? null}
                selectedNeighborIds={selectedNeighborIds}
                selectedNodeIdForLinks={selectedNodeId}
                onNodeMouseDown={onNodeMouseDown}
                onNodeMouseEnter={onNodeMouseEnter}
                onNodeMouseLeave={onNodeMouseLeave}
                onEdgeMouseEnter={onEdgeMouseEnter}
                onEdgeMouseLeave={onEdgeMouseLeave}
                onEdgeMouseDown={onEdgeMouseDown}
              />
              <SelectionOverlay
                node={selectedNode}
                position={selectedPosition}
                positionVersion={renderVersion}
              />
            </>
          )}
        </g>
      </svg>

      {/* Hover tooltip */}
      {hoveredNode && hoveredPos && (
        <div
          className="pointer-events-none absolute z-40 max-w-xs rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={{
            left: hoveredPos.x + 14,
            top: hoveredPos.y + 14,
          }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: colorFor(hoveredNode.type) }}
            />
            <span className="font-medium capitalize">{hoveredNode.type}</span>
            <Badge variant="secondary" className="ml-1 font-mono text-[10px]">
              deg {hoveredNode.degree ?? 0}
            </Badge>
            {hoveredNode.tableIds && hoveredNode.tableIds.length > 0 && (
              <Badge variant="outline" className="font-mono text-[10px] text-amber-500">
                {hoveredNode.tableIds[0]}
                {hoveredNode.tableIds.length > 1 ? ` +${hoveredNode.tableIds.length - 1}` : ''}
              </Badge>
            )}
          </div>
          <div className="mt-1 break-all text-muted-foreground">
            {hoveredNode.value || hoveredNode.label || hoveredNode.id}
          </div>
        </div>
      )}

      {/* Edge provenance panel (bottom-right floating card, scrollable so
          long AI explanations can never push it off-screen) */}
      {selectedEdge && (
        <div className="absolute bottom-3 right-3 z-40 flex max-h-[calc(100%-1.5rem)] w-[340px] max-w-[92%] flex-col rounded-lg border bg-card/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between gap-2 p-3 pb-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs font-semibold">
                {selectedEdge.type.replace(/_/g, ' ')}
              </span>
              {selectedEdge.verState && (
                <span
                  className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
                  style={{
                    backgroundColor: `${VERSTATE_COLOR[selectedEdge.verState]}22`,
                    color: VERSTATE_COLOR[selectedEdge.verState],
                  }}
                  title={VERSTATE_LABEL[selectedEdge.verState]}
                >
                  {selectedEdge.verState}
                </span>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              onClick={() => setSelectedEdgeId(null)}
              title="Close provenance"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 px-3 pb-3 text-[11px]">
            <div className="break-all">
              <span className="text-muted-foreground">Link: </span>
              <span className="font-mono">
                {nodes.find((n) => n.id === selectedEdge.source)?.value ?? selectedEdge.source}
                {' → '}
                {nodes.find((n) => n.id === selectedEdge.target)?.value ?? selectedEdge.target}
              </span>
            </div>
            <div className="flex gap-3">
              <span><span className="text-muted-foreground">Weight:</span> {selectedEdge.weight}</span>
              {selectedEdge.amount != null && (
                <span><span className="text-muted-foreground">Amount:</span> ₹{selectedEdge.amount.toLocaleString('en-IN')}</span>
              )}
              {selectedEdge.confidence != null && (
                <span><span className="text-muted-foreground">Conf:</span> {selectedEdge.confidence.toFixed(2)}</span>
              )}
            </div>
            <Separator className="my-1.5" />
            {/* WHY CONNECTED (v3) — AI-authored explanation, deterministic fallback */}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Why are these connected?
            </div>
            {edgeAiBusy ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                AI is reading the evidence…
              </div>
            ) : edgeAi?.explanation ? (
              <div className="space-y-1">
                <div className="break-words leading-snug text-foreground/90">{edgeAi.explanation}</div>
                <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-crimson-300">
                  <Sparkles className="size-2.5 shrink-0" />
                  AI explanation{edgeAi.model ? ` · ${edgeAi.model}` : ''}
                </div>
              </div>
            ) : edgeAi && !edgeAi.aiAvailable ? (
              <div className="space-y-1">
                <div className="break-words leading-snug text-foreground/90">
                  {edgeAi.heuristicWhy || selectedEdge.why}
                </div>
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                  AI offline — heuristic explanation shown
                </div>
              </div>
            ) : selectedEdge.why ? (
              <div className="break-words leading-snug text-foreground/90">{selectedEdge.why}</div>
            ) : (
              <div className="text-muted-foreground">
                A {selectedEdge.type.replace(/_/g, ' ').toLowerCase()} link between the two.
              </div>
            )}
            {selectedEdge.rationale && (
              <div className="break-words rounded border-l-2 border-primary/40 bg-muted/30 px-2 py-1 italic leading-snug text-muted-foreground">
                “{selectedEdge.rationale}”
              </div>
            )}
            {typeof selectedEdge.sharedEvidence === 'number' && selectedEdge.sharedEvidence > 0 && (
              <div className="text-muted-foreground">
                <FileSearch className="mr-1 inline size-3 text-crimson-400" />
                {selectedEdge.sharedEvidence} evidence file{selectedEdge.sharedEvidence > 1 ? 's' : ''} mention both endpoints.
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-1 h-7 w-full text-[11px]"
              disabled={edgeExplainBusy}
              onClick={runEdgeExplain}
            >
              <Waypoints className="mr-1.5 size-3" />
              {edgeExplainBusy ? 'Analyzing…' : 'Explain connection deeper'}
            </Button>
            {edgeExplainError && (
              <div className="rounded bg-rose-500/10 px-2 py-1 text-[10px] text-rose-400">
                {edgeExplainError}
              </div>
            )}
            {edgeExplain && (
              <div className="space-y-1 rounded-md border bg-muted/20 p-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="shrink-0">Deep explanation</span>
                  <span
                    className={cn(
                      'rounded px-1 py-0.5 text-[9px] font-bold uppercase',
                      edgeExplain.contract.status === 'corroborated'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : edgeExplain.contract.status === 'partial'
                          ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-rose-500/15 text-rose-400',
                    )}
                  >
                    {edgeExplain.conclusion}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
                  <span>Sources: <b className="text-foreground">{edgeExplain.contract.independent_sources}</b></span>
                  <span>Paths: <b className="text-foreground">{edgeExplain.paths.length}</b></span>
                  <span>Sufficiency: <b className="text-foreground">{edgeExplain.sufficiency.score}%</b></span>
                </div>
                {edgeExplain.paths[0] && (
                  <div className="font-mono text-[10px] leading-snug text-muted-foreground">
                    {edgeExplain.paths[0].labels.join(' → ')}
                  </div>
                )}
              </div>
            )}
            <Separator className="my-1.5" />
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Evidence provenance
            </div>
            {selectedEdge.evidenceRef || selectedEdge.evidenceId ? (
              <>
                <div className="truncate" title={selectedEdge.evidenceRef}>
                  <FileSearch className="mr-1 inline size-3 text-crimson-400" />
                  <span className="font-mono">{selectedEdge.evidenceRef ?? selectedEdge.evidenceId}</span>
                  {selectedEdge.evidenceClassification && (
                    <span className="ml-1.5 rounded bg-muted/40 px-1 py-0.5 text-[9px] uppercase">
                      {selectedEdge.evidenceClassification}
                    </span>
                  )}
                </div>
                {selectedEdge.locator && (
                  <div className="text-muted-foreground">
                    Locator: <span className="font-mono">{selectedEdge.locator}</span>
                  </div>
                )}
                <div className="text-muted-foreground">
                  Extracted via: <span className="font-mono">{selectedEdge.extractionMethod ?? 'unknown'}</span>
                  {selectedEdge.provenance ? ` · ${selectedEdge.provenance}` : ''}
                </div>
                {onOpenEvidence && selectedEdge.evidenceId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1.5 h-7 w-full text-[11px]"
                    onClick={() => onOpenEvidence(selectedEdge.evidenceId!)}
                  >
                    <FileSearch className="mr-1.5 size-3" />
                    Open source evidence
                  </Button>
                )}
              </>
            ) : (
              <div className="text-muted-foreground">
                No evidence reference recorded for this relationship (legacy row created before provenance tracking).
              </div>
            )}
            {/* v3.5 — the complete verbatim source rows (table exports) */}
            {selectedEdge.rows && selectedEdge.rows.length > 0 && (
              <EdgeRowsSection key={selectedEdge.id} rows={selectedEdge.rows} />
            )}
          </div>
          </ScrollArea>
        </div>
      )}

      {/* Explain Connection result panel (left, floating) */}
      {explainResult && (
        <div className="absolute bottom-3 left-3 z-40 flex max-h-[calc(100%-1.5rem)] w-[380px] max-w-[94%] flex-col rounded-lg border bg-card/97 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between gap-2 border-b p-3 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <Waypoints className="size-4 shrink-0 text-primary" />
              <span className="text-xs font-semibold">Explain Connection</span>
              <span
                className={cn(
                  'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                  explainResult.contract.status === 'corroborated'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : explainResult.contract.status === 'partial'
                      ? 'bg-amber-500/15 text-amber-400'
                      : 'bg-rose-500/15 text-rose-400',
                )}
              >
                {explainResult.conclusion}
              </span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              onClick={() => {
                setExplainResult(null)
                setPathHighlight(null)
              }}
              title="Close explanation"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-3">
              {/* Sufficiency meter */}
              <div className="rounded-md border bg-muted/20 p-2.5">
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                    Evidence sufficiency
                  </span>
                  <span className="font-mono font-bold">
                    {explainResult.sufficiency.score}% · {explainResult.sufficiency.band}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      explainResult.sufficiency.score >= 75 ? 'bg-emerald-500'
                        : explainResult.sufficiency.score >= 50 ? 'bg-sky-500'
                        : explainResult.sufficiency.score >= 25 ? 'bg-amber-500'
                        : 'bg-rose-500',
                    )}
                    style={{ width: `${Math.max(2, explainResult.sufficiency.score)}%` }}
                  />
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5 text-[10px] text-muted-foreground">
                  <span>Sources: <b className="text-foreground">{explainResult.contract.independent_sources}</b></span>
                  <span>Paths: <b className="text-foreground">{explainResult.paths.length}</b></span>
                  <span>
                    LLM conf: <b className="text-foreground">{explainResult.contract.llm_confidence != null ? `${Math.round(explainResult.contract.llm_confidence * 100)}%` : 'n/a'}</b>
                  </span>
                </div>
                {explainResult.sufficiency.reasons.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {explainResult.sufficiency.reasons.slice(0, 5).map((r, i) => (
                      <li key={i} className="text-[10px] text-muted-foreground">• {r}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Paths as vertical flow diagrams */}
              {explainResult.paths.map((p, pi) => (
                <div key={`path-${pi}`} className="rounded-md border p-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>Path {pi + 1} · {p.nodes.length - 1} hop{p.nodes.length - 1 === 1 ? '' : 's'}</span>
                    {p.hops.some((h) => h.state === 'corroborated') && (
                      <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-bold text-emerald-400">corroborated</span>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {p.labels.map((lbl, li) => (
                      <div key={li}>
                        {li > 0 && (
                          <div className="ml-2 border-l border-dashed pl-3 text-[9px] text-muted-foreground">
                            ↓ {p.hops[li - 1]?.relationTypes.join(' / ').replace(/_/g, ' ').toLowerCase() ?? ''}
                            {p.hops[li - 1] && (
                              <span className={cn('ml-1 font-mono', p.hops[li - 1].state === 'corroborated' ? 'text-emerald-400' : p.hops[li - 1].state === 'inferred' ? 'text-violet-400' : '')}>
                                {p.hops[li - 1].independentSources} src
                              </span>
                            )}
                          </div>
                        )}
                        <div className="truncate font-mono text-[11px]">{lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Contradictions */}
              {explainResult.contradictions.length > 0 && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-400">
                    ⚠ {explainResult.contradictions.length} contradicting evidence signal{explainResult.contradictions.length > 1 ? 's' : ''}
                  </div>
                  {explainResult.contradictions.slice(0, 3).map((c) => (
                    <div key={c.id} className="text-[11px] leading-snug text-muted-foreground">• {c.description}</div>
                  ))}
                </div>
              )}

              {/* Evidence Contract summary */}
              <div className="rounded-md border p-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Evidence contract
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[9.5px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(
                    {
                      finding_id: explainResult.contract.finding_id,
                      status: explainResult.contract.status,
                      supporting_evidence: explainResult.contract.supporting_evidence.map((e) => e.name ? `${e.name}${e.locator ? ` (${e.locator})` : ''}` : e.evidenceId),
                      contradicting_evidence: explainResult.contract.contradicting_evidence.length,
                      graph_paths: explainResult.contract.graph_paths.length,
                      independent_sources: explainResult.contract.independent_sources,
                      evidence_sufficiency: explainResult.contract.evidence_sufficiency / 100,
                      llm_confidence: explainResult.contract.llm_confidence,
                      provenance_complete: explainResult.contract.provenance_complete,
                      investigator_decision: explainResult.contract.investigator_decision,
                    },
                    null,
                    1,
                  )}
                </pre>
                {explainResult.contract.warnings.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-400">{explainResult.contract.warnings.join(' · ')}</div>
                )}
              </div>

              {onOpenEvidence && explainResult.contract.supporting_evidence.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full text-[11px]"
                  onClick={() => onOpenEvidence(explainResult.contract.supporting_evidence[0].evidenceId)}
                >
                  <FileSearch className="mr-1.5 size-3" />
                  Open first supporting evidence
                </Button>
              )}
              {!explainResult.persistedClaimId && explainResult.connected && (
                <Button
                  size="sm"
                  className="h-7 w-full text-[11px]"
                  disabled={explainBusy}
                  onClick={() => void runExplain(explainResult.src.id, explainResult.dst.id, true)}
                >
                  Save to case (claim + decision record)
                </Button>
              )}
              {explainResult.persistedClaimId && (
                <div className="rounded bg-emerald-500/10 px-2 py-1.5 text-center text-[10px] text-emerald-400">
                  Saved as claim + decision record ✓
                </div>
              )}
              {explainError && (
                <div className="text-[11px] text-destructive">{explainError}</div>
              )}
              {!explainResult.connected && (
                <div className="text-center text-[11px] text-muted-foreground">
                  No path within 5 hops between these entities in the current graph.
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
      {explainError && !explainResult && (
        <div className="absolute bottom-3 left-3 z-40 max-w-[340px] rounded-lg border border-destructive/50 bg-card/95 p-3 text-[11px] text-destructive shadow-xl backdrop-blur">
          Explain Connection failed: {explainError}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setExplainError(null)}
          >
            dismiss
          </button>
        </div>
      )}
      {explainBusy && !explainResult && (
        <div className="absolute bottom-3 left-3 z-40 rounded-lg border bg-card/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur">
          <RefreshCw className="mr-1.5 inline size-3 animate-spin" />
          Enumerating paths & scoring sufficiency…
        </div>
      )}

      {/* Side panel (right) — suppressed mid-pick so it never covers B */}
      <div
        className={cn(
          'absolute right-0 top-0 z-40 h-full w-[320px] max-w-[85%] transform border-l bg-card/95 shadow-xl backdrop-blur transition-all duration-300',
          selectedNode && !(explainActive && (explainSrcId != null))
            ? 'translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-full opacity-0',
        )}
      >
        {selectedNode && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b p-3">
              <div className="flex items-center gap-2">
                <span
                  className="size-3 rounded-full"
                  style={{ backgroundColor: colorFor(selectedNode.type) }}
                />
                <span className="font-mono text-xs capitalize">
                  {selectedNode.type}
                </span>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSelectedNodeId(null)}
                title="Close panel"
              >
                <X className="size-4" />
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="space-y-4 p-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Label
                  </div>
                  <div className="break-all text-sm font-medium">
                    {selectedNode.label || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Value
                  </div>
                  <div className="break-all font-mono text-xs">
                    {selectedNode.value ||
                      selectedNode.label ||
                      selectedNode.id}
                  </div>
                </div>
                {selectedNode.tableIds && selectedNode.tableIds.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Source-table ID
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {selectedNode.tableIds.map((tid) => (
                        <Badge
                          key={tid}
                          variant="outline"
                          className="font-mono text-[10px] text-amber-500"
                          title="ID from the original relationship-table export"
                        >
                          {tid}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Degree
                    </div>
                    <div className="font-mono text-lg font-semibold">
                      {selectedNode.degree ?? 0}
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Type
                    </div>
                    <div className="text-sm font-medium capitalize">
                      {selectedNode.type}
                    </div>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Highlight & isolate
                  </div>
                  <Button
                    size="sm"
                    variant={focusEnabled ? 'default' : 'outline'}
                    className="w-full justify-start"
                    onClick={() => setFocusEnabled((v) => !v)}
                  >
                    <Crosshair className="size-3.5" />
                    {focusEnabled ? 'Focus is ON' : 'Highlight connections'}
                  </Button>
                  <div className="flex items-center gap-1 pl-1">
                    <span className="text-[10px] text-muted-foreground">Depth:</span>
                    {[1, 2, 3].map((d) => (
                      <button
                        key={`panel-hop-${d}`}
                        type="button"
                        onClick={() => setFocusDepth(d as 1 | 2 | 3)}
                        className={cn(
                          'rounded border px-2 py-0.5 font-mono text-[10px] transition-colors',
                          focusDepth === d
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant={egoIsolate ? 'default' : 'outline'}
                    className="w-full justify-start"
                    onClick={() =>
                      setEgoIsolate((prev) =>
                        prev && prev.rootId === selectedNodeId ? null : { rootId: selectedNode.id, depth: focusDepth },
                      )
                    }
                  >
                    <Eye className="size-3.5" />
                    {egoIsolate?.rootId === selectedNode.id
                      ? `Ego view active (${egoIds?.size ?? 0} nodes)`
                      : 'Show ONLY this ego network'}
                  </Button>
                </div>
                <Separator />
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Network actions
                  </div>
                  <Button
                    size="sm"
                    variant="default"
                    className="w-full justify-start"
                    onClick={expandNeighbors}
                    disabled={!!busy}
                  >
                    <ChevronRight className="size-3.5" />
                    Expand neighbors (1-hop)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={expandEgo}
                    disabled={!!busy}
                  >
                    <Network className="size-3.5" />
                    Ego network (radius 2)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setShowPathPicker((v) => !v)}
                    disabled={!!busy}
                  >
                    <Spline className="size-3.5" />
                    Shortest path to…
                  </Button>
                  {showPathPicker && (
                    <div className="rounded-md border p-2">
                      <Input
                        type="text"
                        placeholder="Search target node…"
                        value={pathPickerQuery}
                        onChange={(e) => setPathPickerQuery(e.target.value)}
                        className="h-8 text-xs"
                        autoFocus
                      />
                      <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-muted/30">
                        {pathPickerCandidates.length === 0 ? (
                          <div className="p-2 text-xs text-muted-foreground">
                            No matching nodes
                          </div>
                        ) : (
                          pathPickerCandidates.map((n) => (
                            <button
                              key={`pp-${n.id}`}
                              type="button"
                              onClick={() => void computeShortestPath(n.id)}
                              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
                            >
                              <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: colorFor(n.type) }}
                              />
                              <span className="flex-1 truncate font-mono">
                                {n.label || n.value || n.id}
                              </span>
                              <span className="text-muted-foreground capitalize">
                                {n.type}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                  {pathHighlight && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full justify-start text-amber-600 dark:text-amber-400"
                      onClick={() => setPathHighlight(null)}
                    >
                      <X className="size-3.5" />
                      Clear path highlight
                    </Button>
                  )}
                  {(() => {
                    const sp = positionsRef.current.get(selectedNode.id)
                    const isPinned = !!sp?.pinned
                    return (
                      <Button
                        size="sm"
                        variant={isPinned ? 'default' : 'outline'}
                        className="w-full justify-start"
                        onClick={() => {
                          if (sp) {
                            sp.pinned = !isPinned
                            bumpRender()
                          }
                        }}
                        title={
                          isPinned
                            ? 'Release this node so the layout can move it again'
                            : 'Pin this node in place (dragging it also pins it)'
                        }
                      >
                        {isPinned ? (
                          <PinOff className="size-3.5" />
                        ) : (
                          <Pin className="size-3.5" />
                        )}
                        {isPinned ? 'Unpin node' : 'Pin node in place'}
                      </Button>
                    )
                  })()}
                </div>
                <Separator />
                <div className="text-[10px] leading-relaxed text-muted-foreground">
                  Drag the node on the canvas to reposition (it will be pinned).
                  Click anywhere on the background to deselect. Use the wheel to
                  zoom, and click-drag the background to pan.
                </div>
              </div>
            </ScrollArea>
          </div>
        )}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2">
            <RefreshCw className="size-6 animate-spin text-primary" />
            <div className="text-sm text-muted-foreground">Loading graph…</div>
          </div>
        </div>
      )}

      {/* Busy toast (bottom-right) */}
      {busy && !loading && (
        <div className="absolute bottom-3 right-3 z-50 flex items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-md">
          <Zap className="size-3.5 animate-pulse text-primary" />
          <span className="text-xs">{busy}</span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="absolute bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-md">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 underline"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
          <Card className="w-[360px] max-w-full p-6 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
              <Network className="size-6 text-muted-foreground" />
            </div>
            <div className="text-lg font-semibold">No graph data yet</div>
            <div className="mt-1 text-sm text-muted-foreground">
              This case has no entities or relationships yet. Upload evidence
              files (CSV, UPI logs, chat exports, emails, PDFs) to populate the
              knowledge graph.
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

export default NetworkGraph
