/**
 * fileParser.ts — Parse uploaded files of various formats into plain text.
 *
 * Supported formats:
 *   - Plain text: .txt, .log, .md/.markdown, .csv, .tsv, .json/.ndjson, .xml,
 *     .html/.htm, .yaml/.yml, .ini, .conf, .env, .sql, source code files
 *   - Email: .eml (RFC-822 with quoted-printable + html bodies)
 *   - Office: .docx, .xlsx/.xlsm/.xls/.ods (SheetJS), .pptx, legacy .doc/.msg
 *     (binary printable-run extraction)
 *   - PDF: real text extraction — FlateDecode/LZW streams are inflated via
 *     zlib and Tj/TJ/'/" text operators are decoded, with === Page N ===
 *     markers that downstream provenance can cite as locators
 *   - Archives: .zip (recursive — members parsed with the same pipeline)
 *   - Contacts: .vcf  |  Calendar: .ics  |  Subtitles: .srt/.vtt
 *   - Rich text: .rtf (control-word stripping + hex escape decoding)
 *   - Images / unknown binary: detected via magic bytes + printable-run
 *     sniffing; labelled clearly as requiring OCR rather than silently
 *     producing garbage
 *
 * Every parser returns a { text, mime, metadata } triple. The caller persists
 * the text as evidence content and the metadata into metadataJson.
 */
import { createHash } from 'crypto'
import { inflateSync, inflateRawSync } from 'zlib'
import { isWeakPdfText, ocrImage, ocrPdf, type OcrResult } from './ocr'

export interface ParsedFile {
  text: string
  mime: string
  size: number
  metadata: Record<string, unknown>
}

const TEXTUAL_EXTS = new Set([
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'ndjson', 'jsonl',
  'xml', 'html', 'htm', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'env', 'sql',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h',
  'cs', 'go', 'rb', 'php', 'sh', 'bash', 'bat', 'ps1', 'rtf', 'eml', 'vcf',
  'ics', 'srt', 'vtt', 'ldif', 'har', 'geojson', 'toml',
])

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  jsonl: 'application/x-ndjson',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  ini: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  sql: 'application/sql',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  rtf: 'application/rtf',
  vcf: 'text/vcard',
  ics: 'text/calendar',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

/** Extensions handled by SheetJS (spreadsheets). */
const SHEET_EXTS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'])

/** Image extensions — flagged for OCR instead of garbage-decoding. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'])

function getExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function isTextExt(ext: string): boolean {
  return TEXTUAL_EXTS.has(ext)
}

function detectMime(filename: string, fallback?: string): string {
  const ext = getExt(filename)
  return MIME_BY_EXT[ext] ?? fallback ?? 'application/octet-stream'
}

/** Strip a UTF-8/UTF-16 BOM if present. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/** Decode a UTF-8 ArrayBuffer/Uint8Array to string, replacing bad bytes. */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  } catch {
    return Buffer.from(bytes).toString('latin1')
  }
}

/** Fraction (0..1) of bytes that are printable ASCII / common whitespace. */
function printableRatio(bytes: Uint8Array): number {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  if (sample.length === 0) return 1
  let printable = 0
  for (const b of sample) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) printable++
  }
  return printable / sample.length
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML / XML / MD / RTF
// ─────────────────────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)) } catch { return _ }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)) } catch { return _ }
    })
}

/**
 * Extract visible text from HTML (scripts/styles removed, blocks → newlines).
 * v3.9.2 TABLE FIDELITY: rows stay on ONE line with cells joined by ' | ' —
 * the registry/relationship-table detectors key off that shape. The v3.9.1
 * docx fix taught us cell-per-line flattening destroys structured tables
 * (the rel-table detector never fires and the AI is left guessing); HTML
 * tables carry the same evidence and deserve the same fidelity.
 */
function htmlToText(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
  // <br> behaves like a line break everywhere.
  out = out.replace(/<br\s*\/?>/gi, '\n')
  // Table cells: ' | ' separators INSIDE a row (both th and td).
  out = out.replace(/<\/t[dh]>\s*/gi, ' | ')
  // Row ends and block boundaries → newlines (opening tags too: unclosed
  // cells at row end must not glue rows together).
  out = out.replace(/<\/?tr[^>]*>/gi, '\n')
  out = out.replace(/<\/?(div|p|li|h[1-6]|hr|section|article|header|footer|table|thead|tbody|caption)[^>]*>/gi, '\n')
  out = out.replace(/<[^>]+>/g, '')
  out = decodeEntities(out)
  out = out.replace(/[ \t]*\|[ \t]*(\n|$)/g, '$1') // dangling row-end separators
  out = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ')
  return out.trim()
}

/**
 * v3.9.2 XML STRUCTURED-EXPORT FLATTENER.
 *
 * Generic contract: many XML exports (intel tool dumps, SIEM/CRM exports) are
 * <records><record><field>v</field>…</record>…</records> lists. Rendering
 * them as a pipe table (header row + one row per record, camelCase column
 * names → snake_case) lets the EXISTING deterministic registry/relationship
 * detectors fire — zero AI needed, zero format-specific vocabulary.
 *
 * Rules (no dataset-specific names anywhere):
 *  • A parent element with ≥6 children sharing one tag name is a RECORD LIST.
 *  • Columns = record attributes + text-valued child paths (flattened to
 *    depth 2, e.g. attributes.role) — union across records, stable order.
 *  • Records keep document order; other markup falls back to the readable
 *    [tag] outline so mixed documents keep their prose context.
 */
const XML_TEXT_MIN = 6 // min repeated siblings to call it a record list

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-:.]+/g, '_').toLowerCase()
}

/** Token-scan raw XML into a lightweight tree (text kept for leaves). */
type XmlNode =
  | { kind: 'el'; tag: string; attrs: Record<string, string>; children: XmlNode[] }
  | { kind: 'text'; text: string }

function xmlParse(raw: string): {
  root: { kind: 'el'; tag: string; attrs: Record<string, string>; children: XmlNode[] }
} {
  const root: { kind: 'el'; tag: string; attrs: Record<string, string>; children: XmlNode[] } = {
    kind: 'el', tag: '#doc', attrs: {}, children: [],
  }
  const stack: Array<{ kind: 'el'; tag: string; attrs: Record<string, string>; children: XmlNode[] }> = [root]
  const tagRe = /<\/?([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(raw)) !== null) {
    if (m.index > last) {
      const text = decodeEntities(raw.slice(last, m.index)).trim()
      if (text) stack[stack.length - 1].children.push({ kind: 'text', text })
    }
    last = tagRe.lastIndex
    const [, tag, attrsRaw, selfClose] = m
    if (m[0][1] === '/') { // closing
      if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    const attrRe = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(attrsRaw)) !== null) attrs[camelToSnake(am[1])] = decodeEntities(am[2] ?? am[3] ?? '')
    const el: { kind: 'el'; tag: string; attrs: Record<string, string>; children: XmlNode[] } = {
      kind: 'el', tag, attrs, children: [],
    }
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  if (last < raw.length) {
    const text = decodeEntities(raw.slice(last)).trim()
    if (text) root.children.push({ kind: 'text', text })
  }
  return { root: root as never }
}

type XmlEl = { kind: 'el'; tag: string; attrs: Record<string, string>; children: unknown[] }

