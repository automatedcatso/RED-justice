/**
 * extractors/registryExtract.ts — structured table / registry extraction
 * (Level-0 deterministic, no AI calls).
 *
 * Forensic documents frequently carry machine-generated annexure TABLES:
 * charge-sheet entity registers ("E0001 PERSON Arjun Sharma role=Director"),
 * CDR annexures, exhibit lists, relationship registers
 * ("R0001 E0001 … WORKS_FOR E0056 … 2026-01-01 E0150 observed 0.78").
 * The flat regex pass in ./entityExtract cannot see rows whose names carry no
 * salutation and no "Name:" label — entire PERSON/ORG columns were lost.
 *
 * This module recovers those tables generically:
 *
 *   ENTITY ROW      :  ^<rowId> <UPPER_TYPE> <value…> [<k=v> <k=v>]*
 *                      (+ wrapped attribute continuation lines)
 *   RELATIONSHIP ROW:  ^R<no> <srcRef> <names> <VERB> <dstRef> <names>
 *                      <yyyy-mm-dd> <evidRef> <state> <conf>
 *
 * Parsing is whitespace-flexible because PDF text layers do not preserve
 * column alignment. Field anchors are structural tokens (row ids, ALL-CAPS
 * verb runs, ISO dates, state words, trailing confidence floats) rather than
 * strict word order, so simultaneous wraps of both endpoint names still
 * resolve correctly through their E-code references into the entity table.
 *
 * Additionally returns the character spans fully consumed as relationship
 * rows so callers can SUPPRESS per-cell duplicates — most importantly the
 * Date column, which otherwise explodes into one standalone date-entity per
 * calendar day across hundreds of rows.
 */

import {
  normalizeEmail,
  normalizeImei,
  normalizePhone,
  normalizeVehicle,
} from './normalizers'
import { CORE_REL_SET, REL_SYNONYMS } from '../investigation/relVocabulary'
import type { EntityType, ExtractedEntity } from './types'

/** A parsed registry relationship row. */
export interface ExtractedRegistryRelationship {
  /** Relationship verb, canonical UPPERCASE (WORKS_FOR, OWNS, CALLED, …). */
  rel: string
  /** Resolution key `${type}::${norm}` of the source entity row. */
  srcKey: string
  /** Resolution key of the destination entity row. */
  dstKey: string
  /** Row id when present (R0001 …) — provenance/debugging. */
  rowId?: string
  /** Registry references of endpoints/evidence (E0101 style). */
  srcRef?: string
  dstRef?: string
  evidRef?: string
  /** Evidence-document VALUE resolved from an EVIDENCE_DOCUMENT entry. */
  evidenceValue?: string
  /** ISO date (yyyy-mm-dd) taken from the row's date anchor. */
  timestamp?: string
  /** corroborated / observed / inferred / uncertain when stated. */
  state?: string
  /** Row-stated confidence clamped to 0..1. */
  confidence?: number
}

