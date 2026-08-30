/**
 * classify.ts — Evidence classification for RED Justice.
 *
 * Two tiers:
 *   1. AI classification — the local LLM assigns a document type during the
 *      AI scan ("ai" source). This is the preferred path because the model
 *      reads the full content.
 *   2. Deterministic classification — weighted keyword/pattern scoring that
 *      always runs as a fallback ("deterministic" source) so every evidence
 *      file carries a usable type even fully offline.
 *
 * The classification drives: Evidence view filters/badges, the pipeline card,
 * extraction routing hints, and the investigation gap engine (e.g. "you have
 * transactions but no bank_statement source").
 */

export const EVIDENCE_CLASSES = [
  'fir',
  'bank_statement',
  'cdr',
  'whatsapp_chat',
  'invoice',
  'receipt',
  'id_document',
  'contract',
  'email',
  'court_document',
  'property_document',
  'travel_record',
  'social_media',
  'medical_record',
  'screenshot',
  'ledger',
  'letter',
  'certificate',
  'academic_document',
  'application',
  'other',
] as const

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number]

export const CLASS_LABELS: Record<EvidenceClass, string> = {
  fir: 'FIR / Police Report',
  bank_statement: 'Bank Statement',
  cdr: 'Call Detail Record',
  whatsapp_chat: 'Chat Export',
  invoice: 'Invoice / Bill',
  receipt: 'Receipt',
  id_document: 'ID Document',
  contract: 'Contract / Agreement',
  email: 'Email',
  court_document: 'Court Document',
  property_document: 'Property Document',
  travel_record: 'Travel Record',
  social_media: 'Social Media',
  medical_record: 'Medical Record',
  screenshot: 'Screenshot',
  ledger: 'Ledger / Accounts',
  letter: 'Letter / Correspondence',
  certificate: 'Certificate',
  academic_document: 'Academic Document',
  application: 'Application / Form',
  other: 'Unclassified',
}

interface ClassRule {
  cls: EvidenceClass
  /** Strong signals — filename or content phrases, high weight. */
  strong: string[]
  /** Weak signals — generic terms, low weight. */
  weak?: string[]
  /** Regex patterns over the content (per-match weight). */
  patterns?: Array<{ re: RegExp; weight: number; max?: number }>
}

