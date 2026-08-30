/**
 * extractors/normalizers.ts — Per-entity-type normalization helpers.
 *
 * Each function takes a raw matched string and returns its canonical form.
 * The canonical form is what we use for:
 *   - Deduplication inside a single evidence document.
 *   - Cross-evidence entity merging via the Prisma `@@unique([caseId, type, norm])`
 *     constraint (see schema.prisma).
 *   - Stable graph-node identity.
 *
 * All functions are pure and never throw — bad input yields the input trimmed
 * rather than an exception.
 */

import type { EntityType } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Phone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number.
 *
 * Rules:
 *   - Strip everything except digits and a leading '+'.
 *   - If the result is 12 digits starting with '91' → drop the '91' prefix.
 *   - If the result is 11 digits starting with '0'  → drop the '0'  prefix.
 *   - Keep a leading '+' for international numbers with >10 digits that don't
 *     start with 91 / 0.
 *   - If we end up with exactly 10 digits → return those 10 (Indian mobile).
 *
 * Returns the normalized form as a plain digit string (no '+' for Indian
 * 10-digit numbers, with '+' for international numbers).
 */
export function normalizePhone(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return ''
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return trimmed
  // Indian +91 or 91 prefix with 12 digits total → strip 91
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2)
  }
  // Indian 0 prefix with 11 digits total → strip 0
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1)
  }
  // Indian bare 10 digits
  if (digits.length === 10) return digits
  // International number — keep the '+'
  if (hasPlus && digits.length > 10) return '+' + digits
  // Fallback: just the digits
  return digits
}

// ─────────────────────────────────────────────────────────────────────────────
// Email
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an email address: lowercase, trim, strip surrounding angle brackets. */
export function normalizeEmail(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase()
  // Strip surrounding angle brackets like <foo@bar.com>
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1)
  }
  // Strip trailing punctuation that often leaks from regex.
  s = s.replace(/[.,;:!?]+$/, '')
  return s.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// UPI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a UPI id (e.g. "ravi@okhdfc" / "RAVI.KUMAR@oksbi").
 * Lowercase and trim. Does not validate the VPA structure beyond `name@bank`.
 */
