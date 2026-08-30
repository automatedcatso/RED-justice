/**
 * extractors/entityExtract.ts — Level-0 deterministic entity extraction.
 *
 * Pure regex-based extraction. No AI calls. The output is a flat list of
 * {@link ExtractedEntity} objects, deduped by (type, norm).
 *
 * Detection strategy:
 *   - Each entity type has a dedicated regex pattern (or set of patterns).
 *   - Matches are collected with their `index` (match start) so we can pull an
 *     80-char surrounding-context snippet.
 *   - Heuristic person / organization extraction is intentionally low-confidence.
 *
 * The regex patterns are deliberately tuned for "Indian + international cyber
 * fraud evidence" sources: bank statements, UPI SMS, chat exports, email dumps.
 */

import {
  normalizeAccount,
  normalizeAadhaar,
  normalizeDomain,
  normalizeEmail,
  normalizeEntity,
  normalizeGstin,
  normalizeIfsc,
  normalizeImei,
  normalizeIp,
  normalizeMac,
  normalizeOrganization,
  normalizePan,
  normalizePassport,
  normalizePhone,
  normalizePerson,
  normalizeUpi,
  normalizeUrl,
  normalizeVehicle,
  normalizeWallet,
  parseAmount,
} from './normalizers'
import { isValidImei, isValidAadhaar, isValidGstin } from './validators'
import type { EntityType, ExtractedEntity } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Regex catalogue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phone regex — captures Indian (+91 / 0 / bare 10-digit) and international
 * patterns. We allow optional separators (space, hyphen) inside the 10-digit
 * core so formats like "+91-99999-10001" or "99999 10001" are matched, while
 * still requiring the first core digit to be 6-9 (Indian mobile range).
 *
 * Boundaries:
 *   - Lookbehind (?<![\\w@.+]) blocks matches that start INSIDE a longer
 *     alphanumeric token. Without it, the 10-digit tail of an IBAN-style
 *     account number ("IN43BANK7433978249") surfaced as a phantom phone and
 *     the last-10 window of every 15-digit IMEI did too (user-visible as
 *     dozens of fake phone nodes). The blocklist also stops email-local
 *     digit runs, decimal fractions and "+…” intl numbers owned by another
 *     extractor.
 *   - Trailing (?!\d) keeps phone-prefixes of longer digit runs out.
 */
const PHONE_RE =
  /(?<![\w@.+])(?:(?:\+?91|0)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g

/** Email regex — pragmatic; allows dots, hyphens, plus in local part. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/**
 * UPI VPA regex — `name@bank` where bank is a known UPI handle prefix
 * (okhdfc / oksbi / okicici / okaxis / okkotak / ybl / ibl / axl / apl / upi /
 * paytm). Restricting to known prefixes avoids false-positive matches on
 * email fragments such as "alice@example" (which would otherwise be picked
 * up as a UPI id).
 */
const UPI_RE =
  /\b[a-z0-9._+-]{2,40}@(?:ok[a-z]{2,8}|ybl[a-z]{0,8}|ibl[a-z]{0,8}|axl[a-z]{0,8}|apl[a-z]{0,8}|upi[a-z]{0,8}|paytm[a-z]{0,8})\b/gi

/** IFSC — 4 letters + 0 + 6 alphanumeric, with optional word boundaries. */
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g

/** IPv4 — 4 octets of 1-3 digits. */
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

/** HTTP(S) URL. */
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi

/** Bare domain (foo.com, foo.co.in) — must have at least one dot and a TLD. */
const DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi

/** IMEI — 15 digits. */
const IMEI_RE = /\b\d{15}\b/g

/**
 * IBAN-style bank-account token — country code + check digits + BBAN
 * ("IN77BANK4284252722", "GB29NWBK60161331926819"). Guards below exclude
 * IFSC/PAN/GSTIN/vehicle shapes so only genuine account tokens survive.
 */
const IBANISH_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{8,20}(?![a-z0-9])/g

/** MAC address — 6 hex pairs separated by : or -. */
const MAC_RE = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g

/** Ethereum wallet — 0x + 40 hex. */
const ETH_WALLET_RE = /\b0x[0-9a-fA-F]{40}\b/g

/** Bitcoin wallet — legacy / P2SH base58. */
const BTC_WALLET_RE = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g

/**
 * Indian vehicle plate — `AA00AA0000` style. Allow space / hyphen separators
 * between the 4 logical groups (state / district / series / number).
 */
const VEHICLE_RE =
  /\b([A-Z]{2})[\s-]?(\d{1,2})[\s-]?([A-Z]{1,3})[\s-]?(\d{4})\b/g

/**
 * Dates — accepts:
 *   - ISO 8601:  2024-01-05 or 2024-01-05T10:30:00Z
 *   - DD/MM/YYYY or DD-MM-YYYY (with optional 2-digit year)
 *   - "Jan 5, 2024" / "5 January 2024"
 */
const DATE_RE =
  /\b(?:(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?Z?)?|(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})|(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4}))|(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4}))\b/g

/**
 * Amount patterns. Multiple sub-patterns — we collect all and parse later.
 *   - ₹ + numbers
 *   - "Rs. 5000" / "INR 5000"
 *   - "5,000/-"
 *   - "1.5 lakh" / "2 cr" / "5 lac"
 */
