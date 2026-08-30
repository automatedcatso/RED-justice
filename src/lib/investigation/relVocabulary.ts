/**
 * relVocabulary.ts — the SINGLE source of truth for relationship-type
 * vocabulary (v3.6 DYNAMIC EVIDENCE-DRIVEN RELATIONSHIPS).
 *
 * Before v3.6 the system had SIX disconnected hardcoded verb sets:
 *
 *   graph/route.ts        SEMANTIC_TYPES   (read gate — novel types starved)
 *   relTableExtract.ts    RENDERABLE_RELS  (unknown table verbs → ASSOCIATED_WITH)
 *   smartConnect.ts       STORY_REL_MAP    (unmapped AI verbs → dropped)
 *   aiScan.ts             REGISTRY_REL_OK  (unmapped registry verbs → dropped)
 *   crossConnect.ts       VALID_RELS       (6 verbs only → everything else dropped)
 *   aiScanPrompts.ts      verb lists       ("rel MUST be one of these")
 *
 * An investigator uploading a Palantir export with a verb like
 * `SUPPLIED_DRUGS_TO` or an FIR where the AI infers `RECRUITED_BY` lost the
 * intelligence: the verb was either mislabeled as a generic association or
 * dropped entirely. That is unacceptable for criminal-network analysis where
 * the RELATIONSHIP ITSELF is the evidence.
 *
 * v3.6 philosophy: **EVIDENCE DECIDES THE VOCABULARY.**
 *   - A curated CORE of canonical types (with rendering hints) covers every
 *     verb seen in practice.
 *   - Synonym maps translate foreign vocabularies (i2/Palantir exports, AI
 *     snake_case verbs, OCR-truncated registry verbs) onto the core.
 *   - Any OTHER well-formed verb is a NOVEL TYPE and is kept verbatim as a
 *     first-class edge type — persisted, rendered, filterable, explained.
 *   - Only mechanical co-occurrence (CO_OCCURRED) is budget-capped in the
 *     graph API; every evidence-derived type is always rendered.
 *
 * Fully deterministic. No AI. No React.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Canonical core vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core canonical edge types. This set carries every relationship verb the
 * platform itself emits plus the ones exports/AI reliably produce. It is NOT
 * an allow-list — it is the "well-known types" catalogue used for synonym
 * mapping and UI rendering hints. Membership is NOT required to persist or
 * render a type.
 */
export const CORE_REL_TYPES: readonly string[] = [
  // Financial
  'TRANSFERRED_TO',
  'OWNS',
  'USES',
  'CONTROLS_ACCOUNT',
  // Identity / infrastructure
  'SHARED_IDENTIFIER',
  'ACCESSED_BY',
  'CONNECTED_TO',
  'IDENTIFIED_BY',
  // Employment / corporate
  'WORKS_FOR',
  'EMPLOYS',
  'DIRECTOR_OF',
  'MEMBER_OF',
  'AFFILIATED_WITH',
  // Places / registration
  'REGISTERED_AT',
  'LOCATED_AT',
  'STUDIED_AT',
  // Movement / vehicles
  'USED_VEHICLE',
  'TRAVELED_WITH',
  // Communication
  'CALLED',
  'COMMUNICATED_WITH',
  // Association
  'ASSOCIATED_WITH',
  'RELATED_TO',
  'MENTIONED_IN',
  // Documents / authority
  'ISSUED_BY',
  'SIGNED_BY',
  'AUTHORIZED_BY',
  'RECOMMENDS',
  // Registry extras (annexure tables historically emit these)
  'KNOWS',
  'PART_OF',
  'SAME_AS',
  'CALLS',
  'RELATES_TO',
]

export const CORE_REL_SET: ReadonlySet<string> = new Set(CORE_REL_TYPES)

/** Mechanical (non-semantic) types produced by analytics, not evidence. */
export const MECHANICAL_REL_TYPES: ReadonlySet<string> = new Set(['CO_OCCURRED'])

// ─────────────────────────────────────────────────────────────────────────────
// Synonym / translation maps (foreign vocabularies → canonical core)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Table/registry/export verbs (UPPER_SNAKE) that translate onto a canonical
 * type. Merged from the former REL_CANON + REL_ALIASES + registry vocab.
 * Anything NOT here but well-formed is KEPT as a novel type — so this map
 * only needs entries where a DIFFERENT canonical label is strictly better.
 */
