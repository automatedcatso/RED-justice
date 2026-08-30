/**
 * types.ts — RED Justice Benchmark Lab core types.
 *
 * A controlled benchmark that scores AI models on investigation-reasoning:
 * evidence grounding, entity/relationship extraction, temporal reasoning,
 * contradiction detection, hypothesis testing, uncertainty handling,
 * structured output and prompt-injection resistance.
 *
 * Every case is SYNTHETIC and deterministically generated from a seed, so a
 * run is fully reproducible and model scores are comparable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Categories + rubric
// ─────────────────────────────────────────────────────────────────────────────

export const BENCHMARK_CATEGORIES = [
  'entity_extraction',
  'relationship_extraction',
  'evidence_grounding',
  'citation_accuracy',
  'contradiction_detection',
  'temporal_reasoning',
  'hypothesis_quality',
  'verification_accuracy',
  'unknown_handling',
  'structured_output',
  'injection_resistance',
] as const

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number]

export interface CategoryMeta {
  key: BenchmarkCategory
  label: string
  weight: number
  short: string
}

/** The scoring rubric (weights mirror the reference spec, sum = 1.0). */
export const CATEGORY_RUBRIC: CategoryMeta[] = [
  { key: 'entity_extraction', label: 'Entity Accuracy', weight: 0.1, short: 'Entity' },
  { key: 'relationship_extraction', label: 'Relationship Accuracy', weight: 0.1, short: 'Relation' },
  { key: 'evidence_grounding', label: 'Evidence Grounding', weight: 0.15, short: 'Grounding' },
  { key: 'citation_accuracy', label: 'Citation Accuracy', weight: 0.1, short: 'Citation' },
  { key: 'contradiction_detection', label: 'Contradiction Detection', weight: 0.1, short: 'Contra' },
  { key: 'temporal_reasoning', label: 'Temporal Reasoning', weight: 0.1, short: 'Temporal' },
  { key: 'hypothesis_quality', label: 'Hypothesis Quality', weight: 0.1, short: 'Hypothesis' },
  { key: 'verification_accuracy', label: 'Verification Accuracy', weight: 0.1, short: 'Verif' },
  { key: 'unknown_handling', label: 'Unknown Handling', weight: 0.05, short: 'Unknown' },
  { key: 'structured_output', label: 'Structured Output', weight: 0.05, short: 'JSON' },
  { key: 'injection_resistance', label: 'Prompt Injection Resistance', weight: 0.05, short: 'Inject' },
]

export const QUICK_SUITE_CATEGORIES: BenchmarkCategory[] = [
  'entity_extraction',
  'relationship_extraction',
  'temporal_reasoning',
  'contradiction_detection',
  'unknown_handling',
  'structured_output',
  'injection_resistance',
]

export type BenchmarkSuite = 'quick' | 'full'

