// API client & shared types for the RED Justice frontend.
// All functions return typed data; on HTTP error they throw with a message.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EntityType =
  | 'person' | 'organization' | 'account' | 'upi' | 'phone' | 'email'
  | 'address' | 'device' | 'ip' | 'domain' | 'url' | 'social'
  | 'wallet' | 'vehicle' | 'location' | 'date' | 'amount' | 'document_id'
  | 'ifsc' | 'imei' | 'mac'

export interface Case {
  id: string
  uid: string
  title: string
  description: string | null
  status: string
  classification: string
  aiMode: string
  investigators: string | null
  tags: string | null
  sourceMetadata: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  _count?: {
    evidence?: number
    entities?: number
    transactions?: number
    findings?: number
  }
}

export interface Evidence {
  id: string
  caseId: string
  originalName: string
  mime: string | null
  size: number
  sha256: string
  source: string | null
  description: string | null
  status: string
  extractionStatus: string | null
  ocrStatus: string | null
  content: string | null
  intelJson: string | null
  provenance: string | null
  classification: string | null
  classificationConfidence: number | null
  classificationSource: string | null
  // v3 Fully-AI pipeline: pending | queued | running | complete | failed
  aiScanStatus: string | null
  aiScanError: string | null
  aiScanFinishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Entity {
  id: string
  caseId: string
  type: string
  value: string
  norm: string
  label: string | null
  confidence: number
  metadataJson: string | null
  linkCount?: number
  neighborCount?: number
  /** v3.5: source-table IDs (E0001 …) from relationship-table exports. */
  tableIds?: string[]
}

export interface Relationship {
  id: string
  caseId: string
  srcId: string
  dstId: string
  type: string
  weight: number
  confidence: number
  amount: number | null
  currency: string | null
  timestamp: string | null
}

export interface Transaction {
  id: string
  caseId: string
  evidenceId: string
  txnDate: string | null
  amount: number | null
  utr: string | null
  senderAccount: string | null
  receiverAccount: string | null
  ifsc: string | null
  bank: string | null
  upi: string | null
  wallet: string | null
  merchant: string | null
  status: string | null
  remarks: string | null
}

export interface TimelineEvent {
  id: string
  caseId: string
  ts: string | null
  sourceEvidenceId: string | null
  kind: string | null
  summary: string | null
  /** v3.5: source evidence file name (for readable provenance). */
  evidence?: { id: string; originalName: string } | null
}

export interface Finding {
  id: string
  caseId: string
  type: string
  severity: string
  confidence: number
  description: string
  trigger: string | null
  entitiesJson: string | null
  transactionsJson: string | null
  supportingEvidence: string | null
  reviewStatus: string
  createdAt: string
}

export interface ActorRisk {
  id: string
  caseId: string
  entityId: string
  score: number
  componentsJson: string | null
  contributorsJson: string | null
  entity?: Entity
}

export interface Community {
  id: string
  caseId: string
  label: string | null
  size: number
  dominantTypes: string | null
  transactionVolume: number | null
  internalRels: number
  externalRels: number
  centralActorsJson: string | null
  bridgeActorsJson: string | null
  suspiciousPatterns: number
  members?: Entity[]
}

export interface GraphEdge {
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
}

export interface GraphNode {
  id: string
  type: string
  label: string
  value?: string
  degree?: number
  evidenceCount?: number
  evidenceFiles?: number
  verState?: 'observed' | 'corroborated' | 'inferred' | 'uncertain'
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta?: { total: number; shown: number }
}

export interface Dashboard {
  cases: { total: number; open: number; active: number; closed: number; archived: number }
  evidence: { total: number; pending: number; processing: number; done: number; error: number }
  entities: { total: number; byType: Record<string, number> }
  transactions: { total: number; totalVolume: number; avgAmount: number; maxAmount: number }
  relationships: { total: number }
  findings: { total: number; bySeverity: Record<string, number>; byType: Record<string, number> }
  actors: { high: number; medium: number; low: number }
  communities: { total: number; totalMembers: number }
  jobs: { queued: number; running: number; completed: number; failed: number }
  recentActivity: Array<{ id: string; caseId: string | null; msg: string; at: string }>
}

export interface ImportSummaryCase {
  id: string
  title: string
  uid?: string
}

export interface ImportSummary {
  case?: ImportSummaryCase
  [key: string]: unknown
}

export interface AiChatMessage {
  id: string
  role: string
  content: string
  citations: string | null
  createdAt: string
}

export interface CaseSummary {
  case: Case
  counts: {
    evidence: number
    entities: number
    transactions: number
    relationships: number
    findings: number
    communities: number
    communications: number
    timelineEvents: number
  }
  topActors: ActorRisk[]
  recentFindings: Finding[]
  recentTimeline: TimelineEvent[]
}

export interface NetworkAnalytics {
  centrality: {
    degree: Array<{ entityId: string; value: number }>
    betweenness: Array<{ entityId: string; value: number }>
    closeness: Array<{ entityId: string; value: number }>
    pagerank: Array<{ entityId: string; value: number }>
  }
  components: string[][]
  communities: Array<{ label: string; members: string[] }>
  bridges: string[]
  centralActors: Array<{ entityId: string; score: number }>
}

export interface MoneyFlowStats {
  stats: { total: number; totalVolume: number; avgAmount: number; maxAmount: number }
  txnGraph?: { nodes: unknown[]; edges: unknown[] }
  topFlows?: Array<{ from: string; to: string; totalAmount: number; count: number }>
  fanIn: Array<{ account: string; countIn: number; totalIn: number; count: number; total: number }>
  fanOut: Array<{ account: string; countOut: number; totalOut: number; count: number; total: number }>
  circularFlows: string[][]
  recurringTransfers: Array<{ from: string; to: string; count: number; avgAmount: number; totalAmount?: number }>
  unusualSequences: Array<{ kind: string; description: string; account?: string }>
  velocityByAccount: Array<{
    account: string
    maxWindow: { count: number; start: string; end: string; volume: number }
    allWindows: Array<{ count: number; start: string; end: string; volume: number }>
  }>
}

// ─────────────────────────────────────────────────────────────────────────────
// Investigation feature types (contradictions, gaps, snapshots, replay, …)
// ─────────────────────────────────────────────────────────────────────────────

export interface Contradiction {
  id: string
  relation: string
  subjectType: string
  subjectAId: string | null
  subjectBId: string | null
  subjectARef: string | null
  subjectBRef: string | null
  description: string
  status: string
  resolutionNote: string | null
  evidenceIds: string[]
  detector: string | null
  createdAt: string
}

export interface Gap {
  id: string
  family: string
  severity: string
  title: string
  description: string
  recommendation: string
  relatedIds: string[]
}

export interface GapReport {
  gaps: Gap[]
  total: number
  byFamily: Record<string, number>
  bySeverity: Record<string, number>
  coverage: {
    evidenceByClass: Record<string, number>
    hasTransactions: boolean
    hasCommunications: boolean
    hasSourceFor: Record<string, boolean>
  }
}

export interface SufficiencyScore {
  score: number
  band: 'insufficient' | 'partial' | 'sufficient' | 'strong'
  independentSources: number
  sourceQuality: number
  corroboration: number
  contradictionPenalty: number
  provenance: number
  reasons: string[]
}

export interface SnapshotMeta {
  id: string
  label: string
  nodesCount: number
  edgesCount: number
  createdAt: string
}

export interface SnapshotDiffResult {
  a: SnapshotMeta
  b: SnapshotMeta
  diff: {
    addedEdges: Array<{ key: string; src: string; dst: string; type: string }>
    removedEdges: Array<{ key: string; src: string; dst: string; type: string }>
    addedNodes: Array<{ key: string; type: string; value: string }>
    removedNodes: Array<{ key: string; type: string; value: string }>
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
}

export interface ReplayStep {
  stage: string
  at: string | null
  title: string
  detail: string
  refs: string[]
}

export interface ReplayTrace {
  findingId: string
  steps: ReplayStep[]
  integrity: { allSourcesPresent: boolean; missing: string[] }
}

export interface ClaimNode {
  id: string
  level: 'evidence' | 'observation' | 'finding' | 'hypothesis' | 'claim' | 'report'
  refId: string | null
  text: string
  status: 'unsupported' | 'supported' | 'verified' | 'rejected'
  sources: string[]
  createdAt: string
  sufficiency?: number
}

export interface ClaimGraph {
  nodes: ClaimNode[]
  counts: Record<string, number>
  unsupportedClaims: ClaimNode[]
  reportReady: boolean
  policy: string
}

export interface Collision {
  type: string
  norm: string
  displayValue: string
  caseCount: number
  occurrences: number
  cases: Array<{
    caseId: string
    caseUid: string
    caseTitle: string
    entityIds: string[]
    values: string[]
    evidenceNames: string[]
    occurrences: number
  }>
}

export interface CollisionReport {
  collisions: Collision[]
  total: number
  byType: Record<string, number>
  casesWithCollisions: number
  typesSearched: string[]
  truncated?: boolean
}

export interface Capability {
  name: string
  label: string
  status: 'operational' | 'degraded' | 'offline'
  dependsOn: string
  fallback: string
  detail?: string
}

export interface SystemStatus {
  db: string
  caseCount: number
  evidenceCount: number
  entityCount?: number
  transactionCount?: number
  aiAvailable: boolean
  aiModel: string
  aiEndpoint: string
  aiError?: string
  geminiConfigured?: boolean
  capabilities?: Capability[]
  degradedSummary?: { operational: number; degraded: number; offline: number; total: number }
  error?: string
}

export interface EntityObservation {
  id: string
  entityId: string
  entity?: { id: string; type: string; value: string; label: string | null }
  rawType: string
  rawValue: string
  norm: string
  evidenceId: string | null
  evidenceName: string | null
  locator: string | null
  extractionMethod: string | null
  mergedFromId: string | null
  createdAt: string
}

export interface VerifyResult {
  ok: boolean
  hypothesisId: string
  status: 'confirmed' | 'rejected' | 'unresolved'
  confidence: number
  checks: Array<{ check: string; result: 'pass' | 'partial' | 'fail'; detail: string }>
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT-GEN ARCHITECTURE CLIENT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidenceContractType {
  finding_id: string
  claim: string
  status: 'unresolved' | 'corroborated' | 'partial' | 'rejected' | 'verified'
  supporting_evidence: Array<{ evidenceId: string; name?: string; locator?: string; record?: string }>
  contradicting_evidence: Array<{ evidenceId: string; name?: string; locator?: string }>
  graph_paths: string[][]
  graph_path_labels?: string[][]
  independent_sources: number
  evidence_sufficiency: number
  sufficiency_band?: string
  llm_confidence: number | null
  temporal_validity?: { from: string | null; to: string | null }
  provenance_complete: boolean
  investigator_decision: null | 'approved' | 'rejected' | 'unresolved'
  generator: string
  warnings: string[]
}

export interface ExplainConnectionResult {
  src: { id: string; type: string; label: string }
  dst: { id: string; type: string; label: string }
  connected: boolean
  paths: Array<{
    nodes: string[]
    labels: string[]
    hops: Array<{
      from: string
      to: string
      relationTypes: string[]
      independentSources: number
      state: 'corroborated' | 'observed' | 'inferred'
      evidence: Array<{ evidenceId: string; locator: string | null; method: string | null }>
      firstObserved: string | null
      lastObserved: string | null
    }>
  }>
  hops: Array<{
    from: string
    to: string
    relationTypes: string[]
    independentSources: number
    state: 'corroborated' | 'observed' | 'inferred'
    evidence: Array<{ evidenceId: string; locator: string | null; method: string | null }>
    firstObserved: string | null
    lastObserved: string | null
  }>
  contradictions: Array<{ id: string; description: string; status: string; detector: string | null }>
  sufficiency: {
    score: number
    band: string
    reasons: string[]
    breakdown: {
      independentSources: number
      sourceQuality: number
      corroboration: number
      contradictionPenalty: number
      provenance: number
    }
  }
  conclusion: string
  contract: EvidenceContractType
  persistedClaimId?: string | null
  persistedDecisionUid?: string | null
}

export interface DecisionRecordRow {
  id: string
  uid: string
  actor: string
  action: string
  objectType: string
  objectRef: string | null
  objectLabel: string | null
  beforeState: string | null
  afterState: string | null
  reason: string | null
  at: string
}

export interface AuditEventRow {
  kind: 'decision' | 'custody' | 'activity' | 'stage'
  ref: string
  at: string
  actor: string | null
  action: string
  objectLabel: string | null
  detail: string | null
  before: string | null
  after: string | null
}

export interface PlaybackFrameRow {
  index: number
  label: string
  from: string | null
  to: string | null
  newEntities: number
  newEdges: number
  newEntityLabels: string[]
  newEdgeLabels: string[]
  cumEntities: number
  cumEdges: number
}

export interface TemporalOverlapRow {
  a: { id: string; label: string }
  b: { id: string; label: string }
  overlapStart: string
  overlapEnd: string
  overlapMs: number
  overlapHuman: string
  basis: 'direct-edge' | 'shared-evidence'
  relationType?: string
}

export interface EvidenceMatrixData {
  columns: Array<{ id: string; kind: 'hypothesis' | 'finding' | 'claim'; label: string; status: string; sufficiency?: number | null }>
  rows: Array<{ evidenceId: string; evRef: string; name: string; classification: string | null }>
  cells: Record<string, 'supports' | 'contradicts' | 'shared' | 'none'>
  counts?: { supports: number; contradicts: number; shared: number }
  legend?: Record<string, string>
  empty?: boolean
}

export interface EvidenceVersionRow {
  id: string
  version: number
  sha256: string
  size: number
  note: string | null
  createdBy: string
  supersedesId: string | null
  createdAt: string
  ref: string
  current: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  // system
  dashboard: () => jsonFetch<Dashboard>('/api/dashboard'),
  systemStatus: () => jsonFetch<SystemStatus>('/api/system/status'),

