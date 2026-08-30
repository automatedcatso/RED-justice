/**
 * extractors/txnExtract.ts — Transaction extraction from bank statements,
 * UPI SMS logs, and ledger lines.
 *
 * Pure regex-based. No AI calls.
 *
 * Strategy:
 *   1. Split the source text into "transaction-like" blocks (rows / messages).
 *   2. For each block, run the entity extractor to find any account numbers,
 *      UPI ids, IFSC codes, amounts, dates, UTRs.
 *   3. Apply targeted pattern matchers for the most common Indian formats:
 *        - UPI SMS:    "Rs.500 debited from A/c 12345 UPI/ravi@okhdfc/.../Ref no 9988"
 *        - Bank row:   "05/01/2024 | NEFT to Ravi Kumar | 5000.00 | 12345"
 *        - Wallet SMS: "Rs.500 sent to wallet 0xABC..."
 *
 * Direction inference: when the block contains "debited from" / "sent from" /
 * "paid from", the labeled account is the sender. When it contains "credited
 * to" / "received by" / "sent to", the labeled account is the receiver. When
 * ambiguous, we set `accountNo` only.
 */

import { extractEntities } from './entityExtract'
import { parseAmount } from './normalizers'
import type { ExtractedTransaction } from './types'

// Re-export the parseAmount helper for callers that want it from this module.
export { parseAmount }

// ─────────────────────────────────────────────────────────────────────────────
// Pattern catalogue
// ─────────────────────────────────────────────────────────────────────────────

/** UTR / Reference number — alphanumeric, 10-22 chars, often prefixed. */
const UTR_LABEL_RE =
  /\b(?:UTR|Utr|Ref(?:erence)?(?:\s*No\.?)?|RRN|Txn\s*ID|Transaction\s*ID)\s*[:\-]?\s*([A-Z0-9]{10,22})\b/gi

/** Indian bank name lookup (sufficient subset). */
const BANK_NAMES = [
  'HDFC', 'ICICI', 'SBI', 'Axis', 'Kotak', 'Yes', 'IDFC', 'IDBI',
  'Punjab National', 'PNB', 'Bank of Baroda', 'BOB', 'Canara',
  'Union Bank', 'Bank of India', 'BOI', 'IndusInd', 'Federal',
  'South Indian', 'City Union', 'Bandhan', 'RBL', 'AU Small',
  'Paytm', 'PhonePe', 'Google Pay', 'Amazon Pay', 'JioMoney',
] as const