const AMOUNT_RE =
  /(?:₹\s*\d[\d,]*(?:\.\d+)?|rs\.?\s*\d[\d,]*(?:\.\d+)?|inr\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:\/-)?\s*(?:lakhs?|lacs?|lakh|lac|cr|crore|crores|k|m|million)\b)/gi

/** Aadhaar — 12 digits, often formatted as `1234 5678 9012`. */
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g

/** PAN — ABCDE1234F. */
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g

/** GSTIN — 15 chars. */
const GSTIN_RE =
  /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/g

/** Passport — 1 letter + 7 digits. */
const PASSPORT_RE = /\b[A-Z][0-9]{7}\b/g

/**
 * Person name heuristics — capture common Indian name patterns prefixed by a
 * salutation, or `Name: ...` / `Holder: ...` markers.
 */
const SALUTATION_NAME_RE =
  /\b(?:Mr|Mrs|Ms|Dr|Sri|Smt|Sh)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/g
const LABEL_NAME_RE =
  /\b(?:Name|Holder|Customer|Acc(?:ount)?\s*Holder|Beneficiary|Sender|Receiver|Suspect|Owner)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/g

/**
 * Organization suffixes — Indian + international. Captures the 1-3 tokens
 * preceding the suffix as the org name.
 */
const ORG_SUFFIX_RE =
  /\b([A-Z][A-Za-z0-9&.,'-]*(?:\s+[A-Z][A-Za-z0-9&.,'-]*){0,4})\s+(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Ltd\.?|Limited|LLP|Inc\.?|Corp\.?|Corporation|Bank|Banc|Banking|Trust|Foundation|Holdings|Trading\s+Co\.?|Industries|Enterprises|Solutions|Technologies|Tech)\b/g

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull up to 80 chars of context around a match start index. Includes 40 chars
 * before and 40 chars after when available.
 */
function contextAround(text: string, index: number, end: number): string {
  if (typeof text !== 'string') return ''
  const startPad = 40
  const endPad = 40
  const start = Math.max(0, index - startPad)
  const stop = Math.min(text.length, end + endPad)
  let snippet = text.slice(start, stop).replace(/\s+/g, ' ').trim()
  if (snippet.length > 80) snippet = snippet.slice(0, 80)
  return snippet
}

/** Build an ExtractedEntity with normalized form + context. */
function makeEntity(
  text: string,
  type: EntityType,
  rawValue: string,
  matchIndex: number,
  matchEnd: number,
  confidence: number,
  label?: string,
): ExtractedEntity {
  const norm = normalizeEntity(type, rawValue) || rawValue.trim()
  return {
    type,
    value: rawValue.trim(),
    norm,
    label,
    confidence,
    context: contextAround(text, matchIndex, matchEnd),
  }
}