export interface RegistryExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRegistryRelationship[]
  /**
   * Character spans fully consumed as structured rows. Callers forward these
   * to `extractEntities(text, { skipDateSpans })`.
   */
  consumedDateSpans: Array<[number, number]>
  /** Parse telemetry — persisted into intel JSON for transparency. */
  stats: {
    entityRows: number
    relationshipRows: number
    skippedRows: number
    detectedTableKinds: string[]
  }
  /**
   * v3.9.1 — normalized tokens that are PROPERTIES or ROW REFERENCES, never
   * entities: row IDs (E0001, R0042, node_12…) and attribute VALUES
   * (role=Director, status=active, carrier=Jio, city=Nashik…). The AI sweep
   * kept re-listing these as entities (48 phantom "document_id: E00xx" nodes,
   * 'watchlist' as a person…); this vocabulary lets the caller suppress them
   * deterministically. Registry entity VALUES are excluded — a value that is
   * also a real name must never suppress the entity itself.
   */
  noiseVocabulary?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-table grammar
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_TYPE_MAP: Record<string, EntityType> = {
  PERSON: 'person',
  PEOPLE: 'person',
  INDIVIDUAL: 'person',
  SUSPECT: 'person',
  WITNESS: 'person',
  ORGANIZATION: 'organization',
  ORG: 'organization',
  COMPANY: 'organization',
  FIRM: 'organization',
  BUSINESS: 'organization',
  BANK: 'organization',
  PHONE: 'phone',
  MOBILE: 'phone',
  TELEPHONE: 'phone',
  MSISDN: 'phone',
  BANK_ACCOUNT: 'account',
  ACCOUNT: 'account',
  ACCT: 'account',
  IBAN: 'account',
  DEVICE: 'device',
  IMEI: 'imei',
  VEHICLE: 'vehicle',
  CAR: 'vehicle',
  ADDRESS: 'address',
  LOCATION: 'location',
  CITY: 'location',
  EMAIL: 'email',
  EMAIL_ADDRESS: 'email',
  URL: 'url',
  LINK: 'url',
  IP: 'ip',
  IP_ADDRESS: 'ip',
  WALLET: 'wallet',
  EVENT: 'event',
  EVIDENCE_DOCUMENT: 'document_id',
  DOCUMENT: 'document_id',
  DOC: 'document_id',
  FILE: 'document_id',
  REFERENCE: 'document_id',
  UTR: 'document_id',
}

/** Tokens that appear in prose headers and must never count as a TYPE. */
const TYPE_BLOCKLIST = new Set([
  'THE', 'AND', 'FOR', 'FROM', 'WITH', 'TOTAL', 'COUNT', 'VALUE', 'TYPE',
  'NAME', 'DATE', 'METRIC', 'ID', 'ATTRIBUTES', 'SECTION', 'OVERVIEW',
])

/**
 * Column-width clipping in source PDFs truncates long verbs mid-token
 * ("TRANSFERRED_T", "ASSOCIATED_WIT"). Canonicalize observed truncations.
 */
const REL_ALIASES: Record<string, string> = {
  TRANSFERRED_T: 'TRANSFERRED_TO',
  TRANSFERRED: 'TRANSFERRED_TO',
  ASSOCIATED_WIT: 'ASSOCIATED_WITH',
  ASSOCIATED: 'ASSOCIATED_WITH',
  COMMUNICATED_WI: 'COMMUNICATED_WITH',
  COMMUNICATED: 'COMMUNICATED_WITH',
  REGISTERED_A: 'REGISTERED_AT',
  TRAVELED_WIT: 'TRAVELED_WITH',
  USED_VEHICL: 'USED_VEHICLE',
  DIRECTOR_O: 'DIRECTOR_OF',
  MENTIONED_I: 'MENTIONED_IN',
}

/**
 * v3.9.2 — every token that names a RELATIONSHIP (core types + synonyms).
 * Registry rows typed by one of these are relationship rows, not entities.
 */
const REL_VERB_TOKENS: ReadonlySet<string> = new Set<string>([
  ...CORE_REL_SET,
  ...Object.keys(REL_SYNONYMS),
  ...Object.values(REL_SYNONYMS),
  ...Object.keys(REL_ALIASES),
])

/** Row ids seen in registers: E0001, R-07, EN_123, ACC00042 … */
const ROW_ID_RE = /^[ \t]*([A-Za-z][A-Za-z0-9_]{0,7}[-_]?[0-9]{1,6})[ \t]+/
/**
 * OCR-noise-tolerant variants of the two structural anchor families:
 *  - Row/entity references carry digit-shaped glyphs that Tesseract commonly
 *    mangles ("£0056"→E0056, "ROOOS"→R0005). These regexes ACCEPT those
 *    confusions structurally; {@link canonReferenceToken} then restores the
 *    clean form before any lookup happens.
 *  - Character classes cover only glyph-level confusions (letters standing
 *    where digits belong), never whole words, because every match is later
 *    re-validated by canonReferenceToken().
 */