/** Build a regex that matches any of the bank names above. */
const BANK_NAME_RE = new RegExp(
  `\\b(${BANK_NAMES.map((b) => b.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'gi',
)

/** Patterns that indicate a debit (account = sender). */
const DEBIT_MARKERS =
  /\b(?:debited\s+from|sent\s+from|paid\s+from|withdrawn\s+from|dr\.?\s+from|transferred\s+from|debited\s+to\s+your)\b/gi

/** Patterns that indicate a credit (account = receiver). */
const CREDIT_MARKERS =
  /\b(?:credited\s+to|received\s+by|cr\.?\s+to|deposited\s+to|added\s+to)\b/gi

/**
 * v3.6 — Statement-header account detection. Bank statements declare THEIR
 * OWN account near the top ("Account Number: 50100234567891", "A/c No …",
 * "Account Holder: X / Account Number: Y") but the transaction ROWS below
 * often name only the COUNTERPARTY in the narration. Without propagating
 * the header account, every row loses one endpoint — the money-flow graph
 * showed floating counterparties with no source account.
 */
const STATEMENT_ACCOUNT_RE =
  /\b(?:account\s*(?:no|number)?|a\s*\/\s*c\s*(?:no|number)?|acct\.?\s*(?:no|number)?)\s*[:\-]\s*([0-9][0-9\s-]{7,17}[0-9])/gi

function detectStatementAccount(text: string): string | undefined {
  const head = text.slice(0, 4000)
  STATEMENT_ACCOUNT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STATEMENT_ACCOUNT_RE.exec(head)) !== null) {
    const digits = m[1].replace(/\D/g, '')
    if (digits.length >= 9 && digits.length <= 18) return digits
  }
  return undefined
}

/** Pull a counterparty identifier (account / UPI / corporate name) out of a narration. */
function counterpartyFromRemarks(remarks: string, ownAccount: string): { account?: string; upi?: string; name?: string } {
  const out: { account?: string; upi?: string; name?: string } = {}
  const upi = remarks.match(/\b([\w.\-]{2,}@[a-z]{2,})\b/i)
  if (upi) out.upi = upi[1]
  for (const g of remarks.matchAll(/\b(\d{9,18})\b/g)) {
    if (g[1] !== ownAccount) {
      out.account = g[1]
      break
    }
  }
  // v3.6: corporate-name counterparties — Indian narrations name the other
  // party in plain text ("NEFT CR-RED VIPER TRADING CO", "RTGS DR-ZENITH
  // PHARMA DISTRIBUTORS"). Without this, those rows produced single-endpoint
  // transactions that could never become money-flow edges.
  if (!out.account && !out.upi) {
    const m = remarks.match(/(?:^|[\s\-–])(?:TO|FROM|DR|CR|PAID TO|RECV)[-–\s]+([A-Z][A-Za-z&.' ]{3,48})(?:$|[.,;])/)
    if (m) {
      const name = m[1].trim().replace(/\s+/g, ' ')
      // Must be 2+ words or contain a corporate keyword — single generic
      // words like "SALARY" or "CASH" must not become counterparties.
      const words = name.split(' ').filter(Boolean)
      const corpish = /\b(pvt|ltd|llp|inc|corp|bank|enterprises|traders|trading|logistics|imports|exports|finance|services|retail|wholesale|brokers|co|company|hotel|pharma|distributors|associates|agencies|motors|industries|infotech|solutions)\b/i.test(name)
      if (words.length >= 2 && (corpish || words.length <= 4)) out.name = name
    }
  }
  return out
}

/** Status keywords. */
const STATUS_KEYWORDS: Record<string, string> = {
  debited: 'debit',
  debit: 'debit',
  dr: 'debit',
  sent: 'debit',
  paid: 'debit',
  withdrawn: 'debit',
  transferred: 'debit',
  credited: 'credit',
  credit: 'credit',
  cr: 'credit',
  received: 'credit',
  deposited: 'credit',
  added: 'credit',
  success: 'success',
  successful: 'success',
  failed: 'failed',
  failure: 'failed',
  pending: 'pending',
  reversed: 'reversed',
}

// ─────────────────────────────────────────────────────────────────────────────
// Block splitting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a chunk of text into "transaction-like" lines / blocks.
 * Handles:
 *   - Newline-separated lines.
 *   - Pipe-separated rows ("date | desc | amount | balance").
 *   - Semicolon-separated rows.
 *   - Standalone SMS-style blocks (one SMS = one block).
 */
function splitIntoBlocks(text: string): string[] {
  if (!text) return []
  // Normalize Windows line endings; treat consecutive blank lines as one break.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // Split on newlines first.
  const lines = normalized.split(/\n+/)
  const blocks: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // If the line itself contains pipe or semicolon separators and at least
    // one amount / date, treat each segment group as a block (but most rows
    // are exactly one line — we keep the whole line as a block here).
    blocks.push(trimmed)
  }
  return blocks
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-block parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the transaction status (debit / credit / success / failed / ...)
 * from a text block based on keyword presence.
 */
function inferStatus(block: string): string | undefined {
  const lc = block.toLowerCase()
  for (const [kw, status] of Object.entries(STATUS_KEYWORDS)) {
    if (new RegExp(`\\b${kw.replace(/[.]/g, '\\.')}\\b`, 'i').test(lc)) {
      return status
    }
  }
  return undefined
}

/**
 * Determine whether the labeled account in the block is the sender or the
 * receiver, based on surrounding debit / credit markers.
 *
 * Returns:
 *   - 'sender'   : the labeled account sent the money.
 *   - 'receiver' : the labeled account received the money.
 *   - undefined  : cannot be determined.
 */
function inferDirection(block: string): 'sender' | 'receiver' | undefined {
  if (DEBIT_MARKERS.test(block)) return 'sender'
  if (CREDIT_MARKERS.test(block)) return 'receiver'
  return undefined
}

/** Extract the first UTR / reference number from a block. */
function extractUtr(block: string): string | undefined {
  const re = new RegExp(UTR_LABEL_RE.source, 'gi')
  const m = re.exec(block)
  return m?.[1]
}

/** Extract the first bank name mentioned in the block. */
function extractBank(block: string): string | undefined {
  const re = new RegExp(BANK_NAME_RE.source, 'gi')
  const m = re.exec(block)
  return m?.[1] ? m[1].replace(/\s+/g, ' ').trim() : undefined
}

/** Find the first labeled account number (e.g. "A/c 1234567890123"). */
function extractLabeledAccount(block: string): string | undefined {
  const re =
    /\b(?:A\/c(?:count)?|Acct|Ac|Account\s*No\.?|Account\s*Number|Wallet)\s*[:\-]?\s*([Xx0-9][Xx0-9\- ]{6,17})\b/i
  const m = re.exec(block)
  return m?.[1]?.replace(/[\s-]/g, '')
}

/**
 * Try to find a "to <account>" or "from <account>" clause that names the
 * counterparty account. Returns the normalized account string when present.
 */
function extractCounterpartyAccount(
  block: string,
  labeledAccount: string | undefined,
): string | undefined {
  // "to A/c 9988776655" / "from A/c 9988776655"
  const re =
    /\b(?:to|from|by)\s+(?:A\/c(?:count)?|Acct|Ac|Account\s*No\.?|Wallet)\s*[:\-]?\s*([Xx0-9][Xx0-9\- ]{6,17})\b/i
  const m = re.exec(block)
  const cand = m?.[1]?.replace(/[\s-]/g, '')
  if (!cand) return undefined
  if (labeledAccount && cand === labeledAccount) return undefined
  return cand
}

/** Find a date in the block, returning the ISO-normalized form when possible. */
function extractDate(block: string): string | undefined {
  const ents = extractEntities(block)
  const d = ents.find((e) => e.type === 'date')
  return d?.norm
}

/** Find the first amount in the block, returning the numeric value. */
function extractAmountValue(block: string): number | undefined {
  const ents = extractEntities(block)
  const a = ents.find((e) => e.type === 'amount')
  if (!a) return undefined
  const n = Number.parseFloat(a.norm)
  return Number.isFinite(n) ? n : undefined
}

/** Find a UPI id mentioned in the block. */
function extractUpi(block: string): string | undefined {
  const ents = extractEntities(block)
  return ents.find((e) => e.type === 'upi')?.norm
}

/** Find an IFSC mentioned in the block. */
function extractIfsc(block: string): string | undefined {
  const ents = extractEntities(block)
  return ents.find((e) => e.type === 'ifsc')?.norm
}

/** Find a wallet mentioned in the block. */
function extractWallet(block: string): string | undefined {
  const ents = extractEntities(block)
  return ents.find((e) => e.type === 'wallet')?.norm
}

/** Find a phone mentioned in the block (often used as account alias). */
function extractPhone(block: string): string | undefined {
  const ents = extractEntities(block)
  return ents.find((e) => e.type === 'phone')?.norm
}

/** Detect a merchant name from "to <Name>" / "via <Name>" / "at <Name>". */
function extractMerchant(block: string): string | undefined {
  const m =
    block.match(/\b(?:to|via|at|merchant)\s+([A-Z][A-Za-z0-9&.,'\- ]{2,40})/i) ??
    null
  if (!m) return undefined
  // Stop at any punctuation that ends a sentence.
  const v = m[1]
    .replace(/\s+(?:on|for|via|at)\b.*$/i, '')
    .replace(/[.,;:].*$/, '')
    .trim()
  return v || undefined
}

/** Extract the "remarks" portion: text after a "Remarks:" label or the rest. */
function extractRemarks(block: string): string | undefined {
  const m = block.match(/\bRemarks?\s*[:\-]\s*(.+?)$/i)
  return m?.[1]?.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-block transaction builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single block (one line of a bank statement / one SMS) into an
 * {@link ExtractedTransaction}. Returns undefined if no transaction-like
 * signal is found (no date, no amount, no account).
 */
function parseBlock(block: string, sourceRef?: string): ExtractedTransaction | undefined {
  const date = extractDate(block)
  const amount = extractAmountValue(block)
  const labeledAccount = extractLabeledAccount(block)
  const counterparty = extractCounterpartyAccount(block, labeledAccount)
  const direction = inferDirection(block)
  const status = inferStatus(block)
  const utr = extractUtr(block)
  const bank = extractBank(block)
  const upi = extractUpi(block)
  const ifsc = extractIfsc(block)
  const wallet = extractWallet(block)
  const merchant = extractMerchant(block)
  const remarks = extractRemarks(block)

  // Need at least: date OR amount, AND something that identifies an account.
  const hasTxnSignal =
    (amount != null || date != null) &&
    (labeledAccount != null ||
      counterparty != null ||
      upi != null ||
      wallet != null ||
      utr != null)
  if (!hasTxnSignal) return undefined

  const txn: ExtractedTransaction = {
    txnDate: date,
    amount,
    utr,
    ifsc,
    bank,
    upi,
    wallet,
    merchant,
    status,
    remarks,
    sourceRef,
  }

  // Direction assignment.
  if (labeledAccount && direction === 'sender') {
    txn.senderAccount = labeledAccount
    if (counterparty) txn.receiverAccount = counterparty
  } else if (labeledAccount && direction === 'receiver') {
    txn.receiverAccount = labeledAccount
    if (counterparty) txn.senderAccount = counterparty
  } else if (labeledAccount && counterparty) {
    // No direction marker — assume labeled is the sender (most statements
    // are "from the perspective of the account holder").
    txn.senderAccount = labeledAccount
    txn.receiverAccount = counterparty
  } else if (labeledAccount) {
    txn.accountNo = labeledAccount
  }

  // If we have a UPI but no account, UPI itself acts as the account identifier.
  if (upi && !txn.senderAccount && !txn.receiverAccount && !txn.accountNo) {
    txn.accountNo = upi
  }

  return txn
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV-aware parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column header aliases. Maps various column header names to canonical fields.
 * Keys are matched case-insensitively against the CSV header row.
 */
const COLUMN_ALIASES: Record<string, keyof ExtractedTransaction> = {
  date: 'txnDate',
  txn_date: 'txnDate',
  transaction_date: 'txnDate',
  value_date: 'txnDate',
  amount: 'amount',
  amt: 'amount',
  value: 'amount',
  debit: 'amount',
  credit: 'amount',
  withdrawal: 'amount',
  deposit: 'amount',
  withdrawl: 'amount',
  paid_out: 'amount',
  paid_in: 'amount',
  sender: 'senderAccount',
  sender_account: 'senderAccount',
  from: 'senderAccount',
  from_account: 'senderAccount',
  receiver: 'receiverAccount',
  receiver_account: 'receiverAccount',
  to: 'receiverAccount',
  to_account: 'receiverAccount',
  account: 'accountNo',
  account_no: 'accountNo',
  account_number: 'accountNo',
  acct: 'accountNo',
  utr: 'utr',
  utr_no: 'utr',
  utr_number: 'utr',
  ref: 'utr',
  reference: 'utr',
  reference_no: 'utr',
  ref_no: 'utr',
  chq_no: 'utr',
  cheque_no: 'utr',
  chq_ref_no: 'utr',
  cheque_ref: 'utr',
  chq_ref: 'utr',
  transaction_id: 'utr',
  txn_id: 'utr',
  upi: 'upi',
  upi_id: 'upi',
  vpa: 'upi',
  ifsc: 'ifsc',
  ifsc_code: 'ifsc',
  bank: 'bank',
  bank_name: 'bank',
  wallet: 'wallet',
  merchant: 'merchant',
  payee: 'merchant',
  status: 'status',
  remarks: 'remarks',
  remark: 'remarks',
  narration: 'remarks',
  description: 'remarks',
  desc: 'remarks',
  details: 'remarks',
}

/**
 * Column-alias lookup that tolerates spaces, hyphens and dots in headers
 * ("Txn Date", "txn-date", "txn.date" all match the txn_date alias).
 */
function columnAlias(header: string): keyof ExtractedTransaction | undefined {
  const direct = COLUMN_ALIASES[header]
  if (direct) return direct
  const normalized = header.replace(/[\s.\-]+/g, '_')
  return COLUMN_ALIASES[normalized]
}

/**
 * Detect whether a text blob looks like a CSV with a header row containing
 * transaction-related columns. Returns the parsed header + rows, or null.
 * Quote-aware: cells like "Smith, John" stay intact (RFC-4180 style).
 */
function tryParseCsv(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.replace(/\r\n/g, '\n').split(/\n+/).filter((l) => l.trim())
  if (lines.length < 2) return null
  // Try comma, tab, semicolon, pipe as delimiter.
  const delimiters = [',', '\t', ';', '|']
  // v3.6: the header row may not be the FIRST line — statements carry
  // banners above the table ("STATEMENT OF ACCOUNT", "Account Number: …",
  // "=== Sheet: X ===" markers from spreadsheet parsing). Scan the first 12
  // lines for the first row that matches ≥2 column aliases.
  const maxHeaderScan = Math.min(lines.length, 12)
  for (const delim of delimiters) {
    for (let h = 0; h < maxHeaderScan; h++) {
      const firstRow = splitCsvLine(lines[h], delim).map((c) => c.trim().toLowerCase().replace(/^["']|["']$/g, ''))
      if (firstRow.length < 3) continue
      // Check if at least 2 headers match known aliases (space/hyphen tolerant).
      const matched = firstRow.filter((c) => columnAlias(c) !== undefined).length
      if (matched < 2) continue
      const headers = firstRow
      const rows: string[][] = []
      for (let i = h + 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i], delim)
        if (cells.length === headers.length || cells.length === headers.length - 1) {
          rows.push(cells)
        }
      }
      if (rows.length > 0) return { headers, rows }
    }
  }
  return null
}

/**
 * Split a single CSV/TSV line honouring double-quoted cells so embedded
 * delimiters (e.g. "Smith, John") do not break the row structure.
 */
function splitCsvLine(line: string, delim: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

/**
 * Parse a CSV into transactions using the header row to map columns.
 */
function parseCsvTransactions(
  headers: string[],
  rows: string[][],
  sourceRef?: string,
  fallbackAccount?: string,
): ExtractedTransaction[] {
  const out: ExtractedTransaction[] = []
  // Build column index → field map.
  const colMap: Array<{ idx: number; field: keyof ExtractedTransaction }> = []
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    const field = columnAlias(h)
    if (field) colMap.push({ idx: i, field })
  }
  // v3.6: remember which columns are the withdrawal vs deposit sides of the
  // amount so the row's direction (debit/credit) is not lost — previously
  // both mapped to `amount` and every CSV row came out direction-less.
  const debitCol = headers.findIndex((h) => /^(withdrawal|withdrawl|debit|paid_out|dr)$/i.test(h.trim()))
  const creditCol = headers.findIndex((h) => /^(deposit|credit|paid_in|cr)$/i.test(h.trim()))
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]
    // Row locator for per-record provenance: sheet header is row 1, data starts at row 2.
    const rowLocator = `row=${rowIdx + 2}`
    const txnRef = sourceRef ? `${sourceRef}#${rowLocator}` : rowLocator
    const txn: Partial<ExtractedTransaction> = { sourceRef: txnRef }
    if (debitCol >= 0 && (row[debitCol] ?? '') !== '') txn.status = 'debit'
    else if (creditCol >= 0 && (row[creditCol] ?? '') !== '') txn.status = 'credit'
    for (const { idx, field } of colMap) {
      const raw = row[idx]
      if (raw == null || raw === '') continue
      if (field === 'amount') {
        const n = parseAmount(raw)
        if (n != null && Number.isFinite(n)) txn.amount = n
      } else if (field === 'txnDate') {
        // Normalise via the entity extractor's date normalizer. First date
        // column wins — "value date" must not overwrite "txn date".
        if (txn.txnDate == null) {
          const ents = extractEntities(raw)
          const d = ents.find((e) => e.type === 'date')
          if (d) txn.txnDate = d.norm
          else txn.txnDate = raw
        }
      } else if (field === 'status') {
        const st = STATUS_KEYWORDS[raw.toLowerCase().trim()]
        if (st) txn.status = st
      } else {
        // String fields — strip quotes/whitespace.
        ;(txn as Record<string, unknown>)[field] = raw
      }
    }
    // v3.6: apply the statement-header account BEFORE the identifier filter
    // — narrations like "IMPS DR-<counterparty>" carry no account COLUMN, so
    // without propagation every row died at this filter and the whole CSV
    // statement produced zero transactions.
    if (fallbackAccount && !txn.senderAccount && !txn.receiverAccount) {
      const isCredit = txn.status === 'credit' || /\b(cr|credit)\b/i.test(txn.remarks ?? '')
      const cp = counterpartyFromRemarks(`${txn.remarks ?? ''} ${txn.merchant ?? ''}`, fallbackAccount)
      const counterparty = cp.account ?? cp.upi ?? cp.name
      if (isCredit) {
        txn.receiverAccount = fallbackAccount
        if (counterparty) txn.senderAccount = counterparty
      } else {
        txn.senderAccount = fallbackAccount
        if (counterparty) txn.receiverAccount = counterparty
      }
      if (!txn.accountNo) txn.accountNo = fallbackAccount
      if (!txn.upi && cp.upi) txn.upi = cp.upi
    }
    // Need at least an amount or a date to count as a transaction.
    if (txn.amount == null && txn.txnDate == null) continue
    // Need at least one account-like identifier.
    if (
      !txn.senderAccount &&
      !txn.receiverAccount &&
      !txn.accountNo &&
      !txn.upi &&
      !txn.wallet &&
      !txn.utr
    ) {
      continue
    }
    out.push(txn as ExtractedTransaction)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract transactions from a raw text blob.
 *
 * @param text       Raw evidence text (bank statement, UPI SMS log, ledger, CSV).
 * @param sourceRef  Optional cross-reference (e.g. evidence id / sha256).
 * @returns          Array of parsed transactions (deduped by UTR or
 *                   (date+amount+sender+receiver)).
 */
/**
 * Statement-line parser — handles classic bank-statement rows that the CSV
 * and block parsers miss. Typical shapes (PDF text extraction output):
 *   01-Feb-2024  Debit  200000.00  ATM CASH
 *   03/02/2024 DR 200000 UTR90003
 *   2024-02-05  99,000.00  UPI vikram@ybl
 *
 * Requires a date + an amount, plus at least one corroborating marker
 * (direction word, UTR, UPI, or a long account-like number) to keep
 * precision — a random sentence with a number must not become a transaction.
 */
function parseStatementLine(
  line: string,
  sourceRef?: string,
  lineIdx = 0,
): ExtractedTransaction | undefined {
  if (line.length > 400) return undefined
  // Must begin with a date-ish token.
  const dateMatch = line.match(
    /^(\d{1,2}[-/. ](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/. ]\d{2,4}|\d{4}-\d{2}-\d{2})/i,
  )
  if (!dateMatch) return undefined

  // Find the strongest amount on the line (₹-prefixed, or thousands-grouped,
  // or with paise decimals).
  let amount: number | undefined
  const amtRe = /(?:rs\.?|inr|₹)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d{4,})(?:\.\d{1,2})?)/gi
  let m: RegExpExecArray | null
  while ((m = amtRe.exec(line)) !== null) {
    const n = parseAmount(m[1])
    if (n != null && n >= 1) {
      amount = n
      break
    }
  }
  if (amount == null) return undefined

  const lower = line.toLowerCase()
  const hasDirection = /\b(debit|credit|dr|cr|withdrawal|deposit|withdrawn|deposited|paid|received)\b/.test(lower)
  const utrMatch = line.match(/\b([A-Z]{2,6}\d{5,})\b/)
  const upiMatch = line.match(/\b([\w.\-]{2,}@[a-z]{2,})\b/i)
  const acctMatch = line.match(/\b(\d{9,18})\b/)

  if (!hasDirection && !utrMatch && !upiMatch && !acctMatch) return undefined

  const txn: Partial<ExtractedTransaction> = {
    sourceRef: sourceRef ? `${sourceRef}#line=${lineIdx + 1}` : `line=${lineIdx + 1}`,
    amount,
    status: /\b(credit|cr|deposit|deposited|received)\b/.test(lower) ? 'credit' : 'debit',
    remarks: line.slice(0, 200),
  }
  // Normalise the date via the shared date normalizer (entity extractor).
  try {
    const d = extractEntities(dateMatch[1]).find((e) => e.type === 'date')
    if (d) txn.txnDate = d.norm
    else txn.txnDate = dateMatch[1]
  } catch {
    txn.txnDate = dateMatch[1]
  }
  if (utrMatch) txn.utr = utrMatch[1]
  if (upiMatch) txn.upi = upiMatch[1]
  if (acctMatch) txn.accountNo = acctMatch[1]
  if (/atm|cash withdrawal/i.test(line)) txn.merchant = 'ATM'
  return txn as ExtractedTransaction
}

