/**
 * relTableExtract.ts — deterministic RELATIONSHIP-TABLE parser (v3.4).
 *
 * Investigators routinely export knowledge-graph data as DELIMITED EDGE
 * LISTS (CSV/TSV from i2 Analyst's Notebook, Palantir, Excel, or a prior
 * RED Justice case export):
 *
 *   relationship_id,source_name,source_type,relationship_type,target_name,target_type,event_date,confidence,...
 *   R0001,Arjun Sharma,PERSON,WORKS_FOR,Aster Logistics,ORGANIZATION,2026-01-01,0.78
 *
 * For such a document the regex layer recovers only the machine-pattern
 * values (phones, IMEIs, account numbers) and ZERO of the relationships —
 * and no small local model can re-emit hundreds of entities + connections
 * as JSON without truncating (the "only a fraction of entities were
 * connected" failure). But the file IS the graph, stated literally.
 *
 * This parser reads the table directly: every row's two endpoints become
 * graph entities (typed by the table's own type columns) and every row
 * becomes a typed edge — in milliseconds, with zero AI calls and 100%
 * recall. The AI pass then only needs to digest what the table MEANS
 * (one compact call — see runTurboEnrichment's reltable-digest mode).
 *
 * Fully deterministic. No AI. No React. English only.
 */

import { normalizeEntity } from './normalizers'
import type { EntityType } from './types'
import { evidenceRel } from '../investigation/relVocabulary'

// ─────────────────────────────────────────────────────────────────────────────
// Public result types
// ─────────────────────────────────────────────────────────────────────────────

export interface RelTableEntity {
  type: EntityType
  value: string
  context: string
  confidence: number
  /** The table's own ID for this endpoint (E0001, node_12, …) if the table
   *  carries ID columns — shown in the UI so investigators can trace rows
   *  back to the source export verbatim. A value can carry several IDs
   *  across rows (merged aliases); all are kept. */
  tableIds?: string[]
}

/** One verbatim source-table row (header → cell), kept for full-fidelity
 *  display in the edge provenance panel and the investigation timeline. */
export type RelTableRow = Record<string, string>

export interface RelTableEdge {
  from: string
  to: string
  fromType: EntityType
  toType: EntityType
  /** Canonical UPPER_SNAKE graph edge type (always graph-renderable). */
  rel: string
  /** Relationship verb exactly as written in the table (for the rationale). */
  rawRel: string
  why: string
  confidence: number
  timestamp?: string
  rowId?: string
  /** The table's own endpoint IDs (source_id / target_id columns). */
  srcTableId?: string
  tgtTableId?: string
  /** Corroboration state cell (observed / corroborated / …). */
  state?: string
  /** Extraction-method cell (entity-resolution, CDR-extraction, …). */
  method?: string
  /** Evidence references named in the row (evidence_ids column). */
  evidenceRefs?: string[]
  /** The COMPLETE raw row, header→cell verbatim. */
  row: RelTableRow
}

export interface RelTableExtraction {
  detected: boolean
  delimiter: string
  header: string[]
  rowCount: number
  entities: RelTableEntity[]
  edges: RelTableEdge[]
  /** Share of the document's non-empty lines that are table rows (0..1). */
  coverage: number
  /** Compact statistical digest of the table (fed to the AI digest call). */
  digest: string
  /** Document text OUTSIDE the table (prose around it), capped at 4K chars. */
  nonTableText: string
}

const NOT_DETECTED: RelTableExtraction = {
  detected: false,
  delimiter: '',
  header: [],
  rowCount: 0,
  entities: [],
  edges: [],
  coverage: 0,
  digest: '',
  nonTableText: '',
}

// ─────────────────────────────────────────────────────────────────────────────
// Delimited-line splitting (RFC-4180-ish, quote aware)
// ─────────────────────────────────────────────────────────────────────────────

function splitLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQ = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQ = true
    } else if (ch === delim) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