/** Flatten one record element → {col: value} (attrs + depth-2 text paths). */
function xmlRecordCells(el: XmlEl, prefix = ''): Array<[string, string]> {
  const cells: Array<[string, string]> = Object.entries(el.attrs)
  for (const c of el.children as Array<{ kind: string; tag?: string; text?: string; children?: unknown[] }>) {
    if (c.kind !== 'el') continue
    const name = `${prefix}${camelToSnake(c.tag ?? '')}`
    const textKids = (c.children as Array<{ kind: string; text?: string }>).filter((k) => k.kind === 'text')
    const elKids = (c.children as Array<{ kind: string }>).filter((k) => k.kind === 'el')
    if (elKids.length > 0 && textKids.length === 0) {
      cells.push(...xmlRecordCells(c as XmlEl, `${name}.`)) // nested container (e.g. <attributes>)
    } else {
      const v = textKids.map((k) => k.text ?? '').join(' ').trim()
      // v3.9.2: nested-container leaves render docx-registry style
      // (`role=Director`) — the registry/attribute machinery keys off that
      // shape; bare words would glue into the entity value.
      if (v) cells.push([name, prefix ? `${name.split('.').pop()}=${v}` : v])
    }
  }
  return cells
}

/** Render every record list as a pipe table; keep other markup as outline. */
function xmlToText(raw: string): string {
  const src = raw.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--[\s\S]*?-->/g, '')
  try {
    const { root } = xmlParse(src)
    const outLines: string[] = []
    const seenNodes = new Set<unknown>()

    const isEl = (n: unknown): n is XmlEl =>
      !!n && typeof n === 'object' && (n as { kind?: string }).kind === 'el'

    /** Fallback outline for non-record markup (v3.9.1 behavior). */
    const outlineOf = (n: unknown, depth: number): void => {
      if (!isEl(n)) {
        const t = (n as { text?: string }).text
        if (t) outLines.push(t)
        return
      }
      if (depth > 0 && Object.keys(n.attrs).length > 0) {
        outLines.push(`[${n.tag} ${Object.entries(n.attrs).map(([k, v]) => `${k}=${v}`).join(' ')}]`)
      }
      const textHere = (n.children as Array<{ kind: string; text?: string }>).filter((c) => c.kind === 'text').map((c) => c.text ?? '').join(' ').trim()
      if (textHere) outLines.push(textHere)
      for (const c of n.children) {
        if (isEl(c) && seenNodes.has(c)) continue // already rendered as a table
        outlineOf(c, depth + 1)
      }
    }

    const walk = (node: unknown): void => {
      if (!isEl(node)) return
      // Record-list test: children sharing one tag name.
      const byTag = new Map<string, XmlEl[]>()
      for (const c of node.children) {
        if (!isEl(c)) continue
        const arr = byTag.get(c.tag) ?? []
        arr.push(c)
        byTag.set(c.tag, arr)
      }
      for (const [, group] of byTag) {
        if (group.length >= XML_TEXT_MIN) {
          const recs: Array<Array<[string, string]>> = group.map((g) => {
            // v3.9.2: emit the LEAF name as the column id (docx/PDF annexure
            // style: `role`, not the dotted path `attributes.role`) — dotted
            // header tokens read as domain-ish identifiers downstream. Path
            // collisions get a numeric suffix (role, role_2).
            const used = new Map<string, number>()
            return xmlRecordCells(g).map(([p, v]) => {
              const leaf = p.split('.').pop() ?? p
              const n = (used.get(leaf) ?? 0) + 1
              used.set(leaf, n)
              return [n > 1 ? `${leaf}_${n}` : leaf, v] as [string, string]
            })
          })
          const colSet: string[] = []
          for (const cells of recs) {
            for (const [col] of cells) if (!colSet.includes(col)) colSet.push(col)
          }
          // A record list needs SOME structure (≥2 columns) — otherwise it's
          // a list of plain values, better left to the outline.
          if (colSet.length >= 2) {
            outLines.push(`${camelToSnake(group[0].tag)} list`)
            outLines.push(colSet.join(' | '))
            for (const cells of recs) {
              const map = new Map(cells)
              outLines.push(colSet.map((c) => map.get(c) ?? '').join(' | '))
            }
            outLines.push('')
            for (const g of group) seenNodes.add(g)
          }
        }
      }
      for (const c of node.children) walk(c)
    }

    walk(root)
    // Outline for everything not consumed by tables (in document order).
    outlineOf(root, 0)
    let text = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length < 40) text = '' // degenerate → legacy fallback below
    if (text) return text
  } catch {
    // fall through to the legacy outline renderer
  }
  let out = src.replace(/<([A-Za-z_][\w.-]*)([^>]*)\/>/g, (_m, name, attrs) => `\n[${name}${attrs.trim()}]/`)
  out = out.replace(/<([A-Za-z_][\w.-]*)([^>]*)>/g, (_m, name, attrs) => `\n[${name}${attrs.trim()}]`)
  out = decodeEntities(out)
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

