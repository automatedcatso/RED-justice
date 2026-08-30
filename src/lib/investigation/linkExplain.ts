/**
 * linkExplain.ts — "Why are these two nodes connected?" engine (v3.0).
 *
 * Two layers:
 *
 *   1. `whyConnected` — the deterministic sentence builder (edge type +
 *      provenance + rationale + shared-evidence count). Instant, always
 *      available, used as the fallback layer.
 *
 *   2. `aiExplainLink` — the AI narrative. Gathers the two entities, the
 *      relationship rows between them, the SHARED EVIDENCE FILES and REAL
 *      TEXT EXCERPTS around every mention of both values, then asks the
 *      local model to explain the connection in plain investigative
 *      language ("Aarav Sharma is a student of MIT College — the LOR names
 *      him with registration number MH2023-0417…"). This is the layer the
 *      user asked for: explanations authored by the AI, not templates.
 */

import { LINK_EXPLAIN_SYSTEM_PROMPT } from './aiScanPrompts'

export type WhyMeta = Record<string, unknown>

/**
 * Human-readable "why are these two nodes connected" sentence. Combines the
 * edge type, provenance engine, metadata rationale and the number of
 * evidence files that mention BOTH endpoints.
 */
export function whyConnected(
  r: {
    type: string
    weight: number
    evidenceRef: string | null
    provenance: string | null
  },
  rationale: string | undefined,
  sharedEvidence: number,
  meta: WhyMeta,
): string {
  const parts: string[] = []
  const ref = r.evidenceRef ? `"${r.evidenceRef}"` : 'the source document'
  switch (r.type) {
    case 'TRANSFERRED_TO':
      parts.push('A money transfer between the two is recorded in ' + ref + '.')
      break
    case 'COMMUNICATED_WITH':
    case 'CALLED':
      parts.push('A call/communication between the two is recorded in ' + ref + '.')
      break
    case 'SHARED_IDENTIFIER':
      if (meta.kind === 'name-alias') {
        const sim = typeof meta.similarity === 'number' ? ` (similarity ${meta.similarity.toFixed(2)})` : ''
        parts.push('Both names appear to denote the same actor under different aliases' + sim + '.')
      } else {
        parts.push('The two share an identifier across documents.')
      }
      break
    case 'CONTROLS_ACCOUNT':
      parts.push('The account is attributed to this actor in ' + ref + '.')
      break
    case 'LOCATED_AT':
      parts.push('The document places this actor/entity at this location.')
      break
    case 'WORKS_FOR':
    case 'EMPLOYS':
      parts.push('An employment/role link between the two is stated in ' + ref + '.')
      break
    case 'DIRECTOR_OF':
      parts.push('A directorship between the two is stated in ' + ref + '.')
      break
    case 'AFFILIATED_WITH':
    case 'STUDIED_AT':
    case 'MEMBER_OF':
      parts.push('A membership/affiliation between the two is stated in ' + ref + '.')
      break
    case 'IDENTIFIED_BY':
      parts.push(ref + ' identifies one entity as belonging to / describing the other (registration number, ID, attribute).')
      break
    case 'ISSUED_BY':
      parts.push('The document/certificate was issued by this authority per ' + ref + '.')
      break
    case 'SIGNED_BY':
      parts.push('The document was signed by this person per ' + ref + '.')
      break
    case 'AUTHORIZED_BY':
      parts.push('The action/document was authorized by this person per ' + ref + '.')
      break
    case 'RECOMMENDS':
      parts.push('A recommendation between the two is made in ' + ref + '.')
      break
    case 'RELATED_TO':
      parts.push('A personal/family relationship between the two is stated in ' + ref + '.')
      break
    case 'USED_VEHICLE':
      parts.push('The vehicle is linked to this actor in ' + ref + '.')
      break
    default: {
      const isCo = r.type === 'CO_OCCURRED' || (r.provenance ?? '').includes('co-occurrence')
      if (isCo) {
        const dist = typeof meta.distance === 'number' ? meta.distance : null
        parts.push(
          'Both values appear in the same passage of ' + ref +
          (dist != null ? ` (${dist} chars apart)` : '') + '.',
        )
        if (r.weight > 1) {
          parts.push(`The pair was re-observed across ${r.weight} scan passes/documents.`)
        }
      } else {
        parts.push('This relationship was extracted from ' + ref + '.')
      }
    }
  }
  if (sharedEvidence > 1) {
    parts.push(`${sharedEvidence} evidence files mention both endpoints.`)
  }
  if (r.provenance === 'ai-story') {
    parts.push('Connection inferred by the AI story engine from the document narrative.')
  } else if (r.provenance === 'ai-crosslink') {
    parts.push('Connection inferred across separate evidence files by the AI cross-link engine.')
  } else if (r.provenance === 'alias-resolution') {
    parts.push('Connection created by identity/alias resolution.')
  }
  return parts.join(' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence excerpt mining — feed the AI REAL document text
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkExcerpt {
  evidenceName: string
  /** Text windows around mentions of the two values in that file. */
  snippets: string[]
}

/**
 * Find ±window-char excerpts of the evidence files that mention BOTH values.
 * Digit-normalized containment handles formatted identifiers
 * ("+91-99999-10001" vs "9999910001").
 */
export function mineLinkExcerpts(
  files: Array<{ name: string; content: string }>,
  valueA: string,
  valueB: string,
  window = 170,
  maxSnippetsPerFile = 3,
  maxCharsPerSnippet = 460,
): LinkExcerpt[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[^0-9a-z]/g, '')
  const out: LinkExcerpt[] = []

  const findOffsets = (text: string, value: string): number[] => {
    const offsets: number[] = []
    const lower = text.toLowerCase()
    const push = (needle: string): void => {
      if (!needle) return
      let i = lower.indexOf(needle)
      while (i !== -1 && offsets.length < 8) {
        offsets.push(i)
        i = lower.indexOf(needle, i + needle.length)
      }
    }
    push(value.toLowerCase())
    if (offsets.length === 0) {
      const digits = norm(value)
      if (digits.length >= 4) push(digits)
    }
    return offsets
  }

  for (const f of files) {
    if (!f.content) continue
    const aOffsets = findOffsets(f.content, valueA)
    const bOffsets = findOffsets(f.content, valueB)
    if (aOffsets.length === 0 && bOffsets.length === 0) continue
    const snippets: string[] = []
    const cut = (at: number): string => {
      const start = Math.max(0, at - window)
      const end = Math.min(f.content.length, at + window)
      const raw = f.content.slice(start, end).replace(/\s+/g, ' ').trim()
      return raw.length > maxCharsPerSnippet ? raw.slice(0, maxCharsPerSnippet) + '…' : raw
    }
    for (const a of aOffsets.slice(0, 2)) snippets.push(cut(a))
    for (const b of bOffsets.slice(0, 2)) {
      if (snippets.length >= maxSnippetsPerFile) break
      snippets.push(cut(b))
    }
    if (snippets.length > 0) out.push({ evidenceName: f.name, snippets })
    if (out.length >= 3) break
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// AI narrative
// ─────────────────────────────────────────────────────────────────────────────

export interface AiLinkExplanation {
  explanation: string
  aiAvailable: boolean
  model: string
}

/**
 * Ask the local AI to explain why two entities are connected, grounded in
 * the relationship metadata + real document excerpts. Never throws — on
 * failure returns aiAvailable:false so the caller can fall back to the
 * deterministic sentence.
 */
export async function aiExplainLink(input: {
  srcLabel: string
  srcType: string
  dstLabel: string
  dstType: string
  relationTypes: string[]
  confidence: number | null
  provenance: string | null
  rationale?: string
  excerpts: LinkExcerpt[]
  sharedEvidenceFiles: string[]
}): Promise<AiLinkExplanation> {
  try {
    const { localChatDetailed, isLocalAiConfigured } = await import('@/lib/localAi')
    if (!isLocalAiConfigured()) {
      return { explanation: '', aiAvailable: false, model: 'ai-offline' }
    }

    const excerptBlock = input.excerpts.length
      ? input.excerpts
          .map(
            (e) =>
              `FILE "${e.evidenceName}":\n${e.snippets.map((s) => `  …${s}…`).join('\n  …')}`,
          )
          .join('\n\n')
      : '(no raw excerpts available — reason only from the facts below)'

    const user = `ENTITY A: ${input.srcLabel} (type: ${input.srcType})
ENTITY B: ${input.dstLabel} (type: ${input.dstType})
RELATIONSHIP: ${input.relationTypes.join(', ')}
CONFIDENCE: ${input.confidence != null ? input.confidence.toFixed(2) : 'n/a'}
ORIGIN: ${input.provenance ?? 'unknown'}
AI RATIONALE RECORDED WHEN THE LINK WAS CREATED: ${input.rationale || '(none)'}
SHARED EVIDENCE FILES: ${input.sharedEvidenceFiles.length ? input.sharedEvidenceFiles.join(', ') : '(none)'}

=== DOCUMENT EXCERPTS ===
${excerptBlock}

Explain why A and B are connected.`

    // v3.3 tier routing: "why are these connected?" is genuine reasoning →
    // DEEP tier with chain-of-thought ENABLED (the user explicitly waits for
    // this answer — quality over latency). The token budget must leave room
    // for the thinking channel AND the final narrative.
    const { modelForTier } = await import('@/lib/modelTiers')
    const deepModel = await modelForTier('deep')
    const raw = await localChatDetailed(
      [
        { role: 'system', content: LINK_EXPLAIN_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      { model: deepModel, maxTokens: 2400, tier: 'deep' },
    )
    const text = raw.content.replace(/^["'\s]+|["'\s]+$/g, '').trim()
    if (!text) return { explanation: '', aiAvailable: false, model: raw.model || 'ai-empty' }
    return { explanation: text.slice(0, 1500), aiAvailable: true, model: raw.model || 'local-ai' }
  } catch (err) {
    console.error('[linkExplain] AI explanation failed:', err instanceof Error ? err.message : err)
    return { explanation: '', aiAvailable: false, model: 'ai-unavailable' }
  }
}