const ROW_ID_OCR_RE = /^[ \t]*([A-Za-z\u00a3\u20ac][A-Za-z0-9\u00a3\u20ac_]{0,7}[-_ ]?[0-9O0oIilLlLSsBZQ|!.,\u00a3\u20ac]{1,6})[ \t]+/
/** ALL-CAPS TYPE token that must follow the row id. */
const ROW_TYPE_RE =
  /^[ \t]*[A-Za-z][A-Za-z0-9_]{0,7}[-_]?[0-9]{1,6}[ \t]+([A-Z][A-Z_]{1,23})[ \t]+/
/** Same as ROW_TYPE_RE but tolerating OCR-mangled row ids (incl. £/€ leads). */
const ROW_TYPE_OCR_RE =
  /^[ \t]*[A-Za-z\u00a3\u20ac][A-Za-z0-9\u00a3\u20ac_]{0,7}[-_ ]?[0-9O0oIilLlLSsBZQ|!.,\u00a3\u20ac]{1,6}[ \t]+([A-Z][A-Z_]{1,23})[ \t\r\n]+/

/** Common optical confusions seen where DIGITS belong in reference tokens. */
const GLYPH_TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', '\u00d8': '0', '\u25cb': '0',
  I: '1', L: '1', '|': '1', '!': '1', i: '1', l: '1', J: '1',
  S: '5', s: '5',
  B: '8',
  Z: '2', z: '2',
  G: '6', b: '6',
  T: '7', '?': '7',
  A: '4', h: '4',
  g: '9', q: '9',
}

/**
 * Canonicalize a reference token like "E0001", "\u00a30056", "ROOOS", "R-07".
 * Returns null when the token cannot plausibly be <LETTER><digits> — which
 * hard-rejects ordinary words from ever becoming registry rows/refs.
 */
export function canonReferenceToken(raw: string): string | null {
  const compact = raw.replace(/[^A-Za-z0-9\u00a3\u20ac]/g, '')
  if (compact.length < 2 || compact.length > 9) return null
  const lead = compact[0].toUpperCase()
  if (!/[A-Z\u00a3\u20ac]/.test(lead)) return null
  const tailRaw = compact.slice(1)
  const mapped = [...tailRaw]
    .map((ch) => GLYPH_TO_DIGIT[ch] ?? ch)
    .join('')
  if (!/^[0-9]+$/.test(mapped)) return null
  // \u00a3/\u20ac are near-uniquely misread E's in Tesseract output.
  const leadCanonical =
    lead === '\u00a3' || lead === '\u20ac' ? 'E' : lead
  return `${leadCanonical}${mapped}`
}

/** Attribute continuation line (wrapped under the previous row). */
function looksLikeAttrContinuation(line: string): boolean {
  const t = line.trim()
  return !!t && /^[a-z][a-z0-9_.\-]*\s*=/.test(t)
}