/** Markdown → plain text (structure kept readable, syntax markers removed). */
function mdToText(raw: string): string {
  let out = raw
  // Fenced code blocks: keep the content, drop the fences.
  out = out.replace(/```[a-zA-Z0-9_-]*\n?/g, '\n')
  // Images: ![alt](url) → alt (url)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
  // Links: [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  // Reference-style links: [text]: url → drop the line
  out = out.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
  // Headings / blockquotes: drop markers
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  out = out.replace(/^\s{0,3}>\s?/gm, '')
  // Emphasis markers
  out = out.replace(/(\*\*\*|\*\*|\*|___|__|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
  // Inline code
  out = out.replace(/`([^`]+)`/g, '$1')
  // Table separators like |---|---|
  out = out.replace(/^\s*\|?[\s:-]*-{2,}[\s|:-]*\|?\s*$/gm, '')
  // Table pipes → separators
  out = out.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '')
  // Horizontal rules
  out = out.replace(/^\s*([-*_]\s*){3,}$/gm, '')
  // List markers → dashes (keep readability)
  out = out.replace(/^(\s*)[-*+]\s+/gm, '$1- ')
  out = out.replace(/^(\s*)\d+\.\s+/gm, '$1- ')
  return out.trim()
}

/** RTF → plain text (control words stripped, \'hh escapes decoded). */
function rtfToText(raw: string): string {
  let out = raw
  // Remove RTF groups for headers/font tables etc. (best effort, balanced enough)
  out = out.replace(/\\fonttbl[\s\S]*?\\f0[\s\S]*?;/g, '')
  out = out.replace(/\\colortbl[\s\S]*?;/g, '')
  // \par / \line → newlines
  out = out.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n')
  // \'hh hex escapes
  out = out.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  // Unicode escapes \uNNNN
  out = out.replace(/\\u(-?\d+)\s?\??/g, (_, d) => {
    try { return String.fromCodePoint((parseInt(d, 10) + 65536) % 65536) } catch { return '' }
  })
  // Remaining control words \wordNN
  out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
  // Braces
  out = out.replace(/[{}]/g, '')
  out = decodeEntities(out)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Email (.eml), vCard (.vcf), iCal (.ics), NDJSON
// ─────────────────────────────────────────────────────────────────────────────

/** Extract fields from .eml (RFC 822) incl. multipart bodies. */
function emlToText(raw: string): { text: string; metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {}
  const headerBlockEnd = raw.search(/\r?\n\r?\n/)
  const headerBlock = headerBlockEnd >= 0 ? raw.slice(0, headerBlockEnd) : raw
  let body = headerBlockEnd >= 0 ? raw.slice(headerBlockEnd).replace(/^\r?\n\r?\n/, '') : ''

  // Folded headers
  const lines = headerBlock.split(/\r?\n/)
  let currentHeader = ''
  for (const line of lines) {
    if (/^\s/.test(line) && currentHeader) {
      metadata[currentHeader] = ((metadata[currentHeader] as string) ?? '') + ' ' + line.trim()
    } else {
      const m = line.match(/^([A-Za-z-]+):\s*(.*)$/)
      if (m) {
        currentHeader = m[1].toLowerCase()
        metadata[currentHeader] = m[2]
      }
    }
  }

  /** Decode one MIME part body per its Content-Transfer-Encoding headers. */
  const decodePart = (partBody: string, partHeaders: string): string => {
    let text = partBody
    if (/content-transfer-encoding:\s*base64/i.test(partHeaders)) {
      // v3.6 fix: base64 bodies (Gmail/Outlook .eml exports) were previously
      // left encoded — the entity extractor saw an opaque blob.
      try {
        text = Buffer.from(partBody.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
      } catch { /* keep raw on malformed base64 */ }
    } else if (/content-transfer-encoding:\s*quoted-printable/i.test(partHeaders)) {
      text = decodeQuotedPrintable(partBody)
    }
    return text
  }

  // Multipart: prefer text/plain part; fall back to whole body.
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i)
  if (boundaryMatch) {
    const boundary = '--' + boundaryMatch[1]
    const parts = body.split(boundary)
    const textParts: string[] = []
    for (const part of parts) {
      const partBody = part.replace(/^[\s\S]*?\r?\n\r?\n/, '')
      if (part.includes('Content-Type: text/html')) {
        textParts.push(htmlToText(decodePart(partBody, part)))
      } else if (part.includes('Content-Type: text/plain')) {
        textParts.push(decodePart(partBody, part))
      }
    }
    if (textParts.length > 0) body = textParts.join('\n\n')
  }

  let text = body
  if (metadata['content-transfer-encoding'] === 'quoted-printable') {
    text = decodeQuotedPrintable(text)
  } else if (metadata['content-transfer-encoding'] === 'base64') {
    try {
      text = Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
    } catch { /* keep raw */ }
  }
  if (/<html/i.test(text)) text = htmlToText(text)
  // v3.6: surface the key headers at the top of the extracted text — the
  // From/To/Subject lines are primary intelligence (sender/receiver emails,
  // dates) that entity extraction previously never saw because only the
  // decoded body was returned.
  const headerLines: string[] = []
  for (const key of ['from', 'to', 'cc', 'subject', 'date']) {
    const v = metadata[key]
    if (typeof v === 'string' && v.trim()) headerLines.push(`${key.charAt(0).toUpperCase() + key.slice(1)}: ${v.trim()}`)
  }
  const headerSummary = headerLines.length > 0 ? headerLines.join('\n') + '\n\n' : ''
  return { text: (headerSummary + text).trim(), metadata }
}

function decodeQuotedPrintable(s: string): string {
  // v3.6 fix: decode =XX escapes to raw BYTES first, then interpret the byte
  // sequence as UTF-8 — the old per-char fromCharCode produced mojibake for
  // any non-ASCII content (e.g. "R=C3=A9sum=C3=A9" → "RÃ©sumÃ©").
  const soft = s.replace(/=\r?\n/g, '')
  if (!/=[0-9A-Fa-f]{2}/.test(soft)) return soft
  const bytes: number[] = []
  for (let i = 0; i < soft.length; i++) {
    const m = soft.slice(i, i + 3).match(/^=([0-9A-Fa-f]{2})$/)
    if (m) {
      bytes.push(parseInt(m[1], 16))
      i += 2
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff)
    }
  }
  try {
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return soft
  }
}

/** vCard → flat "Field: value" lines the entity extractor can read. */
function vcfToText(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '')
  const lines: string[] = []
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+)(?:;[^:]*)?:(.*)$/)
    if (!m) continue
    const key = m[1].toUpperCase()
    const val = m[2].trim()
    if (!val || key === 'BEGIN' || key === 'END' || key === 'VERSION' || key === 'PRODID') continue
    lines.push(`${key}: ${val}`)
  }
  return lines.join('\n')
}

/** iCalendar → "SUMMARY/DTSTART/LOCATION/DESCRIPTION" lines. */
function icsToText(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '')
  const lines: string[] = []
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+)(?:;[^:]*)?:(.*)$/)
    if (!m) continue
    const key = m[1].toUpperCase()
    const val = m[2].trim()
    if (['BEGIN', 'END', 'VERSION', 'PRODID', 'CALSCALE', 'METHOD'].includes(key)) continue
    lines.push(`${key}: ${val}`)
  }
  return lines.join('\n')
}

/** JSON → pretty text; NDJSON → each record pretty-printed and separated. */
const JSON_TABLE_MIN = 6 // min sibling records to flatten JSON into a pipe table

/** Render one JSON scalar/object/array value as a table cell (pipe-safe). */
function jsonCell(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) {
    return v.map(jsonCell).filter(Boolean).join(', ').replace(/\|/g, '/').slice(0, 200)
  }
  if (typeof v === 'object') {
    // Nested object → docx-registry attribute style (key=value pairs) so the
    // attribute machinery downstream can parse the cell.
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x != null && typeof x !== 'object')
      .map(([k, x]) => `${k}=${String(x).replace(/\|/g, '/')}`)
      .join(' ')
      .slice(0, 200)
  }
  return String(v).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 200)
}

/** Flatten an array of sibling objects into a pipe table (xmlToText style).
 *  Returns null when the array is not record-shaped (mixed scalars/objects,
 *  runaway schemas >40 cols, single-column objects). */
function jsonRecordTable(items: unknown[]): string | null {
  if (!items.every((i) => i && typeof i === 'object' && !Array.isArray(i))) return null
  const colSet: string[] = []
  for (const it of items) {
    for (const k of Object.keys(it as object)) {
      if (!colSet.includes(k)) colSet.push(k)
      if (colSet.length > 40) return null
    }
  }
  if (colSet.length < 2) return null
  const lines = [colSet.join(' | ')]
  for (const it of items) {
    const o = it as Record<string, unknown>
    lines.push(colSet.map((c) => jsonCell(o[c])).join(' | '))
  }
  return lines.join('\n')
}

function jsonToText(raw: string, ext: string): string {
  if (ext === 'ndjson' || ext === 'jsonl') {
    // v3.10: a homogeneous NDJSON stream IS a record list — flatten it into
    // one pipe table (the registry/rel-table machinery reads tables, not
    // pretty-printed JSON).
    const objs: unknown[] = []
    let parseable = true
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try { objs.push(JSON.parse(t)) } catch { parseable = false; break }
    }
    if (parseable && objs.length >= JSON_TABLE_MIN) {
      const tbl = jsonRecordTable(objs)
      if (tbl) return `records list\n${tbl}\n`
    }
    const parts: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try { parts.push(JSON.stringify(JSON.parse(t), null, 2)) } catch { parts.push(t) }
    }
    return parts.join('\n\n')
  }
  try {
    const data = JSON.parse(raw)
    // v3.10: object/array documents carrying record lists (arrays of ≥6
    // sibling objects — API dumps, graph exports, linkage indexes) render as
    // labelled pipe tables, mirroring the v3.9.2 XML record-list flattener.
    // Pretty-printed JSON stays as the fallback so mixed/prose documents are
    // unchanged.
    if (Array.isArray(data)) {
      if (data.length >= JSON_TABLE_MIN) {
        const tbl = jsonRecordTable(data)
        if (tbl) return `records list\n${tbl}\n`
      }
    } else if (data && typeof data === 'object') {
      const out: string[] = []
      const consumed = new Set<string>()
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v) && v.length >= JSON_TABLE_MIN) {
          const tbl = jsonRecordTable(v)
          if (tbl) {
            out.push(`${camelToSnake(k)} list`)
            out.push(tbl)
            out.push('')
            consumed.add(k)
          }
        }
      }
      if (out.length > 0) {
        const rest = Object.fromEntries(
          Object.entries(data).filter(([k]) => !consumed.has(k)),
        )
        if (Object.keys(rest).length > 0) {
          out.push(JSON.stringify(rest, null, 2).slice(0, 4000))
        }
        return `${out.join('\n').trim()}\n`
      }
    }
    return JSON.stringify(data, null, 2)
  } catch {
    return raw
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — real text extraction via stream inflation + text-operator decoding
// ─────────────────────────────────────────────────────────────────────────────

/** Decode PDF string escape sequences. */
function decodePdfString(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') { out += ch; continue }
    const next = s[i + 1]
    if (next === undefined) break
    if (next === 'n') { out += '\n'; i++ }
    else if (next === 'r') { out += '\n'; i++ }
    else if (next === 't') { out += '\t'; i++ }
    else if (next === 'b' || next === 'f') { out += ' '; i++ }
    else if (next >= '0' && next <= '7') {
      // Octal escape: up to 3 digits
      let oct = ''
      let j = i + 1
      while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') { oct += s[j]; j++ }
      const code = parseInt(oct, 8)
      out += code >= 32 ? String.fromCharCode(code) : ''
      i = j - 1
    } else { out += next; i++ }
  }
  return out
}