/** Header cell normalization: lowercase, trim, spaces/hyphens → underscore. */
function normHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-type label mapping (table's own vocabulary → canonical graph types)
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, EntityType> = {
  PERSON: 'person', PEOPLE: 'person', INDIVIDUAL: 'person', HUMAN: 'person',
  SUSPECT: 'person', ACCUSED: 'person', WITNESS: 'person', VICTIM: 'person',
  OFFICER: 'person', DIRECTOR: 'person', EMPLOYEE: 'person', STUDENT: 'person',
  ORGANIZATION: 'organization', ORGANISATION: 'organization', ORG: 'organization',
  COMPANY: 'organization', FIRM: 'organization', BUSINESS: 'organization',
  ENTERPRISE: 'organization', ESTABLISHMENT: 'organization', COLLEGE: 'organization',
  UNIVERSITY: 'organization', INSTITUTE: 'organization', SCHOOL: 'organization',
  BANK: 'organization', TRUST: 'organization', NGO: 'organization',
  PHONE: 'phone', MOBILE: 'phone', PHONE_NUMBER: 'phone', MOBILE_NUMBER: 'phone',
  CONTACT: 'phone', CONTACT_NUMBER: 'phone', WHATSAPP: 'phone', CELL: 'phone',
  MSISDN: 'phone', TELEPHONE: 'phone',
  BANK_ACCOUNT: 'account', ACCOUNT: 'account', ACCOUNT_NUMBER: 'account',
  BANK_ACC: 'account', A_C: 'account',
  DEVICE: 'device', MOBILE_DEVICE: 'device', HANDSET: 'device',
  PHONE_DEVICE: 'device', IMEI: 'imei',
  VEHICLE: 'vehicle', CAR: 'vehicle', AUTOMOBILE: 'vehicle',
  ADDRESS: 'location', LOCATION: 'location', PLACE: 'location', CITY: 'location',
  TOWN: 'location', AREA: 'location', DISTRICT: 'location', STATE: 'location',
  COUNTRY: 'location', LOCALITY: 'location',
  EVIDENCE_DOCUMENT: 'document_id', DOCUMENT: 'document_id', DOC: 'document_id',
  EVIDENCE: 'document_id', RECORD: 'document_id', FILE: 'document_id',
  EMAIL: 'email', MAIL: 'email', EMAIL_ID: 'email',
  UPI: 'upi', VPA: 'upi', UPI_ID: 'upi',
  IP: 'ip', IP_ADDRESS: 'ip',
  URL: 'url', WEBSITE: 'url',
  DOMAIN: 'domain',
  WALLET: 'wallet', CRYPTO_WALLET: 'wallet', CRYPTO: 'wallet',
  SOCIAL: 'social', SOCIAL_MEDIA: 'social', HANDLE: 'social',
  USERNAME: 'social', TWITTER: 'social', INSTAGRAM: 'social',
  SOCIAL_ACCOUNT: 'social', SOCIAL_PROFILE: 'social', ACCOUNT_HANDLE: 'social',
  EVENT: 'event', INCIDENT: 'event', OCCURRENCE: 'event',
  EMAIL_ADDRESS: 'email', MAIL_ADDRESS: 'email',
  IFSC: 'ifsc', IFSC_CODE: 'ifsc',
}

/** True when a label is a KNOWN entity-type label (used to keep entity
 *  registers from being misread as relationship tables). */
function isEntityTypeLabel(label: string): boolean {
  return mapType(label) !== null
}

/** Structural guess for values whose type label the table did not map. */
function guessType(value: string): EntityType {
  const v = value.trim()
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return 'email'
  if (/^\+?\d[\d\s-]{7,}$/.test(v)) return 'phone'
  if (/^imei[-\s]?\d{12,17}$/i.test(v)) return 'imei'
  if (/^\d{15}$/.test(v.replace(/\D/g, ''))) return 'imei'
  if (/^[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{1,4}$/i.test(v)) return 'vehicle'
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) return 'ifsc'
  if (/^(0x)?[0-9a-f]{25,}$/i.test(v)) return 'wallet'
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^[a-z0-9]+@[a-z]{2,}$/i.test(v)) return 'upi'
  if (/^\d{9,18}$/.test(v.replace(/\s/g, ''))) return 'account'
  if (/\b(pvt|ltd|llp|inc|corp|bank|enterprises|traders|logistics|trading|imports|exports|finance|services|retail|wholesale|brokers|systems|infoworks|exchange|mobility|components)\b/i.test(v)) {
    return 'organization'
  }
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/.test(v)) return 'person'
  if (/^\d+\s+[A-Za-z]/.test(v)) return 'location' // "415 Station Road, Pune"
  return 'other'
}

