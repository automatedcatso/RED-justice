/**
 * ocr.ts — Tesseract OCR bridge (offline).
 *
 * The user has tesseract installed; this module makes the app USE it instead
 * of parking images as "OCR required" stubs. Pipeline:
 *
 *   IMAGE (jpg/png/tif/bmp/webp/pnm)
 *     → temp file → `tesseract <file> stdout -l <langs>` → text
 *
 *   PDF with a weak / empty text layer (scanned document)
 *     → `pdftoppm -r 150 -png` renders pages → tesseract per page (capped)
 *     → text joined with page markers "─── OCR page N ───"
 *
 * Everything degrades gracefully: when binaries are missing we report
 * availability=false and callers keep their old placeholder behaviour.
 * Env knobs: TESSERACT_PATH, PDFTOPPM_PATH, OCR_LANGS (default "eng"),
 * OCR_MAX_PDF_PAGES (default 24), OCR_TIMEOUT_MS (default 90s/page-ish).
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface OcrAvailability {
  tesseract: boolean
  pdftoppm: boolean
  langs: string | null
  version: string | null
}

let availabilityCache: OcrAvailability | null = null

function binPath(envKey: string, fallback: string): string {
  const v = process.env[envKey]?.trim()
  if (v && existsSync(v)) return v
  return fallback
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: { code: number; out: string; err: string }) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ code: -1, out, err: err || 'timeout' })
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString()
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        finish({ code: -1, out, err: String(e.message ?? e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ code: code ?? -1, out, err })
      })
    } catch (e) {
      finish({ code: -1, out: '', err: String(e) })
    }
  })
}

/** Probe toolchain once per process (never throws). */
export async function getOcrAvailability(force = false): Promise<OcrAvailability> {
  if (!force && availabilityCache) return availabilityCache
  const res: OcrAvailability = { tesseract: false, pdftoppm: false, langs: null, version: null }

  const tess = binPath('TESSERACT_PATH', 'tesseract')
  const v = await runCapture(tess, ['--version'], 6_000)
  if (v.code === 0 || /tesseract\s+v?\d/i.test(v.out + v.err)) {
    res.tesseract = true
    const m = (v.err + v.out).match(/tesseract\s+v?(\d+[^\s]*)/i)
    res.version = m ? m[1] : 'unknown'
    const langs = await runCapture(tess, ['--list-langs'], 5_000)
    // v3.6 fix: use the FILTERED language list — the old code computed a
    // cleaned `lines` list, then threw it away (`void lines`) and used the
    // raw tail, which includes the boilerplate "eng"/"osd" entries and the
    // "List of available languages" header line.
    const lines = (langs.out + langs.err)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(List of available|.*tessdata\/|eng$|osd$)/i.test(l))
    res.langs = lines.length > 0 ? lines.join('+') : null
  }

  const pdfbin = binPath('PDFTOPPM_PATH', 'pdftoppm')
  const pv = await runCapture(pdfbin, ['-v'], 5_000)
  res.pdftoppm = pv.code === 0 || /pdftoppm/i.test(pv.err + pv.out)

  availabilityCache = res
  return res
}

export interface OcrResult {
  ok: boolean
  text: string
  engine: 'tesseract' | null
  pages?: number
  error?: string
}

