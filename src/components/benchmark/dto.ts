/**
 * dto.ts — client-side types for the Benchmark Lab API surface.
 */

export interface BenchmarkModelDto {
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

export interface ModelsResponse {
  models: BenchmarkModelDto[]
  providers: {
    local: { available: boolean; endpoint: string; error?: string; count: number }
    gemini: { configured: boolean; available: boolean; error?: string }
  }
}

export interface CategoryScoreDto {
  category: string
  score: number
  samples: number
}

export interface ResultMetricsDto {
  latencyAvgMs?: number
  latencyP95Ms?: number
  testsRun?: number
  failures?: number
  suite?: string
  caseCount?: number
  seed?: number
  /** 'turbo' (production scan config) or 'quality' (raw model defaults). */
  mode?: string
}

export interface TestDetailDto {
  category: string
  label: string
  caseIndex: number
  score: number
  notes: string
  latencyMs: number
  error?: string
  responsePreview: string
  parsed: boolean
}

export interface ResultSummaryDto {
  id: string
  model: string
  provider: string
  overallScore: number
  categoryScores: CategoryScoreDto[]
  metrics: ResultMetricsDto
  createdAt: string
}

export interface ResultFullDto extends ResultSummaryDto {
  details: TestDetailDto[]
}

export interface ProgressDto {
  done?: number
  total?: number
  currentModel?: string
  currentTest?: string
  perModel?: Array<{ model: string; provider: string; done: number; total: number; status: 'pending' | 'running' | 'complete' }>
}

export interface RunSummaryDto {
  id: string
  label?: string
  status: string
  error?: string
  createdAt: string
  finishedAt?: string
  config: { suite?: string; caseCount?: number; seed?: number; mode?: string }
  progress: ProgressDto
  models: Array<{ id: string; provider: string }>
  results: ResultSummaryDto[]
}

export interface RunFullDto extends RunSummaryDto {
  results: ResultFullDto[]
}

export interface RunsResponse {
  runs: RunSummaryDto[]
}