function mapType(label: string): EntityType | null {
  const k = label.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return TYPE_MAP[k] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Relationship-verb mapping — delegated to the shared relVocabulary (v3.6)
//
// v3.6: evidence decides the vocabulary. Table verbs are normalized through
// the SINGLE source of truth in src/lib/investigation/relVocabulary.ts:
// known verbs map onto canonical types, and any OTHER well-formed verb
// (e.g. SUPPLIED_DRUGS_TO, LAUNDERED_FOR, RECRUITED_BY from a Palantir/
// Analyst's-Notebook export) is KEPT verbatim as a first-class novel edge
// type instead of being mislabeled ASSOCIATED_WITH. The raw verb always
// survives in `rawRel` + the verbatim row snapshot for provenance.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Column detection
// ─────────────────────────────────────────────────────────────────────────────

const SRC_NAME_RE = /^(source|src|from|from_name|subject|subject_name|origin|sender|payer|entity_a|entity_1|node_a|node_1|a_name|source_name|source_entity|person_a|holder|account_holder)$/
const TGT_NAME_RE = /^(target|tgt|to|to_name|object|object_name|destination|dest|receiver|recipient|payee|entity_b|entity_2|node_b|node_2|b_name|target_name|target_entity|person_b|counterpart|connected_to)$/
const SRC_TYPE_RE = /^(source|src|from|subject|origin|sender|payer|entity_a|entity_1|node_a|node_1|a|source_entity)_(entity_)?type$/
const TGT_TYPE_RE = /^(target|tgt|to|object|destination|dest|receiver|recipient|payee|entity_b|entity_2|node_b|node_2|b|target_entity)_(entity_)?type$/
const SRC_ID_RE = /^(source|src|from|subject|origin|sender|payer|entity_a|entity_1|node_a|node_1|a|source_entity)_(id|uid|key|ref|ref_id|code)$/
const TGT_ID_RE = /^(target|tgt|to|object|destination|dest|receiver|recipient|payee|entity_b|entity_2|node_b|node_2|b|target_entity)_(id|uid|key|ref|ref_id|code)$/
const REL_COL_RE = /^(relationship|relationship_type|relation|relation_type|rel|rel_type|relationship_name|edge|edge_type|link_type|connection|connection_type|verb|interaction|interaction_type|association|association_type)$/
const ROW_ID_RE = /^(relationship_id|row_id|record_id|id|sr_no|s_no|serial_no|sl_no|no|#|ref)$/
const DATE_RE = /^(event_?date|date|timestamp|when|occurred_?on|occurred_?at|on|txn_?date|transaction_?date|time|dated|observed_?at|observed_?on|valid_?from|valid_?to|valid_until|first_?seen|last_?seen|event_?time|from_?date|to_?date)$/
const CONF_RE = /^(confidence|confidence_score|conf|score|prob|probability|certainty)$/
const STATE_RE = /^(state|status|verdict|corroboration)$/
const METHOD_RE = /^(extraction_method|method|technique|derived_from|source_method|basis)$/
const EVID_RE = /^(evidence|evidence_id|evidence_ids|evidence_ref|doc_ref|document_ref|source_doc|source_document)$/
const NAMEISH_RE = /_name$|^(name|entity|value|label)$|^name[__]?[0-9a]$/

interface Columns {
  srcName: number
  tgtName: number
  srcType: number
  tgtType: number
  rel: number
  rowId: number
  date: number
  conf: number
  state: number
  method: number
  evidence: number
  srcTableId: number
  tgtTableId: number
}

/** Identify the semantic columns of a delimited header row. */
function detectColumns(header: string[]): Columns | null {
  const h = header.map(normHeader)

  let srcName = h.findIndex((c) => SRC_NAME_RE.test(c))
  let tgtName = h.findIndex((c) => TGT_NAME_RE.test(c))

  // Fallback: two "name"-ish columns with type siblings (source_name +
  // target_name, name1/name2, entity/value pairs …). First → source,
  // second → target.
  if (srcName < 0 || tgtName < 0) {
    const nameish = h
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => NAMEISH_RE.test(c) && SRC_NAME_RE.test(c) === false && TGT_NAME_RE.test(c) === false && i !== srcName && i !== tgtName)
    if (nameish.length >= 2) {
      if (srcName < 0) srcName = nameish[0].i
      if (tgtName < 0) tgtName = nameish[1].i
    }
  }
  if (srcName < 0 || tgtName < 0 || srcName === tgtName) return null

  const srcType = h.findIndex((c) => SRC_TYPE_RE.test(c))
  const tgtType = h.findIndex((c) => TGT_TYPE_RE.test(c))
  let rel = h.findIndex((c) => REL_COL_RE.test(c))
  if (rel < 0) {
    // With BOTH endpoints present, a bare "type" column is the verb
    // (person,company,WORKS_FOR-style tables), not an entity-type column.
    rel = h.findIndex((c, i) => c === 'type' && i !== srcName && i !== tgtName)
  }

  return {
    srcName,
    tgtName,
    srcType: srcType >= 0 ? srcType : -1,
    tgtType: tgtType >= 0 ? tgtType : -1,
    rel,
    rowId: h.findIndex((c) => ROW_ID_RE.test(c) && !c.includes('source') && !c.includes('target')),
    date: h.findIndex((c) => DATE_RE.test(c)),
    conf: h.findIndex((c) => CONF_RE.test(c)),
    state: h.findIndex((c) => STATE_RE.test(c)),
    method: h.findIndex((c) => METHOD_RE.test(c)),
    evidence: h.findIndex((c) => EVID_RE.test(c)),
    srcTableId: h.findIndex((c) => SRC_ID_RE.test(c)),
    tgtTableId: h.findIndex((c) => TGT_ID_RE.test(c)),
  }
}

/**
 * Split a leading table-reference token off an endpoint cell:
 * "E0001 Arjun Sharma" → { ref: "E0001", name: "Arjun Sharma" }.
 * v3.9.1: relationship tables exported from entity registries prefix the
 * entity ID to the name in endpoint columns. Keeping the prefix glued into
 * the value creates a SECOND, differently-normalized node ("E0001 Arjun
 * Sharma") beside the registry's clean one ("Arjun Sharma") — duplicate
 * nodes and half-resolved edges. The ref must look like a real ID: starts
 * with a letter, 4-16 chars of [A-Za-z0-9_-] INCLUDING at least one digit
 * (rejects "Samsung Galaxy S24", "A2B Courier", "Q4 Report"…).
 */
function splitLeadingRef(cell: string): { ref: string; name: string } | null {
  const m = cell.match(/^([A-Za-z][A-Za-z0-9_-]{2,15})\s+(\S.*)$/)
  if (!m) return null
  const ref = m[1]
  if (!/\d/.test(ref)) return null
  const name = m[2].trim()
  if (name.length < 2) return null
  // A ref that is a plain word-with-digit ("FIR2026", "Case5") should not
  // swallow a following sentence — require the rest to be name-like (≤8 words).
  if (name.split(/\s+/).length > 8) return null
  return { ref, name }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference tokens — dataset-portable row/entity identifiers (v3.10)
// ─────────────────────────────────────────────────────────────────────────────

/** A machine-shaped reference token: 2+ char alpha prefix + digits with an
 *  optional hyphen/underscore (PER-002, ORG-001, E0001, R0042, NODE_12).
 *  Structural, NOT vocabulary-driven — any export's id scheme qualifies. */
const REF_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]{0,11}(?:[-_][A-Za-z0-9]{1,11})*[-_]?[0-9]{1,8}$/

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

const DELIMS = [',', '\t', ';', '|']

/** Parse a confidence cell into 0..1. */
function parseConfidence(raw: string | undefined): number | null {
  if (raw == null) return null
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  if (n <= 1) return n
  if (n <= 100) return n / 100
  return null
}

/** Loose date-ish validation (the schema stores timestamp as a string). */
function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const v = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2})?)?/.test(v)) return v
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v)) return v
  return undefined
}