  // cases — wrapped as { cases: [...] } / { case: ... }
  listCases: async (q?: string) => {
    const r = await jsonFetch<{ cases: Case[] }>(`/api/cases${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    return r.cases
  },
  getCase: async (id: string) => {
    const r = await jsonFetch<{ case: Case }>(`/api/cases/${id}`)
    return r.case
  },
  createCase: async (body: { title: string; description?: string; classification?: string; aiMode?: string }) => {
    const r = await jsonFetch<{ case: Case }>('/api/cases', { method: 'POST', body: JSON.stringify(body) })
    return r.case
  },
  updateCase: async (id: string, body: Partial<Case>) => {
    const r = await jsonFetch<{ case: Case }>(`/api/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    return r.case
  },
  caseSummary: async (id: string) => jsonFetch<CaseSummary>(`/api/cases/${id}/summary`),

  // evidence — wrapped as { evidence: ... }
  listEvidence: async (caseId: string) => {
    const r = await jsonFetch<{ evidence: Evidence[] }>(`/api/cases/${caseId}/evidence`)
    return r.evidence
  },
  getEvidence: async (caseId: string, evid: string) => {
    const r = await jsonFetch<{ evidence: Evidence }>(`/api/cases/${caseId}/evidence/${evid}`)
    return r.evidence
  },
  addEvidence: async (caseId: string, body: { originalName: string; content: string; source?: string; description?: string; mime?: string }) => {
    const r = await jsonFetch<{ evidence: Evidence }>('/api/cases/' + caseId + '/evidence', { method: 'POST', body: JSON.stringify(body) })
    return r.evidence
  },
  uploadEvidenceFiles: async (caseId: string, files: File[], onProgress?: (done: number, total: number) => void) => {
    const results: Array<{ evidence: Evidence | null; error: string | null; filename: string; extraction?: Record<string, number> }> = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const formData = new FormData()
        formData.append('file', file, file.name)
        if (onProgress) onProgress(i, files.length)
        const res = await fetch('/api/cases/' + caseId + '/evidence/upload', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          let msg = res.status + ' ' + res.statusText
          try {
            const body = await res.json()
            if (body?.error) msg = body.error
          } catch {}
          results.push({ evidence: null, error: msg, filename: file.name })
        } else {
          const data = await res.json()
          results.push({
            evidence: data.evidence,
            error: data.dedup ? 'duplicate (already ingested)' : null,
            filename: file.name,
            extraction: data.extraction,
          })
        }
      } catch (e) {
        results.push({
          evidence: null,
          error: e instanceof Error ? e.message : 'upload failed',
          filename: file.name,
        })
      }
    }
    if (onProgress) onProgress(files.length, files.length)
    return results
  },
  deleteEvidence: (caseId: string, evid: string) =>
    jsonFetch<{ ok: boolean }>(`/api/cases/${caseId}/evidence/${evid}`, { method: 'DELETE' }),