export const REL_SYNONYMS: Record<string, string> = {
  // Communication
  MESSAGED: 'COMMUNICATED_WITH', WHATSAPPED: 'COMMUNICATED_WITH',
  SMS: 'COMMUNICATED_WITH', EMAILED: 'COMMUNICATED_WITH',
  CHATTED_WITH: 'COMMUNICATED_WITH', TALKED_TO: 'COMMUNICATED_WITH',
  CONTACTED: 'COMMUNICATED_WITH', COMMUNICATED: 'COMMUNICATED_WITH',
  PHONE_CALL: 'CALLED', CALLS: 'CALLED',
  // Association
  MET: 'ASSOCIATED_WITH', KNOWS_OF: 'ASSOCIATED_WITH',
  ACQUAINTANCE_OF: 'ASSOCIATED_WITH', FRIEND_OF: 'ASSOCIATED_WITH',
  SEEN_WITH: 'ASSOCIATED_WITH', LINKED_TO: 'ASSOCIATED_WITH',
  ASSOCIATE_OF: 'ASSOCIATED_WITH', AFFILIATED: 'AFFILIATED_WITH',
  // Kinship
  RELATED: 'RELATED_TO', RELATIVE_OF: 'RELATED_TO', FAMILY_OF: 'RELATED_TO',
  BROTHER_OF: 'RELATED_TO', SISTER_OF: 'RELATED_TO', SON_OF: 'RELATED_TO',
  DAUGHTER_OF: 'RELATED_TO', WIFE_OF: 'RELATED_TO', HUSBAND_OF: 'RELATED_TO',
  FATHER_OF: 'RELATED_TO', MOTHER_OF: 'RELATED_TO', KIN_OF: 'RELATED_TO',
  // Money
  TRANSFERRED_MONEY_TO: 'TRANSFERRED_TO', SENT_MONEY_TO: 'TRANSFERRED_TO',
  PAID: 'TRANSFERRED_TO', PAID_TO: 'TRANSFERRED_TO',
  TRANSFER: 'TRANSFERRED_TO', TRANSFERRED: 'TRANSFERRED_TO',
  WIRED_TO: 'TRANSFERRED_TO', TRANSFERRED_CASH_TO: 'TRANSFERRED_TO',
  // Accounts / control
  OWNS_ACCOUNT: 'CONTROLS_ACCOUNT', CONTROLS: 'CONTROLS_ACCOUNT',
  SAME_AS: 'SAME_AS', SAME_IDENTITY: 'SHARED_IDENTIFIER',
  // Membership
  PART_OF: 'PART_OF', MEMBER: 'MEMBER_OF',
  // Access
  ACCESSED: 'ACCESSED_BY',
  // Study
  STUDIED: 'STUDIED_AT', STUDENT_OF: 'STUDIED_AT',
  // Employment
  EMPLOYED_AT: 'WORKS_FOR', WORKS_AT: 'WORKS_FOR', EMPLOYEE_OF: 'WORKS_FOR',
  // Residence
  STAYS_AT: 'REGISTERED_AT', RESIDES_AT: 'REGISTERED_AT',
  LIVES_AT: 'REGISTERED_AT', ADDRESS_OF: 'LOCATED_AT',
  RESIDES_IN: 'REGISTERED_AT', LOCATED_IN: 'LOCATED_AT',
  // Vehicles
  DRIVES: 'USED_VEHICLE', DROVE: 'USED_VEHICLE',
  // Documents
  MENTIONED: 'MENTIONED_IN', REFERENCES: 'MENTIONED_IN',
  ISSUED: 'ISSUED_BY', SIGNED: 'SIGNED_BY', AUTHORIZED: 'AUTHORIZED_BY',
  // OCR-truncation repair (registry tables on scanned documents)
  TRANSFERRED_T: 'TRANSFERRED_TO', TRANSFERRED_TO_: 'TRANSFERRED_TO',
  ASSOCIATED_WIT: 'ASSOCIATED_WITH', COMMUNICATED_WIT: 'COMMUNICATED_WITH',
  WORKS_FO: 'WORKS_FOR', DIRECTOR_O: 'DIRECTOR_OF', REGISTERED_A: 'REGISTERED_AT',
  CONTROLS_ACCOUN: 'CONTROLS_ACCOUNT', IDENTIFIED_B: 'IDENTIFIED_BY',
  USED_VEHICL: 'USED_VEHICLE', TRAVELED_WIT: 'TRAVELED_WITH',
  MENTIONED_I: 'MENTIONED_IN', STUDIED_A: 'STUDIED_AT', MEMBER_O: 'MEMBER_OF',
}