/**
 * Adobe ASCII85 decoding (v3.6). ReportLab and many PDF generators emit
 * `/Filter [ /ASCII85Decode /FlateDecode ]` chains — the stream is ASCII85
 * FIRST and Flate SECOND. Without this decoder every such PDF fell through
 * to the garbage literal-string fallback.
 */
function ascii85Decode(s: string): Buffer | null {
  try {
    // Strip whitespace and the optional EOD marker.
    let body = s.replace(/\s+/g, '')
    const eod = body.indexOf('~>')
    if (eod >= 0) body = body.slice(0, eod)
    const out: number[] = []
    let group: number[] = []
    const pushGroup = (): void => {
      if (group.length === 0) return
      // 'z' inside a group is invalid; treat as zeros.
      const padded = group.length
      const chars = [...group]
      while (chars.length < 5) chars.push(117) // 'u'
      let val = 0
      for (const c of chars) val = val * 85 + (c - 33)
      if (val > 0xffffffff) val = 0xffffffff
      const b = [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff]
      out.push(...b.slice(0, Math.max(1, padded - 1)))
      group = []
    }
    for (const ch of body) {
      if (ch === 'z' && group.length === 0) {
        out.push(0, 0, 0, 0)
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 33 || code > 117) return null // invalid char — bail
      group.push(code)
      if (group.length === 5) pushGroup()
    }
    if (group.length > 0) pushGroup()
    return Buffer.from(out)
  } catch {
    return null
  }
}

/**
 * Extract the ordered /Filter chain from a stream dictionary.
 * Handles `/Filter /FlateDecode` and `/Filter [/ASCII85Decode /FlateDecode]`.
 */
function pdfFilterChain(dict: string): string[] {
  const arr = dict.match(/\/Filter\s*\[([^\]]*)\]/)
  if (arr) {
    return [...arr[1].matchAll(/\/(\w+)/g)].map((m) => m[1])
  }
  const single = dict.match(/\/Filter\s*\/(\w+)/)
  return single ? [single[1]] : []
}

/** Decode a PDF stream body through its filter chain (ASCII85 → Flate → raw). */
function decodePdfStream(chunk: string, filters: string[]): string | null {
  let buf: Buffer | null = null
  for (const f of filters) {
    if (f === 'ASCII85Decode' || f === 'A85') {
      const next = ascii85Decode(buf ? buf.toString('latin1') : chunk)
      if (!next) return null
      buf = next
    } else if (f === 'FlateDecode' || f === 'Fl') {
      const input = buf ?? Buffer.from(chunk, 'latin1')
      let out: Buffer | null = null
      try { out = inflateSync(input) } catch { try { out = inflateRawSync(input) } catch { out = null } }
      if (!out) return null
      buf = out
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      const src = (buf ? buf.toString('latin1') : chunk).replace(/[^0-9A-Fa-f]/g, '')
      const pairs = src.length - (src.length % 2)
      buf = Buffer.from(src.slice(0, pairs), 'hex')
    } else {
      // Unsupported filter (LZW, DCT, …) — stop; text unlikely recoverable.
      return null
    }
  }
  if (!buf) return null
  return buf.toString('latin1')
}

/**
 * v3.9.2 — Type0/CID font support: build fontResourceName → (code → unicode)
 * maps from every /ToUnicode CMap in the document.
 *
 * Why: LibreOffice / OpenOffice / many exporters subset their fonts and emit
 * text as HEX CID strings (`[<01>2<02>-1<03>] TJ`) keyed to a per-font
 * ToUnicode CMap. The literal-string-only decoder saw NOTHING for such PDFs
 * and the pipeline fell back to an 88-second, fidelity-losing OCR pass.
 *
 * Generic, spec-driven (PDF 3200-1:2008 §9.10):
 *   /Font << /F1 6480 0 R … >>      resource name → font object
 *   6480 0 obj << /ToUnicode 6481 0 R … >>   font object → CMap stream
 *   begincodespacerange <00> <FF>    code byte-width
 *   beginbfchar <01> <0054> …        single code → unicode
 *   beginbfrange <06> <0A> <0066> …  inclusive range → unicode start
 */
function parseToUnicodeCMaps(raw: string, decompress: (chunk: string) => string | null): Map<string, { bytes: number; map: Map<number, string> }> {
  const fonts = new Map<string, { bytes: number; map: Map<number, string> }>()

  // Object table: objNum → body between "N 0 obj" and "endobj" (dict only).
  const objBody = new Map<string, string>()
  const objRe = /(\d+)\s+0\s+obj\s*([\s\S]*?)endobj/g
  let otm: RegExpExecArray | null
  while ((otm = objRe.exec(raw)) !== null) objBody.set(otm[1], otm[2])

  /** name→ref pairs out of a dict body that maps resource names to objects. */
  const refsIn = (dict: string): Array<[string, string]> => {
    const out: Array<[string, string]> = []
    const refRe = /\/([A-Za-z0-9.+_-]+)\s+(\d+)\s+0\s+R/g
    let rm: RegExpExecArray | null
    while ((rm = refRe.exec(dict)) !== null) out.push([rm[1], rm[2]])
    return out
  }

  // Resource name → font object, from BOTH dict styles:
  //   inline    /Font << /F1 6480 0 R … >>
  //   indirect  /Font 6503 0 R   where 6503 0 obj << /F1 6492 0 R … >>
  const nameToObj = new Map<string, string>()
  const fontDictRe = /\/Font\s*(?:(<<)|(?:(?!\d+\s+0\s+R\s*>>)(\d+)\s+0\s+R))/g
  let fm: RegExpExecArray | null
  const seenFontObjs = new Set<string>()
  while ((fm = fontDictRe.exec(raw)) !== null) {
    if (fm[1]) {
      const inline = raw.slice(fm.index, raw.indexOf('>>', fm.index) + 2)
      for (const [n, o] of refsIn(inline)) nameToObj.set(n, o)
    } else if (fm[2]) {
      // resolve the referenced dict object (skip /FontDescriptor/FontName etc.
      // — only /Font NN 0 R has a digit immediately after).
      const body = objBody.get(fm[2])
      if (body && !seenFontObjs.has(fm[2])) {
        seenFontObjs.add(fm[2])
        for (const [n, o] of refsIn(body)) nameToObj.set(n, o)
      }
    }
  }

  for (const [resName, fontObj] of nameToObj) {
    const fontBody = objBody.get(fontObj) ?? ''
    const tu = fontBody.match(/\/ToUnicode\s+(\d+)\s+0\s+R/)
    if (!tu) continue
    const cmapObj = tu[1]
    // Extract + decompress the CMap stream body.
    const streamIdx = raw.indexOf(`${cmapObj} 0 obj`)
    if (streamIdx < 0) continue
    const streamStart = raw.indexOf('stream', streamIdx)
    if (streamStart < 0) continue
    const bodyStart = streamStart + 'stream'.length + (raw[streamStart + 6] === '\r' ? 2 : 1)
    const bodyEnd = raw.indexOf('endstream', bodyStart)
    if (bodyEnd < 0) continue
    const dict = raw.slice(streamIdx, streamStart)
    let cmap = raw.slice(bodyStart, bodyEnd)
    if (/\/FlateDecode/.test(dict)) {
      const d = decompress(cmap)
      if (d == null) continue
      cmap = d
    }
    // codespacerange → code byte width.
    const cs = cmap.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/)
    const bytes = cs ? Math.ceil(cs[1].length / 2) : 1
    const map = new Map<number, string>()
    // bfchar blocks: <code> <utf16hex> pairs.
    const bfcharBlockRe = /beginbfchar([\s\S]*?)endbfchar/g
    let bm: RegExpExecArray | null
    while ((bm = bfcharBlockRe.exec(cmap)) !== null) {
      const pairs = bm[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) ?? []
      for (const p of pairs) {
        const mm = p.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/)!
        map.set(parseInt(mm[1], 16), hexToUnicode(mm[2]))
      }
    }
    // bfrange blocks: <lo> <hi> <dst-start> OR <lo> <hi> [<dst> <dst> …].
    const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g
    let rrm: RegExpExecArray | null
    while ((rrm = rangeRe.exec(cmap)) !== null) {
      const rows = rrm[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g) ?? []
      for (const row of rows) {
        const parts = row.match(/<([0-9A-Fa-f]+)>/g) ?? []
        if (parts.length < 3 && !row.includes('[')) continue
        const lo = parseInt((parts[0] ?? '').slice(1, -1), 16)
        const hi = parseInt((parts[1] ?? '').slice(1, -1), 16)
        if (row.includes('[')) {
          const arr = row.slice(row.indexOf('[') + 1, row.lastIndexOf(']'))
          const dsts = arr.match(/<([0-9A-Fa-f]+)>/g) ?? []
          for (let i = 0; i < dsts.length && lo + i <= hi; i++) {
            map.set(lo + i, hexToUnicode(dsts[i].slice(1, -1)))
          }
        } else {
          const dst = parseInt((parts[2] ?? '').slice(1, -1), 16)
          for (let c = lo; c <= hi && c - lo < 65536; c++) {
            map.set(c, String.fromCodePoint(dst + (c - lo)))
          }
        }
      }
    }
    if (map.size > 0) fonts.set(resName, { bytes, map })
  }
  return fonts
}

