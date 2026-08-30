/**
 * extractors/index.ts — Barrel re-export for the Level-0 deterministic
 * extraction pipeline.
 *
 * Submodules:
 *   - types          : public type declarations.
 *   - hashing        : SHA-256 helper (node:crypto).
 *   - normalizers    : per-entity-type normalization functions.
 *   - entityExtract  : main `extractEntities(text)`.
 *   - txnExtract     : `extractTransactions(text, sourceRef?)`.
 *   - commExtract    : `extractCommunications(text, sourceRef?)`.
 *
 * Everything in here is pure TypeScript. No AI calls. No React.
 */

export type {
  EntityType,
  ExtractedEntity,
  ExtractedTransaction,
  ExtractedCommunication,
  ExtractionResult,
} from './types'

export { sha256Hex } from './hashing'

export {
  normalizePhone,
  normalizeEmail,
  normalizeUpi,
  normalizeIfsc,
  normalizeIp,
  normalizeUrl,
  normalizeDomain,
  normalizeAccount,
  normalizeImei,
  normalizeMac,
  normalizeWallet,
  normalizeVehicle,
  normalizePerson,
  normalizeOrganization,
  normalizeAadhaar,
  normalizePan,
  normalizeGstin,
  normalizePassport,
  parseAmount,
  normalizeEntity,
} from './normalizers'

export {
  extractEntities,
  extractDateStrings,
  extractAmountNumbers,
} from './entityExtract'

export {
  extractTransactions,
  txnBlockContext,
} from './txnExtract'

export {
  extractRegistry,
  type RegistryExtractionResult,
  type ExtractedRegistryRelationship,
} from './registryExtract'

export {
  extractRelationshipTable,
  extractEntityTable,
  type RelTableExtraction,
  type RelTableEntity,
  type RelTableEdge,
  type EntityTableExtraction,
  type EntityTableEntity,
} from './relTableExtract'

export {
  extractCommunications,
  extractCommEntities,
} from './commExtract'

/**
 * Convenience aggregator: run every extractor on the same text and return a
 * combined {@link ExtractionResult}. Useful when seeding / pre-processing
 * evidence in a single pass.
 */
import { extractEntities as _extractEntities } from './entityExtract'
import { extractTransactions as _extractTransactions } from './txnExtract'
import { extractCommunications as _extractCommunications } from './commExtract'
import type { ExtractionResult } from './types'

export function extractAll(
  text: string,
  sourceRef?: string,
): ExtractionResult {
  const entities = _extractEntities(text)
  const transactions = _extractTransactions(text, sourceRef)
  const communications = _extractCommunications(text, sourceRef)
  const dates = entities
    .filter((e) => e.type === 'date')
    .map((e) => e.norm)
    .filter((v, i, arr) => arr.indexOf(v) === i)
  const amounts = entities
    .filter((e) => e.type === 'amount')
    .map((e) => Number.parseFloat(e.norm))
    .filter((n) => Number.isFinite(n) && n > 0)
  return {
    entities,
    transactions,
    communications,
    dates,
    amounts,
  }
}