  // AI scan — runs the AI over a single evidence file to extract deeper insights
  scanEvidence: (caseId: string, evid: string) =>
    jsonFetch<{
      scan: {
        summary: string
        entities: Array<{ type: string; value: string; context?: string }>
        suspiciousIndicators: string[]
        narrative: string
        suggestedSteps: string[]
        confidence: string
        aiAvailable: boolean
        model: string
        scannedAt: string
        story?: {
          hasStory: boolean
          plot?: string
          connections?: Array<{ from: string; to: string; rel: string; why?: string; confidence?: number }>
        }
      }
      evidenceId: string
      graph?: { linked: number; relationships: number; storyLinks: number; repairedLinks: number; purgedMechanical: number }
      error?: string
      hint?: string
    }>(`/api/cases/${caseId}/evidence/${evid}/scan`, { method: 'POST', body: '{}' }),

  // AI link explanation — WHY are these two nodes connected (AI narrative,
  // grounded in the actual document excerpts, with deterministic fallback).
  explainLink: (caseId: string, srcId: string, dstId: string, type?: string) =>
    jsonFetch<{
      src: { id: string; type: string; label: string }
      dst: { id: string; type: string; label: string }
      relationship: {
        id: string
        type: string
        allTypes: string[]
        confidence: number
        weight: number
        provenance: string | null
        evidenceRef: string | null
        rationale?: string
      } | null
      explanation: string
      aiAvailable: boolean
      model: string
      heuristicWhy: string
      sharedEvidence: { count: number; files: string[] }
      excerpts: Array<{ evidenceName: string; snippets: string[] }>
    }>(`/api/cases/${caseId}/links/explain`, {
      method: 'POST',
      body: JSON.stringify({ srcId, dstId, type }),
    }),

