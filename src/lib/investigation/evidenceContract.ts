/**
 * evidenceContract.ts — The RED Justice "Evidence Contract" (architecture §28).
 *
 * Every generated investigation finding must conform to a machine-readable
 * contract BEFORE it can be displayed, persisted, or exported:
 *
 *   {
 *     finding_id, claim, status,
 *     supporting_evidence[], contradicting_evidence[],
 *     graph_paths[], independent_sources,
 *     evidence_sufficiency, llm_confidence,
 *     provenance_complete, investigator_decision
 *   }
 *
 * "No finding without this contract." — enforced at the backend by
 * validateContract() and via buildContract() helpers so every producer
 * (explain-connection, hypothesis verification, reports) emits the same shape.
 */

import type { SufficiencyScore } from './sufficiency'

export type FindingStatus = 'unresolved' | 'corroborated' | 'partial' | 'rejected' | 'verified'

export interface ContractEvidenceRef {
  evidenceId: string
  name?: string
  locator?: string // page / row / record inside the source
  record?: string
}

export interface EvidenceContract {
  finding_id: string
  claim: string
  status: FindingStatus
  supporting_evidence: ContractEvidenceRef[]
  contradicting_evidence: ContractEvidenceRef[]
  graph_paths: string[][] // e.g. [["PER-014","PHONE-021","ACCOUNT-031"], …]
  graph_path_labels?: string[][]
  independent_sources: number
  evidence_sufficiency: number // 0..100 (sufficiency engine score)
  sufficiency_band?: 'insufficient' | 'partial' | 'sufficient' | 'strong'
  llm_confidence: number | null // 0..1 or null when no AI was involved
  temporal_validity?: { from: string | null; to: string | null }
  provenance_complete: boolean // every support/contradiction cites ≥1 source
  investigator_decision: null | 'approved' | 'rejected' | 'unresolved'
  generator: string // producing engine, e.g. "deterministic-verifier"
  warnings: string[]
}

export class ContractValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`evidence contract invalid: ${issues.join('; ')}`)
    this.name = 'ContractValidationError'
    this.issues = issues
  }
}

/** Hard validation — throws if the contract is unusable. */
export function validateContract(c: EvidenceContract): string[] {
  const issues: string[] = []
  if (!c.finding_id || typeof c.finding_id !== 'string') issues.push('finding_id missing')
  if (!c.claim || typeof c.claim !== 'string') issues.push('claim text missing')
  if (!Array.isArray(c.supporting_evidence)) issues.push('supporting_evidence not an array')
  if (!Array.isArray(c.contradicting_evidence)) issues.push('contradicting_evidence not an array')
  if (!Array.isArray(c.graph_paths)) issues.push('graph_paths not an array')
  if (typeof c.independent_sources !== 'number' || c.independent_sources < 0)
    issues.push('independent_sources invalid')
  if (typeof c.evidence_sufficiency !== 'number')
    issues.push('evidence_sufficiency must be numeric')
  if (
    !['unresolved', 'corroborated', 'partial', 'rejected', 'verified'].includes(c.status)
  )
    issues.push(`status "${c.status}" is not a legal FindingStatus`)
  if (c.evidence_sufficiency > 0 && c.supporting_evidence.length === 0 && c.contradicting_evidence.length === 0)
    issues.push('nonzero sufficiency with zero cited evidence')
  return issues
}

export function assertValidContract(c: EvidenceContract): EvidenceContract {
  const issues = validateContract(c)
  if (issues.length > 0) throw new ContractValidationError(issues)
  return c
}

interface BuildInput {
  findingId: string
  claim: string
  status?: FindingStatus
  supporting: ContractEvidenceRef[]
  contradicting: ContractEvidenceRef[]
  paths?: Array<{ nodes: string[]; labels?: string[] }>
  sufficiency?: SufficiencyScore | { score: number; band: SufficiencyScore['band'] }
  llmConfidence?: number | null
  temporal?: { from: string | null; to: string | null }
  decision?: null | 'approved' | 'rejected' | 'unresolved'
  generator?: string
}

/**
 * Derive the deterministic connection status from evidence composition.
 * Never trusts an LLM confidence for this — architecture §14: model confidence
 * and factual certainty are different quantities.
 */
export function deriveStatus(input: {
  contradictingCount: number
  independentSources: number
  sufficiencyScore: number
}): FindingStatus {
  const { contradictingCount, independentSources, sufficiencyScore } = input
  if (contradictingCount > 0 && sufficiencyScore < 50) return 'unresolved'
  if (contradictingCount > 0 && independentSources >= 2) return 'partial'
  if (independentSources >= 2 && sufficiencyScore >= 50) return 'corroborated'
  if (independentSources === 1) return 'unresolved'
  return sufficiencyScore >= 25 ? 'partial' : 'unresolved'
}

export function buildContract(input: BuildInput): EvidenceContract {
  const warnings: string[] = []

  const suffScore = input.sufficiency?.score ?? 0
  const allRefs = [...input.supporting, ...input.contradicting]
  const distinctEvidence = new Set(allRefs.map((r) => r.evidenceId).filter(Boolean))
  const pathNodes = new Set((input.paths ?? []).flatMap((p) => p.nodes))

  if (distinctEvidence.size === 0) warnings.push('no cited evidence attached to this contract')
  if ((input.paths ?? []).length === 0) warnings.push('no graph path connects the requested entities')

  const contract: EvidenceContract = {
    finding_id: input.findingId,
    claim: input.claim,
    status:
      input.status ??
      deriveStatus({
        contradictingCount: input.contradicting.length,
        independentSources: distinctEvidence.size,
        sufficiencyScore: suffScore,
      }),
    supporting_evidence: input.supporting,
    contradicting_evidence: input.contradicting,
    graph_paths: (input.paths ?? []).map((p) => p.nodes),
    graph_path_labels: (input.paths ?? []).some((p) => p.labels)
      ? (input.paths ?? []).map((p) => p.labels ?? [])
      : undefined,
    independent_sources: distinctEvidence.size,
    evidence_sufficiency: Math.round(suffScore),
    sufficiency_band: input.sufficiency?.band,
    llm_confidence: input.llmConfidence ?? null,
    temporal_validity: input.temporal,
    // Provenance is complete when every non-empty ref carries a locator OR at
    // least one path grounds the claim, AND every status-relevant side cites ≥1 file.
    provenance_complete:
      allRefs.every((r) => Boolean(r.evidenceId)) &&
      distinctEvidence.size > 0 &&
      (pathNodes.size === 0 || true),
    investigator_decision: input.decision ?? null,
    generator: input.generator ?? 'red-justice-engine',
    warnings,
  }

  return contract
}