/**
 * Verbs whose table direction is REVERSED relative to the canonical edge.
 * e.g. row says "B RECEIVED_FROM A" ⇒ canonical edge A —TRANSFERRED_TO→ B.
 */
export const REL_REVERSE: Record<string, string> = {
  RECEIVED_FROM: 'TRANSFERRED_TO',
  RECEIVED_MONEY_FROM: 'TRANSFERRED_TO',
  PAID_BY: 'TRANSFERRED_TO',
  OWNED_BY: 'OWNS',
  EMPLOYED_BY: 'EMPLOYS',
  EMPLOYER_OF: 'EMPLOYS',
  ISSUED_TO: 'ISSUED_BY',
  DIRECTED_BY: 'DIRECTOR_OF',
  RECOMMENDED_BY: 'RECOMMENDS',
}

/**
 * AI snake_case verbs (story connections, crosslinks) → canonical types.
 * Merged from the former STORY_REL_MAP + crossConnect VALID_RELS. An AI verb
 * NOT in this map is sanitized and kept as a novel type (never dropped).
 */
export const AI_REL_SYNONYMS: Record<string, string> = {
  communicated_with: 'COMMUNICATED_WITH',
  transferred_money: 'TRANSFERRED_TO',
  associated_with: 'ASSOCIATED_WITH',
  located_at: 'LOCATED_AT',
  owns_account: 'CONTROLS_ACCOUNT',
  worked_for: 'WORKS_FOR',
  director_of: 'DIRECTOR_OF',
  traveled_with: 'TRAVELED_WITH',
  called: 'CALLED',
  used_vehicle: 'USED_VEHICLE',
  registered_at: 'REGISTERED_AT',
  same_identity: 'SHARED_IDENTIFIER',
  accessed_by: 'ACCESSED_BY',
  connected_to: 'CONNECTED_TO',
  owns: 'OWNS',
  uses: 'USES',
  affiliated_with: 'AFFILIATED_WITH',
  studied_at: 'STUDIED_AT',
  identified_by: 'IDENTIFIED_BY',
  issued_by: 'ISSUED_BY',
  signed_by: 'SIGNED_BY',
  authorized_by: 'AUTHORIZED_BY',
  employs: 'EMPLOYS',
  member_of: 'MEMBER_OF',
  related_to: 'RELATED_TO',
  recommends: 'RECOMMENDS',
  mentions: 'MENTIONED_IN',
  mentioned_in: 'MENTIONED_IN',
  relates_to: 'RELATES_TO',
  knows: 'KNOWS',
  part_of: 'PART_OF',
  same_as: 'SAME_AS',
  calls: 'CALLS',
  // reverse-direction AI verbs
  received_from: 'TRANSFERRED_TO',
  received_money_from: 'TRANSFERRED_TO',
  paid_by: 'TRANSFERRED_TO',
  owned_by: 'OWNS',
  employed_by: 'EMPLOYS',
  employed_at: 'WORKS_FOR',
  issued_to: 'ISSUED_BY',
  resides_at: 'REGISTERED_AT',
  resides_in: 'REGISTERED_AT',
  lives_at: 'REGISTERED_AT',
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitization — what counts as a valid NOVEL relationship verb
// ─────────────────────────────────────────────────────────────────────────────

/** Quality gate for a novel (unknown) verb: UPPER_SNAKE, 2-5 words, ≤48 chars. */
const NOVEL_REL_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,4}$/
const MAX_REL_LEN = 48

