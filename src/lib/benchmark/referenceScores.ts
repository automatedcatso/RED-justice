/**
 * referenceScores.ts — PUBLISHED benchmark reference table.
 *
 * Approximate public scores for well-known models, from official model cards
 * and public leaderboards. These are CONTEXT for the live Benchmark Lab
 * results — they are NOT live-tested here and different evaluation harnesses
 * produce different numbers. Verify against official model cards.
 */

export interface ReferenceModel {
  model: string
  params: string
  mmlu: number | null
  gpqa: number | null
  math: number | null
  humaneval: number | null
  extra?: string
  notes: string
}

export const REFERENCE_MODELS: ReferenceModel[] = [
  { model: 'GPT-4o (2024-05)', params: '—', mmlu: 88.7, gpqa: 53.6, math: 76.6, humaneval: 90.2, notes: 'OpenAI flagship multimodal (closed)' },
  { model: 'GPT-4o mini', params: '—', mmlu: 82.0, gpqa: 40.0, math: 87.8, humaneval: 87.2, notes: 'Small closed sibling (GPQA ≈)' },
  { model: 'Claude 3.5 Sonnet', params: '—', mmlu: 88.3, gpqa: 59.0, math: 71.0, humaneval: 92.0, notes: 'Anthropic (closed)' },
  { model: 'Claude Sonnet 4', params: '—', mmlu: 89.0, gpqa: 73.0, math: null, humaneval: null, extra: 'SWE-bench ≈ 73', notes: 'Anthropic (closed), strong coding' },
  { model: 'Gemini 2.5 Pro', params: '—', mmlu: 86.0, gpqa: 86.0, math: 92.0, humaneval: null, extra: 'AIME ≈ 88', notes: 'Google flagship thinking model' },
  { model: 'Gemini 2.0 Flash', params: '—', mmlu: 78.0, gpqa: null, math: 73.0, humaneval: null, notes: 'Google fast tier — available in your Benchmark Lab' },
  { model: 'Llama 3.1 8B', params: '8B', mmlu: 69.4, gpqa: null, math: 52.0, humaneval: 72.6, notes: 'Meta open-weights — runs on modest local hardware' },
  { model: 'Llama 3.1 70B', params: '70B', mmlu: 85.3, gpqa: null, math: 69.0, humaneval: 80.5, notes: 'Meta open-weights' },
  { model: 'Llama 3.1 405B', params: '405B', mmlu: 88.6, gpqa: null, math: 74.0, humaneval: 89.0, notes: 'Largest open-weights Llama' },
  { model: 'Llama 3.3 70B', params: '70B', mmlu: 86.0, gpqa: null, math: 77.0, humaneval: 88.4, notes: 'Tuned successor to 3.1 70B' },
  { model: 'Qwen 2.5 7B', params: '7B', mmlu: 74.3, gpqa: null, math: 76.0, humaneval: 74.0, notes: 'Alibaba open-weights, strong at math' },
  { model: 'Qwen 2.5 72B', params: '72B', mmlu: 85.3, gpqa: null, math: 84.0, humaneval: 84.0, notes: 'Alibaba open-weights flagship' },
  { model: 'DeepSeek V3', params: '671B MoE', mmlu: 88.5, gpqa: null, math: 90.2, humaneval: 92.0, notes: 'Open-weights MoE' },
  { model: 'DeepSeek R1', params: '671B MoE', mmlu: 90.8, gpqa: null, math: 97.3, humaneval: null, extra: 'AIME 79.8', notes: 'Open-weights reasoning model' },
  { model: 'Mistral Large 2', params: '123B', mmlu: 84.0, gpqa: null, math: 70.0, humaneval: 84.0, notes: 'Mistral open-weights flagship' },
  { model: 'Gemma 2 27B', params: '27B', mmlu: 79.0, gpqa: null, math: 65.0, humaneval: 76.0, notes: 'Google open-weights' },
  { model: 'Phi-4 14B', params: '14B', mmlu: 85.0, gpqa: null, math: 80.0, humaneval: null, notes: 'Microsoft small-but-strong' },
  { model: 'gpt-oss-20b', params: '20B MoE', mmlu: null, gpqa: null, math: null, humaneval: null, extra: 'AIME ≈ 80', notes: 'OpenAI open-weights, reasoning-optimized' },
]

export const REFERENCE_FOOTNOTE =
  'Scores vary by evaluation harness and snapshot; verify against official model cards. These reference numbers contextualize your LIVE Benchmark Lab results — they are not live-tested here.'