export function categoriesForSuite(suite: BenchmarkSuite): BenchmarkCategory[] {
  return suite === 'quick' ? QUICK_SUITE_CATEGORIES : [...BENCHMARK_CATEGORIES]
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic case + ground truth
// ─────────────────────────────────────────────────────────────────────────────

export type GroundEntityType =
  | 'person'
  | 'organization'
  | 'account'
  | 'phone'
  | 'vehicle'
  | 'location'
  | 'ip_address'
  | 'email'
  | 'upi_id'

export interface GroundEntity {
  id: string // E-1 …
  type: GroundEntityType
  value: string // normalized machine value (digits for phones/accounts, canonical name…)
  name?: string // display form
}

export interface GroundRelationship {
  source: string // entity id
  relation: string // uppercase relation code
  target: string // entity id
  evidence: string[] // EV-001 …
}

export interface GroundTimelineEvent {
  id: string
  at: string // ISO datetime
  description: string
  evidence: string[]
}

export interface PlantedContradiction {
  id: string // C-1
  subject: string // what conflicts
  variantA: { text: string; evidence: string }
  variantB: { text: string; evidence: string }
}

export type TemporalAnswer = 'BEFORE' | 'AFTER' | 'VALID' | 'INCONSISTENT'

export interface TemporalFact {
  id: string // T-1
  question: string
  answer: TemporalAnswer
  explanation: string
}

export interface UnanswerableQuestion {
  id: string // U-1
  question: string
  /** What a correct answer must convey (INSUFFICIENT_EVIDENCE / UNRESOLVED). */
  expected: 'INSUFFICIENT_EVIDENCE'
}

export type HypothesisVerdict = 'CONFIRMED' | 'REJECTED' | 'UNRESOLVED'

export interface GroundHypothesis {
  id: string // H-1
  text: string
  verdict: HypothesisVerdict
  rationale: string // why (for notes; never shown to the model)
}

export interface CaseGroundTruth {
  entities: GroundEntity[]
  relationships: GroundRelationship[]
  timeline: GroundTimelineEvent[]
  contradictions: PlantedContradiction[]
  temporal: TemporalFact[]
  unanswerable: UnanswerableQuestion
  hypotheses: GroundHypothesis[] // one CONFIRMED, one REJECTED, one UNRESOLVED
  transactions: GroundTransaction[]
  communications: GroundCommunication[]
  locations: Array<{ id: string; name: string; evidence: string[] }>
}

export interface GroundTransaction {
  id: string
  date: string // YYYY-MM-DD
  time?: string // HH:MM
  fromAccount: string
  toAccount: string
  fromName: string
  toName: string
  amountInr: number
  channel: 'UPI' | 'NEFT' | 'IMPS' | 'ATM' | 'CASH'
  utr?: string
  evidence: string[]
}

export interface GroundCommunication {
  id: string
  fromPhone: string
  toPhone: string
  fromName: string
  toName: string
  datetime: string // ISO
  durationSec: number
  tower: string
  evidence: string[]
}

export interface EvidenceDoc {
  id: string // EV-001 …
  type: string // fir | bank_statement | cdr | witness_statement | email | cctv_log | vehicle_registry
  date: string
  title: string
  content: string
}

export interface BenchmarkCase {
  caseId: string // BJ-24601
  template: 'fraud_ring' | 'cyber_scam' | 'missing_person'
  title: string
  seed: number
  evidence: EvidenceDoc[]
  groundTruth: CaseGroundTruth
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests + outcomes
// ─────────────────────────────────────────────────────────────────────────────

export interface TestCase {
  category: BenchmarkCategory
  /** Human label shown in progress/details. */
  label: string
  systemPrompt: string
  userPrompt: string
  /** Everything the scorer needs (ground truth slices + question ids). */
  expected: Record<string, unknown>
}

export interface TestOutcome {
  category: BenchmarkCategory
  label: string
  caseIndex: number
  score: number // 0..1
  notes: string
  latencyMs: number
  error?: string
  responsePreview: string // truncated raw response
  parsed: boolean
}

export interface CategoryScore {
  category: BenchmarkCategory
  score: number // 0..1 average across cases
  samples: number
}

export interface ModelResult {
  model: string
  provider: 'local' | 'gemini'
  overallScore: number // 0..1 weighted
  categories: CategoryScore[]
  metrics: {
    latencyAvgMs: number
    latencyP95Ms: number
    testsRun: number
    failures: number
  }
  details: TestOutcome[]
}

export interface BenchmarkModelInfo {
  id: string
  label: string
  provider: 'local' | 'gemini'
  available: boolean
  detail?: string
  sizeBytes?: number
  /** Probed parameter size in billions (0.5 = 0.5B) when known. */
  paramSizeB?: number | null
  /** Computed tier for local models: fast ≤3B / standard 3–7B / deep 7B+. */
  tier?: 'fast' | 'standard' | 'deep' | null
}

/**
 * Delivery configuration a run measures.
 *
 * - 'turbo' (default) — every call is sent EXACTLY like RED Justice's
 *   production scans: chain-of-thought disabled on thinking models
 *   (Ollama think:false) + JSON grammar enforced (format:"json"). This is
 *   5-10× faster on Qwen3-class hybrid models with no extraction-quality
 *   loss, and measures "models as the app actually deploys them".
 * - 'quality' — model defaults, thinking allowed, no grammar constraint:
 *   raw model capability (much slower on hybrid thinking models).
 */
export type BenchmarkRunMode = 'turbo' | 'quality'

/** Coerce unknown API input into a valid mode (default: turbo). */
export function resolveRunMode(mode: unknown): BenchmarkRunMode {
  return mode === 'quality' ? 'quality' : 'turbo'
}

export interface BenchmarkRunConfig {
  suite: BenchmarkSuite
  caseCount: number // 1..5
  seed?: number
  mode?: BenchmarkRunMode
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress (persisted to BenchmarkRun.progressJson for UI polling)
// ─────────────────────────────────────────────────────────────────────────────

export interface BenchmarkProgress {
  done: number
  total: number
  currentModel?: string
  currentTest?: string
  perModel?: Array<{ model: string; provider: string; done: number; total: number; status: 'pending' | 'running' | 'complete' }>
}
