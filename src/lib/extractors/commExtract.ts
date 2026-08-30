/**
 * extractors/commExtract.ts — Communication extraction from chat exports,
 * WhatsApp logs, Telegram exports, SMS threads, and email dumps.
 *
 * Pure regex-based. No AI calls.
 *
 * Supported chat-line formats:
 *   - WhatsApp export: `[2024-01-05, 10:30:00 AM] Alice: message text`
 *   - WhatsApp export (alt): `05/01/2024, 10:30 AM - Alice: message text`
 *   - Telegram export: `[05.01.2024 10:30] Alice: message text`
 *   - Generic: `2024-01-05T10:30:00Z <Alice> message text`
 *   - IRC-style: `[10:30] <Alice> message text`
 *
 * Each line is parsed into an {@link ExtractedCommunication} object with the
 * timestamp, sender handle, and message text. We do not extract the receiver
 * from the chat header because most chat exports are 1:N (a group), so we
 * leave `receiver` undefined unless the body explicitly mentions "@user" or
 * the platform metadata names a DM partner.
 */

import { extractEntities } from './entityExtract'
import { normalizeEmail, normalizePhone } from './normalizers'
import type { ExtractedCommunication } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Chat-line regex catalogue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WhatsApp export (most common):
 *   `[2024-01-05, 10:30:00 AM] Alice: message text`
 *   `[05/01/2024, 10:30 AM] Alice: message text`
 *   `[09/06/26, 10:14:33] Alice: message text`  ← real iOS exports use
 *     DD/MM/YY with 2-digit years — previously unsupported.
 */
const WHATSAPP_TS_BRACKET_RE =
  /^\[(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\]\s+([^:]+):\s+(.+)$/i

/**
 * WhatsApp export (alternate — uses dashes and slash dates):
 *   `05/01/2024, 10:30 AM - Alice: message text`
 */
const WHATSAPP_DASH_RE =
  /^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)\s+-\s+([^:]+):\s+(.+)$/i

/**
 * Telegram export:
 *   `[05.01.2024 10:30] Alice: message text`
 *   `[05.01.2024 10:30:00] Alice: message text`
 */
const TELEGRAM_RE =
  /^\[(\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^:]+):\s+(.+)$/i

/**
 * Generic ISO timestamp + author in brackets:
 *   `2024-01-05T10:30:00Z <Alice> message text`
 *   `2024-01-05T10:30:00Z Alice: message text`
 */
const ISO_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)\s+(?:<([^>]+)>|([^:]+)):?\s+(.+)$/i

/**
 * IRC-style:
 *   `[10:30] <Alice> message text`
 */
const IRC_RE = /^\[(\d{1,2}:\d{2})\]\s+<([^>]+)>\s+(.+)$/i

/** Mention / tag: `@username`. */
const MENTION_RE = /@([A-Za-z0-9_.]{2,40})/g

/** Detect a DM partner from the chat header line (Telegram-style). */
const DM_HEADER_RE = /(?:Chat with|Direct message with|DM with)\s+([^\n]+)/i

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a date-shaped timestamp string into ISO form when possible. */
function toIso(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return s.endsWith('Z') ? s : s + 'Z'
  }
  // Try Date.parse — works for many formats including "Jan 5, 2024 10:30 AM".
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return new Date(t).toISOString()
  // DD/MM/YYYY, HH:MM AM → YYYY-MM-DDTHH:MM:SSZ
  const dmy = s.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i,
  )
  if (dmy) {
    let [, dd, mm, yy, hh, mi, ampm] = dmy
    let year = Number.parseInt(yy, 10)
    if (year < 100) year += 2000
    let h = Number.parseInt(hh, 10)
    if (ampm) {
      const ap = ampm.toUpperCase()
      if (ap === 'PM' && h < 12) h += 12
      if (ap === 'AM' && h === 12) h = 0
    }
    const ts = Date.UTC(year, Number.parseInt(mm, 10) - 1, Number.parseInt(dd, 10), h, Number.parseInt(mi, 10))
    return new Date(ts).toISOString()
  }
  // DD.MM.YYYY HH:MM
  const dmy2 = s.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  )
  if (dmy2) {
    const [, dd, mm, yy, hh, mi, ss] = dmy2
    const ts = Date.UTC(
      Number.parseInt(yy, 10),
      Number.parseInt(mm, 10) - 1,
      Number.parseInt(dd, 10),
      Number.parseInt(hh, 10),
      Number.parseInt(mi, 10),
      ss ? Number.parseInt(ss, 10) : 0,
    )
    return new Date(ts).toISOString()
  }
  return s
}

/** Normalize a chat handle (phone / email / display name). */
function normalizeHandle(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return s
  if (s.includes('@') && !s.startsWith('@')) {
    return normalizeEmail(s)
  }
  if (/^\+?\d[\d\s-]{6,}$/.test(s)) {
    return normalizePhone(s)
  }
  return s
}

/**
 * Heuristically detect the platform of a chat log from its header / line
 * format. Returns 'whatsapp' | 'telegram' | 'irc' | 'generic'.
 */