/** UTF-16BE hex (<0054> or <00540068>) → unicode string. */
function hexToUnicode(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  let out = ''
  for (let i = 0; i + 3 < clean.length + 1; i += 4) {
    const cp = parseInt(clean.slice(i, i + 4), 16)
    if (Number.isFinite(cp) && cp > 0) out += String.fromCodePoint(cp)
  }
  if (!out && clean) {
    // odd-length / single-byte destinations
    for (let i = 0; i + 1 < clean.length + 1; i += 2) {
      const cp = parseInt(clean.slice(i, i + 2), 16)
      if (Number.isFinite(cp) && cp > 0) out += String.fromCodePoint(cp)
    }
  }
  return out
}

/**
 * v3.9.2 — decode a hex CID string (<014A…>) through the current font's
 * ToUnicode map; falls back to latin1 when unmapped (some generators emit
 * ASCII in hex strings without a CMap).
 */
function decodeHexString(hex: string, font: { bytes: number; map: Map<number, string> } | undefined): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  if (!font || font.map.size === 0) {
    // No map: treat pairs as latin1 chars.
    let latin = ''
    for (let i = 0; i + 1 < clean.length + 1; i += 2) latin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
    return latin
  }
  const w = font.bytes
  let out = ''
  for (let i = 0; i + w * 2 <= clean.length; i += w * 2) {
    const code = parseInt(clean.slice(i, i + w * 2), 16)
    out += font.map.get(code) ?? ''
  }
  return out
}

/**
 * Extract text tokens from a decoded PDF content stream (Tj / TJ / ' / ").
 * v3.9.2: font- and position-aware —
 *  • tracks the current font via `/FN size Tf` and decodes HEX CID strings
 *    through its ToUnicode map (Type0 subset fonts — LibreOffice et al.)
 *  • tracks the text matrix (Tm / Td / TD / T* / TL) so text-showing ops on
 *    the SAME baseline join into one line, with ' | ' marking column gaps
 *    (x advance larger than the rendered width) — registry/rel-table rows
 *    come out as single pipe-joined lines instead of cell confetti.
 */
