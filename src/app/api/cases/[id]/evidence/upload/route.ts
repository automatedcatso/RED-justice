/**
 * POST /api/cases/[id]/evidence/upload — multipart file upload.
 *
 * Body: FormData with a `file` field (any format the fileParser supports:
 * txt/md/csv/json/xml/eml/docx/xlsx/pptx/pdf/zip/vcf/ics/rtf/images… plus
 * OCR fallback for scanned documents) and optional `source` /
 * `description` text fields.
 *
 * Pipeline: parseFile → text (+ metadata) → shared ingestExtractedText
 * (SHA-256 dedup, provenance, chain of custody, structured record tables,
 * timeline) → queueAiScan (FULLY-AI analysis runs AUTOMATICALLY — entities,
 * story and explained connections are authored by the AI only).
 *
 * Response mirrors the paste-text POST /evidence route:
 *   { evidence, dedup?, extraction, aiScanStatus, aiScanAuto: true }
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { ingestExtractedText } from '@/lib/api/ingest'
import { parseFile } from '@/lib/extractors/fileParser'
import { queueAiScan } from '@/lib/investigation/aiScan'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** Upload ceiling — matches what a local single-node deployment can parse. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json(
        { error: 'multipart/form-data body with a "file" field is required' },
        { status: 400 },
      )
    }

    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'file is required (multipart field "file")' },
        { status: 400 },
      )
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` },
        { status: 413 },
      )
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'file is empty' }, { status: 400 })
    }

    const sourceField = form.get('source')
    const descriptionField = form.get('description')
    const source = typeof sourceField === 'string' && sourceField.trim() ? sourceField.trim() : 'file-upload'
    const description =
      typeof descriptionField === 'string' && descriptionField.trim() ? descriptionField.trim() : undefined

    // ── Parse the file into plain text (+ per-format metadata) ──
    const bytes = new Uint8Array(await file.arrayBuffer())
    let parsed: Awaited<ReturnType<typeof parseFile>>
    try {
      parsed = await parseFile(file.name, bytes)
    } catch (err) {
      console.error('[api/cases/[id]/evidence/upload] parseFile failed:', err)
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? `could not parse "${file.name}": ${err.message}`
              : `could not parse "${file.name}"`,
        },
        { status: 422 },
      )
    }

    // ── Shared ingest pipeline (dedup → persist → records → custody) ──
    const result = await ingestExtractedText(db, caseId, {
      originalName: file.name,
      content: parsed.text,
      mime: parsed.mime || file.type || 'application/octet-stream',
      size: file.size,
      source,
      description,
      provenance: 'file-upload',
    })

    // Merge the parser's metadata (pages, OCR info, archive members…) into
    // the evidence row so the provenance panel can cite it.
    if (!result.dedup) {
      const evId = (result.evidence as { id?: string }).id
      if (evId && parsed.metadata && Object.keys(parsed.metadata).length > 0) {
        await db.evidence
          .update({
            where: { id: evId },
            data: {
              metadataJson: JSON.stringify({
                uploadedAt: new Date().toISOString(),
                originalMime: file.type || null,
                parser: parsed.metadata,
              }),
              // v3.6 fix: persist the parser's ACTUAL OCR outcome — images
              // that were OCR'd at upload kept ocrStatus 'n/a', hiding the
              // OCR provenance (the scan pass then had nothing to preserve).
              ...(parsed.metadata.ocr === true
                ? { ocrStatus: 'ocr-complete' }
                : parsed.metadata.ocrRequired === true
                  ? { ocrStatus: 'ocr-failed' }
                  : {}),
            },
          })
          .catch(() => {
            /* metadata is best-effort */
          })
      }
    }

    // ── AUTOMATIC AI ANALYSIS (v3.0) — identical to the paste-text route ──
    let aiScanStatus: string | null = null
    if (!result.dedup) {
      const evId = (result.evidence as { id?: string }).id
      if (evId) {
        try {
          queueAiScan(db, caseId, evId, { trigger: 'auto-upload' })
          aiScanStatus = 'queued'
        } catch (err) {
          console.error('[evidence upload POST] auto AI scan queue failed:', err)
        }
      }
    } else {
      aiScanStatus = (result.evidence as { aiScanStatus?: string | null }).aiScanStatus ?? null
    }

    return NextResponse.json(
      {
        evidence: result.evidence,
        dedup: result.dedup || undefined,
        extraction: result.dedup
          ? { skipped: true, reason: 'duplicate-sha256' }
          : result.extraction,
        aiScanStatus,
        aiScanAuto: true,
      },
      { status: result.dedup ? 200 : 201 },
    )
  } catch (err) {
    console.error('[api/cases/[id]/evidence/upload POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'upload failed' },
      { status: 500 },
    )
  }
}