/**
 * Detect and parse a delimited relationship/edge-list table. Returns
 * `detected: false` (empty result) when the document is not one.
 *
 * Two detection passes:
 *   1. GLOBAL — the delimiter whose per-line field count is consistent (≥75%)
 *      and ≥3 across the whole document (pure CSV/TSV exports).
 *   2. WINDOWED — the longest contiguous run of ≥3-field lines (≥6 lines),
 *      for tables embedded in prose (an annexure table inside an FIR).
 */
export function extractRelationshipTable(text: string): RelTableExtraction {
  const lines = text.split('\n').map((l) => l.trimEnd())
  const nonEmptyIdx: number[] = []
  lines.forEach((l, i) => {
    if (l.trim().length > 0) nonEmptyIdx.push(i)
  })
  if (nonEmptyIdx.length < 6) return NOT_DETECTED

  // Per-line field counts for every candidate delimiter (computed once).
  const countsByDelim = new Map<string, number[]>()
  for (const delim of DELIMS) {
    countsByDelim.set(
      delim,
      nonEmptyIdx.map((i) => splitLine(lines[i], delim).filter((f) => f.length > 0).length),
    )
  }

  // Try a header line (by index into nonEmptyIdx) → columns, or null.
  const tryColumns = (d: string, start: number): Columns | null => {
    const cells = splitLine(lines[nonEmptyIdx[start]], d)
    if (cells.filter((f) => f.length > 0).length < 3) return null
    return detectColumns(cells)
  }

  // Pass 1 — GLOBAL: the delimiter whose modal field count is ≥3 and covers
  // ≥75% of lines, whose FIRST line carries relationship columns.
  let delim = ''
  let regionStart = -1
  let regionEnd = -1
  let cols: Columns | null = null
  const globalCandidates: Array<{ d: string; ratio: number }> = []
  for (const [d, counts] of countsByDelim) {
    const freq = new Map<number, number>()
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1)
    let modal = 0
    let modalN = 0
    for (const [c, n] of freq) {
      if (n > modalN || (n === modalN && c > modal)) {
        modal = c
        modalN = n
      }
    }
    if (modal < 3) continue
    const ratio = modalN / counts.length
    if (ratio < 0.75) continue
    globalCandidates.push({ d, ratio })
  }
  globalCandidates.sort((a, b) => b.ratio - a.ratio)
  for (const { d } of globalCandidates) {
    const c = tryColumns(d, 0)
    if (c) {
      delim = d
      cols = c
      regionStart = 0
      regionEnd = countsByDelim.get(d)!.length - 1
      break
    }
  }

  // Pass 2 — WINDOWED: longest contiguous run of ≥3-field lines (≥6 lines)
  // whose header carries relationship columns — tables embedded in prose.
  // The first 3 lines of a run may each be tried as the header (title lines
  // above a table are common).
  if (!cols) {
    const runs: Array<{ d: string; s: number; e: number }> = []
    for (const [d, counts] of countsByDelim) {
      let s = 0
      while (s < counts.length) {
        if (counts[s] < 3) {
          s++
          continue
        }
        let e = s
        while (e + 1 < counts.length && counts[e + 1] >= 3) e++
        if (e - s + 1 >= 6) runs.push({ d, s, e })
        s = e + 1
      }
    }
    runs.sort((a, b) => b.e - b.s - (a.e - a.s))
    for (const run of runs) {
      for (let h = run.s; h <= Math.min(run.s + 2, run.e - 4); h++) {
        const c = tryColumns(run.d, h)
        if (c) {
          delim = run.d
          cols = c
          regionStart = h
          regionEnd = run.e
          break
        }
      }
      if (cols) break
    }
  }
  if (!cols) return NOT_DETECTED

  // 2. Header (first line of the detected region).
  const headerIdx = nonEmptyIdx[regionStart]
  const header = splitLine(lines[headerIdx], delim).filter((f) => f.length > 0)
  if (header.length < 3) return NOT_DETECTED

  // 3. Row parsing → entities + edges.
  const entityMap = new Map<string, RelTableEntity>()
  const edges: RelTableEdge[] = []
  const tableLineIdx = new Set<number>([headerIdx])
  let rowCount = 0
  // Raw header cells (unfiltered) — the verbatim key set for full rows.
  const headerCells = splitLine(lines[headerIdx], delim)

  const addEntity = (
    value: string,
    type: EntityType,
    confidence: number,
    context: string,
    tableId?: string,
  ): void => {
    const v = value.trim().slice(0, 120)
    if (v.length < 2) return
    const norm = normalizeEntity(type, v) || v.toLowerCase().replace(/[^a-z0-9@.+_-]/g, '')
    const key = `${type}::${norm}`
    const prev = entityMap.get(key)
    if (prev) {
      if (confidence > prev.confidence) prev.confidence = confidence
      if (tableId && !prev.tableIds?.includes(tableId)) {
        prev.tableIds = [...(prev.tableIds ?? []), tableId].slice(0, 12)
      }
      return
    }
    entityMap.set(key, {
      type,
      value: v,
      context: context.slice(0, 300),
      confidence,
      ...(tableId ? { tableIds: [tableId] } : {}),
    })
  }

  for (let k = regionStart + 1; k <= regionEnd; k++) {
    const li = nonEmptyIdx[k]
    const raw = splitLine(lines[li], delim)
    if (raw.length < 3) continue
    // Rows must roughly match the header width (±1 handles trailing commas).
    if (Math.abs(raw.length - header.length) > 1) continue
    const cell = (idx: number): string => (idx >= 0 && idx < raw.length ? raw[idx].trim() : '')

    let srcVal = cell(cols.srcName).replace(/^"|"$/g, '')
    let tgtVal = cell(cols.tgtName).replace(/^"|"$/g, '')
    if (!srcVal || !tgtVal) continue

    // v3.9.1: registry-prefixed endpoint cells ("E0001 Arjun Sharma") — the
    // ID goes to the table-id trace fields, the clean NAME becomes the value
    // (merges with the entity registry's node instead of duplicating it).
    let srcRefExtra = ''
    let tgtRefExtra = ''
    if (cols.srcTableId < 0) {
      const sp = splitLeadingRef(srcVal)
      if (sp) {
        srcRefExtra = sp.ref
        srcVal = sp.name
      }
    }
    if (cols.tgtTableId < 0) {
      const sp = splitLeadingRef(tgtVal)
      if (sp) {
        tgtRefExtra = sp.ref
        tgtVal = sp.name
      }
    }
    // v3.10: an endpoint cell that is ITSELF a pure reference token
    // ("PER-002", "E0001"…) — record the token as the endpoint's own table
    // id so the cross-file reference stitcher can join this node with the
    // typed registry entity the token belongs to.
    if (cols.srcTableId < 0 && !srcRefExtra && REF_TOKEN_RE.test(srcVal)) srcRefExtra = srcVal
    if (cols.tgtTableId < 0 && !tgtRefExtra && REF_TOKEN_RE.test(tgtVal)) tgtRefExtra = tgtVal

    if (srcVal.toLowerCase() === tgtVal.toLowerCase()) continue

    const srcType = (cols.srcType >= 0 ? mapType(cell(cols.srcType)) : null) ?? guessType(srcVal)
    const tgtType = (cols.tgtType >= 0 ? mapType(cell(cols.tgtType)) : null) ?? guessType(tgtVal)

    const rawRel = cols.rel >= 0 ? cell(cols.rel) : ''
    // v3.9.2: structured evidence keeps its LITERAL verb (MESSAGED stays
    // MESSAGED, not folded to COMMUNICATED_WITH) — the table asserted it.
    const { rel, reversed } = evidenceRel(rawRel || 'ASSOCIATED_WITH')
    if (reversed) {
      const t = srcVal
      srcVal = tgtVal
      tgtVal = t
    }

    const rowId = cols.rowId >= 0 ? cell(cols.rowId) : ''
    const state = cols.state >= 0 ? cell(cols.state) : ''
    const method = cols.method >= 0 ? cell(cols.method) : ''
    const confCell = cols.conf >= 0 ? cell(cols.conf) : ''
    const confidence = parseConfidence(confCell) ?? 0.8
    const date = parseDate(cols.date >= 0 ? cell(cols.date) : '')
    const verb = rawRel || 'ASSOCIATED_WITH'
    const srcTableId = cols.srcTableId >= 0 ? cell(cols.srcTableId) : srcRefExtra
    const tgtTableId = cols.tgtTableId >= 0 ? cell(cols.tgtTableId) : tgtRefExtra
    const evidenceRefs = (cols.evidence >= 0 ? cell(cols.evidence) : '')
      .split(/[;,|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 8)

    // The COMPLETE verbatim row (header → cell) for full-fidelity display.
    const row: RelTableRow = {}
    for (let c = 0; c < headerCells.length && c < raw.length; c++) {
      const h = headerCells[c].trim()
      if (h) row[h] = raw[c]
    }

    const ctx = `relationship-table row ${rowId || rowCount + 1}: ${srcVal} ${verb} ${tgtVal}`
    addEntity(srcVal, srcType, Math.max(confidence, 0.8), ctx, srcTableId || undefined)
    addEntity(tgtVal, tgtType, Math.max(confidence, 0.8), ctx, tgtTableId || undefined)

    const why =
      `table row ${rowId || rowCount + 1} asserts ${verb}` +
      `${state ? ` (${state})` : ''}${method ? ` [${method}]` : ''}: ${srcVal} → ${tgtVal}`

    edges.push({
      from: srcVal,
      to: tgtVal,
      fromType: srcType,
      toType: tgtType,
      rel,
      rawRel: verb,
      why: why.slice(0, 300),
      confidence,
      timestamp: date,
      rowId: rowId || undefined,
      srcTableId: srcTableId || undefined,
      tgtTableId: tgtTableId || undefined,
      state: state || undefined,
      method: method || undefined,
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : undefined,
      row,
    })
    tableLineIdx.add(li)
    rowCount++
  }

  // v3.10 — ENTITY-REGISTER GUARD: a delimited table whose "verb" column
  // is actually an entity-TYPE column (master entity inventories:
  // `entity_id,name,role,type` with cells PERSON/ORGANIZATION/…) is NOT a
  // relationship table. Every row would fabricate a nonsense edge
  // ("Asterion Ops —BANK_ACCOUNT→ AXIS-771204"). When the verb cells are
  // dominated by known entity-type labels, this is an entity register —
  // `extractEntityTable()` reads it instead.
  const typeLabelRows = edges.filter((e) => isEntityTypeLabel(e.rawRel)).length
  if (typeLabelRows / edges.length >= 0.6) return NOT_DETECTED

  if (rowCount < 3 || edges.length < 3) return NOT_DETECTED

  // 4. Coverage + non-table text.
  const coverage = rowCount / nonEmptyIdx.length
  const nonTableLines = lines.filter((_, i) => !tableLineIdx.has(i) && lines[i].trim().length > 0)
  const nonTableText = nonTableLines.join('\n').slice(0, 4000)

  // 5. Compact digest (for the single AI digest call).
  const typeCounts = new Map<string, number>()
  for (const e of entityMap.values()) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1)
  const relCounts = new Map<string, number>()
  for (const e of edges) relCounts.set(e.rawRel.toUpperCase().replace(/[\s-]+/g, '_'), (relCounts.get(e.rawRel.toUpperCase().replace(/[\s-]+/g, '_')) ?? 0) + 1)
  const fmtCounts = (m: Map<string, number>, max: number): string =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([t, n]) => `${t} ×${n}`).join(', ')

  const sample = edges
    .slice(0, 8)
    .map((e) => `  ${e.rowId ? e.rowId + ' · ' : ''}${e.srcTableId ? e.srcTableId + ' ' : ''}${e.from} (${e.fromType}) —${e.rawRel}→ ${e.to}${e.tgtTableId ? ' ' + e.tgtTableId : ''} (${e.toType})${e.timestamp ? ' · ' + e.timestamp : ''} · conf ${e.confidence.toFixed(2)}`)
    .join('\n')

  const digest =
    `Delimiter "${delim === '\t' ? 'TAB' : delim === ',' ? 'comma' : delim}" · ${header.length} columns · ${rowCount} data rows (${Math.round(coverage * 100)}% of document lines)\n` +
    `Columns: ${splitLine(lines[headerIdx], delim).join(', ')}\n` +
    `Entity mix: ${fmtCounts(typeCounts, 12)}\n` +
    `Relationship mix: ${fmtCounts(relCounts, 14)}\n` +
    `Sample rows:\n${sample}`

  return {
    detected: true,
    delimiter: delim,
    header: splitLine(lines[headerIdx], delim),
    rowCount,
    entities: [...entityMap.values()],
    edges,
    coverage,
    digest,
    nonTableText,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v3.10 — ENTITY-REGISTER TABLES (master inventories, typed lists)
//
// A large class of forensic exports is a delimited ENTITY REGISTER, not an
// edge list:
//
//   entity_id,document_type,imei,importance,label,name,role,type
//   PER-001,,,primary,,"Vikram ""Vik"" Deshmukh",suspect,PERSON
//   ACC-001,,,,"Asterion Ops",AXIS-771204,,BANK_ACCOUNT
//
// Such a table states its entities and their types literally — one typed
// node per row, with the row id as the cross-file reference token. The
// relationship-table grammar cannot read it (no source/target pair), and the
// flat regex layer cannot see names without machine patterns. This parser
// reads it directly: fully deterministic, zero AI calls.
// ─────────────────────────────────────────────────────────────────────────────

const ET_TYPE_COL_RE = /^(entity_?type|type|record_?type|row_?type|category|classification)$/
const ET_NAME_COL_RE =
  /^(name|label|entity|entity_?name|full_?name|display_?name|value|holder|account_?holder|subject|title|alias)$|_name$/
const ET_ID_COL_RE = /^(entity_?id|id|record_?id|ref_?id|uid|code|identifier)$/

export interface EntityTableEntity {
  type: EntityType
  value: string
  context: string
  confidence: number
  /** The row's own identifier (entity_id …) — cross-file reference token. */
  tableIds?: string[]
}

export interface EntityTableExtraction {
  detected: boolean
  header: string[]
  rowCount: number
  entities: EntityTableEntity[]
  coverage: number
}

const ET_NOT_DETECTED: EntityTableExtraction = {
  detected: false, header: [], rowCount: 0, entities: [], coverage: 0,
}

/**
 * Detect and parse delimited entity-register tables. A table qualifies when:
 *   • its header carries an entity-TYPE column whose cells map (≥60%) through
 *     the shared TYPE_MAP vocabulary,
 *   • it carries a NAME-ish column with a real fill-rate (≥30%),
 *   • and it does NOT carry a source/target endpoint pair (that is the
 *     relationship-table parser's domain).
 * All decisions are structural + fill-rate based — no dataset vocabulary.
 */
export function extractEntityTable(text: string): EntityTableExtraction {
  const lines = text.split('\n').map((l) => l.trimEnd())
  const nonEmptyIdx: number[] = []
  lines.forEach((l, i) => {
    if (l.trim().length > 0) nonEmptyIdx.push(i)
  })
  if (nonEmptyIdx.length < 6) return ET_NOT_DETECTED

  const entities = new Map<string, EntityTableEntity>()
  const headers: string[][] = []
  let totalRows = 0
  let tableLines = 0

  for (const delim of DELIMS) {
    const counts = nonEmptyIdx.map((i) => splitLine(lines[i], delim).filter((f) => f.length > 0).length)
    // contiguous runs of ≥3-field lines, ≥6 lines (tables embedded in prose)
    let s = 0
    while (s < counts.length) {
      if (counts[s] < 3) { s++; continue }
      let e = s
      while (e + 1 < counts.length && counts[e + 1] >= 3) e++
      if (e - s + 1 >= 6) {
        for (let h = s; h <= Math.min(s + 2, e - 4); h++) {
          const headerCells = splitLine(lines[nonEmptyIdx[h]], delim)
          const hNorm = headerCells.map(normHeader)
          const typeCol = hNorm.findIndex((c) => ET_TYPE_COL_RE.test(c))
          if (typeCol < 0) continue
          // A source/target pair means relationship table — not ours.
          if (hNorm.some((c) => SRC_NAME_RE.test(c)) && hNorm.some((c) => TGT_NAME_RE.test(c))) continue
          // Name column: prefer the name-ish column with the highest fill.
          const dataIdx: number[] = []
          for (let k = h + 1; k <= e; k++) dataIdx.push(k)
          const rows = dataIdx
            .map((k) => splitLine(lines[nonEmptyIdx[k]], delim))
            .filter((r) => Math.abs(r.length - headerCells.length) <= 1)
          if (rows.length < 5) continue
          const nameCands = hNorm
            .map((c, i) => ({ c, i }))
            .filter(({ c, i }) => ET_NAME_COL_RE.test(c) && i !== typeCol)
          if (nameCands.length === 0) continue
          let nameCol = nameCands[0].i
          let bestFill = -1
          for (const cand of nameCands) {
            const fill = rows.filter((r) => (r[cand.i] ?? '').trim().length > 0).length
            if (fill > bestFill) { bestFill = fill; nameCol = cand.i }
          }
          if (bestFill / rows.length < 0.3) continue
          const idCol = hNorm.findIndex((c) => ET_ID_COL_RE.test(c) && c !== 'type')

          // Row pass → typed entities.
          let mappedTypes = 0
          let emitted = 0
          const tableKeys: string[] = []
          for (const r of rows) {
            const cell = (i: number): string => (i >= 0 && i < r.length ? r[i].trim() : '')
            const typeCell = cell(typeCol).replace(/^["']|["']$/g, '')
            if (!typeCell) continue
            const mapped = mapType(typeCell)
            const wellFormedLabel = /^[A-Z][A-Z_]{1,23}$/.test(typeCell.replace(/\s+/g, '_'))
            if (mapped) mappedTypes++
            else if (!wellFormedLabel) continue // junk cell — not a register row
            const type: EntityType = mapped ?? 'other'
            let value = cell(nameCol).replace(/^"|"$/g, '').replace(/""/g, '"').trim()
            const rowId = idCol >= 0 ? cell(idCol).trim() : ''
            if (!value && rowId) value = rowId
            if (!value || value.length < 2) continue
            const attrs = hNorm
              .map((c, i) => ({ c, i }))
              .filter(({ c, i }) => c && i !== typeCol && i !== nameCol && i !== idCol && !ET_NAME_COL_RE.test(c))
              .map(({ c, i }) => (cell(i) ? `${c}=${cell(i)}` : ''))
              .filter(Boolean)
              .slice(0, 4)
              .join(' ')
            const norm = (type === 'person' || type === 'organization'
              ? value.toLowerCase().replace(/["']/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
              : value.toLowerCase().replace(/[^a-z0-9@.+_-]/g, ''))
            const key = `${type}::${norm}`
            const prev = entities.get(key)
            const tableIds = rowId && rowId !== value ? [rowId] : undefined
            if (prev) {
              if (tableIds && !prev.tableIds?.includes(tableIds[0])) {
                prev.tableIds = [...(prev.tableIds ?? []), tableIds[0]].slice(0, 12)
              }
            } else {
              entities.set(key, {
                type,
                value: value.slice(0, 120),
                context: `entity-register row${rowId ? ` ${rowId}` : ''}: ${typeCell}${attrs ? ` ${attrs}` : ''}`.slice(0, 300),
                confidence: mapped ? 0.9 : 0.7,
                ...(tableIds ? { tableIds } : {}),
              })
              emitted++
              tableKeys.push(key)
            }
          }
          // ≥60% of typed rows must map through the shared vocabulary —
          // otherwise the "type" column is something else entirely and the
          // table's rows are rolled back wholesale.
          if (emitted >= 5 && mappedTypes / Math.max(1, emitted) >= 0.6) {
            headers.push(headerCells.map((c) => c.trim()).filter(Boolean))
            tableLines += rows.length
            totalRows += rows.length
          } else {
            for (const k of tableKeys) entities.delete(k)
          }
        }
      }
      s = e + 1
    }
  }

  if (headers.length === 0 || entities.size < 5) return ET_NOT_DETECTED
  return {
    detected: true,
    header: headers[0],
    rowCount: totalRows,
    entities: [...entities.values()],
    coverage: tableLines / nonEmptyIdx.length,
  }
}