function pdfContentStreamToText(content: string, fonts?: Map<string, { bytes: number; map: Map<number, string> }>): string {
  interface Piece { y: number; x: number; s: string; size: number }
  const pieces: Piece[] = []
  let curX = 0
  let curY = 0
  let leading = 12
  let fontSize = 10
  let font: { bytes: number; map: Map<number, string> } | undefined
  let lineStartX = 0

  const emit = (s: string): void => {
    if (!s) return
    pieces.push({ x: curX, y: curY, s, size: fontSize })
    // advance x by an approximate rendered width (avg glyph ≈ 0.5 × size)
    curX += s.length * fontSize * 0.5
  }

  let m: RegExpExecArray | null
  const opRe = /\((?:\\.|[^\\()])*\)\s*(Tj|'|"|TJ)|<([0-9A-Fa-f\s]+)>\s*(Tj|'|"|TJ)|\[(?:[^\]\\]|\\.)*\]\s*TJ|\/([A-Za-z0-9.+_-]+)\s+(-?[\d.]+)\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(T\*)|(BT)|(ET)|(-?[\d.]+)\s+TL/g
  while ((m = opRe.exec(content)) !== null) {
    if (m[1] && !m[0].startsWith('[')) { // (string) Tj / ' / " / TJ-single
      emit(decodePdfString(m[0].replace(/\s*(Tj|'|"|TJ)$/, '').slice(1, -1)))
    } else if (m[3]) { // <hex> Tj / ' / " / TJ-single
      emit(decodeHexString(m[2], font))
    } else if (m[0].endsWith('TJ')) { // [array] TJ — strings + hex + kerns
      const arr = m[0].slice(1, -3)
      let line = ''
      const elRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|-?\d+(?:\.\d+)?/g
      let el: RegExpExecArray | null
      while ((el = elRe.exec(arr)) !== null) {
        const tok = el[0]
        if (tok.startsWith('(')) line += decodePdfString(tok.slice(1, -1))
        else if (tok.startsWith('<')) line += decodeHexString(tok.slice(1, -1), font)
        else {
          const num = parseFloat(tok)
          if (num <= -180 && !line.endsWith(' ')) line += ' ' // big kern → space
        }
      }
      emit(line)
    } else if (m[4]) { // /FN size Tf
      font = fonts?.get(m[4])
      const sz = parseFloat(m[5])
      if (Number.isFinite(sz) && sz > 0) fontSize = sz
    } else if (m[8]) { // x y Td / TD (relative move)
      curX += parseFloat(m[6])
      curY += parseFloat(m[7])
      if (m[8] === 'TD') leading = -parseFloat(m[7])
    } else if (m[9]) { // a b c d e f Tm (absolute text-space matrix)
      curX = parseFloat(m[13]) // e
      curY = parseFloat(m[14]) // f
      lineStartX = curX
    } else if (m[15]) { // T* — next line
      curY -= leading
      curX = lineStartX
    } else if (m[16]) { // BT — text object: text matrix RESETS to identity
      curX = 0
      curY = 0
      lineStartX = 0
    } else if (m[17]) { // ET — end text object (font persists)
      // no position change
    } else if (m[18]) { // n TL — set leading
      leading = parseFloat(m[18]) || leading
    }
  }

  if (pieces.length === 0) return ''
  // Assemble: group pieces by baseline y (0.6pt tolerance), descending y
  // (PDF y grows upward), preserving x order within a line. A column gap is
  // an x jump > rendered width + 1.2 × font size.
  pieces.sort((a, b) => (Math.abs(a.y - b.y) > 0.6 ? b.y - a.y : a.x - b.x))
  const lines: string[] = []
  let line: string[] = []
  let lineY = pieces[0].y
  let lineRight = -Infinity
  const flush = (): void => {
    if (line.length) {
      lines.push(line.join(''))
      line = []
    }
  }
  for (const p of pieces) {
    if (Math.abs(p.y - lineY) > 0.6) {
      flush()
      lineY = p.y
      lineRight = -Infinity
    }
    const rendered = p.s.length * p.size * 0.5
    const gap = p.x - lineRight
    if (lineRight > -Infinity && gap > rendered * 0.4 + p.size * 1.2) line.push(' | ')
    else if (lineRight > -Infinity && gap > p.size * 0.15 && !line.join('').endsWith(' ')) line.push(' ')
    line.push(p.s)
    lineRight = p.x + rendered
  }
  flush()
  return lines.join('\n')
}

/** Find /Annots URLs and plain http(s) URLs in raw PDF (useful indicators). */
function extractPdfUrls(raw: string): string[] {
  const urls = new Set<string>()
  const re = /https?:\/\/[^\s)<>"']{6,}/g
  let m: RegExpExecArray | null
  const sample = raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw
  while ((m = re.exec(sample)) !== null) urls.add(m[0])
  return Array.from(urls).slice(0, 100)
}

/**
 * PDF text extraction:
 *  1. Slice every "stream … endstream" section together with its dictionary.
 *  2. Inflate FlateDecode streams (zlib) / raw-flate fallback.
 *  3. Decode text operators inside content streams.
 *  4. Split content by page markers where possible so provenance can cite
 *     "=== Page N ===".
 */
export function pdfToText(bytes: Uint8Array): { text: string; metadata: Record<string, unknown> } {
  const raw = Buffer.from(bytes).toString('latin1')
  const metadata: Record<string, unknown> = { format: 'pdf' }

  if (/\/Encrypt\s/.test(raw)) {
    metadata.encrypted = true
    return {
      text: '(PDF is encrypted — password required before text extraction)',
      metadata,
    }
  }

  const pageCountMatch = raw.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/) ??
    raw.match(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/)
  if (pageCountMatch) metadata.pages = parseInt(pageCountMatch[1], 10)
  metadata.urls = extractPdfUrls(raw)

  // v3.9.2: ToUnicode CMaps for Type0/CID subset fonts (LibreOffice & co).
  // Built ONCE per document; content streams decode hex CID strings through
  // the font they were drawn with.
  const cidFonts = parseToUnicodeCMaps(raw, (chunk) => decodePdfStream(chunk, ['FlateDecode']))
  if (cidFonts.size > 0) metadata.cidFonts = cidFonts.size

  const streams: string[] = []
  const re = /stream\r?\n?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const streamStart = m.index + m[0].length
    const endIdx = raw.indexOf('endstream', streamStart)
    if (endIdx < 0) break
    // Look back for the dictionary that governs this stream.
    const dictStart = Math.max(0, m.index - 800)
    const dict = raw.slice(dictStart, m.index)
    const chunk = raw.slice(streamStart, endIdx)
    // v3.6: decode through the FULL filter chain (handles the ReportLab
    // /ASCII85Decode+/FlateDecode combination that previously produced
    // garbage or nothing).
    const filters = pdfFilterChain(dict)
    if (filters.length > 0) {
      const decoded = decodePdfStream(chunk, filters)
      if (decoded) {
        if (/(Tj|TJ)\s/.test(decoded) || /\bBT\b/.test(decoded)) {
          streams.push(pdfContentStreamToText(decoded, cidFonts))
        }
      }
    } else if (/\bBT\b/.test(chunk) || /(Tj|TJ)\s/.test(chunk)) {
      // Uncompressed content stream.
      streams.push(pdfContentStreamToText(chunk, cidFonts))
    }
    re.lastIndex = endIdx + 9
  }

  // Page attribution: if the PDF stored per-page content separately we can
  // approximate page numbers by counting streams; label each chunk.
  const pageCount = typeof metadata.pages === 'number' ? (metadata.pages as number) : streams.length
  let text: string
  if (streams.length === 0) {
    // Fallback: legacy literal-string scan (old regex approach) so at least
    // uncompressed text-only PDFs still yield something.
    const textMatches: string[] = []
    const strRe = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g
    let sm: RegExpExecArray | null
    while ((sm = strRe.exec(raw)) !== null) {
      if (sm[1].length > 1) textMatches.push(decodePdfString(sm[1]))
    }
    text = textMatches.join('\n')
    metadata.pdfExtraction = streams.length === 0 && text ? 'literal-fallback' : 'none'
  } else {
    metadata.pdfExtraction = 'flate-streams'
    const labelled = streams.map((s, i) => {
      const page = Math.min(i + 1, Math.max(pageCount, streams.length))
      return `=== Page ${page} ===\n${s.trim()}`
    })
    text = labelled.join('\n\n')
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return {
    text: text.length > 0 ? text : '(PDF text extraction yielded no text; OCR may be required)',
    metadata,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Office docs — docx / pptx via fflate; xlsx/xls/ods via SheetJS; doc/msg legacy
// ─────────────────────────────────────────────────────────────────────────────

async function loadFflate() {
  return import('fflate').catch(() => null)
}

/**
 * .docx — unzip, read word/document.xml, paragraphs → newlines, cells → " | ".
 *
 * v3.9.1 TABLE-AWARE FLATTENING: a naive "</w:p> → \n" puts every table CELL
 * on its own line (each <w:tc> wraps a <w:p>), destroying row structure — the
 * downstream relationship-table detector, structure detection and chunker then
 * see ~1-field lines and the whole tabular pipeline silently degrades to
 * prose-guessing. This pass tracks <w:tbl> depth instead:
 *   - OUTSIDE tables: </w:p> → newline (normal paragraphs)
 *   - INSIDE tables: </w:tc> → " | " cell separator, </w:tr> → newline
 *     (one table row = ONE line), </w:p> → soft space (paragraph inside a
 *     cell never breaks the row), <w:br/> inside a cell → space too.
 * Nested tables flatten to their innermost rows — good enough for text
 * extraction and preserves the one-row-one-line invariant everywhere.
 */
async function docxToText(bytes: Uint8Array): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const fflate = await loadFflate()
    if (!fflate) return { text: '(docx parsing requires the fflate package)', metadata: {} }
    const unzipped = fflate.unzipSync(bytes)
    const docXml = unzipped['word/document.xml']
    if (!docXml) return { text: '(no word/document.xml found in docx)', metadata: {} }
    const xml = decodeUtf8(docXml)

    // NOTE: <w:tbl> must NOT match <w:tblPr>/<w:tblGrid> — hence the bare-or-
    // space-attribute alternatives.
    const TOKEN_RE = /<\/w:p>|<\/w:tc>|<\/w:tr>|<\/w:tbl>|<w:tbl>|<w:tbl\s[^>]*>|<w:tab[^>]*\/>|<w:br[^>]*\/>/gi
    let out = ''
    let depth = 0
    let last = 0
    for (const m of xml.matchAll(TOKEN_RE)) {
      out += xml.slice(last, m.index)
      last = (m.index ?? 0) + m[0].length
      const tok = m[0].toLowerCase()
      if (tok === '<w:tbl>' || (tok.startsWith('<w:tbl ') && !tok.endsWith('/>'))) depth++
      else if (tok === '</w:tbl>') depth = Math.max(0, depth - 1)
      else if (tok === '</w:tc>') out += ' | '
      else if (tok === '</w:tr>') out += '\n'
      else if (tok === '</w:p>') out += depth > 0 ? ' ' : '\n'
      else if (tok.startsWith('<w:tab')) out += depth > 0 ? ' ' : '\t'
      else if (tok.startsWith('<w:br')) out += depth > 0 ? ' ' : '\n'
    }
    out += xml.slice(last)

    let text = out.replace(/<[^>]+>/g, '')
    text = decodeEntities(text)
    // Rows legitimately end with a trailing " | " (last cell) — harmless for
    // the delimited splitters (empty trailing fields are filtered), but tidy
    // it for human reading: " | \n" → "\n".
    text = text.replace(/[ \t]*\|[ \t]*\n/g, '\n')
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    // Core properties (author/dates) when present.
    const coreXml = unzipped['docProps/core.xml']
    const meta: Record<string, unknown> = { format: 'docx' }
    if (coreXml) {
      const core = decodeUtf8(coreXml)
      const author = core.match(/<dc:creator>([^<]*)</)
      const title = core.match(/<dc:title>([^<]*)</)
      if (author?.[1]) meta.author = author[1]
      if (title?.[1]) meta.title = title[1]
    }
    return { text, metadata: meta }
  } catch (e) {
    return { text: '(failed to parse docx: ' + (e instanceof Error ? e.message : 'unknown') + ')', metadata: {} }
  }
}

/** .pptx — unzip, read ppt/slides/slideN.xml, <a:t> runs → lines. */
async function pptxToText(bytes: Uint8Array): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const fflate = await loadFflate()
    if (!fflate) return { text: '(pptx parsing requires the fflate package)', metadata: {} }
    const unzipped = fflate.unzipSync(bytes)
    const slideFiles = Object.keys(unzipped)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10)
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10)
        return na - nb
      })
    if (slideFiles.length === 0) return { text: '(no slides found in pptx)', metadata: {} }
    const parts: string[] = []
    for (const sf of slideFiles) {
      const xml = decodeUtf8(unzipped[sf])
      const runs: string[] = []
      const re = /<a:t>([\s\S]*?)<\/a:t>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(xml)) !== null) runs.push(decodeEntities(m[1]))
      const num = sf.match(/slide(\d+)\.xml$/)?.[1] ?? '?'
      parts.push(`=== Slide ${num} ===\n${runs.join('\n')}`)
    }
    return { text: parts.join('\n\n').trim(), metadata: { format: 'pptx', slides: slideFiles.length } }
  } catch (e) {
    return { text: '(failed to parse pptx: ' + (e instanceof Error ? e.message : 'unknown') + ')', metadata: {} }
  }
}