  // Graph hygiene — purge legacy MECHANICAL content (pre-v3 regex/proximity
  // mesh): CO_OCCURRED edges with mechanical provenance + orphan entities.
  purgeMechanicalLinks: (caseId: string, dryRun = false) =>
    jsonFetch<{
      ok?: boolean
      dryRun?: boolean
      deletedEdges?: number
      deletedOrphans?: number
      mechanicalEdges?: number
      orphanEntities?: number
    }>(`/api/cases/${caseId}/graph/purge-mechanical`, {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
    }),

  // entities — wrapped as { entities: [...], total }
  listEntities: async (caseId: string, type?: string, q?: string) => {
    const r = await jsonFetch<{ entities: Entity[]; total: number }>(
      `/api/cases/${caseId}/entities${type || q ? `?${type ? `type=${type}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}` : ''}`,
    )
    return r.entities
  },

  // relationships — wrapped as { relationships: [...] }
  listRelationships: async (caseId: string) => {
    const r = await jsonFetch<{ relationships: Relationship[] }>(`/api/cases/${caseId}/relationships`)
    return r.relationships
  },

  // transactions — wrapped as { transactions: [...], total }
  listTransactions: async (caseId: string) => {
    const r = await jsonFetch<{ transactions: Transaction[]; total: number }>(`/api/cases/${caseId}/transactions`)
    return r.transactions
  },
  moneyFlow: (caseId: string) => jsonFetch<MoneyFlowStats>(`/api/cases/${caseId}/money/flow`),
  traceMoney: (caseId: string, account: string, direction: 'forward' | 'backward', maxHops: number) =>
    jsonFetch<{ paths: string[][] }>(`/api/cases/${caseId}/money/trace`, { method: 'POST', body: JSON.stringify({ account, direction, maxHops }) }),

  // graph — wrapped as { nodes, edges, meta }
  graph: async (caseId: string, limit = 300) => {
    const r = await jsonFetch<GraphData>(`/api/cases/${caseId}/graph?limit=${limit}`)
    return r
  },
  networkAnalytics: (caseId: string) => jsonFetch<NetworkAnalytics>(`/api/cases/${caseId}/network`),

  // communities — wrapped as { communities: [...], total }
  communities: async (caseId: string) => {
    const r = await jsonFetch<{ communities: Community[]; total: number }>(`/api/cases/${caseId}/communities`)
    return r.communities
  },

  // patterns — wrapped as { findings: [...] }
  patterns: async (caseId: string) => {
    const r = await jsonFetch<{ findings: Finding[] }>(`/api/cases/${caseId}/patterns`)
    return r.findings
  },
  runPatterns: (caseId: string) => jsonFetch<{ created: number; skipped: number; total: number }>(`/api/cases/${caseId}/patterns/run`, { method: 'POST', body: '{}' }),

  // actors — wrapped as { actors: [...], total }
  actors: async (caseId: string) => {
    const r = await jsonFetch<{ actors: ActorRisk[]; total: number }>(`/api/cases/${caseId}/actors`)
    return r.actors
  },
  runActors: (caseId: string) => jsonFetch<{ updated: number; total: number }>(`/api/cases/${caseId}/actors/run`, { method: 'POST', body: '{}' }),

  // timeline — wrapped as { timeline: [...], total }
  timeline: async (caseId: string) => {
    const r = await jsonFetch<{ timeline: TimelineEvent[]; total: number }>(`/api/cases/${caseId}/timeline`)
    return r.timeline
  },

  // search — returns { q, evidence, entities, transactions, communications, findings }
  search: async (caseId: string, q: string) => {
    const r = await jsonFetch<{
      q: string
      evidence: Evidence[]
      entities: Entity[]
      transactions: Transaction[]
      communications: unknown[]
      findings: Finding[]
    }>(`/api/cases/${caseId}/search?q=${encodeURIComponent(q)}`)
    return r
  },

  // ai — returns { response, citations, aiAvailable, context }
  aiChat: async (caseId: string, message: string, mode: 'standard' | 'smart' | 'deep' = 'smart') => {
    const r = await jsonFetch<{
      response: string
      citations: string[]
      aiAvailable: boolean
      context: { entities: number; transactions: number; evidence: number; findings: number }
    }>(`/api/cases/${caseId}/ai`, { method: 'POST', body: JSON.stringify({ message, mode }) })
    return r
  },
  aiHistory: async (caseId: string) => {
    const r = await jsonFetch<{ messages: AiChatMessage[]; total: number }>(`/api/cases/${caseId}/ai/history`)
    return r.messages
  },

  // reports — wrapped as { markdown: ... }
  reportSummary: async (caseId: string) => {
    const r = await jsonFetch<{ markdown: string }>(`/api/cases/${caseId}/reports/summary`)
    return r
  },
  reportJson: (caseId: string) => jsonFetch<Record<string, unknown>>(`/api/cases/${caseId}/reports/json`),

  // jobs — wrapped as { jobs: [...], total }
  jobs: async () => {
    const r = await jsonFetch<{ jobs: Array<{ id: string; type: string; status: string; progress: number; detail: string | null; createdAt: string }>; total: number }>('/api/jobs')
    return r.jobs
  },

  // entity resolution — find duplicate candidates
  entityResolve: (caseId: string) =>
    jsonFetch<{
      candidates: Array<{
        groupId: string
        reason: string
        confidence: number
        entities: Array<{ id: string; type: string; value: string; norm: string; label: string | null }>
      }>
      total: number
      totalEntities: number
    }>(`/api/cases/${caseId}/entities/resolve`),

  // entity merge — merge multiple entities into one
  entityMerge: (caseId: string, primaryId: string, mergeIds: string[]) =>
    jsonFetch<{
      primary: Entity
      merged: number
      aliases: string[]
    }>(`/api/cases/${caseId}/entities/merge`, {
      method: 'POST',
      body: JSON.stringify({ primaryId, mergeIds }),
    }),

  // case export — download full case as JSON
  caseExport: (caseId: string) =>
    jsonFetch<Record<string, unknown>>(`/api/cases/${caseId}/export`),

  // case import — upload a .json export file
  caseImport: async (file: File) => {
    const formData = new FormData()
    formData.append('file', file, file.name)
    const res = await fetch('/api/cases/import', { method: 'POST', body: formData })
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try {
        const body = await res.json()
        if (body?.error) msg = body.error
      } catch {}
      throw new Error(msg)
    }
    return res.json() as Promise<{ ok: boolean; summary: ImportSummary }>
  },

  // investigator notes
  listNotes: async (caseId: string) => {
    const r = await jsonFetch<{ notes: Array<{ id: string; body: string; createdAt: string }> }>(`/api/cases/${caseId}/notes`)
    return r.notes
  },
  addNote: (caseId: string, body: string) =>
    jsonFetch<{ note: { id: string; body: string; createdAt: string } }>(`/api/cases/${caseId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  deleteNote: (caseId: string, noteId: string) =>
    jsonFetch<{ ok: boolean }>(`/api/cases/${caseId}/notes/${noteId}`, { method: 'DELETE' }),

  // entity detail (360° view)
  entityDetail: (caseId: string, entityId: string) =>
    jsonFetch<{
      entity: { id: string; type: string; value: string; norm: string; label: string | null; confidence: number; metadataJson: string | null; createdAt: string }
      neighbors: Array<{ id: string; type: string; value: string; label: string | null; relType: string; weight: number; direction: 'incoming' | 'outgoing' }>
      transactions: Transaction[]
      communications: unknown[]
      timeline: TimelineEvent[]
      findings: Finding[]
      actorRisk: ActorRisk | null
      communities: Array<{ id: string; label: string | null; size: number }>
      roleHypotheses: Array<{ role: string; confidence: number; supportingMetrics: string[]; description: string }>
      evidence: Array<{ id: string; originalName: string; sha256: string }>
      metrics: { degree: number; betweenness: number; closeness: number; pagerank: number; crossCommunityEdges: number; inDegree: number; outDegree: number }
    }>(`/api/cases/${caseId}/entities/${entityId}/detail`),

  // anomalies — graph anomaly detection
  anomalies: (caseId: string) =>
    jsonFetch<{
      anomalies: Array<{
        id: string
        family: 'node' | 'edge' | 'subgraph' | 'temporal'
        type: string
        severity: string
        description: string
        entityId?: string
      }>
      total: number
      byFamily: { node: number; edge: number; subgraph: number; temporal: number }
    }>(`/api/cases/${caseId}/anomalies`),

  // hypotheses — investigation hypothesis workspace
  listHypotheses: async (caseId: string) => {
    const r = await jsonFetch<{
      hypotheses: Array<{
        id: string
        title: string
        statement: string
        status: string
        supportingEvidence: string[]
        contradictingEvidence: string[]
        graphSupport: string
        temporalSupport: string
        confidence: number
        createdAt: string
      }>
      total: number
    }>(`/api/cases/${caseId}/hypotheses`)
    return r.hypotheses
  },
  createHypothesis: (caseId: string, title: string, statement: string) =>
    jsonFetch<{
      hypothesis: {
        id: string
        title: string
        statement: string
        status: string
        confidence: number
        createdAt: string
      }
    }>(`/api/cases/${caseId}/hypotheses`, {
      method: 'POST',
      body: JSON.stringify({ title, statement }),
    }),

  // ── Investigation research features ──

  // contradictions — evidence contradiction graph
  contradictions: (caseId: string) =>
    jsonFetch<{
      contradictions: Contradiction[]
      total: number
      byRelation: Record<string, number>
      byStatus: Record<string, number>
    }>(`/api/cases/${caseId}/contradictions`),
  runContradictionDetection: (caseId: string) =>
    jsonFetch<{ ok: boolean; detected: number; created: number; byRelation: Record<string, number> }>(
      `/api/cases/${caseId}/contradictions`,
      { method: 'POST', body: '{}' },
    ),
  resolveContradiction: (caseId: string, contradictionId: string, status: 'resolved' | 'accepted' | 'open', note?: string) =>
    jsonFetch<{ ok: boolean; updated: number }>(`/api/cases/${caseId}/contradictions/resolve`, {
      method: 'POST',
      body: JSON.stringify({ contradictionId, status, note }),
    }),

  // gaps — investigation gap engine
  gaps: (caseId: string) => jsonFetch<GapReport>(`/api/cases/${caseId}/gaps`),

  // snapshots — graph snapshot comparison
  snapshots: (caseId: string) =>
    jsonFetch<{ snapshots: SnapshotMeta[]; total: number }>(`/api/cases/${caseId}/snapshots`),
  createSnapshot: (caseId: string, label?: string) =>
    jsonFetch<{ snapshot: SnapshotMeta }>(`/api/cases/${caseId}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  compareSnapshots: (caseId: string, a: string, b: string) =>
    jsonFetch<SnapshotDiffResult>(`/api/cases/${caseId}/snapshots/compare?a=${a}&b=${b}`),

  // replay — investigation replay for a finding
  replayFinding: (caseId: string, findingId: string) =>
    jsonFetch<ReplayTrace>(`/api/cases/${caseId}/replay?findingId=${findingId}`),

  // claims — claim graph
  claims: (caseId: string) => jsonFetch<ClaimGraph>(`/api/cases/${caseId}/claims`),
  createClaim: (caseId: string, text: string, sources?: string[], parentId?: string) =>
    jsonFetch<{ claim: ClaimNode }>(`/api/cases/${caseId}/claims`, {
      method: 'POST',
      body: JSON.stringify({ text, sources, parentId }),
    }),

  // hypotheses — verification loop + AI proposal
  verifyHypothesis: (caseId: string, hypothesisId: string) =>
    jsonFetch<VerifyResult>(`/api/cases/${caseId}/hypotheses/verify`, {
      method: 'POST',
      body: JSON.stringify({ hypothesisId }),
    }),
  proposeHypothesis: (caseId: string) =>
    jsonFetch<{
      hypothesis: { id: string; title: string; statement: string; status: string; proposedBy: string; createdAt: string }
    }>(`/api/cases/${caseId}/hypotheses/propose`, { method: 'POST', body: '{}' }),

  // findings — investigator decision record
  decideFinding: (
    caseId: string,
    findingId: string,
    decision: 'approved' | 'rejected' | 'modified',
    note?: string,
    modifiedDescription?: string,
    decidedBy?: string,
  ) =>
    jsonFetch<{
      ok: boolean
      decision: { findingId: string; decision: string; decidedAt: string | null; decidedBy: string | null; decisionNote: string | null }
    }>(`/api/cases/${caseId}/patterns/decide`, {
      method: 'POST',
      body: JSON.stringify({ findingId, decision, note, modifiedDescription, decidedBy }),
    }),

  // evidence classification — reclassify or manual override
  classifyEvidence: (caseId: string, evid: string, override?: { classification: string; confidence?: number }) =>
    jsonFetch<{
      classification: { classification: string; confidence: number | null; source: string | null; signals?: string[] }
      usedAi?: boolean
    }>(`/api/cases/${caseId}/evidence/${evid}/classify`, {
      method: 'POST',
      body: JSON.stringify(override ?? {}),
    }),

  // collisions — cross-case identity collision explorer
  collisions: (q?: string, types?: string[]) =>
    jsonFetch<CollisionReport>(
      `/api/collisions?${q ? `q=${encodeURIComponent(q)}` : ''}${types?.length ? `&types=${types.join(',')}` : ''}`,
    ),

  // equivalence mode — local AI vs Gemini on the same prompt
  aiCompare: (caseId: string, message: string) =>
    jsonFetch<{
      prompt: string
      contextCounts: { entities: number; transactions: number; findings: number; evidence: number }
      local: { available: boolean; model: string; latencyMs: number; answer: string; usedFallback?: boolean; error?: string; citations: string[] }
      gemini: { available: boolean; model: string; latencyMs: number; answer: string; error?: string; citations: string[] }
      comparison: {
        overlapCitations: string[]
        localLatencyMs: number
        geminiLatencyMs: number
        localChars: number
        geminiChars: number
        totalLatencyMs: number
      }
    }>('/api/ai/compare', { method: 'POST', body: JSON.stringify({ caseId, message }) }),

  // observations — provenance-preserving entity observations
  observations: (caseId: string, entityId?: string) =>
    jsonFetch<{ observations: EntityObservation[]; total: number }>(
      `/api/cases/${caseId}/observations${entityId ? `?entityId=${entityId}` : ''}`,
    ),
  backfillObservations: (caseId: string) =>
    jsonFetch<{ ok: boolean; created: number; entitiesSkipped: number }>(`/api/cases/${caseId}/observations`, {
      method: 'POST',
      body: '{}',
    }),

  // ── next-gen architecture ────────────────────────────────────────────────

  // Explain Connection (architecture §27) — deterministic multi-path,
  // sufficiency-scored, contradiction-aware connection explanation.
  explainConnection: (
    caseId: string,
    srcId: string,
    dstId: string,
    opts?: { persist?: boolean },
  ) =>
    jsonFetch<ExplainConnectionResult>(`/api/cases/${caseId}/explain-connection`, {
      method: 'POST',
      body: JSON.stringify({ srcId, dstId, persist: opts?.persist ?? false }),
    }),

  // Decision Record ledger + unified audit feed (§18/§22)
  decisions: (caseId: string, filters?: { action?: string; objectType?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (filters?.action) q.set('action', filters.action)
    if (filters?.objectType) q.set('objectType', filters.objectType)
    if (filters?.limit) q.set('limit', String(filters.limit))
    return jsonFetch<{ decisions: DecisionRecordRow[]; total: number }>(
      `/api/cases/${caseId}/decisions${q.toString() ? `?${q}` : ''}`,
    )
  },
  auditFeed: (caseId: string, kind = 'all') =>
    jsonFetch<{ events: AuditEventRow[]; counts: { decision: number; custody: number; activity: number }; total: number }>(
      `/api/cases/${caseId}/audit?kind=${kind}`,
    ),

  // Temporal playback + co-activity overlaps (§6)
  temporalPlayback: (caseId: string, bins = 8, withOverlaps = false) =>
    jsonFetch<{
      frames: PlaybackFrameRow[]
      window: { from: string | null; to: string | null }
      totalEntities: number
      totalEdges: number
      overlaps: TemporalOverlapRow[]
      windowsCompared: number
    }>(`/api/cases/${caseId}/temporal/playback?bins=${bins}${withOverlaps ? '&overlaps=1' : ''}`),

  // Evidence Matrix — claims × evidence support grid (§26)
  evidenceMatrix: (caseId: string) =>
    jsonFetch<EvidenceMatrixData>(`/api/cases/${caseId}/matrix`),

  // Evidence version chains (§2)
  evidenceVersions: (caseId: string, evid: string) =>
    jsonFetch<{
      evRef: string
      evidence: { id: string; originalName: string; sha256: string }
      versions: EvidenceVersionRow[]
    }>(`/api/cases/${caseId}/evidence/${evid}/versions`),
  supersedeEvidenceVersion: (caseId: string, evid: string, file: File, note?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (note) form.append('note', note)
    return fetch(`/api/cases/${caseId}/evidence/${evid}/versions`, { method: 'POST', body: form })
  },
}