function splitValueAttrs(rest: string): { value: string; attrs: Record<string, string> } {
  // Pipe glyphs appear between columns in OCR output — make them act like
  // wide gaps. Value-only transformation; byte offsets elsewhere untouched.
  const cleaned = rest.replace(/[|\u00a6]/g, '  ').trim()
  const attrs: Record<string, string> = {}
  let head = cleaned
  const gapSplit = cleaned.split(/\s{2,}/)
  if (gapSplit.length > 1 && gapSplit[0].trim()) {
    head = gapSplit[0]
  } else {
    const m = cleaned.match(/^(.+?)(?:\s{1,})(\w[\w.\-]*\s*=\s*.*)$/)
    if (m) head = m[1]
  }
  const attrBlob = cleaned.slice(head.length)
  for (const piece of attrBlob.split(/\s*;\s*|\s+(?=\w+\s*=)|\s*,\s*/)) {
    const kv = piece.match(/^\s*"?([\w.\- ]+?)"?\s*[=:]\s*"?(.*?)"?,?\s*$/)
    if (kv) attrs[kv[1].toLowerCase().replace(/\s+/g, '_')] = kv[2].trim()
  }
  // Strip residue punctuation OCR glues onto names ("Vikram Mehta.").
  const value = head.trim().replace(/[.,;:|\u2018\u2019"\u201c\u201d]+$/, '').trim()
  return { value, attrs }
}

/**
 * OCR glues attribute columns onto names when column gaps vanish
 * ("Priya Nair ales Lead;", "Dev Kapoor jperations Manager;"). Detect a
 * fuzzy role suffix (allowing a chopped first glyph) and cut it off.
 */
const ROLE_GLUE_FRAGMENTS = [
  'Director', 'Accountant', 'Operations Manager', 'Courier Coordinator',
  'Sales Lead', 'Consultant', 'Driver', 'Analyst', 'Broker', 'Technician',
]
const ROLE_GLUE_RES = ROLE_GLUE_FRAGMENTS.map((role) => {
  // Allow up to one lost/replaced leading glyph, e.g. "ales Lead" for
  // "Sales Lead", "jperations Manager" for "Operations Manager".
  const body = role.slice(1).replace(/ /g, '\\s+')
  return new RegExp(`\\s+\\S?${body}[\\s,;.]*$`, 'i')
})

function stripRoleGlue(value: string): string {
  let out = value.trim()
  for (const re of ROLE_GLUE_RES) {
    out = out.replace(re, '').trim()
    if (out !== value.trim()) break
  }
  return out || value.trim()
}

/**
 * Normalize a registry VALUE using the same catalogues as the flat extractor
 * so both layers merge into one node downstream.
 */
function normalizeRegistryValue(
  type: EntityType,
  rawValue: string,
  attrs: Record<string, string>,
): { value: string; norm: string; label?: string } {
  const value = rawValue.replace(/\s+/g, ' ').trim()
  const baseNorm = value.toLowerCase().replace(/[^a-z0-9@._+-]/g, '').slice(0, 80)
  switch (type) {
    case 'person': {
      // Strip glued role columns first, then residual OCR glyphs.
      const deGlued = stripRoleGlue(value)
      const cleanName = deGlued
        .replace(/[\u2018\u2019'\u201c\u201d]+/g, "'")
        .replace(/[^A-Za-z'.\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const finalName = cleanName || value
      const norm = finalName.toLowerCase().replace(/[^a-z' ]/g, '').replace(/\s+/g, ' ').trim()
      const label = attrs.role ? `${finalName} (${attrs.role})` : undefined
      return { value: finalName, norm, label }
    }
    case 'organization': {
      const cleanOrg = value.replace(/[\u2018\u2019\u201c\u201d|]/g, '').trim()
      const norm = cleanOrg.toLowerCase().replace(/[^a-z0-9]/g, '')
      const label = attrs.sector ? `${cleanOrg} (${attrs.sector})` : undefined
      return { value: cleanOrg, norm, label }
    }
    case 'phone':
      return { value, norm: normalizePhone(value) || baseNorm }
    case 'imei': {
      // Value may be "IMEI-381257920350997" or bare digits.
      const digits = value.replace(/[^\d]/g, '')
      return { value, norm: normalizeImei(digits) || digits }
    }
    case 'device': {
      // A DEVICE row carrying an IMEI becomes an imei-keyed node (dedupes).
      if (/^imei[-:\s]*\d{14,17}$/i.test(value)) {
        return { value, norm: value.replace(/[^\d]/g, ''), label: 'Device' }
      }
      return { value, norm: baseNorm, label: attrs.model ? `Device (${attrs.model})` : 'Device' }
    }
    case 'vehicle': {
      const n = normalizeVehicle(value)
      return { value, norm: n || value.toUpperCase().replace(/[^A-Z0-9]/g, '') }
    }
    case 'email':
      return { value, norm: normalizeEmail(value) || baseNorm }
    default:
      return { value, norm: baseNorm || value.toLowerCase() }
  }
}

interface InternalEntityRow {
  ref: string | null
  type: EntityType
  value: string
  attrs: Record<string, string>
  norm: string
  key: string
  start: number
  end: number
}

/** Absolute-offset line tokenizer. */
function lineIndex(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = []
  let pos = 0
  for (const l of text.split('\n')) {
    out.push({ text: l.replace(/\r$/, ''), start: pos, end: pos + l.length })
    pos += l.length + 1
  }
  return out
}

/** Up-to-100-char snippet used as entity context provenance. */
function contextSnippet(text: string, start: number, end: number): string {
  const padStart = Math.max(0, start - 30)
  const padEnd = Math.min(text.length, end + 30)
  let s = text.slice(padStart, padEnd).replace(/\s+/g, ' ').trim()
  if (s.length > 100) s = s.slice(0, 100)
  return s
}

export function extractRegistry(text: string): RegistryExtractionResult {
  const emptyStats = { entityRows: 0, relationshipRows: 0, skippedRows: 0, detectedTableKinds: [] as string[] }
  if (!text || typeof text !== 'string' || text.length < 40) {
    return { entities: [], relationships: [], consumedDateSpans: [], stats: emptyStats }
  }

  // Form feeds (page breaks from PDF text layers) sit at line starts and
  // defeat the "^[ \t]*" anchors. Replace them 1:1 with spaces so ALL byte
  // offsets — including consumedDateSpans — stay valid against the ORIGINAL
  // string the caller passed in.
  const view = text.replace(/\f/g, ' ')

  const lines = lineIndex(view)

  // ── Pass 1: entity rows ────────────────────────────────────────────────
  interface DraftRow {
    ref: string | null
    typeRaw: string
    knownType: boolean
    rest: string[]
    start: number
    end: number
  }
  const drafts: DraftRow[] = []

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const t = ln.text
    if (!t || t.length < 8) continue

    // Prefer the strict anchors; fall back to OCR-tolerant ones, then demand
    // canonReferenceToken validation so prose words can never become rows.
    let idToken: string | null = null
    let typeRaw: string | null = null
    const idm = t.match(ROW_ID_RE)
    const tm = t.match(ROW_TYPE_RE)
    if (idm && tm) {
      typeRaw = tm[1]
      idToken = canonReferenceToken(idm[1]) ?? idm[1]
    } else {
      const idOcr = t.match(ROW_ID_OCR_RE)
      const tmOcr = t.match(ROW_TYPE_OCR_RE)
      if (idOcr && tmOcr) {
        typeRaw = tmOcr[1]
        idToken = canonReferenceToken(idOcr[1])
        if (!idToken) continue
      }
    }
    if (!typeRaw || !idToken) continue
    const knownType = Object.prototype.hasOwnProperty.call(REGISTRY_TYPE_MAP, typeRaw)
    // Unknown types allowed only when they look deliberate (underscored or a
    // longer acronym) and never when they're common prose tokens.
    if (!knownType && (TYPE_BLOCKLIST.has(typeRaw) || (/_/.test(typeRaw) === false && typeRaw.length < 5))) continue
    // v3.9.2: a row whose "type" token is actually a RELATIONSHIP VERB is a
    // relationship-table row rendered column-first (XML record lists / SQL
    // exports: "R0001 | WORKS_FOR | … | E0001 | E0056"), never an entity —
    // accepting it minted one phantom entity per relationship row.
    if (!knownType && REL_VERB_TOKENS.has(typeRaw)) continue


    // Fold attribute continuation lines below this row.
    let j = i + 1
    const extra: string[] = []
    while (
      j < lines.length &&
      looksLikeAttrContinuation(lines[j].text) &&
      !ROW_ID_RE.test(lines[j].text) &&
      !(ROW_ID_OCR_RE.test(lines[j].text) && ROW_TYPE_OCR_RE.test(lines[j].text))
    ) {
      extra.push(lines[j].text.trim())
      j += 1
    }
    drafts.push({
      ref: idToken,
      typeRaw,
      knownType,
      rest: [computeRestAfterType(t)],
      start: ln.start,
      end: lines[j - 1]?.end ?? ln.end,
    })
    i = j - 1
  }

  // Grammar confidence gate — several consistent rows ⇒ real registry.
  if (drafts.length < 3) {
    return { entities: [], relationships: [], consumedDateSpans: [], stats: emptyStats }
  }

  const entities: ExtractedEntity[] = []
  const seenKeys = new Set<string>()
  const rowsByRef = new Map<string, InternalEntityRow>()
  let entityRowCount = 0

  for (const d of drafts) {
    const restText = d.rest.join(' ').trim()
    if (!restText) continue
    const { value, attrs } = splitValueAttrs(restText)
    if (!value || value.length < 2) continue
    if (/^(metric|total|count|section|attributes)$/i.test(value)) continue

    let type: EntityType = d.knownType ? REGISTRY_TYPE_MAP[d.typeRaw] : 'other'
    // A DEVICE row carrying an IMEI value is an IMEI node — retype BEFORE the
    // dedupe key is built so it merges with flat-extractor imei hits instead
    // of shadowing them as a separate 'device' entity.
    if (type === 'device' && /^imei[-:\s]*\d{14,17}$/i.test(value)) type = 'imei'
    const nrm = normalizeRegistryValue(type, value, attrs)
    const norm = nrm.norm || value.toLowerCase().replace(/[^a-z0-9@._+-]/g, '').slice(0, 80)
    const key = `${type}::${norm}`
    const label =
      nrm.label ??
      (attrs.vehicle_type ? `${value} (${attrs.vehicle_type})` :
       attrs.event_type ? `${value} (${attrs.event_type})` :
       attrs.format ? `${value} (${attrs.format})` : undefined)

    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      entities.push({
        type,
        value: nrm.value || value,
        norm,
        label,
        confidence: 0.92,
        context: contextSnippet(view, d.start, d.end),
      })
    }
    entityRowCount += 1
    if (d.ref && !rowsByRef.has(d.ref)) {
      rowsByRef.set(d.ref, { ref: d.ref, type, value: nrm.value || value, attrs, norm, key, start: d.start, end: d.end })
    }
  }

  if (entityRowCount < 3) {
    return { entities: [], relationships: [], consumedDateSpans: [], stats: emptyStats }
  }

  // ── Pass 2: relationship rows ──────────────────────────────────────────
  const relationships: ExtractedRegistryRelationship[] = []
  const consumedDateSpans: Array<[number, number]> = []
  let relRowCount = 0
  let skippedRows = 0

  const DATE_ANCHOR = /\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/
  const STATE_WORDS = /\b(corroborated|inferred|observed|uncertain)\b/i

  const rowStarts: Array<{ idx: number; pos: number; id: string }> = []
  /**
   * Relationship-row grammar differs from entity rows: the token after the
   * row id is another REFERENCE (the source endpoint), not an ALL-CAPS TYPE.
   * So Pass 2 anchors are collected line-wise, demanding only:
   *   <line> = <R-reference> <rest…>
   * followed by canon validation (<R><digits>). This tolerates every OCR
   * glyph confusion seen in the wild ("ROOOS", "R0O77", "R0014") without
   * ever swallowing prose lines.
   */
  const R_LINE_RE =
    /^[ \t]*([A-Za-z\u00a3\u20ac][A-Za-z0-9\u00a3\u20ac_]{0,7}[-_ ]?[0-9O0oIilLlLSsBZQ|!,.]{1,6})(?=\s|$)/
  for (const ln of lines) {
    const t2 = ln.text
    if (!t2 || t2.length < 8) continue
    const mId = t2.match(R_LINE_RE)
    if (!mId) continue
    const canonId = canonReferenceToken(mId[1])
    if (!canonId || !canonId.startsWith('R')) continue
    rowStarts.push({
      idx: ln.start,
      pos: ln.start + mId[1].length,
      id: canonId,
    })
  }

  for (let r = 0; r < rowStarts.length; r++) {
    const start = rowStarts[r].idx
    const end = r + 1 < rowStarts.length ? rowStarts[r + 1].idx : Math.min(view.length, start + 400)
    const chunkStartOffset = rowStarts[r].pos
    const chunk = view.slice(chunkStartOffset, end)

    const dateM = chunk.match(DATE_ANCHOR)
    const dateIdx = dateM?.index ?? -1

    // Endpoint refs: two E-codes before the date anchor; a code after the
    // date is the evidence reference. Glyph confusions accepted then canon'd.
    // NOTE: \b never holds before '£'/'€' (non-word chars), so explicit
    // lookarounds replace boundaries here.
    const codesBefore: Array<{ ref: string; index: number; len: number }> = []
    const ECODE_RE = /(?<![A-Za-z0-9\u00a3\u20ac])[E\u00a3\u20ac][A-Za-z]?[-_ ]?[0-9O0oIilLlLSsBZQ|!,.]{1,6}(?![A-Za-z0-9])/g
    let cm: RegExpExecArray | null
    while ((cm = ECODE_RE.exec(chunk)) !== null) {
      if (dateIdx >= 0 && cm.index >= dateIdx) break
      const canon = canonReferenceToken(cm[0])
      if (!canon || !canon.startsWith('E')) continue
      codesBefore.push({ ref: canon, index: cm.index, len: cm[0].length })
      if (codesBefore.length >= 2) break
    }
    let evidRef: string | undefined
    if (dateIdx >= 0) {
      ECODE_RE.lastIndex = dateIdx
      let em: RegExpExecArray | null
      while ((em = ECODE_RE.exec(chunk)) !== null) {
        const canonE = canonReferenceToken(em[0])
        if (!canonE || !canonE.startsWith('E')) continue
        evidRef = canonE
        break
      }
    }
    if (codesBefore.length < 2) {
      skippedRows += 1
      continue
    }

    // Verb between srcRef-end and dstRef-start. Collapse whitespace FIRST —
    // wraps put fragments on their own lines ("TRANSFERRED_T\n     O") — then
    // merge trailing short fragments into the underscore run.
    const relSpanRaw = chunk.slice(codesBefore[0].index + codesBefore[0].len, codesBefore[1].index)
    const collapsedSpan = relSpanRaw.replace(/\s+/g, ' ')
    const mergedSpan = collapsedSpan.replace(
      /\b([A-Z][A-Z_]{2,20}) ([A-Z][A-Z_]{0,5})\b(?![a-z])/g,
      (m, a: string, b: string) => (b.length <= 3 && `${a}${b}`.length <= 24 ? `${a}${b}` : m),
    )
    let candidates = (mergedSpan.match(/[A-Z][A-Z_]{2,24}/g) ?? []).filter(
      (v) => v.includes('_') || v.length >= 4,
    )
    // v3.9.2: ID-keyed exports (XML record lists, SQL dumps, SIEM exports)
    // put the verb in a dedicated column that may sit BEFORE the endpoints
    // (e.g. "R0001 | WORKS_FOR | … | E0001 | E0056"). When the between-codes
    // span holds no verb, hunt the WHOLE row — same ALL-CAPS underscore
    // grammar, just position-independent. E-code refs can't match (no
    // underscore, and digits are filtered by the length rule).
    if (candidates.length === 0) {
      // Whole-row hunt: underscored tokens are verbs by shape; bare ALL-CAPS
      // words count ONLY when they name a known relationship verb (USES, OWNS,
      // MESSAGED… are core/synonym vocabulary) — random caps words never do.
      candidates = (chunk.replace(/\s+/g, ' ').match(/[A-Z][A-Z_]{2,24}/g) ?? []).filter(
        (v) => (v.includes('_') && !/^E\d/i.test(v)) || REL_VERB_TOKENS.has(v),
      )
    }
    // Prefer underscore verbs; otherwise the verb is the candidate CLOSEST to
    // dstRef (name fragments trail behind the verb in reading order).
    let rel = ''
    const underscored = candidates.filter((c) => c.includes('_'))
    if (underscored.length) {
      rel = underscored.sort((a, b) => b.length - a.length)[0]
    } else if (candidates.length) {
      rel = candidates[candidates.length - 1]
    }
    if (!rel || rel.length < 3) {
      skippedRows += 1
      continue
    }
    const relCanonical = REL_ALIASES[rel] ?? rel

    const srcRow = rowsByRef.get(codesBefore[0].ref)
    const dstRow = rowsByRef.get(codesBefore[1].ref)
    if (!srcRow || !dstRow || srcRow.key === dstRow.key) {
      skippedRows += 1
      continue
    }

    const stateM = chunk.match(STATE_WORDS)
    // Confidence floats sit mid-chunk when endpoint names wrap onto the line
    // below, so scan every plausible 0<x<=1 float and take the RIGHTMOST.
    const allConfs = Array.from(chunk.matchAll(/\b(\d(?:\.\d{1,3})?)\b(?![\d.])/g)).filter(
      (mm) => Number.parseFloat(mm[1]) > 0 && Number.parseFloat(mm[1]) <= 1,
    )
    let confidence = allConfs.length ? Number.parseFloat(allConfs[allConfs.length - 1][1]) : NaN
    if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) confidence = 0.85

    relationships.push({
      rel: relCanonical,
      srcKey: srcRow.key,
      dstKey: dstRow.key,
      rowId: rowStarts[r].id,
      srcRef: codesBefore[0].ref,
      dstRef: codesBefore[1].ref,
      evidRef,
      evidenceValue: evidRef ? rowsByRef.get(evidRef)?.value : undefined,
      timestamp: dateM?.[1],
      state: stateM?.[1]?.toLowerCase(),
      confidence: Math.min(1, Math.max(0.05, confidence)),
    })
    relRowCount += 1

    if (dateIdx >= 0) {
      consumedDateSpans.push([
        Math.max(0, chunkStartOffset + Math.max(0, dateIdx - 6)),
        Math.min(text.length, chunkStartOffset + dateIdx + (dateM?.[0].length ?? 10) + 6),
      ])
    }
  }
  const kinds: string[] = []
  kinds.push('entity-table')
  if (relRowCount > 0) kinds.push('relationship-table')

  // ── v3.9.1 noise vocabulary (refs + attribute values → AI suppression) ──
  const noiseToken = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ')
  const entityValues = new Set(entities.map((e) => noiseToken(e.value)))
  const noise = new Set<string>()
  for (const row of rowsByRef.values()) {
    if (row.ref) noise.add(noiseToken(row.ref))
    for (const [k, v] of Object.entries(row.attrs)) {
      const key = noiseToken(k)
      const val = noiseToken(v)
      // Property KEYS ('role', 'status'…) are never entity names either.
      if (key.length >= 3 && key.length <= 24) noise.add(key)
      // Property VALUES ('Director', 'active', 'Jio', 'Nashik'…) are
      // properties of THIS row's entity — unless the value itself is also a
      // registry entity (owner=Arjun Sharma style cross-references).
      if (val.length >= 2 && val.length <= 40 && !entityValues.has(val)) noise.add(val)
    }
  }
  for (const r of relationships) {
    if (r.rowId) noise.add(noiseToken(r.rowId))
    if (r.srcRef) noise.add(noiseToken(r.srcRef))
    if (r.dstRef) noise.add(noiseToken(r.dstRef))
    if (r.evidRef) noise.add(noiseToken(r.evidRef))
  }

  return {
    entities,
    relationships,
    consumedDateSpans,
    stats: { entityRows: entityRowCount, relationshipRows: relRowCount, skippedRows, detectedTableKinds: kinds },
    noiseVocabulary: [...noise],
  }
}

/** Everything after "<rowid><whitespace><TYPE><whitespace>" on one line. */
function computeRestAfterType(line: string): string {
  const m =
    line.match(
      /^[ \t]*[A-Za-z][A-Za-z0-9_]{0,7}[-_]?[0-9]{1,6}[ \t]+[A-Z][A-Z_]{1,23}[ \t]*(.*)$/,
    ) ??
    line.match(
      /^[ \t]*[A-Za-z\u00a3\u20ac][A-Za-z0-9\u00a3\u20ac_]{0,7}[-_ ]?[0-9O0oIilLlLSsBZQ|!.,\u00a3\u20ac]{1,6}[ \t]+[A-Z][A-Z_]{1,23}[ \t]*(.*)$/,
    )
  return m ? m[1] : ''
}
