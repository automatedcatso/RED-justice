/**
 * extractors/types.ts — Public types for the Level-0 deterministic extraction
 * pipeline used by RED Justice.
 *
 * The extractor pipeline is fully regex-based (no AI calls). It consumes raw
 * evidence text and returns typed objects that the API layer persists into
 * the Prisma `Entity`, `Transaction`, and `Communication` tables.
 *
 * Conventions:
 *   - `value` is the raw matched text (preserves original casing/punctuation).
 *   - `norm`  is the canonical / normalized form used for dedup and graph
 *             merging (e.g. E.164-style phone digits, lowercase email).
 *   - `confidence` is a 0..1 score. Pure regex hits default to 0.85-0.95,
 *                  heuristic hits (e.g. inferred person names) default to
 *                  0.4-0.6.
 */

/**
 * The full catalogue of entity types recognized by RED Justice's Level-0
 * extractor. Each maps 1:1 to an `Entity.type` string in the Prisma schema
 * (the schema uses `String` for `type`, not an enum, so we keep the union
 * narrow here for compile-time safety in the extractor code).
 */
export type EntityType =
  | 'person'
  | 'organization'
  | 'account'
  | 'upi'
  | 'phone'
  | 'email'
  | 'address'
  | 'device'
  | 'ip'
  | 'domain'
  | 'url'
  | 'social'
  | 'wallet'
  | 'vehicle'
  | 'location'
  | 'date'
  | 'amount'
  | 'document_id'
  | 'ifsc'
  | 'imei'
  | 'mac'
  /** Structured-table EVENT rows (annexure registers). */
  | 'event'
  /** Registry rows with an unrecognized ALL-CAPS type — kept, not dropped. */
  | 'other'

/** A single extracted entity occurrence. */
export interface ExtractedEntity {
  /** Entity category. */
  type: EntityType
  /** Raw matched text, preserved as found in the source. */
  value: string
  /** Normalized form (used for dedup and graph merging). */
  norm: string
  /** Optional human-readable label (e.g. account holder, "Mr. Ravi Kumar"). */
  label?: string
  /** 0..1 confidence — heuristically inferred matches score lower. */
  confidence: number
  /** Up to 80 chars of context surrounding the match. */
  context?: string
}

/** A single extracted financial transaction (bank statement row, UPI SMS, ...). */
export interface ExtractedTransaction {
  /** ISO date string when present (e.g. "2024-01-05T10:30:00Z" or "2024-01-05"). */
  txnDate?: string
  /** Amount in INR (numeric). */
  amount?: number
  /** UTR / reference number. */
  utr?: string
  /** Sender bank account number (normalized digits). */
  senderAccount?: string
  /** Receiver bank account number (normalized digits). */
  receiverAccount?: string
  /** Account number referenced in the row (when direction is ambiguous). */
  accountNo?: string
  /** IFSC code (normalized, uppercase 11 chars). */
  ifsc?: string
  /** Bank name (HDFC, SBI, ICICI, ...). */
  bank?: string
  /** UPI id (e.g. ravi@okhdfc). */
  upi?: string
  /** Crypto wallet address (eth/btc). */
  wallet?: string
  /** Merchant name (when present). */
  merchant?: string
  /** Status: "debit" / "credit" / "success" / "failed" / ... */
  status?: string
  /** Free-text remarks from the source line. */
  remarks?: string
  /** Cross-reference to the source evidence item (e.g. evidence id / sha256). */
  sourceRef?: string
}

/** A single extracted communication message (chat / SMS / email body). */
export interface ExtractedCommunication {
  /** Platform: "whatsapp", "telegram", "sms", "email", ... */
  platform?: string
  /** Sender display name. */
  sender?: string
  /** Receiver display name. */
  receiver?: string
  /** Sender handle / phone / email. */
  senderHandle?: string
  /** Receiver handle / phone / email. */
  receiverHandle?: string
  /** Message body text. */
  messageText?: string
  /** ISO timestamp string when present. */
  timestamp?: string
  /** Cross-reference to the source evidence item. */
  sourceRef?: string
}

/**
 * Combined extraction result returned by `extractAll`. The flat arrays
 * (`dates`, `amounts`) are convenience views for callers that just want to
 * know "all the dates mentioned in this document".
 */
export interface ExtractionResult {
  entities: ExtractedEntity[]
  transactions: ExtractedTransaction[]
  communications: ExtractedCommunication[]
  dates: string[]
  amounts: number[]
}