/**
 * v3.6 — JSON/NDJSON payment-ledger pass. Payment exports as NDJSON or JSON
 * arrays ({"from_account": "...", "to_account": "...", "amount": 150000,
 * "mode": "IMPS", "ref": "N0623012"}) are parsed object-by-object with
 * balanced-brace scanning, so both raw and pretty-printed variants work.
 */
function extractJsonLedgerTransactions(text: string, sourceRef?: string): ExtractedTransaction[] {
  if (!/"(from_account|to_account|sender|receiver|sender_account|receiver_account|from|to)"\s*:/i.test(text)) return []
  const out: ExtractedTransaction[] = []
  // Balanced-brace scan over all top-level {...} blocks.
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { if (inStr) esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const block = text.slice(start, i + 1)
        start = -1
        try {
          const obj = JSON.parse(block)
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            const txn = jsonLedgerRowToTxn(obj, sourceRef)
            if (txn) out.push(txn)
          }
        } catch { /* not JSON — skip block */ }
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

/** Map one JSON ledger object onto a transaction (snake_case + camelCase keys). */
function jsonLedgerRowToTxn(obj: Record<string, unknown>, sourceRef?: string): ExtractedTransaction | undefined {
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
    }
    return undefined
  }
  const sender = String(get('from_account', 'sender_account', 'sender', 'from', 'src', 'source') ?? '')
  const receiver = String(get('to_account', 'receiver_account', 'receiver', 'to', 'dst', 'target', 'payee') ?? '')
  const amountRaw = get('amount', 'amt', 'value')
  const amount = typeof amountRaw === 'number' ? amountRaw : parseAmount(String(amountRaw ?? ''))
  const date = String(get('date', 'txn_date', 'transaction_date', 'timestamp', 'txnDate') ?? '')
  const utr = String(get('ref', 'reference', 'utr', 'utr_no', 'ref_no', 'rrn', 'txn_id') ?? '')
  const upi = String(get('upi', 'upi_id', 'vpa') ?? '')
  const mode = String(get('mode', 'type', 'channel') ?? '')
  const note = String(get('note', 'narration', 'remarks', 'description') ?? '')
  // Must have both endpoints + an amount or date to be a real ledger row.
  if (!sender || !receiver || sender === receiver) return undefined
  if (amount == null && !date) return undefined
  const txn: Partial<ExtractedTransaction> = {
    sourceRef,
    senderAccount: sender.slice(0, 60),
    receiverAccount: receiver.slice(0, 60),
    remarks: `${mode ? mode + ' ' : ''}${note}`.trim().slice(0, 200) || undefined,
    status: undefined,
  }
  if (amount != null && Number.isFinite(amount)) txn.amount = amount
  if (date) {
    try {
      const d = extractEntities(date).find((e) => e.type === 'date')
      txn.txnDate = d?.norm ?? date.slice(0, 24)
    } catch { txn.txnDate = date.slice(0, 24) }
  }
  if (utr) txn.utr = utr.slice(0, 40)
  if (upi) txn.upi = upi
  if (mode) txn.merchant = mode.slice(0, 40)
  return txn as ExtractedTransaction
}