/**
 * Sanitize a raw verb into an UPPER_SNAKE candidate.
 * Lowercase/mixed input, hyphens and spaces become underscores.
 */
function toUpperSnake(raw: string): string {
  return raw
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()
    .slice(0, MAX_REL_LEN)
}

/** True when a sanitized candidate passes the novel-verb quality gate. */
function isWellFormedVerb(v: string): boolean {
  if (v.length < 2 || v.length > MAX_REL_LEN) return false
  if (!NOVEL_REL_RE.test(v)) return false
  // Must contain at least one letter and no run of digits-only segments.
  if (!/[A-Z]/.test(v)) return false
  const segs = v.split('_')
  if (segs.some((s) => s.length === 0)) return false
  // Reject empty meaning: single 1-char segment like "A".
  if (segs.length === 1 && v.length < 3) return false
  return true
}

export interface NormalizedRel {
  /** The edge type to persist (canonical OR novel, never invented). */
  type: string
  /** True when the raw verb's direction must be flipped. */
  reversed: boolean
  /** True when `type` is a NOVEL evidence-derived type (not in the core). */
  novel: boolean
  /** The sanitized UPPER_SNAKE form of the raw verb (for metadata). */
  raw: string
}

/**
 * Normalize an UPPER_SNAKE table/registry/export verb.
 * Order: reverse-map → core set → synonym map → novel gate → fallback.
 * Unknown-but-well-formed verbs are KEPT (novel=true).
 */
export function normalizeRelVerb(raw: string): NormalizedRel {
  const k = toUpperSnake(raw)
  if (!k) return { type: 'ASSOCIATED_WITH', reversed: false, novel: false, raw: '' }
  const rev = REL_REVERSE[k]
  if (rev) return { type: rev, reversed: true, novel: false, raw: k }
  if (CORE_REL_SET.has(k)) return { type: k, reversed: false, novel: false, raw: k }
  const canon = REL_SYNONYMS[k]
  if (canon) return { type: canon, reversed: false, novel: false, raw: k }
  if (isWellFormedVerb(k)) return { type: k, reversed: false, novel: true, raw: k }
  // Poorly formed (free text, numbers, garbage) → generic association, but
  // keep the raw form so provenance panels can show what the source wrote.
  return { type: 'ASSOCIATED_WITH', reversed: false, novel: false, raw: k }
}

/**
 * Normalize an AI-emitted (typically lowercase_snake) relationship verb.
 * Order: core (upper) → AI synonym map (incl. reverse verbs) → reverse-map →
 * synonym map → novel gate → fallback. Unknown-but-well-formed AI verbs
 * (e.g. `laundered_money_for`, `supplied_drugs_to`, `recruited_by`) are KEPT.
 */
export function normalizeAiRelVerb(raw: string): NormalizedRel {
  const kSnake = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const kUpper = toUpperSnake(raw)
  if (!kUpper) return { type: 'ASSOCIATED_WITH', reversed: false, novel: false, raw: '' }

  // Direct core hit (AI sometimes emits UPPERCASE).
  if (CORE_REL_SET.has(kUpper)) return { type: kUpper, reversed: false, novel: false, raw: kUpper }

  // AI synonym map (lowercase snake keys).
  const aiCanon = AI_REL_SYNONYMS[kSnake]
  if (aiCanon) {
    // Reverse-direction AI verbs: flip endpoints, keep canonical direction.
    const reversedOnly = ['received_from', 'received_money_from', 'paid_by', 'owned_by', 'employed_by', 'issued_to']
    return { type: aiCanon, reversed: reversedOnly.includes(kSnake), novel: false, raw: kUpper }
  }

  // Fall through to the generic table-verb normalizer (covers REL_REVERSE +
  // REL_SYNONYMS + the novel gate).
  return normalizeRelVerb(raw)
}

/** Back-compat: the former canonRel() shape used by relTableExtract. */
export function canonRel(raw: string): { rel: string; reversed: boolean; novel: boolean } {
  const n = normalizeRelVerb(raw)
  return { rel: n.type, reversed: n.reversed, novel: n.novel }
}