export function normalizeUpi(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase()
  s = s.replace(/[;,:.]+$/, '')
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// IFSC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an IFSC code (Indian Financial System Code).
 * Format: 4 letters + '0' + 6 alphanumeric = 11 chars total. Uppercase.
 * If the input does not match the expected length, returns the uppercased
 * trimmed string (so the caller can still store / inspect it).
 */
export function normalizeIfsc(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(s)) return s
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// IP address (IPv4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an IPv4 address. Strips whitespace and validates the 4-octet form.
 * Returns the canonical "a.b.c.d" representation, or the trimmed input if it
 * does not parse.
 */
export function normalizeIp(raw: string): string {
  const s = (raw ?? '').trim()
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return s
  const octets = [m[1], m[2], m[3], m[4]].map((o) => {
    const n = Number.parseInt(o, 10)
    if (Number.isNaN(n) || n < 0 || n > 255) return null
    return String(n)
  })
  if (octets.some((o) => o === null)) return s
  return octets.join('.')
}

// ─────────────────────────────────────────────────────────────────────────────
// URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a URL: lowercase the host, strip trailing slashes / fragment /
 * query (we only care about the site identity for graph-merge purposes).
 *
 * Examples:
 *   "HTTPS://Example.COM/path?a=1" → "https://example.com"
 *   "example.com/path"             → "http://example.com"
 */
export function normalizeUrl(raw: string): string {
  let s = (raw ?? '').trim()
  if (!s) return s
  // Lowercase the scheme + host portion only.
  if (!/^[a-z]+:\/\//i.test(s)) {
    s = 'http://' + s
  }
  try {
    const u = new URL(s)
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}`
  } catch {
    return s.toLowerCase()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a domain: lowercase, strip leading "www.", strip trailing slash. */
export function normalizeDomain(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase().replace(/\/+$/, '')
  if (s.startsWith('www.')) s = s.slice(4)
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Bank account
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a bank account number: digits only (some accounts use hyphens /
 * X-masking like "XXXX1234" → we keep the digits and any X's verbatim so the
 * norm is still stable for dedup).
 */
export function normalizeAccount(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '')
  // If the account is masked (XXXX...), keep the X's so two masked sightings
  // of the same account dedupe together.
  if (/^X+\d+/.test(s)) return s
  // Otherwise digits only.
  return s.replace(/[^\d]/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// IMEI / MAC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an IMEI: 15 digits, strip separators. Returns first 15 digits if
 * longer (some sources append a check digit + SV).
 */
export function normalizeImei(raw: string): string {
  const digits = (raw ?? '').replace(/[^\d]/g, '')
  if (digits.length < 15) return digits
  return digits.slice(0, 15)
}

/**
 * Normalize a MAC address to AA:BB:CC:DD:EE:FF form (uppercase, colon-separated).
 */
export function normalizeMac(raw: string): string {
  const hex = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
  if (hex.length !== 12) return raw.trim().toUpperCase()
  return hex.match(/.{2}/g)!.join(':')
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet (crypto)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a cryptocurrency wallet address.
 *
 *   - Ethereum (0x + 40 hex) → lowercase.
 *   - Bitcoin (1 / 3 / bc1 + base58 / bech32) → as-is (already case-sensitive).
 *
 * If we can't classify, returns the trimmed input.
 */
export function normalizeWallet(raw: string): string {
  const s = (raw ?? '').trim()
  // Ethereum
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase()
  // Bitcoin legacy / P2SH
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s)) return s
  // Bitcoin bech32
  if (/^bc1[ac-hj-np-z02-9]{6,87}$/i.test(s)) return s.toLowerCase()
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle (Indian plate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an Indian vehicle registration plate. Uppercase, strip spaces /
 * hyphens. Example: "MH 12 AB 1234" → "MH12AB1234".
 */
export function normalizeVehicle(raw: string): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount
// ─────────────────────────────────────────────────────────────────────────────

/** Multipliers for Indian short-form notation. */
const INDIAN_AMOUNT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  lac: 100_000,
  lakh: 100_000,
  lacs: 100_000,
  lakhs: 100_000,
  cr: 10_000_000,
  crore: 10_000_000,
  crores: 10_000_000,
  m: 1_000_000,
  million: 1_000_000,
}

/**
 * Parse an amount string into a numeric INR value.
 *
 * Handles:
 *   - "₹5,000"   → 5000
 *   - "Rs. 5000" → 5000
 *   - "INR 5000/-" → 5000
 *   - "5,000/-"  → 5000
 *   - "1.5 lakh" → 150000
 *   - "2 cr"     → 20000000
 *   - "5 lac"    → 500000
 *
 * Returns NaN if the input cannot be parsed.
 */
export function parseAmount(raw: string): number {
  if (raw == null) return NaN
  const s = String(raw).trim().toLowerCase()
  if (!s) return NaN
  // Strip currency markers.
  let cleaned = s
    .replace(/₹/g, '')
    .replace(/rs\.?/g, '')
    .replace(/inr/g, '')
    .replace(/\/-/g, '')
    .replace(/=/g, '')
    .trim()
  // Look for Indian suffix notation first.
  // Examples: "1.5 lakh", "2 cr", "5 lac", "10 million"
  const m = cleaned.match(/^([\d.,]+)\s*([a-z]+)?$/)
  if (!m) return NaN
  const numStr = m[1].replace(/,/g, '')
  const num = Number.parseFloat(numStr)
  if (!Number.isFinite(num)) return NaN
  const suffix = m[2]
  if (suffix && INDIAN_AMOUNT_MULTIPLIERS[suffix]) {
    return num * INDIAN_AMOUNT_MULTIPLIERS[suffix]
  }
  return num
}

// ─────────────────────────────────────────────────────────────────────────────
// Person / Organization (light normalization — keep display form)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a person-name candidate: collapse whitespace, title-case the result. */
export function normalizePerson(raw: string): string {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return s
  // Title-case the result while preserving connectives (Mr./Dr./Ms./Mrs.).
  return s
    .split(' ')
    .map((word) => {
      if (/^(mr|mrs|ms|dr|sri|sh|smt)$/i.test(word)) {
        const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        return cap + '.'
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

/** Normalize an organization name: collapse whitespace, preserve case. */
export function normalizeOrganization(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Document IDs (Aadhaar / PAN / Passport / GSTIN)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize Aadhaar: 12 digits, strip separators. Returns '' if not 12 digits. */
export function normalizeAadhaar(raw: string): string {
  const digits = (raw ?? '').replace(/[^\d]/g, '')
  if (digits.length !== 12) return ''
  // Aadhaar is conceptually masked with first 8 digits as X often. Don't
  // unmask — preserve whatever we saw.
  return digits
}

/** Normalize PAN: ABCDE1234F — uppercase, 10 chars. */
export function normalizePan(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s)) return s
  return s
}

/** Normalize GSTIN: 15 chars, uppercase. */
export function normalizeGstin(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '')
  if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(s)) return s
  return s
}

/** Normalize passport: 1 letter + 7 digits, uppercase. */
export function normalizePassport(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (/^[A-Z][0-9]{7}$/.test(s)) return s
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch table — map an {@link EntityType} to its normalizer function.
 * Falls back to identity (trimmed) for types without a dedicated normalizer
 * (e.g. `address`, `location`, `social`).
 */
/** v3.10 — wrapped-table row glue detector. A value that is several CELLS
 *  of a flattened CSV/table row ("ORG-001,ORGANIZATION,Asterion Logistics
 *  Pvt Ltd", "ORG-005,,,,Northstar Digital Solutions") is a wrapped row,
 *  never one entity. Betrayed by ≥2 commas PLUS either a leading reference
 *  token or an ALL-CAPS type-word cell. Real names/addresses keep ≤1 comma
 *  or no ALL-CAPS cell and always pass. */
export function isWrappedRowGlue(value: string): boolean {
  const v = value.trim()
  if (!/,.*,/.test(v)) return false
  if (/^[A-Za-z][A-Za-z0-9_-]*\d[-_,]/.test(v)) return true
  return /,[A-Z][A-Z_]{3,23},/.test(v)
}

export function normalizeEntity(type: EntityType, value: string): string {
  switch (type) {
    case 'phone':
      return normalizePhone(value)
    case 'email':
      return normalizeEmail(value)
    case 'upi':
      return normalizeUpi(value)
    case 'ifsc':
      return normalizeIfsc(value)
    case 'ip':
      return normalizeIp(value)
    case 'url':
      return normalizeUrl(value)
    case 'domain':
      return normalizeDomain(value)
    case 'account':
      return normalizeAccount(value)
    case 'imei':
      return normalizeImei(value)
    case 'mac':
      return normalizeMac(value)
    case 'wallet':
      return normalizeWallet(value)
    case 'vehicle':
      return normalizeVehicle(value)
    case 'person':
      return normalizePerson(value)
    case 'organization':
      return normalizeOrganization(value)
    default:
      return (value ?? '').trim()
  }
}
