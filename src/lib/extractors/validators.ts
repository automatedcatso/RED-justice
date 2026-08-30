/**
 * validators.ts — v3.9 checksum/domain validation for structured identifiers.
 *
 * MASTER PROMPT §3 (Pass 1 — deterministic extraction):
 *   "Use checksum or domain validation wherever applicable"
 *     IMEI    → Luhn validation
 *     Aadhaar → Verhoeff validation
 *     GSTIN   → mod-36 check-digit validation
 *     PAN/IFSC → strict structural + domain validation (shape is their check)
 *
 * Policy: an identifier extracted from UNLABELED text must pass its checksum
 * to be an entity of that type (a random 15-digit number is 90% likely to
 * fail Luhn — it was never an IMEI, it belongs to the account-number
 * extractors instead). Identifiers from a LABELED source (column header says
 * "IMEI", registry row says "Aadhaar No") already carry DOMAIN validation —
 * the label is the proof — so checksums only annotate confidence there.
 *
 * Escape hatch for OCR-noisy corpora: RJ_CHECKSUM_VALIDATION=off.
 */

/** Luhn mod-10 checksum (IMEI, card numbers). */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '')
  if (d.length < 12) return false
  let sum = 0
  let alt = false // counts from the RIGHT; last digit is the check digit
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// ── Verhoeff (Aadhaar) ────────────────────────────────────────────────────────
// The classic Verhoeff d-table/permutation-table algorithm; UIDAI uses it for
// the 12th digit of every Aadhaar number.

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]

/** Verhoeff checksum over a digit string (valid INCLUDING its check digit). */
export function verhoeffValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '')
  if (d.length < 2) return false
  let c = 0
  for (let i = d.length - 1, step = 0; i >= 0; i--, step++) {
    const n = d.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    c = VERHOEFF_D[c][VERHOEFF_P[step % 8][n]]
  }
  return c === 0
}

// ── GSTIN mod-36 check digit ─────────────────────────────────────────────────
// GSTIN = 2-digit state code + 10-char PAN + entity digit + 'Z' + check digit.
// The check digit makes `value[0..13]` map to `value[14]` via mod-36 code points.

const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** GSTIN check-digit validation (15-char GSTIN) — GSTN reference algorithm:
 *  RIGHT→LEFT, factor starts at 2 and alternates 2,1,2,1…; each product is
 *  folded mod-36 (d/36 + d%36); check char = alphabet[(36 − sum%36) % 36]. */
export function gstinCheckValid(gstin: string): boolean {
  const g = gstin.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  if (g.length !== 15) return false
  const payload = g.slice(0, 14)
  const check = g[14]
  let factor = 2
  let sum = 0
  for (let i = payload.length - 1; i >= 0; i--) {
    const val = GSTIN_ALPHABET.indexOf(payload[i])
    if (val < 0) return false
    let digit = factor * val
    factor = factor === 2 ? 1 : 2
    digit = Math.floor(digit / 36) + (digit % 36)
    sum += digit
  }
  const checkCodePoint = (36 - (sum % 36)) % 36
  return GSTIN_ALPHABET[checkCodePoint] === check
}

// ── Composed entity validators ───────────────────────────────────────────────

function checksumValidationEnabled(): boolean {
  return (process.env.RJ_CHECKSUM_VALIDATION ?? 'on').toLowerCase() !== 'off'
}

/** IMEI: 15 digits + Luhn (unlabeled extraction requires the checksum). */
export function isValidImei(norm: string): boolean {
  if (!/^\d{15}$/.test(norm)) return false
  if (!checksumValidationEnabled()) return true
  return luhnValid(norm)
}

/** Aadhaar: 12 digits + Verhoeff (unlabeled extraction requires the checksum). */
export function isValidAadhaar(norm: string): boolean {
  if (!/^\d{12}$/.test(norm)) return false
  if (!checksumValidationEnabled()) return true
  return verhoeffValid(norm)
}

/** GSTIN: 15 chars + mod-36 check digit. */
export function isValidGstin(norm: string): boolean {
  if (norm.length !== 15) return false
  if (!checksumValidationEnabled()) return true
  return gstinCheckValid(norm)
}