const RULES: ClassRule[] = [
  {
    cls: 'fir',
    strong: ['first information report', 'fir no', 'f.i.r', 'police station', 'complainant', 'informant'],
    weak: ['investigating officer', 'io ', 'case crime number', 'sections 4', 'ipc section', 'bns section'],
    patterns: [
      { re: /\b(?:u\/s|under section)\s+\d+[a-z]?\s*(?:ipc|bns)?/gi, weight: 0.15, max: 0.3 },
      { re: /\b\d{4}\s*\/\s*fir\b|\bfir\s*\/?\s*\d{2,4}\b/gi, weight: 0.2, max: 0.4 },
    ],
  },
  {
    cls: 'bank_statement',
    strong: ['statement of account', 'account statement', 'closing balance', 'opening balance', 'ifsc', 'transaction remark', 'branch address', 'available balance'],
    weak: ['debit', 'credit', 'balance', 'withdrawal', 'deposit', 'narration', 'utr', 'value date', 'transaction date', 'cr ', 'dr ', 'ref no', 'chq no', 'cheque number', 'particulars'],
    patterns: [
      { re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, weight: 0.15, max: 0.3 }, // IFSC codes
      { re: /\b\d{9,18}\b(?=.*balance)/gi, weight: 0.1, max: 0.2 },
      { re: /\b(txn|value|trans)\s*date\b[\s\S]{0,80}\b(debit|credit|withdrawal|deposit)\b/gi, weight: 0.12, max: 0.24 },
      { re: /\bbalance\b[^\n]{0,30}\bdebit\b[^\n]{0,30}\bcredit\b/gi, weight: 0.18, max: 0.36 }, // column header rows
      { re: /\b(imps|neft|rtgs|upi)[\s/-][crd]{1,2}[\s/-]/gi, weight: 0.12, max: 0.36 }, // narration codes
    ],
  },
  {
    cls: 'cdr',
    strong: ['call detail record', 'call details record', 'cdr report', 'cell id', 'first cell id', 'last cell id', 'calling number', 'called number', 'dialed number', 'cell tower', 'traffic direction'],
    weak: ['incoming', 'outgoing', 'roaming', 'imei', 'imsi', 'duration (sec)', 'b party', 'a party', 'tower', 'duration'],
    patterns: [
      { re: /\b\d{10,15}\b\s*,\s*\d{10,15}\b/g, weight: 0.1, max: 0.3 }, // phone-to-phone rows
      { re: /\b\d{15}\b/g, weight: 0.08, max: 0.24 }, // IMEI-ish
      { re: /(?:calling|called)[^\n]{0,20}number[^\n]{0,60}cell/gi, weight: 0.15, max: 0.3 }, // CDR header rows
    ],
  },
  {
    cls: 'whatsapp_chat',
    strong: ['messages and calls are end-to-end encrypted', 'whatsapp chat with'],
    weak: ['<media omitted>', 'this message was deleted', 'missed voice call', 'missed video call'],
    patterns: [
      { re: /^\[\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},\s*\d{1,2}:\d{2}(:\d{2})?\s*(?:am|pm|AM|PM)?\]/gm, weight: 0.12, max: 0.5 },
      { re: /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}\s*-\s/gm, weight: 0.12, max: 0.5 },
    ],
  },
  {
    cls: 'invoice',
    strong: ['tax invoice', 'invoice no', 'invoice number', 'gst invoice', 'bill no', 'gstIN', 'taxable value'],
    weak: ['hsn', 'sac code', 'cgst', 'sgst', 'igst', 'total amount due', 'due date', 'purchase order'],
    patterns: [{ re: /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/g, weight: 0.2, max: 0.4 }], // GSTIN
  },
  {
    cls: 'receipt',
    strong: ['payment receipt', 'amount received', 'received with thanks', 'cash receipt', 'paid receipt'],
    weak: ['receipt no', 'received from', 'towards payment', 'rupees in words'],
  },
  {
    cls: 'id_document',
    strong: ['aadhaar', 'aadhar', 'unique identification', 'pan card', 'permanent account number card', 'passport no', 'driving licence', 'voter id'],
    weak: ['date of birth', 'dob:', 'male / female', 'enrollment no', 'vid '],
    patterns: [
      { re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, weight: 0.18, max: 0.36 }, // Aadhaar
      { re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, weight: 0.18, max: 0.36 }, // PAN
    ],
  },
  {
    cls: 'contract',
    strong: ['this agreement', 'agreement made', 'witnesseth', 'whereas the parties', 'memorandum of understanding', 'terms and conditions of'],
    weak: ['the party of the first part', 'the party of the second part', 'shall be binding', 'in witness whereof', 'clause'],
  },
  {
    cls: 'email',
    strong: ['message/rfc822', 'delivered-to', 'return-path', 'x-mailer', 'received: by', 'mime-version:'],
    weak: ['subject:', 'from:', 'to:', 'cc:', 'reply-to', 'unsubscribe', 'regards,', 'dear sir', 'forwarded message'],
    patterns: [
      { re: /^(from|to|subject|date):\s/gim, weight: 0.1, max: 0.4 },
    ],
  },
  {
    cls: 'court_document',
    strong: ['in the court of', "hon'ble", 'honorable court', ' writ petition', 'affidavit', 'charge sheet', 'chargesheet', 'summons'],
    weak: ['petitioner', 'respondent', 'plaintiff', 'defendant', 'judgment', 'decree', 'counsel', 'court hall'],
  },
  {
    cls: 'property_document',
    strong: ['sale deed', 'title deed', 'gift deed', 'lease deed', 'registry', 'mutation', 'khatauni', 'khasra', 'sale certificate'],
    weak: ['property no', 'survey no', 'plot no', 'square feet', 'stamped', 'sub-registrar', 'registrar office'],
  },
  {
    cls: 'travel_record',
    strong: ['boarding pass', 'pnr', 'e-ticket', 'eticket', 'irctc', 'flight ticket', 'air ticket'],
    weak: ['departure', 'arrival', 'gate', 'seat no', 'class of travel', 'coach', 'berth'],
  },
  {
    cls: 'social_media',
    strong: ['facebook', 'instagram', 'twitter', 'linkedin', 'telegram chat', 'snapchat'],
    weak: ['followers', 'following', 'likes', 'retweet', 'share', 'profile picture', 'friend request'],
  },
  {
    cls: 'medical_record',
    strong: ['medical record', 'discharge summary', 'prescription', 'diagnosis', 'opd', 'ipd'],
    weak: ['hospital', 'patient', 'doctor', 'dr.', 'medicine', 'dosage', 'treatment'],
  },
  {
    cls: 'ledger',
    strong: ['ledger', 'day book', 'cash book', 'hisab', 'khata', 'bahikhata'],
    weak: ['debit', 'credit', 'balance b/f', 'balance c/f', 'carried forward'],
  },
  // v3.6 — the four "document-about-a-person" classes previously had NO
  // deterministic rules, making them unreachable without an AI model (they
  // always classified as 'other' offline). Letters, certificates, academic
  // documents and applications are core evidence types in document-fraud and
  // organized-crime cases, so they now have deterministic signals too.
  {
    cls: 'letter',
    strong: ['letter of recommendation', 'reference letter', 'offer letter', 'experience letter', 'cover letter', 'show cause notice', 'demand letter', 'legal notice', 'letter of intent'],
    weak: ['dear sir', 'dear madam', 'to whom it may concern', 'yours faithfully', 'yours sincerely', 'with regards', 'subject:', 're:', 'dated this', 'enclosed herewith', 'kindly find attached'],
    patterns: [
      { re: /\b(?:ref|reference)\s*(?:no\.?|number|#)\s*[:\-]?\s*[a-z0-9/-]{3,}/gi, weight: 0.12, max: 0.24 },
      { re: /\bsubject\s*:[^\n]{10,}/gi, weight: 0.1, max: 0.2 },
    ],
  },
  {
    cls: 'certificate',
    strong: ['this is to certify', 'certificate of', 'bonafide certificate', 'bonafide', 'character certificate', 'transfer certificate', 'migration certificate', 'death certificate', 'birth certificate', 'registration certificate'],
    weak: ['certified that', 'issued on', 'certificate no', 'registration no', 'place of issue'],
    patterns: [
      { re: /\bcertificate\s*(?:no\.?|number|#)\s*[:\-]?\s*[a-z0-9/-]{3,}/gi, weight: 0.18, max: 0.36 },
    ],
  },
  {
    cls: 'academic_document',
    strong: ['marksheet', 'mark sheet', 'statement of marks', 'transcript of records', 'academic transcript', 'score card', 'semester grade', 'consolidated marksheet'],
    weak: ['roll no', 'enrollment number', 'registration number', 'cgpa', 'sgpa', 'semester', 'university examination', 'board of examination', 'passed with division', 'result declared'],
    patterns: [
      { re: /\b(?:roll|enrol{1,2}ment|registration)\s*(?:no\.?|number|#)\s*[:\-]?\s*[a-z0-9/-]{4,}/gi, weight: 0.14, max: 0.28 },
    ],
  },
  {
    cls: 'application',
    strong: ['application form', 'application for', 'form no', 'applicant name', 'name of applicant', 'duly filled', 'applicant signature'],
    weak: ['date of birth', 'father name', 'mother name', 'nationality', 'occupation', 'annual income', 'declaration', 'signature of applicant', 'place:', 'pin code'],
    patterns: [
      { re: /\bfield\s*(?:no\.?|#)?\s*[:\-]\s*.{2,40}/gi, weight: 0.06, max: 0.18 },
    ],
  },
]

export interface ClassificationResult {
  classification: EvidenceClass
  confidence: number
  source: 'ai' | 'deterministic' | 'manual'
  signals?: string[]
  runnerUp?: { classification: EvidenceClass; confidence: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model-output canonicalization — bigger models answer with their own class
// vocabulary ("Bank Statement", "whatsapp", "call detail records",
// "aadhaar card"). Map every reasonable synonym onto our fixed class list,
// otherwise valid AI answers used to fall through to 'other'.
// ─────────────────────────────────────────────────────────────────────────────

/** Token-substring synonym table → canonical class. */
const CLASS_SYNONYMS: Array<{ re: RegExp; cls: EvidenceClass }> = [
  { re: /\bf\.?i\.?r\b|first information|police report|police complaint/i, cls: 'fir' },
  { re: /bank[\s_-]*(statement|acct?ount)?|account statement|passbook|statement of account/i, cls: 'bank_statement' },
  { re: /call[\s_-]*detail[sd]?[\s_-]*record|\bcd?r\b|call log|cell tower dump/i, cls: 'cdr' },
  { re: /whats?app|wa[\s_-]*chat|chat[\s_-]*export|telegram(?!.*social)|instant message|im chat|signal chat|messenger chat/i, cls: 'whatsapp_chat' },
  { re: /invoice|bill of|tax bill|purchase order/i, cls: 'invoice' },
  { re: /receipt|payment proof|amount received/i, cls: 'receipt' },
  { re: /aadhaa?r|pan card|passport|driving licen[cs]e|voter[\s_-]*id|id card|identity (card|document)|kyc document/i, cls: 'id_document' },
  { re: /contract|agreement|mou|memorandum of understanding|deed of|lease agreement|terms of service/i, cls: 'contract' },
  { re: /e-?mail|rfc822|eml/i, cls: 'email' },
  { re: /court|judgment|judgement|charge ?sheet|summons|writ|petition|affidavit|fir copy/i, cls: 'court_document' },
  { re: /sale deed|title deed|gift deed|property|registry|mutation|land record|khatauni/i, cls: 'property_document' },
  { re: /boarding pass|\bpnr\b|e-?ticket|air ticket|flight|railway ticket|irctc|travel/i, cls: 'travel_record' },
  { re: /social media|facebook|instagram|twitter|linkedin|snapchat|post(s)? from/i, cls: 'social_media' },
  { re: /medical|discharge summary|prescription|diagnosis|hospital bill/i, cls: 'medical_record' },
  { re: /screenshot|screen shot|screen capture|image capture/i, cls: 'screenshot' },
  { re: /ledger|cash book|day book|khata|hisaab|accounts book/i, cls: 'ledger' },
  // v3.1 — the scan prompt legitimately asks the model for these labels
  // (letters of recommendation, bonafide certificates, mark sheets,
  // admission/visa/job applications); they used to canonicalize to 'other'.
  { re: /letter of recommend|recommendation letter|reference letter|cover letter|correspondence|official letter|letter$/i, cls: 'letter' },
  { re: /certificate|bonafide|bona fide|no objection|noc$/i, cls: 'certificate' },
  { re: /academic|transcript|mark ?sheet|marksheet|grade (card|sheet)|score ?card|university document|school document/i, cls: 'academic_document' },
  { re: /application( form)?|form submission|nomination/i, cls: 'application' },
]

/**
 * Canonicalize any model/vendor-provided class label into our enum.
 * Returns undefined when nothing maps (caller decides fallback).
 */
export function canonicalizeClassName(raw: unknown): EvidenceClass | undefined {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!s) return undefined
  if ((EVIDENCE_CLASSES as readonly string[]).includes(s)) return s as EvidenceClass
  // snake_case equality after stripping filler words like "copy", "scan", "doc"
  const compact = s.replace(/(_?(copy|scan|doc(ument)?|file|pdf))$/,'')
  if ((EVIDENCE_CLASSES as readonly string[]).includes(compact)) return compact as EvidenceClass
  const phrase = s.replace(/_/g, ' ')
  for (const syn of CLASS_SYNONYMS) {
    if (syn.re.test(phrase)) return syn.cls
  }
  return undefined
}

/**
 * Hybrid arbitration between AI and deterministic classifications.
 *
 * Rules:
 *   - if only one side exists, take it
 *   - same class → corroborated (AI wins, confidence boosted)
 *   - AI 'other' vs a real deterministic signal → deterministic wins
 *   - disagreement between two REAL classes → the AI must beat the
 *     deterministic read by a clear margin (+0.15) to override it. Small
 *     models love inflating classificationConfidence; without this margin a
 *     confident-but-wrong LLM label used to clobber solid structural reads.
 */
export function arbitrateClassification(
  ai: ClassificationResult,
  det: ClassificationResult,
): ClassificationResult {
  if (!ai || ai.source !== 'ai') return det
  if (!det) return ai
  if (ai.classification === det.classification) {
    return {
      ...ai,
      confidence: Math.max(ai.confidence, det.confidence),
      signals: [...(ai.signals ?? []), ...(det.signals ?? []).slice(0, 3)].slice(0, 6),
    }
  }
  if (ai.classification === 'other' && det.classification !== 'other') {
    return det.confidence >= 0.25
      ? det
      : { ...det, confidence: Math.min(det.confidence, 0.24) }
  }
  if (det.classification === 'other') return ai
  // Disagreement: only a NEAR-CERTAIN AI call (≥0.95 AND +0.3 over the
  // structural read) may override the deterministic classification.
  return ai.confidence >= 0.95 && ai.confidence >= det.confidence + 0.3 ? ai : det
}

/**
 * Deterministic weighted-keyword classifier. Never throws; always returns
 * something (worst case 'other' with low confidence).
 */
export function classifyDeterministic(
  filename: string,
  content: string | null | undefined,
  hints: { mime?: string | null; isEmail?: boolean } = {},
): ClassificationResult {
  const name = (filename ?? '').toLowerCase()
  const text = (content ?? '').toLowerCase()
  const head = text.slice(0, 20000)
  const scores = new Map<EvidenceClass, { score: number; signals: string[] }>()

  const add = (cls: EvidenceClass, weight: number, signal: string) => {
    const cur = scores.get(cls) ?? { score: 0, signals: [] }
    cur.score += weight
    if (cur.signals.length < 8) cur.signals.push(signal)
    scores.set(cls, cur)
  }

  // Filename hints are strong ("Screenshot_2024-01-05", "FIR_0447.pdf", "statement.xlsx").
  for (const rule of RULES) {
    for (const s of rule.strong) {
      if (name.includes(s)) add(rule.cls, 0.45, `filename~${s}`)
    }
  }
  if (/screenshot|screen[_-]?shot|screencapture/.test(name)) add('screenshot', 0.6, 'filename~screenshot')
  if (hints.isEmail) add('email', 0.7, 'parsed-rfc822')

  // Content signals.
  for (const rule of RULES) {
    for (const s of rule.strong) {
      if (head.includes(s)) add(rule.cls, 0.35, s)
    }
    for (const s of rule.weak ?? []) {
      if (head.includes(s)) add(rule.cls, 0.08, s)
    }
    for (const p of rule.patterns ?? []) {
      const re = new RegExp(p.re.source, p.re.flags)
      let count = 0
      const maxMatches = 40
      while (re.exec(head) !== null && count < maxMatches) count++
      if (count > 0) {
        const w = Math.min(p.weight * count, p.max ?? p.weight * 3)
        add(rule.cls, w, `${p.re.source.slice(0, 24)}…×${count}`)
      }
    }
  }

  // Chat-format detection is structural, add a boost.
  const tsLineCount = (head.match(/^\[\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/gm) ?? []).length
  if (tsLineCount >= 5) add('whatsapp_chat', 0.4, `${tsLineCount} timestamped lines`)

  // Image files default to screenshot class (they're usually evidence screenshots).
  if (/format.*image|"ext":"(png|jpg|jpeg|webp|bmp|gif)"/.test(JSON.stringify(hints)) || name.match(/\.(png|jpe?g|webp|bmp|gif)$/)) {
    add('screenshot', 0.25, 'image file')
  }

  const ranked = Array.from(scores.entries())
    .map(([cls, v]) => ({ cls, score: Math.min(v.score, 1.4), signals: v.signals }))
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0 || ranked[0].score < 0.25) {
    return {
      classification: 'other',
      confidence: ranked.length ? Math.min(0.24, ranked[0].score) : 0,
      source: 'deterministic',
      signals: ranked[0]?.signals ?? [],
    }
  }

  const top = ranked[0]
  const second = ranked[1]
  return {
    classification: top.cls,
    confidence: Math.min(0.95, Math.round((top.score / (top.score + (second?.score ?? 0.2) + 0.15)) * 100) / 100),
    source: 'deterministic',
    signals: top.signals,
    runnerUp: second ? { classification: second.cls, confidence: Math.round(second.score * 100) / 100 } : undefined,
  }
}

const AI_CLASSIFICATION_PROMPT_RULES = `"classification": one exact value from this list:
    fir, bank_statement, cdr, whatsapp_chat, invoice, receipt, id_document, contract, email, court_document, property_document, travel_record, social_media, medical_record, screenshot, ledger, other
  "classificationConfidence": number between 0 and 1
  "keyFacts": ["fact 1", "fact 2"] — the 2-5 most investigation-relevant facts`

/** Parse an AI scan JSON payload into a classification result (or null). */
export function classificationFromAiScan(parsedScan: Record<string, unknown>): ClassificationResult | null {
  const rawCls = parsedScan.classification
  if (rawCls === undefined || rawCls === null || String(rawCls).trim() === '') return null
  const canonical = canonicalizeClassName(rawCls)
  const conf = typeof parsedScan.classificationConfidence === 'number'
    ? Math.min(1, Math.max(0, parsedScan.classificationConfidence))
    : 0.6
  if (!canonical) {
    // Unknown vocabulary + no synonym hit → treat as other but note it.
    return {
      classification: 'other',
      confidence: Math.min(conf, 0.5),
      source: 'ai',
      signals: [`unrecognized class "${String(rawCls).slice(0, 40)}"`],
    }
  }
  return {
    classification: canonical,
    confidence: conf,
    source: 'ai',
    signals: Array.isArray(parsedScan.keyFacts) ? parsedScan.keyFacts.slice(0, 5).map(String) : undefined,
  }
}

/** Prompt fragment shared by the upload auto-scan and manual scan routes. */
export function aiClassificationPromptFragment(): string {
  return AI_CLASSIFICATION_PROMPT_RULES
}