/**
 * v3.9.2 — verb normalization for STRUCTURED evidence rows (relationship
 * tables, registry annexures). When a table asserts a verb that is EXACTLY a
 * synonym key (MESSAGED, MET, WHATSAPPED…), the evidence is already using
 * precise, deliberate vocabulary in a dedicated column — folding it to the
 * canonical label (COMMUNICATED_WITH / ASSOCIATED_WITH) LOSES information
 * the document explicitly stated. Synonym folding stays active for AI-story
 * free-form verbs and truncated fragments; structured tables keep their
 * literal verb. (Same principle as the v3.6 novel-verb gate: evidence
 * decides the vocabulary.)
 */
export function evidenceRel(raw: string): { rel: string; reversed: boolean; novel: boolean } {
  const upper = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const n = normalizeRelVerb(raw)
  if (upper in REL_SYNONYMS && !REL_ALIASES_TRUNCATIONS.has(upper)) {
    return { rel: upper, reversed: n.reversed, novel: false }
  }
  return { rel: n.type, reversed: n.reversed, novel: n.novel }
}

/** Truncated fragments that must NEVER be kept literally (TRANSFERRED_T…). */
const REL_ALIASES_TRUNCATIONS = new Set<string>([
  'TRANSFERRED_T', 'ASSOCIATED_WIT', 'COMMUNICATED_WI', 'REGISTERED_A',
  'TRAVELED_WIT', 'USED_VEHICL', 'DIRECTOR_O', 'MENTIONED_I', 'MESSAGED_I',
])

/**
 * Is this edge type evidence-derived (semantic) rather than mechanical?
 * The graph API renders every evidence-derived type and only budget-caps
 * mechanical CO_OCCURRED edges.
 */
export function isEvidenceRelType(type: string): boolean {
  return type !== 'CO_OCCURRED'
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering hints (UI color / arrow semantics — HINTS, not gates)
// ─────────────────────────────────────────────────────────────────────────────

/** Stable palette for edge types without a dedicated color. */
const NOVEL_PALETTE: readonly string[] = [
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#eab308', // yellow
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#84cc16', // lime
]

/** Deterministic palette index for an arbitrary type string. */
function paletteIndex(type: string): number {
  let h = 0
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0
  return h % NOVEL_PALETTE.length
}

export interface RelRenderHint {
  color: string
  arrow: boolean
  dashed: boolean
}

/** Rendering hints for any edge type — core types get curated treatment. */
export function relRenderHint(type: string): RelRenderHint {
  if (type === 'TRANSFERRED_TO') return { color: '#14b8a6', arrow: true, dashed: false }
  if (type === 'CO_OCCURRED') return { color: '#94a3b8', arrow: false, dashed: false }
  if (type === 'SHARED_IDENTIFIER') return { color: '#f97316', arrow: false, dashed: true }
  if (type === 'COMMUNICATED_WITH' || type === 'CALLED') return { color: '#3b82f6', arrow: true, dashed: false }
  if (type === 'WORKS_FOR' || type === 'EMPLOYS' || type === 'DIRECTOR_OF' || type === 'MEMBER_OF')
    return { color: '#8b5cf6', arrow: true, dashed: false }
  if (type === 'USED_VEHICLE' || type === 'TRAVELED_WITH') return { color: '#a16207', arrow: false, dashed: false }
  if (type === 'ASSOCIATED_WITH' || type === 'RELATED_TO' || type === 'KNOWS')
    return { color: '#64748b', arrow: false, dashed: false }
  if (type === 'LOCATED_AT' || type === 'REGISTERED_AT' || type === 'STUDIED_AT')
    return { color: '#0ea5e9', arrow: false, dashed: false }
  if (type === 'CONTROLS_ACCOUNT' || type === 'OWNS' || type === 'USES')
    return { color: '#059669', arrow: false, dashed: false }
  if (type === 'IDENTIFIED_BY' || type === 'ISSUED_BY' || type === 'SIGNED_BY' ||
      type === 'AUTHORIZED_BY' || type === 'MENTIONED_IN')
    return { color: '#7c3aed', arrow: false, dashed: false }
  // NOVEL type — deterministic palette color so every new verb is visually
  // distinct yet stable across renders.
  return { color: NOVEL_PALETTE[paletteIndex(type)], arrow: false, dashed: false }
}