/** Collect all matches for a regex into ExtractedEntity[]. */
function collectAll(
  text: string,
  type: EntityType,
  regex: RegExp,
  confidence: number,
  normalizer?: (raw: string) => string,
  label?: string,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  // Reset regex state in case it was used before.
  const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, '') + 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    if (!raw) continue
    const norm = normalizer ? normalizer(raw) : normalizeEntity(type, raw)
    if (!norm) continue
    out.push({
      type,
      value: raw.trim(),
      norm,
      label,
      confidence,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    // Avoid zero-length match infinite loop.
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-extractors
// ─────────────────────────────────────────────────────────────────────────────

function extractPhones(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(PHONE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const norm = normalizePhone(raw)
    if (!norm || norm.length < 10) continue
    // Filter out things that look like Aadhaar / account numbers / UTRs.
    if (/^\d{12}$/.test(norm) || /^\d{14,}$/.test(norm) && norm.length > 12) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: 'phone',
      value: raw.trim(),
      norm,
      confidence: 0.9,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

function extractEmails(text: string): ExtractedEntity[] {
  return collectAll(text, 'email', EMAIL_RE, 0.95, undefined)
}

function extractUpis(text: string): ExtractedEntity[] {
  // The UPI regex is greedy on the host side; filter false positives.
  const collected = collectAll(text, 'upi', UPI_RE, 0.9, normalizeUpi)
  return collected.filter((e) => {
    // Must look like `name@bank`.
    const parts = e.norm.split('@')
    if (parts.length !== 2) return false
    if (!parts[0] || !parts[1]) return false
    // Avoid matching email addresses (which also have name@bank form) — a UPI
    // VPA's bank part is typically 2-12 chars and starts with `ok` / `ybl` /
    // `ibl` / `axl` / `paytm` / `upi` / `oksbi` / etc.
    if (parts[1].length > 12) return false
    if (parts[1].includes('.')) return false
    // If the local part looks like a real email local part AND the host looks
    // like a real domain (has a dot), skip — it's an email.
    if (parts[1].length > 6 && /^[a-z]+$/.test(parts[1]) === false) return false
    return true
  })
}

function extractIfscs(text: string): ExtractedEntity[] {
  return collectAll(text, 'ifsc', IFSC_RE, 0.95, undefined).filter(
    (e) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(e.norm),
  )
}

function extractIps(text: string): ExtractedEntity[] {
  const collected = collectAll(text, 'ip', IP_RE, 0.85, undefined)
  return collected.filter((e) => {
    const parts = e.norm.split('.')
    if (parts.length !== 4) return false
    return parts.every((p) => {
      const n = Number.parseInt(p, 10)
      return Number.isFinite(n) && n >= 0 && n <= 255
    })
  })
}

function extractUrls(text: string): ExtractedEntity[] {
  return collectAll(text, 'url', URL_RE, 0.9, undefined)
}

function extractDomains(text: string): ExtractedEntity[] {
  // Strip URLs and emails first so we don't double-count their hosts as bare
  // domains. We then collect bare-domain matches.
  const stripped = text
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(IP_RE, ' ')
  return collectAll(stripped, 'domain', DOMAIN_RE, 0.7, normalizeDomain).filter(
    (e) => {
      // Reject obvious false positives.
      const tld = e.norm.split('.').pop() ?? ''
      if (tld.length < 2) return false
      // Reject "file.pdf" / "img.jpg" / etc.
      const KNOWN_FILE_TLDS = new Set([
        'pdf',
        'jpg',
        'jpeg',
        'png',
        'gif',
        'txt',
        'csv',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'zip',
        'tar',
        'gz',
        'mp4',
        'mp3',
        'exe',
        'bin',
      ])
      if (KNOWN_FILE_TLDS.has(tld.toLowerCase())) return false
      return true
    },
  )
}

function extractImeis(text: string): ExtractedEntity[] {
  // v3.9 master prompt: unlabeled IMEI extraction requires the LUHN checksum —
  // a random 15-digit token (account no, reference no) fails Luhn ~90% of the
  // time and was never an IMEI. Labeled sources (CDR IMEI column) keep domain
  // validation via the column header instead.
  return collectAll(text, 'imei', IMEI_RE, 0.7, normalizeImei).filter(
    (e) => isValidImei(e.norm),
  )
}

function extractMacs(text: string): ExtractedEntity[] {
  return collectAll(text, 'mac', MAC_RE, 0.85, normalizeMac)
}

function extractWallets(text: string): ExtractedEntity[] {
  const eth = collectAll(text, 'wallet', ETH_WALLET_RE, 0.95, normalizeWallet)
  const btc = collectAll(text, 'wallet', BTC_WALLET_RE, 0.8, normalizeWallet)
  return [...eth, ...btc]
}

function extractVehicles(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(VEHICLE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const norm = normalizeVehicle(raw)
    if (!norm) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: 'vehicle',
      value: raw.trim(),
      norm,
      confidence: 0.85,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

/** Options for {@link extractEntities}. */
export interface ExtractEntitiesOptions {
  /**
   * Character spans already consumed by structured-table parsing
   * (see ./registryExtract). Date matches starting inside any span are
   * skipped, so a relationship register's per-row Date column doesn't spawn
   * one date-entity per calendar day.
   */
  skipDateSpans?: Array<[number, number]>
  /**
   * Specific ISO date VALUES already claimed by structured rows — dropped
   * wherever they appear (belt-and-braces alongside spans).
   */
  skipDateValues?: Set<string>
}

function spanContains(spans: Array<[number, number]> | undefined, idx: number): boolean {
  if (!spans || spans.length === 0) return false
  for (const [s, e] of spans) if (idx >= s && idx <= e) return true
  return false
}

function extractDates(text: string): ExtractedEntity[]
function extractDates(text: string, skipSpans?: Array<[number, number]>, skipValueSet?: Set<string>): ExtractedEntity[]
function extractDates(
  text: string,
  skipSpans?: Array<[number, number]>,
  skipValueSet?: Set<string>,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(DATE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (skipSpans && spanContains(skipSpans, m.index)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    const raw = m[0]
    // Normalize to ISO date string when possible.
    const iso = dateToIso(raw)
    // Unparseable date-shaped tokens (e.g. cross-column PDF artifacts like
    // "18 Lake      2026") carry zero investigative value — never nodes.
    if (!iso) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    const norm = iso
    if (skipValueSet?.has(norm)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    if (seen.has(norm)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    seen.add(norm)
    out.push({
      type: 'date',
      value: raw.trim(),
      norm,
      confidence: 0.8,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

function extractAmounts(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<number>()
  const re = new RegExp(AMOUNT_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const value = parseAmount(raw)
    if (!Number.isFinite(value) || value <= 0) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    // Use the numeric value as the norm (string form for dedup stability).
    const norm = String(value)
    if (seen.has(value)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    seen.add(value)
    out.push({
      type: 'amount',
      value: raw.trim(),
      norm,
      confidence: 0.85,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

function extractDocumentIds(text: string): ExtractedEntity[] {
  // v3.9 master prompt: Aadhaar → VERHOEFF, GSTIN → mod-36 check digit.
  // Unlabeled 12-digit numbers failing Verhoeff are account/reference numbers,
  // not Aadhaar — they belong to the account extractor, not document_id.
  const aadhaar = collectAll(text, 'document_id', AADHAAR_RE, 0.8, normalizeAadhaar)
    .filter((e) => isValidAadhaar(e.norm))
    .map((e) => ({ ...e, label: 'Aadhaar' }))
  const pans = collectAll(text, 'document_id', PAN_RE, 0.95, normalizePan)
    .filter((e) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(e.norm))
    .map((e) => ({ ...e, label: 'PAN' }))
  const gstins = collectAll(text, 'document_id', GSTIN_RE, 0.95, normalizeGstin)
    .filter((e) => isValidGstin(e.norm))
    .map((e) => ({ ...e, label: 'GSTIN' }))
  const passports = collectAll(text, 'document_id', PASSPORT_RE, 0.7, normalizePassport)
    .filter((e) => /^[A-Z][0-9]{7}$/.test(e.norm))
    .map((e) => ({ ...e, label: 'Passport' }))
  return [...aadhaar, ...pans, ...gstins, ...passports]
}

function extractPeople(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  // Run both heuristics, dedup by normalized name.
  for (const re of [SALUTATION_NAME_RE, LABEL_NAME_RE]) {
    const r = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = r.exec(text)) !== null) {
      const raw = m[1]
      if (!raw) {
        if (r.lastIndex === m.index) r.lastIndex += 1
        continue
      }
      const norm = normalizePerson(raw)
      if (!norm || norm.length < 3) {
        if (r.lastIndex === m.index) r.lastIndex += 1
        continue
      }
      if (seen.has(norm)) {
        if (r.lastIndex === m.index) r.lastIndex += 1
        continue
      }
      seen.add(norm)
      out.push(
        makeEntity(
          text,
          'person',
          raw,
          m.index,
          m.index + raw.length,
          0.55,
          'Inferred person name',
        ),
      )
      if (r.lastIndex === m.index) r.lastIndex += 1
    }
  }
  return out
}

function extractOrganizations(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(ORG_SUFFIX_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    if (!raw) continue
    const norm = normalizeOrganization(raw)
    if (!norm) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    if (seen.has(norm)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    seen.add(norm)
    out.push(
      makeEntity(
        text,
        'organization',
        raw,
        m.index,
        m.index + raw.length,
        0.7,
        'Inferred organization',
      ),
    )
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

/**
 * Extract account-number-like tokens. We are conservative here because
 * 10-16 digit numbers overlap with phones, IMEIs, UTRs, Aadhaar, etc.
 *
 * Strategy: look for explicit labels (`A/c`, `Account`, `Acct`, `Ac`, etc.)
 * followed by a 9-18 digit (or X-masked) token, OR a standalone 11-18 digit
 * number with a banking context keyword nearby (IFSC, NEFT, IMPS, UPI,
 * balance, debit, credit).
 */
const ACCOUNT_LABEL_RE =
  /\b(?:a\/c(?:count)?|acct|ac\s*no|account)\s*(?:no\.?|number)?\s*[:\-]?\s*([Xx0-9][Xx0-9\- ]{8,17})\b/gi

function extractAccounts(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(ACCOUNT_LABEL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    const norm = normalizeAccount(raw)
    if (!norm || norm.length < 6) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    // Aadhaar shape (4-4-4 / 12 digits) must not become a bank account.
    if (/^\d{4}\s?\d{4}\s?\d{4}$/.test(raw.trim())) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    if (seen.has(norm)) {
      if (re.lastIndex === m.index) re.lastIndex += 1
      continue
    }
    seen.add(norm)
    out.push(
      makeEntity(
        text,
        'account',
        raw,
        m.index,
        m.index + raw.length,
        0.85,
        'Bank account',
      ),
    )
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

/**
 * IBAN-style account tokens — "IN77BANK4284252722". Country code + check
 * digits + BBAN. Filters keep IFSC/PAN/GSTIN/vehicle/hex shapes out: the
 * tail after country+check must contain a run of 4+ letters (bank code) or a
 * long digit tail (core number).
 */
function extractIbanAccounts(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(IBANISH_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    if (raw.length < 12 || raw.length > 26) continue
    const tail = raw.slice(4)
    if (!/[A-Z]{4}/.test(tail) && !/\d{6,}/.test(tail)) continue
    const norm = raw.toLowerCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: 'account',
      value: raw,
      norm,
      label: 'Bank account (IBAN-style)',
      confidence: 0.85,
      context: contextAround(text, m.index, m.index + raw.length),
    })
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Date normalization
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

/**
 * Best-effort conversion of a date-shaped string into ISO `YYYY-MM-DD`.
 * Returns the input string when parsing fails.
 */
function dateToIso(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  // ISO 8601 — already close to ISO date.
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/)
  if (isoMatch) {
    const [, y, mo, d, time] = isoMatch
    const core = `${y}-${mo}-${d}`
    return time ? `${core}T${time}${time.endsWith('Z') ? '' : 'Z'}` : core
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (dmyMatch) {
    let [, dd, mm, yy] = dmyMatch
    let year = Number.parseInt(yy, 10)
    if (year < 100) year += 2000
    const moN = Number.parseInt(mm, 10)
    const dayN = Number.parseInt(dd, 10)
    // Range sanity kills vehicle-plate ghosts like "50-1-8454".
    if (moN < 1 || moN > 12 || dayN < 1 || dayN > 31) return undefined
    if (year < 1950 || year > 2100) return undefined
    return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }
  // "Jan 5, 2024"
  const mdyMatch = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/)
  if (mdyMatch) {
    const [, monName, dd, yy] = mdyMatch
    const mo = MONTHS[monName.toLowerCase()]
    if (!mo) return undefined
    return `${yy}-${String(mo).padStart(2, '0')}-${dd.padStart(2, '0')}`
  }
  // "5 January 2024"
  const dmonMatch = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/)
  if (dmonMatch) {
    const [, dd, monName, yy] = dmonMatch
    const mo = MONTHS[monName.toLowerCase()]
    if (!mo) return undefined
    return `${yy}-${String(mo).padStart(2, '0')}-${dd.padStart(2, '0')}`
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended detectors — v1.4 entity-detection fixes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UTR / reference numbers — bank fraud evidence references these constantly,
 * usually labeled explicitly: "UTR: N123...", "UPI Ref No 123456789012",
 * "RRN 458796321456", "Txn ID ABC123…".
 */
const REF_NO_RE =
  /\b(?:utr|neft\s*utr|ref(?:erence)?(?:\s*no|number|#)?|rrn|retrival reference|txn\s*(?:id|no)|transaction\s*(?:id|ref(?:\s*no)?)?|upi\s*ref(?:\s*no)?)\s*[:#\-]?\s*([A-Z0-9]{8,22})\b/gi

function extractReferenceNumbers(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(REF_NO_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    // Reject pure runs shorter than meaningful refs; reject values that are
    // clearly dates/amount fragments.
    if (/^\d{5}$/.test(raw)) continue
    const norm = raw.toUpperCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: 'document_id',
      value: raw.trim(),
      norm,
      label: 'UTR / Reference No',
      confidence: 0.85,
      context: contextAround(text, m.index, m.index + m[0].length),
    })
  }
  return out
}

/**
 * WhatsApp/Telegram sender extraction. Exported chat lines look like:
 *   [12/05/24, 10:15:00 AM] Ravi Kumar: bhai call karo
 *   12/05/24, 10:15 - +91 99999 10001: sent money?
 * Senders named as phone numbers become phone entities; named senders become
 * person candidates (medium confidence).
 */
const CHAT_SENDER_LINE_RE =
  /^(?:[\u200e\u200f]?[[(]?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*\]?\s*-?\s*)([^:\n]{1,64}):/gim

function extractChatSenders(text: string): { people: ExtractedEntity[]; phoneSenders: ExtractedEntity[] } {
  const counts = new Map<string, { count: number; firstIndex: number; index: number }>()
  const phoneCounts = new Map<string, { count: number; firstIndex: number; norm: string }>()
  const re = new RegExp(CHAT_SENDER_LINE_RE.source, 'gm')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let sender = (m[1] ?? '').trim().replace(/^~+/, '')
    if (!sender || sender.length < 2) continue
    // Phone-number senders: "‎+91 99999 10001" or bare digits.
    const digits = sender.replace(/[^\d]/g, '')
    if (/^[+?\d][\d\s()-]{6,}$/.test(sender) && digits.length >= 10 && sender.length <= 20) {
      const norm = digits.length === 10 ? `+91${digits}` : digits.length === 12 ? `+${digits}` : digits
      const cur = phoneCounts.get(norm)
      if (cur) cur.count += 1
      else phoneCounts.set(norm, { count: 1, firstIndex: m.index, norm })
      continue
    }
    // Plain sanity: not HTML, not media markers, reasonable name shape.
    if (/[<>]|https?:|www\./i.test(sender)) continue
    if ((sender.match(/\s/g)?.length ?? 0) > 6) continue
    const idx = m.index + m[0].indexOf(m[1])
    const key = sender.toLowerCase()
    const cur = counts.get(key)
    if (cur) cur.count += 1
    else counts.set(key, { count: 1, firstIndex: m.index, index: idx })
  }
  const people: ExtractedEntity[] = []
  // Second pass keeps original casing of the most frequent variant.
  const casing = new Map<string, string>()
  const caseRe = new RegExp(CHAT_SENDER_LINE_RE.source, 'gm')
  while ((m = caseRe.exec(text)) !== null) {
    const s = (m[1] ?? '').trim()
    if (s) {
      const key = s.toLowerCase()
      if (!casing.has(key)) casing.set(key, s)
    }
  }
  for (const [key, info] of counts.entries()) {
    const value = casing.get(key) ?? key
    const norm = normalizePerson(value)
    if (!norm || norm.length < 3) continue
    people.push({
      type: 'person',
      value,
      norm,
      label: 'Chat participant',
      confidence: info.count >= 3 ? 0.7 : 0.55,
      context: contextAround(text, info.index, info.index + value.length),
    })
  }
  const phoneSenders: ExtractedEntity[] = []
  for (const [, info] of phoneCounts.entries()) {
    if (!info.norm || info.norm.length < 10) continue
    phoneSenders.push({
      type: 'phone',
      value: info.norm.startsWith('+') ? info.norm : `+91${info.norm}`,
      norm: info.norm.startsWith('+') ? info.norm : `+91${info.norm}`,
      label: 'Chat participant (phone)',
      confidence: 0.8,
      context: contextAround(text, info.firstIndex, info.firstIndex + 40),
    })
  }
  return { people, phoneSenders }
}

/**
 * Bank-transaction narrations — the goldmine inside statements/SMS.
 * Standard forms:
 *   UPI/DR/512345678901/RAVI KUMAR/YBL
 *   IMPS/CR/567890123456/M/S GLOBEX TRADERS/HDFC/Chennai
 * We pull counterparty NAME segments and bank/org mentions so statement rows
 * stop silently losing their participants at extraction time.
 */
const NARRATION_RE =
  /\b(UPI|IMPS|NEFT|RTGS|ACH|MMT|ECS|CLG|POS|PATM|INF|TXN)\s*[/-]\s*(?:CR|DR|BY DEBIT|TO CREDIT|[CD])\s*[/-]\s*[A-Z0-9]{2,26}\s*[/-]\s*([A-Za-z0-9][A-Za-z0-9 .,&'_/-]{2,46}?)(?=\s*[/-]\s*[A-Z0-9@.]{2,26}|$|[,;\n])/gi

const KNOWN_BANKS: Array<[string, string]> = [
  ['state bank of india', 'State Bank of India'], ['sbi', 'State Bank of India'],
  ['hdfc', 'HDFC Bank'], ['icici', 'ICICI Bank'], ['axis bank', 'Axis Bank'],
  ['kotak', 'Kotak Mahindra Bank'], ['punjab national', 'Punjab National Bank'], ['pnb', 'Punjab National Bank'],
  ['bank of baroda', 'Bank of Baroda'], ['bob', 'Bank of Baroda'], ['canara bank', 'Canara Bank'],
  ['union bank', 'Union Bank of India'], ['idfc', 'IDFC FIRST Bank'], ['yes bank', 'Yes Bank'],
  ['indusind', 'IndusInd Bank'], ['federal bank', 'Federal Bank'], ['rbl bank', 'RBL Bank'],
  ['bandhan bank', 'Bandhan Bank'], ['idbi', 'IDBI Bank'], ['indian bank', 'Indian Bank'],
  ['indian overseas', 'Indian Overseas Bank'], ['central bank of india', 'Central Bank of India'],
  ['bank of india', 'Bank of India'], ['uco bank', 'UCO Bank'], ['mahabank', 'Maharashtra Bank'],
  ['bank of maharashtra', 'Bank of Maharashtra'], ['karnataka bank', 'Karnataka Bank'],
  ['karur vysya', 'Karur Vysya Bank'], ['city union bank', 'City Union Bank'], ['tmb', 'Tamilnad Mercantile Bank'],
  ['csb bank', 'CSB Bank'], ['dcb bank', 'DCB Bank'], ['au small finance', 'AU Small Finance Bank'],
  ['equitas', 'Equitas Small Finance Bank'], ['ujjivan', 'Ujjivan Small Finance Bank'],
  ['paytm', 'Paytm'], ['phonepe', 'PhonePe'], ['phone pe', 'PhonePe'],
  ['google pay', 'Google Pay'], ['googlepay', 'Google Pay'], ['gpay', 'Google Pay'],
  ['amazon pay', 'Amazon Pay'], ['amazonpay', 'Amazon Pay'], ['bhim', 'BHIM UPI'],
  ['freecharge', 'Freecharge'], ['mobikwik', 'MobiKwik'], ['jiomoney', 'JioMoney'],
  ['airtel payments bank', 'Airtel Payments Bank'], ['fino payments bank', 'Fino Payments Bank'],
  ['western union', 'Western Union'], ['moneygram', 'MoneyGram'], ['wise', 'Wise Transfer'],
]

function titleCaseName(raw: string): string {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 || /^[a-z]/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(' ')
}

function extractNarrationParties(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = new RegExp(NARRATION_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = (m[2] ?? '').replace(/\s*\/\s*$/, '').trim()
    if (!name || name.length < 3) continue
    const words = name.split(/\s+/).filter(Boolean)
    const looksLikePerson =
      words.length <= 4 &&
      !/ltd|pvt|llp|inc|corp|enterprises|traders|store|agency|transport|hotel|hospital/i.test(name)
    // Use the SAME norm format as the salutation/label extractors
    // (normalizePerson → "Ravi Kumar") so cross-file dedup merges them.
    const value = looksLikePerson ? normalizePerson(titleCaseName(name)) : name
    const norm = normalizePerson(titleCaseName(name))
    if (!norm || norm.length < 3 || seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: looksLikePerson ? 'person' : 'organization',
      value,
      norm,
      label: looksLikePerson ? 'From txn narration' : 'Merchant (from narration)',
      confidence: 0.62,
      context: contextAround(text, m.index, m.index + m[0].length),
    })
  }
  // Known banks/organizations mentioned with narration proximity or plainly.
  const lower = text.toLowerCase()
  for (const [needle, canonical] of KNOWN_BANKS) {
    if (out.some((o) => o.value === canonical)) continue
    let idx = lower.indexOf(` ${needle}`)
    if (idx === -1) idx = lower.startsWith(needle) ? 0 : -1
    if (idx === -1) continue
    const normKey = canonical.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (seen.has(normKey)) continue
    seen.add(normKey)
    out.push({
      type: 'organization',
      value: canonical,
      norm: normKey,
      label: 'Financial institution',
      confidence: 0.78,
      context: contextAround(text, Math.max(0, idx), Math.max(0, idx) + needle.length + 2),
    })
  }
  return out.slice(0, 60)
}

/**
 * Indian location recognition — curated city/district/state vocabulary.
 * Helps "connecting dots": places where evidence events occurred become
 * first-class graph nodes instead of invisible prose.
 */
const KNOWN_LOCATIONS: Array<[string, string]> = [
  ['delhi', 'Delhi'], ['new delhi', 'New Delhi'], ['mumbai', 'Mumbai'], ['navi mumbai', 'Navi Mumbai'],
  ['thane', 'Thane'], ['pune', 'Pune'], ['nagpur', 'Nagpur'], ['nashik', 'Nashik'],
  ['bengaluru', 'Bengaluru'], ['bangalore', 'Bengaluru'], ['mysuru', 'Mysuru'], ['hubli', 'Hubli'],
  ['hyderabad', 'Hyderabad'], ['secunderabad', 'Secunderabad'], ['warangal', 'Warangal'],
  ['chennai', 'Chennai'], ['coimbatore', 'Coimbatore'], ['madurai', 'Madurai'], ['trichy', 'Tiruchirappalli'],
  ['kolkata', 'Kolkata'], ['howrah', 'Howrah'], ['siliguri', 'Siliguri'], ['asansol', 'Asansol'],
  ['ahmedabad', 'Ahmedabad'], ['surat', 'Surat'], ['vadodara', 'Vadodara'], ['rajkot', 'Rajkot'],
  ['jaipur', 'Jaipur'], ['jodhpur', 'Jodhpur'], ['udaipur', 'Udaipur'], ['kota', 'Kota'],
  ['lucknow', 'Lucknow'], ['kanpur', 'Kanpur'], ['varanasi', 'Varanasi'], ['prayagraj', 'Prayagraj'],
  ['allahabad', 'Prayagraj'], ['agra', 'Agra'], ['mathura', 'Mathura'], ['meerut', 'Meerut'],
  ['ghaziabad', 'Ghaziabad'], ['noida', 'Noida'], ['greater noida', 'Greater Noida'], ['gurgaon', 'Gurugram'],
  ['gurugram', 'Gurugram'], ['faridabad', 'Faridabad'], ['chandigarh', 'Chandigarh'], ['panchkula', 'Panchkula'],
  ['bhopal', 'Bhopal'], ['indore', 'Indore'], ['gwalior', 'Gwalior'], ['jabalpur', 'Jabalpur'],
  ['patna', 'Patna'], ['gaya', 'Gaya'], ['muzaffarpur', 'Muzaffarpur'], ['bhagalpur', 'Bhagalpur'],
  ['ranchi', 'Ranchi'], ['jamshedpur', 'Jamshedpur'], ['dhanbad', 'Dhanbad'], ['bhubaneswar', 'Bhubaneswar'],
  ['cuttack', 'Cuttack'], ['raipur', 'Raipur'], ['bhilai', 'Bhilai'], ['dehradun', 'Dehradun'],
  ['haridwar', 'Haridwar'], ['roorkee', 'Roorkee'], ['guwahati', 'Guwahati'], ['shillong', 'Shillong'],
  ['imphal', 'Imphal'], ['aizawl', 'Aizawl'], ['kohima', 'Kohima'], ['itanagar', 'Itanagar'],
  ['gangtok', 'Gangtok'], ['agartala', 'Agartala'], ['port blair', 'Port Blair'], ['puducherry', 'Puducherry'],
  ['goa', 'Goa'], ['panaji', 'Panaji'], ['kochi', 'Kochi'], ['ernakulam', 'Ernakulam'],
  ['kozhikode', 'Kozhikode'], ['thrissur', 'Thrissur'], ['trivandrum', 'Thiruvananthapuram'],
  ['thiruvananthapuram', 'Thiruvananthapuram'], ['amritsar', 'Amritsar'], ['ludhiana', 'Ludhiana'],
  ['patiala', 'Patiala'], ['jalandhar', 'Jalandhar'], ['shimla', 'Shimla'], ['srinagar', 'Srinagar'],
  ['jammu', 'Jammu'], ['leh', 'Leh'], ['jamshedpur', 'Jamshedpur'],
  ['uttar pradesh', 'Uttar Pradesh'], ['maharashtra', 'Maharashtra'], ['karnataka', 'Karnataka'],
  ['telangana', 'Telangana'], ['tamil nadu', 'Tamil Nadu'], ['kerala', 'Kerala'],
  ['west bengal', 'West Bengal'], ['gujarat', 'Gujarat'], ['rajasthan', 'Rajasthan'],
  ['madhya pradesh', 'Madhya Pradesh'], ['bihar', 'Bihar'], ['jharkhand', 'Jharkhand'],
  ['odisha', 'Odisha'], ['chhattisgarh', 'Chhattisgarh'], ['uttarakhand', 'Uttarakhand'],
  ['assam', 'Assam'], ['punjab', 'Punjab'], ['haryana', 'Haryana'], ['himachal pradesh', 'Himachal Pradesh'],
  ['tripura', 'Tripura'], ['manipur', 'Manipur'], ['meghalaya', 'Meghalaya'], ['nagaland', 'Nagaland'],
  ['mizoram', 'Mizoram'], ['arunachal pradesh', 'Arunachal Pradesh'], ['sikkim', 'Sikkim'],
]

function extractLocations(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const bare = ` ${text.replace(/\s+/g, ' ').toLowerCase()} `
  for (const [needle, canonical] of KNOWN_LOCATIONS) {
    if (seen.has(canonical)) continue
    const at = bare.indexOf(` ${needle}`)
    if (at === -1) continue
    seen.add(canonical)
    const origIdx = Math.max(0, at - 1)
    out.push({
      type: 'location',
      value: canonical,
      norm: canonical.toLowerCase().replace(/[^a-z0-9]/g, ''),
      label: 'Location',
      confidence: needle.includes(' ') || needle.length > 6 ? 0.72 : 0.6,
      context: contextAround(text, origIdx, origIdx + needle.length),
    })
  }
  return out.sort((a, b) => (a.context?.indexOf(a.value.toLowerCase()) ?? 0) - (b.context?.indexOf(b.value.toLowerCase()) ?? 0)).slice(0, 50)
}

/** Masked account fragments like "XXXXXX1234" / "**7481" near banking labels. */
function extractMaskedAccounts(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = /\b([Xx*]{4,8}\d{3,5})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    const window = text.slice(Math.max(0, start - 60), Math.min(text.length, end + 60))
    if (!/(account|a\/c|acct|ac no|card number|linked|beneficiary|debit card|credit card|upi)/i.test(window)) continue
    const norm = `MASKED-${m[1].toUpperCase()}`
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      type: 'account',
      value: m[1],
      norm,
      label: 'Masked account/card',
      confidence: 0.6,
      context: contextAround(text, start, end),
    })
  }
  return out
}

/** International phones beyond +91 (E.164-style, any country code). */
function extractIntlPhones(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = []
  const seen = new Set<string>()
  const re = /\+(?!91(?![^\d]))(\d[\d\s-]{8,17}\d)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim()
    const digits = raw.replace(/[^\d]/g, '') // includes country code, no leading 91 by design
    if (digits.length < 8 || digits.length > 15) continue
    if (/^91/.test(digits)) continue // domestic handled by PHONE_RE
    const fullNorm = `+${digits}`
    if (seen.has(fullNorm)) continue
    seen.add(fullNorm)
    out.push({
      type: 'phone',
      value: raw,
      norm: fullNorm,
      label: 'International number',
      confidence: 0.75,
      context: contextAround(text, m.index, m.index + raw.length),
    })
  }
  return out
}


/**
 * Extract all recognized entities from a text string.
 *
 * Returns the combined list of {@link ExtractedEntity} objects, deduped by
 * `(type, norm)`. Confidence values reflect the source reliability:
 *   - 0.9 - 0.95 : structured identifiers (IFSC, PAN, email, ETH wallet, IMEI).
 *   - 0.85       : phones (post-validation), bank accounts (labeled).
 *   - 0.7 - 0.8  : domains, BTC wallets, vehicle plates, dates, amounts.
 *   - 0.4 - 0.6  : inferred person / organization names.
 *
 * This is the Level-0 deterministic analysis layer; it never makes AI calls.
 */
export function extractEntities(
  text: string,
  options?: ExtractEntitiesOptions,
): ExtractedEntity[] {
  if (!text || typeof text !== 'string') return []
  const skipDateSpans = options?.skipDateSpans
  const skipDateValues = options?.skipDateValues
  const chatSenders = extractChatSenders(text)
  const raw: ExtractedEntity[] = [
    ...extractPhones(text),
    ...extractIntlPhones(text),
    ...extractEmails(text),
    ...extractUpis(text),
    ...extractIfscs(text),
    ...extractIps(text),
    ...extractUrls(text),
    ...extractDomains(text),
    ...extractImeis(text),
    ...extractMacs(text),
    ...extractWallets(text),
    ...extractVehicles(text),
    ...extractDates(text, skipDateSpans, skipDateValues),
    ...extractAmounts(text),
    ...extractDocumentIds(text),
    ...extractPeople(text),
    ...chatSenders.people,
    ...chatSenders.phoneSenders,
    ...extractOrganizations(text),
    ...extractNarrationParties(text),
    ...extractLocations(text),
    ...extractAccounts(text),
    ...extractMaskedAccounts(text),
    ...extractIbanAccounts(text),
    ...extractReferenceNumbers(text),
  ]

  // Dedupe by (type, norm). Keep the highest-confidence occurrence; on ties,
  // prefer the earliest one.
  const map = new Map<string, ExtractedEntity>()
  for (const e of raw) {
    const key = `${e.type}::${e.norm}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, e)
      continue
    }
    if (e.confidence > existing.confidence) {
      map.set(key, e)
    }
  }

  // Cross-type dedup: 15-digit numbers can be matched as both IMEI and
  // (labeled) account. Prefer the account classification (higher confidence,
  // labeled context) and drop the IMEI duplicate.
  const accountNorms = new Set<string>()
  for (const e of map.values()) {
    if (e.type === 'account') {
      accountNorms.add(e.norm)
      // Also account for masked variants like "XXXX1234".
      if (/^\d+$/.test(e.norm)) accountNorms.add(e.norm)
    }
  }
  const filtered: ExtractedEntity[] = []
  for (const e of map.values()) {
    if (e.type === 'imei' && accountNorms.has(e.norm)) continue
    filtered.push(e)
  }
  return filtered
}

/**
 * Convenience: extract just the date strings (ISO normalized when parseable).
 * Useful for timeline construction.
 */
export function extractDateStrings(text: string): string[] {
  return extractDates(text).map((e) => e.norm).filter(Boolean)
}

/**
 * Convenience: extract just the numeric amounts found in the text.
 */
export function extractAmountNumbers(text: string): number[] {
  return extractAmounts(text)
    .map((e) => Number.parseFloat(e.norm))
    .filter((n) => Number.isFinite(n) && n > 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for downstream consumers (txnExtract, commExtract, seed)
// ─────────────────────────────────────────────────────────────────────────────

export {
  ACCOUNT_LABEL_RE,
  AADHAAR_RE,
  AMOUNT_RE,
  DATE_RE,
  DOMAIN_RE,
  EMAIL_RE,
  ETH_WALLET_RE,
  BTC_WALLET_RE,
  GSTIN_RE,
  IFSC_RE,
  IMEI_RE,
  IP_RE,
  MAC_RE,
  PAN_RE,
  PASSPORT_RE,
  PHONE_RE,
  ORG_SUFFIX_RE,
  SALUTATION_NAME_RE,
  LABEL_NAME_RE,
  UPI_RE,
  URL_RE,
  VEHICLE_RE,
  dateToIso,
  contextAround,
  parseAmount as parseAmountNumber,
}