/**
 * .xlsx/.xlsm/.xlsb/.xls/.ods via SheetJS — every sheet converted to CSV text
 * with === Sheet: name === markers, so the downstream CSV transaction
 * extractor sees proper header rows.
 */
async function sheetToText(bytes: Uint8Array): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
    const parts: string[] = []
    const sheetNames: string[] = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      if (!ws) continue
      sheetNames.push(name)
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, FS: ',' })
      // v3.10: cells with embedded newlines would otherwise break ONE logical
      // row across several physical lines — downstream table detectors then
      // glue multiple records into single junk values ("ORG-004,…\nORG-005,…").
      // A cell is a VALUE, never a line structure: fold in-cell newlines to
      // spaces BEFORE the sheet text is emitted.
      const safeCsv = csv.replace(/"(?:[^"]|"")*"/g, (m) => m.replace(/\r?\n/g, ' '))
      parts.push(`=== Sheet: ${name} ===\n${safeCsv.trim()}`)
    }
    if (parts.length === 0) return { text: '(workbook contains no readable sheets)', metadata: { format: 'sheet' } }
    const meta: Record<string, unknown> = {
      format: 'spreadsheet',
      sheets: sheetNames,
      sheetCount: sheetNames.length,
    }
    const props = wb.Props as Record<string, unknown> | undefined
    if (props) {
      if (props.Author) meta.author = props.Author
      if (props.Title) meta.title = props.Title
    }
    return { text: parts.join('\n\n'), metadata: meta }
  } catch (e) {
    return { text: '(failed to parse spreadsheet: ' + (e instanceof Error ? e.message : 'unknown') + ')', metadata: {} }
  }
}

/**
 * Legacy binary formats (.doc, .msg, .xls without a parser): OLE2 compound
 * documents store text as either latin1 or UTF-16LE runs. Extract the
 * printable runs — lossy but reliably surfaces names/accounts/phones.
 */
function oleBinaryToText(bytes: Uint8Array, format: string): { text: string; metadata: Record<string, unknown> } {
  const buf = Buffer.from(bytes)
  // UTF-16LE runs: sequences of ≥4 chars matching [printable]\0 pattern.
  const utf16Chunks: string[] = []
  let run = ''
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8)
    const isPrintable = (code >= 0x20 && code <= 0x7e) || code === 0x0a || code === 0x0d || code === 0x09
    if (isPrintable) {
      run += String.fromCharCode(code)
    } else {
      if (run.trim().length >= 6) utf16Chunks.push(run.trim())
      run = ''
    }
  }
  if (run.trim().length >= 6) utf16Chunks.push(run.trim())

  // Latin1 printable runs as a secondary source.
  const latinChunks: string[] = []
  const latin = buf.toString('latin1')
  for (const chunk of latin.split(/[^ -~\n\r\t]+/)) {
    if (chunk.trim().length >= 8) latinChunks.push(chunk.trim())
  }

  const utf16Text = utf16Chunks.join('\n')
  const latinText = latinChunks.slice(0, 400).join('\n')
  const text = utf16Text.length > latinText.length
    ? `${utf16Text}\n\n${latinText}`
    : latinText + (utf16Text ? `\n\n${utf16Text}` : '')

  return {
    text: text.trim() || `(binary ${format} document — no readable text runs found; OCR/conversion may be required)`,
    metadata: { format, extraction: 'binary-printable-runs', lossy: true },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP — recursive member parsing
// ─────────────────────────────────────────────────────────────────────────────

async function zipToText(bytes: Uint8Array, depth = 0): Promise<{ text: string; metadata: Record<string, unknown> }> {
  try {
    const fflate = await loadFflate()
    if (!fflate) return { text: '(zip parsing requires the fflate package)', metadata: {} }
    const unzipped = fflate.unzipSync(bytes)
    const members = Object.keys(unzipped)
    const parts: string[] = []
    const fileList: string[] = []
    // v3.6 guard: hard member cap — a zip bomb / quine must never freeze the
    // event loop or exhaust memory (unzipSync is synchronous).
    const MAX_ZIP_MEMBERS = 500
    const memberSlice = members.slice(0, MAX_ZIP_MEMBERS)
    if (members.length > MAX_ZIP_MEMBERS) {
      fileList.push(`(archive truncated: ${members.length} members, parsed first ${MAX_ZIP_MEMBERS})`)
    }
    for (const member of memberSlice) {
      if (member.endsWith('/')) continue
      if (member.startsWith('__MACOSX/') || member.endsWith('.DS_Store')) continue
      const memberBytes = unzipped[member]
      const ext = getExt(member)
      fileList.push(member)
      try {
        if (ext === 'zip' && depth < 2) {
          const sub = await zipToText(memberBytes, depth + 1)
          parts.push(`=== ${member} (nested archive) ===\n${sub.text}`)
        } else if (ext === 'zip') {
          // v3.6 fix: nested-zip members past the depth limit previously
          // re-entered parseFile → zipToText(depth=0), making the recursion
          // effectively UNBOUNDED (zip-quine = stack overflow / OOM). At the
          // limit we now list the archive instead of re-parsing it.
          parts.push(`=== ${member} (nested archive — depth limit reached, not expanded) ===`)
        } else {
          const sub = await parseFile(member, memberBytes)
          parts.push(`=== ${member} ===\n${sub.text}`)
        }
      } catch (e) {
        parts.push(`=== ${member} (parse error: ${e instanceof Error ? e.message : 'unknown'}) ===`)
      }
    }
    return {
      text: parts.join('\n\n'),
      metadata: { format: 'zip', members: fileList, memberCount: fileList.length },
    }
  } catch (e) {
    return { text: '(failed to parse zip: ' + (e instanceof Error ? e.message : 'unknown') + ')', metadata: {} }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — quote-aware normalisation (RFC-4180) so extractors see clean rows
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a single CSV line honouring double-quoted cells with embedded commas. */
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
      cells.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur.trim())
  return cells
}

/** Full RFC-4180-ish CSV parse across lines (handles quoted newlines). */
export function parseCsvRows(raw: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  const pushCell = () => { row.push(cur.trim()); cur = '' }
  const pushRow = () => { pushCell(); if (row.some((c) => c !== '')) rows.push(row); row = [] }
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      pushCell()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i++
      pushRow()
    } else {
      cur += ch
    }
  }
  if (cur !== '' || row.length > 0) pushRow()
  return rows
}

