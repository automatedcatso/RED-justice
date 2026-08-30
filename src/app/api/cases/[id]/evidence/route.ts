/**
 * GET  /api/cases/[id]/evidence — list evidence for a case.
 * POST /api/cases/[id]/evidence — ingest new evidence (paste-text JSON body).
 *
 * POST body: { originalName, content, source?, description?, mime? }
 * The full ingest pipeline lives in src/lib/api/ingest.ts (shared with the
 * multipart file upload route).
 *
 * v3.0: after ingest, the FULLY-AI analysis is queued AUTOMATICALLY —
 * no manual scan click needed. The response carries aiScanStatus so the UI
 * can immediately show the live AI progress for the new file.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { ingestExtractedText } from '@/lib/api/ingest'
import { queueAiScan } from '@/lib/investigation/aiScan'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const q = sp.get('q') ?? undefined

    const where: {
      caseId: string
      status?: string
      OR?: Array<Record<string, unknown>>
    } = { caseId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { originalName: { contains: q } },
        { description: { contains: q } },
        { content: { contains: q } },
      ]
    }

    const evidenceRows = await db.evidence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            entityLinks: true,
            transactions: true,
            communications: true,
            timelineEvents: true,
            evidenceStages: true,
          },
        },
      },
    })

    // v3.7.1 LIST SLIMMING: the evidence list is polled every 4s while scans
    // run, and big files (300K-char bank trails, 4K-entity manifests inside
    // intelJson) used to ship ~1.5MB PER POLL — starving the write-heavy scan
    // pipeline and freezing the UI ("offline mode is broken"). The list now
    // carries a content preview + a trimmed aiScan digest; the per-file detail
    // endpoint still returns everything verbatim.
    const CONTENT_PREVIEW_CHARS = 20_000
    const LIST_ENTITY_CAP = 300
    const slim = evidenceRows.map((e) => {
      const next: Record<string, unknown> = { ...e }
      if (e.content && e.content.length > CONTENT_PREVIEW_CHARS) {
        next.content =
          e.content.slice(0, CONTENT_PREVIEW_CHARS) +
          `\n\n… (preview truncated for the list view — ${e.content.length.toLocaleString()} chars total; open the file for the full text)`
      }
      if (e.intelJson && e.intelJson.length > 60_000) {
        try {
          const intel = JSON.parse(e.intelJson) as Record<string, unknown>
          const scan = intel.aiScan as { entities?: unknown[] } | undefined
          if (Array.isArray(scan?.entities) && scan.entities.length > LIST_ENTITY_CAP) {
            next.intelJson = JSON.stringify({
              ...intel,
              aiScan: {
                ...scan,
                entities: scan.entities.slice(0, LIST_ENTITY_CAP),
                entitiesTruncated: true,
                entitiesTotal: scan.entities.length,
              },
            })
          }
        } catch {
          /* unparseable intel passes through untouched */
        }
      }
      return next
    })
    return NextResponse.json({ evidence: slim })
  } catch (err) {
    console.error('[api/cases/[id]/evidence GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'list failed' },
      { status: 500 },
    )
  }
}

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

    const body = await req.json().catch(() => ({}))
    const {
      originalName,
      content,
      source,
      description,
      mime,
    } = body as {
      originalName?: string
      content?: string
      source?: string
      description?: string
      mime?: string
    }

    if (!originalName || typeof originalName !== 'string') {
      return NextResponse.json(
        { error: 'originalName is required' },
        { status: 400 },
      )
    }
    if (typeof content !== 'string') {
      return NextResponse.json(
        { error: 'content (string) is required' },
        { status: 400 },
      )
    }

    // Shared ingest pipeline (see src/lib/api/ingest.ts).
    const result = await ingestExtractedText(db, caseId, {
      originalName,
      content,
      mime,
      source,
      description,
      provenance: 'api-upload',
    })

    // ── AUTOMATIC AI ANALYSIS (v3.0) — same as file uploads ──
    let aiScanStatus: string | null = null
    if (!result.dedup) {
      const evId = (result.evidence as { id?: string }).id
      if (evId) {
        try {
          queueAiScan(db, caseId, evId, { trigger: 'auto-paste' })
          aiScanStatus = 'queued'
        } catch (err) {
          console.error('[evidence POST] auto AI scan queue failed:', err)
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
    console.error('[api/cases/[id]/evidence POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ingest failed' },
      { status: 500 },
    )
  }
}
