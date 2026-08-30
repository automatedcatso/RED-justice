/**
 * extractors/hashing.ts — Tiny SHA-256 helper using node:crypto.
 *
 * Used by the extractor pipeline to fingerprint evidence content (so we can
 * dedupe identical evidence items) and to generate stable `sourceRef`
 * identifiers when none is supplied by the caller.
 */

import { createHash } from 'node:crypto'

/**
 * Compute the SHA-256 hex digest of an arbitrary UTF-8 string.
 *
 * @param text Input text (null/undefined → empty string).
 * @returns Lowercase 64-char hex digest.
 */
export function sha256Hex(text: string | null | undefined): string {
  const input = text == null ? '' : String(text)
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