/** OCR a single image buffer. */
export async function ocrImage(
  bytes: Uint8Array,
  ext: string,
): Promise<OcrResult> {
  const avail = await getOcrAvailability()
  if (!avail.tesseract) {
    return { ok: false, text: '', engine: null, error: 'tesseract not installed' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'rj-ocr-'))
  const timeoutMs = parseInt(process.env.OCR_TIMEOUT_MS ?? '0', 10) || 120_000
  try {
    const input = join(dir, `img.${ext.replace(/^\./, '') || 'png'}`)
    writeFileSync(input, bytes)
    const langs = process.env.OCR_LANGS?.trim() || avail.langs || 'eng'
    const r = await runCapture(
      binPath('TESSERACT_PATH', 'tesseract'),
      [input, 'stdout', '-l', langs],
      timeoutMs,
    )
    const text = r.out.trim()
    if (r.code !== 0 && !text) {
      return { ok: false, text: '', engine: 'tesseract', error: (r.err || `exit ${r.code}`).slice(0, 300) }
    }
    return { ok: true, text, engine: 'tesseract', pages: 1 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Weak-text-layer detector for scanned PDFs. */
export function isWeakPdfText(text: string): boolean {
  const t = text.trim()
  if (t.length < 40) return true
  // Garbled binary masquerading as text (decoded image/compressed object
  // streams): when most characters fall outside sane forensic-text inventory,
  // the layer is junk even though some letters exist.
  const benign = (
    t.match(/[A-Za-z0-9\s@.,:;()\\/|_\-–—_$₹€£%=+*#[\]?"'’“”•]/g) ?? []
  ).length
  if (benign / Math.max(1, t.length) < 0.72) return true
  const letters = (t.match(/[\p{L}]/gu) ?? []).length
  return letters / Math.max(1, t.length) < 0.3
}

/**
 * OCR a scanned PDF: rasterize ≤N pages via pdftoppm then tesseract each.
 */
export async function ocrPdf(bytes: Uint8Array): Promise<OcrResult> {
  const avail = await getOcrAvailability()
  if (!avail.tesseract) return { ok: false, text: '', engine: null, error: 'tesseract not installed' }
  if (!avail.pdftoppm) return { ok: false, text: '', engine: null, error: 'pdftoppm not installed (needed for scanned PDF rasterization)' }

  // Default covers typical annexure/charge-sheet PDFs end-to-end. The old
  // default of 8 silently TRUNCATED multi-page registers mid-table (rows on
  // later pages vanished from extraction entirely). Env stays overridable.
  const maxPages = Math.min(parseInt(process.env.OCR_MAX_PDF_PAGES ?? '0', 10) || 24, 40)
  const dpi = parseInt(process.env.OCR_DPI ?? '0', 10) || 150
  const timeoutPerPage = parseInt(process.env.OCR_TIMEOUT_MS ?? '0', 10) || 120_000

  const dir = mkdtempSync(join(tmpdir(), `rj-ocr-${randomUUID().slice(0, 6)}-`))
  try {
    const pdfPath = join(dir, 'doc.pdf')
    writeFileSync(pdfPath, bytes)

    const render = await runCapture(
      binPath('PDFTOPPM_PATH', 'pdftoppm'),
      ['-r', String(dpi), '-png', '-f', '1', '-l', String(maxPages), pdfPath, join(dir, 'page')],
      timeoutPerPage * 2,
    )
    if (render.code !== 0) {
      return { ok: false, text: '', engine: null, error: `pdftoppm failed: ${(render.err || `exit ${render.code}`).slice(0, 200)}` }
    }

    const pages = readdirSync(dir).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort()
    if (pages.length === 0) return { ok: false, text: '', engine: null, error: 'no pages rendered' }

    const langs = process.env.OCR_LANGS?.trim() || avail.langs || 'eng'
    const chunks: string[] = []
    for (const p of pages) {
      const pageNum = Number(p.match(/(\d+)\.png$/)?.[1] ?? chunks.length + 1)
      const r = await runCapture(
        binPath('TESSERACT_PATH', 'tesseract'),
        [join(dir, p), 'stdout', '-l', langs],
        timeoutPerPage,
      )
      const pageText = r.out.trim()
      if (pageText) chunks.push(`─── OCR page ${pageNum} ───\n${pageText}`)
    }
    if (chunks.length === 0) {
      return { ok: false, text: '', engine: 'tesseract', pages: pages.length, error: 'no text found on any page' }
    }
    return { ok: true, text: chunks.join('\n\n'), engine: 'tesseract', pages: pages.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