export function extractTransactions(
  text: string,
  sourceRef?: string,
): ExtractedTransaction[] {
  if (!text || typeof text !== 'string') return []
  const out: ExtractedTransaction[] = []
  const seen = new Set<string>()

  // v3.6 — the statement's OWN account (from the header block) anchors every
  // row: debits send FROM it, credits arrive TO it. The narration's embedded
  // counterparty account/UPI/name becomes the other endpoint.
  const stmtAccount = detectStatementAccount(text)
  const applyStatementAccount = (txn: ExtractedTransaction): void => {
    if (!stmtAccount) return
    if (txn.senderAccount && txn.receiverAccount) return
    const isCredit = txn.status === 'credit' || /\b(cr|credit)\b/i.test(txn.remarks ?? '')
    const cp = counterpartyFromRemarks(`${txn.remarks ?? ''} ${txn.merchant ?? ''}`, stmtAccount)
    const counterparty = cp.account ?? cp.upi ?? cp.name
    if (isCredit) {
      if (!txn.receiverAccount) txn.receiverAccount = stmtAccount
      if (!txn.senderAccount && counterparty) txn.senderAccount = counterparty
    } else {
      if (!txn.senderAccount) txn.senderAccount = stmtAccount
      if (!txn.receiverAccount) txn.receiverAccount = counterparty
    }
    if (!txn.accountNo) txn.accountNo = stmtAccount
    if (!txn.upi && cp.upi) txn.upi = cp.upi
  }

  const pushTxn = (txn: ExtractedTransaction) => {
    applyStatementAccount(txn)
    const key = [
      txn.txnDate ?? '',
      txn.amount ?? '',
      txn.senderAccount ?? '',
      txn.receiverAccount ?? '',
      txn.utr ?? '',
      txn.upi ?? '',
      txn.wallet ?? '',
      txn.accountNo ?? '',
    ].join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push(txn)
  }

  // v3.6 — JSON-ledger pass FIRST: NDJSON/JSON payment exports
  // ({"from_account": "...", "to_account": "...", "amount": ...}) are a
  // standard machine-export format and previously produced ~0 transactions
  // because the CSV/statement parsers cannot read pretty-printed JSON.
  for (const txn of extractJsonLedgerTransactions(text, sourceRef)) pushTxn(txn)
  if (out.length > 0) return out

  // First, try CSV-aware parsing.
  const csv = tryParseCsv(text)
  if (csv) {
    const csvTxns = parseCsvTransactions(csv.headers, csv.rows, sourceRef, stmtAccount)
    for (const txn of csvTxns) pushTxn(txn)
    if (out.length > 0) return out // CSV parsing succeeded — don't double-parse.
  }

  const lines = text.replace(/\r\n/g, '\n').split(/\n+/)

  // Statement-line pass (bank-statement rows from PDFs / text exports).
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    const st = parseStatementLine(trimmed, sourceRef, i)
    if (st) pushTxn(st)
  }
  if (out.length > 0) return out

  // Fallback: line-by-line block parsing (SMS / pipe-separated / free text).
  const blocks = splitIntoBlocks(text)
  for (const block of blocks) {
    const txn = parseBlock(block, sourceRef)
    if (!txn) continue
    pushTxn(txn)
  }
  return out
}

/**
 * Convenience: build a short context snippet for a parsed transaction block.
 * Useful when persisting `Transaction.remarks`.
 */
export function txnBlockContext(block: string): string {
  return block.length > 120 ? block.slice(0, 120) : block
}