function detectPlatform(line: string): string {
  if (WHATSAPP_TS_BRACKET_RE.test(line) || WHATSAPP_DASH_RE.test(line)) {
    return 'whatsapp'
  }
  if (TELEGRAM_RE.test(line)) return 'telegram'
  if (IRC_RE.test(line)) return 'irc'
  if (ISO_RE.test(line)) return 'generic'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed chat line — raw timestamp + sender + body. */
interface ParsedLine {
  rawTimestamp: string
  isoTimestamp: string
  sender: string
  body: string
  format: string
}

/** Parse a single chat line into a ParsedLine, or null if it doesn't match. */
function parseChatLine(line: string): ParsedLine | null {
  let m: RegExpMatchArray | null
  if ((m = line.match(WHATSAPP_TS_BRACKET_RE))) {
    return {
      rawTimestamp: m[1],
      isoTimestamp: toIso(m[1]),
      sender: m[2].trim(),
      body: m[3].trim(),
      format: 'whatsapp',
    }
  }
  if ((m = line.match(WHATSAPP_DASH_RE))) {
    return {
      rawTimestamp: m[1],
      isoTimestamp: toIso(m[1]),
      sender: m[2].trim(),
      body: m[3].trim(),
      format: 'whatsapp',
    }
  }
  if ((m = line.match(TELEGRAM_RE))) {
    return {
      rawTimestamp: m[1],
      isoTimestamp: toIso(m[1]),
      sender: m[2].trim(),
      body: m[3].trim(),
      format: 'telegram',
    }
  }
  if ((m = line.match(ISO_RE))) {
    return {
      rawTimestamp: m[1],
      isoTimestamp: toIso(m[1]),
      sender: (m[2] ?? m[3] ?? '').trim(),
      body: m[4].trim(),
      format: 'generic',
    }
  }
  if ((m = line.match(IRC_RE))) {
    return {
      rawTimestamp: m[1],
      isoTimestamp: m[1],
      sender: m[2].trim(),
      body: m[3].trim(),
      format: 'irc',
    }
  }
  return null
}

/**
 * Look at the first few lines of the text for a "Chat with X" header, which
 * we can use as a default `receiver` for every parsed message.
 */
function detectDmPartner(text: string): string | undefined {
  const head = text.slice(0, 500)
  const m = head.match(DM_HEADER_RE)
  return m?.[1]?.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract communication records from a raw chat / SMS / email export or a
 * CDR table.
 *
 * @param text       Raw chat log / CDR text.
 * @param sourceRef  Optional cross-reference (e.g. evidence id / sha256).
 * @returns          Array of {@link ExtractedCommunication} objects, one per
 *                   parsed chat line. Empty if no chat-line format matches.
 */
export function extractCommunications(
  text: string,
  sourceRef?: string,
): ExtractedCommunication[] {
  if (!text || typeof text !== 'string') return []
  // v3.6: CDR tables (calling/called number columns) are parsed FIRST —
  // they are the most common law-enforcement evidence format and previously
  // produced ZERO deterministic communications.
  const cdrRows = extractCdrRows(text, sourceRef)
  if (cdrRows.length > 0) return cdrRows
  const dmPartner = detectDmPartner(text)
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: ExtractedCommunication[] = []
  let platform: string | undefined
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const parsed = parseChatLine(line)
    if (!parsed) continue
    if (!platform) platform = parsed.format
    // Skip system / metadata messages like "Alice added Bob" or "Messages and
    // calls are end-to-end encrypted" — they don't carry useful intel.
    if (/^(?:messages\s+and\s+calls|end-to-end|alice\s+added|.*\bchanged\b.*\bprofile)/i.test(parsed.body)) {
      continue
    }
    // Detect @mentions — first one becomes the receiver if we don't have a DM
    // partner.
    let receiver = dmPartner
    let receiverHandle: string | undefined
    if (!receiver) {
      const m = parsed.body.match(MENTION_RE)
      if (m) {
        receiver = m[0].slice(1)
        receiverHandle = m[0]
      }
    } else if (receiver.includes('@')) {
      receiverHandle = normalizeEmail(receiver)
    } else if (/^\+?\d/.test(receiver)) {
      receiverHandle = normalizePhone(receiver)
    }
    out.push({
      platform: platform ?? parsed.format,
      sender: parsed.sender,
      senderHandle: normalizeHandle(parsed.sender),
      receiver,
      receiverHandle,
      messageText: parsed.body,
      timestamp: parsed.isoTimestamp,
      sourceRef,
    })
  }
  return out
}

/**
 * Convenience: extract every entity mentioned inside any chat message body.
 * Useful for building entity-message links.
 */
export function extractCommEntities(
  comms: ExtractedCommunication[],
): Map<string, ReturnType<typeof extractEntities>> {
  const map = new Map<string, ReturnType<typeof extractEntities>>()
  for (const c of comms) {
    if (!c.messageText) continue
    map.set(c.messageText, extractEntities(c.messageText))
  }
  return map
}

// ─────────────────────────────────────────────────────────────────────────────
// CDR (Call Detail Record) table parsing — v3.6
//
// Telecom operators and LEAF/COGNOS exports deliver CDRs as CSV/TSV with
// phone-pair columns:
//
//   calling_number,called_number,date,time,duration_secs,cell_id_first,imei,call_type
//   +919876543210,+919822011234,2026-06-09,10:12:33,141,JH-THANE-011,356938…,outgoing
//
// Every row IS a communication record between two phone numbers — the heart
// of criminal-network analysis. Deterministic, zero AI.
// ─────────────────────────────────────────────────────────────────────────────

/** Header names that identify the calling (A-party) column. */
const CDR_SRC_RE = /^(calling|caller|caller_number|calling_number|a_party|a_number|from_number|from_no|origin_number|originating_number|source_number|dialer|msisdn_a|call_from|from)$/i
/** Header names that identify the called (B-party) column. */
const CDR_DST_RE = /^(called|called_number|dialed|dialed_number|dialled_number|b_party|b_number|to_number|to_no|destination_number|terminating_number|target_number|callee|msisdn_b|call_to|to)$/i
/** Header names for date/time/duration/imei/cell columns. */
const CDR_DATE_RE = /^(date|call_date|cdr_date|call_datetime|start_time|start_date_time|date_of_call)$/i
const CDR_TIME_RE = /^(time|call_time|start_time_of_day)$/i
const CDR_DUR_RE = /^(duration|duration_secs|duration_sec|duration_seconds|call_duration|dur\(s\)|dur_s|seconds)$/i
const CDR_IMEI_RE = /^(imei|imei_a|caller_imei|device_imei|a_imei)$/i
const CDR_TYPE_RE = /^(call_type|direction|traffic_direction|type)$/i
const CDR_CELL_RE = /^(cell_id|cell_id_first|first_cell_id|cell_tower|tower_id|bts_id|lac|ci|site_id)$/i

function isPhoneish(v: string): boolean {
  const d = v.replace(/\D/g, '')
  return d.length >= 8 && d.length <= 15 && /^[+\d][\d\s-]*$/.test(v.trim())
}

/** Parse a CDR-style delimited table into communication records. */
function extractCdrRows(text: string, sourceRef?: string): ExtractedCommunication[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length < 4) return []

  // Pick the delimiter that splits the header into the most fields.
  let delim = ''
  let header: string[] | null = null
  for (const d of [',', '\t', ';', '|']) {
    const cells = lines[0].split(d).map((c) => c.trim().replace(/^"|"$/g, ''))
    if (cells.length < 3) continue
    const src = cells.findIndex((c) => CDR_SRC_RE.test(c))
    const dst = cells.findIndex((c) => CDR_DST_RE.test(c))
    if (src >= 0 && dst >= 0 && src !== dst) {
      delim = d
      header = cells
      break
    }
  }
  if (!header) return []

  const idx = {
    src: header.findIndex((c) => CDR_SRC_RE.test(c)),
    dst: header.findIndex((c) => CDR_DST_RE.test(c)),
    date: header.findIndex((c) => CDR_DATE_RE.test(c)),
    time: header.findIndex((c) => CDR_TIME_RE.test(c)),
    dur: header.findIndex((c) => CDR_DUR_RE.test(c)),
    imei: header.findIndex((c) => CDR_IMEI_RE.test(c)),
    type: header.findIndex((c) => CDR_TYPE_RE.test(c)),
    cell: header.findIndex((c) => CDR_CELL_RE.test(c)),
  }

  const out: ExtractedCommunication[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    const cells = line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''))
    if (cells.length < 3) continue
    const get = (i: number): string => (i >= 0 && i < cells.length ? cells[i] : '')
    const src = get(idx.src)
    const dst = get(idx.dst)
    if (!isPhoneish(src) || !isPhoneish(dst)) continue
    const dateRaw = get(idx.date)
    const timeRaw = idx.time >= 0 ? get(idx.time) : ''
    const datetime = [dateRaw, timeRaw].filter(Boolean).join(' ').trim()
    const key = `${src}|${dst}|${datetime}`
    if (seen.has(key)) continue
    seen.add(key)
    const dur = idx.dur >= 0 ? get(idx.dur) : ''
    const imei = idx.imei >= 0 ? get(idx.imei) : ''
    const type = idx.type >= 0 ? get(idx.type).toLowerCase() : ''
    const cell = idx.cell >= 0 ? get(idx.cell) : ''
    const meta: string[] = []
    if (type) meta.push(type)
    if (dur) meta.push(`${dur}s`)
    if (cell) meta.push(`cell ${cell}`)
    out.push({
      platform: 'cdr',
      sender: src,
      senderHandle: normalizePhone(src),
      receiver: dst,
      receiverHandle: normalizePhone(dst),
      messageText: `${type || 'call'} ${src} → ${dst}${dur ? ` (${dur}s)` : ''}${cell ? ` [${cell}]` : ''}${imei ? ` IMEI ${imei}` : ''}`,
      timestamp: toIso(datetime || dateRaw),
      sourceRef,
    })
  }
  return out
}