/**
 * Normalise a CSV/TSV file into clean comma-joined rows. Quote-aware, so
 * "Smith, John" stays a single cell. Output is re-joined with commas only
 * when no cell contains a comma; otherwise the original delimiter is kept
 * and quoting is normalised — the downstream extractor handles both.
 */
function csvToText(raw: string, ext: string): string {
  const delim = ext === 'tsv' ? '\t' : raw.includes('\t') && !raw.includes(',') ? '\t' : ','
  const rows = parseCsvRows(raw, delim)
  if (rows.length === 0) return raw
  const needsQuote = (c: string) => c.includes(',') || c.includes('"') || c.includes('\n')
  const quote = (c: string) => (needsQuote(c) ? '"' + c.replace(/"/g, '""') + '"' : c)
  return rows.map((r) => r.map(quote).join(',')).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export async function parseFile(filename: string, bytes: Uint8Array): Promise<ParsedFile> {
  const ext = getExt(filename)
  const mime = detectMime(filename)
  const metadata: Record<string, unknown> = { ext, originalMime: mime }

  // Empty file guard.
  if (bytes.byteLength === 0) {
    return { text: '(empty file)', mime, size: 0, metadata }
  }

  // ── Spreadsheets (SheetJS: xlsx, xlsm, xlsb, xls, ods) ──
  if (SHEET_EXTS.has(ext)) {
    const { text, metadata: sheetMeta } = await sheetToText(bytes)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...sheetMeta } }
  }

  // ── Archives ──
  if (ext === 'zip') {
    const { text, metadata: zipMeta } = await zipToText(bytes)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...zipMeta } }
  }

  // ── OOXML presentations ──
  if (ext === 'pptx') {
    const { text, metadata: pptxMeta } = await pptxToText(bytes)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...pptxMeta } }
  }

  // ── OOXML documents ──
  if (ext === 'docx') {
    const { text, metadata: docxMeta } = await docxToText(bytes)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...docxMeta } }
  }

  // ── Legacy binary Office (.doc, .msg) ──
  if (ext === 'doc' || ext === 'msg') {
    const { text, metadata: oleMeta } = oleBinaryToText(bytes, ext)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...oleMeta } }
  }

  // ── PDF (zlib stream decode) ──
  if (ext === 'pdf') {
    const { text, metadata: pdfMeta } = pdfToText(bytes)
    // Scanned PDFs carry no usable text layer — rasterize + Tesseract when
    // the toolchain is present instead of shipping near-empty content.
    if (isWeakPdfText(text)) {
      const ocr = await ocrPdf(bytes).catch(
        (e): OcrResult => ({ ok: false, text: '', engine: null, error: String(e) }),
      )
      // The existing layer was judged garbage — any MEANINGFUL transcription
      // beats it, even a short one. (Old rule "must be longer" lost to
      // thousands of decoded-binary junk chars.)
      if (ocr.ok && ocr.text.replace(/\s/g, '').length >= 40) {
        return {
          text: ocr.text,
          mime,
          size: bytes.byteLength,
          metadata: { ...metadata, ...pdfMeta, ocr: true, ocrEngine: 'tesseract', ocrPages: ocr.pages, pdfExtraction: 'ocr-overlay' },
        }
      }
      if (ocr.error) pdfMeta.ocrError = ocr.error
    }
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...pdfMeta } }
  }

  // ── Images: flag for OCR, never garbage-decode ──
  if (IMAGE_EXTS.has(ext)) {
    metadata.format = 'image'
    metadata.ocrRequired = true
    // User's machine has Tesseract? Extract REAL text instead of parking the
    // upload as an OCR stub — results flow straight into extraction + AI scan.
    const ocr = await ocrImage(bytes, ext).catch(
      (e): OcrResult => ({ ok: false, text: '', engine: null, error: String(e) }),
    )
    if (ocr.ok && ocr.text.trim()) {
      delete metadata.ocrRequired
      return {
        text: ocr.text,
        mime,
        size: bytes.byteLength,
        metadata: { ...metadata, ocr: true, ocrEngine: 'tesseract', ocrPages: ocr.pages ?? 1 },
      }
    }
    if (ocr.error) metadata.ocrError = ocr.error
    return {
      text: `(image file: ${filename}, ${bytes.byteLength} bytes — text extraction requires OCR; AI scan may still classify from metadata)`,
      mime,
      size: bytes.byteLength,
      metadata,
    }
  }

  // ── Email / contacts / calendar / rtf ──
  if (ext === 'eml') {
    const raw = decodeUtf8(bytes)
    const { text, metadata: emlMeta } = emlToText(raw)
    return { text, mime, size: bytes.byteLength, metadata: { ...metadata, ...emlMeta } }
  }
  if (ext === 'vcf') {
    return { text: vcfToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'ics') {
    return { text: icsToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'rtf') {
    return { text: rtfToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }

  // ── Structured text formats ──
  // v3.6 fix: geojson/har are single JSON documents like .json — the old
  // code routed them to the NDJSON branch, mangling pretty-printed files
  // (every line failed JSON.parse and was pushed raw).
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl' || ext === 'geojson' || ext === 'har') {
    const jsonMode = ext === 'ndjson' || ext === 'jsonl' ? 'ndjson' : 'json'
    return { text: jsonToText(decodeUtf8(bytes), jsonMode), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'html' || ext === 'htm') {
    return { text: htmlToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'xml') {
    return { text: xmlToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'csv' || ext === 'tsv') {
    return { text: csvToText(decodeUtf8(bytes), ext), mime, size: bytes.byteLength, metadata }
  }
  if (ext === 'md' || ext === 'markdown') {
    return { text: mdToText(decodeUtf8(bytes)), mime, size: bytes.byteLength, metadata }
  }

  // ── Known textual extensions ──
  if (isTextExt(ext)) {
    return { text: decodeUtf8(bytes), mime, size: bytes.byteLength, metadata }
  }

  // ── Unknown extension: sniff printable content before giving up ──
  const ratio = printableRatio(bytes)
  if (ratio > 0.85 && bytes.byteLength >= 8) {
    // Looks textual (e.g. .dat/.srt/.unknown text exports) — decode as text.
    metadata.detectedAs = 'text-sniff'
    return { text: decodeUtf8(bytes), mime: 'text/plain', size: bytes.byteLength, metadata }
  }

  // ── Binary unknown ──
  metadata.detectedAs = 'binary'
  return {
    text: `(binary file, ${bytes.byteLength} bytes, no text extractor available for .${ext || 'unknown'} files)`,
    mime,
    size: bytes.byteLength,
    metadata,
  }
}

/** SHA-256 of a buffer, hex-encoded. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}
