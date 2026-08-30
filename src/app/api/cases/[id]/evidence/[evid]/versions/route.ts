/**
 * GET /api/cases/[id]/evidence/[evid]/versions — immutable version chain.
 * POST (multipart: `file`, optional `note`, optional `actor`).
 *
 * Architecture §2 — Evidence Fabric immutability:
 *   NEVER silently overwrite evidence. A re-submitted document becomes
 *   EV-xxx:v(n+1) and SUPERSEDES :v(n). Every version keeps its own sha256,
 *   size, note and custody event. v1 is lazily materialised from the current
 *   content on the first supersede so full history always exists.
 *
 * After a supersede the derived intelligence (intelJson / classification) is
 * marked stale (extractionStatus=pending) so investigators know the file must
 * be re-scanned; prior observations stay intact in EntityObservation.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { recordDecision } from '@/lib/investigation/decisions'
import { parseFile } from '@/lib/extractors/fileParser'
import { sha256Hex } from '@/lib/extractors'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Params = { params: Promise<{ id: string; evid: string }> }

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const evidence = await db.evidence.findFirst({ where: { id: evid, caseId } })
    if (!evidence) return NextResponse.json({ error: 'evidence not found' }, { status: 404 })

    const versions = await db.evidenceVersion.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { version: 'asc' },
    })

    // Display refs: case-relative EV numbering by ingest order.
    const siblings = await db.evidence.findMany({
      where: { caseId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    const evNo = siblings.findIndex((s) => s.id === evidence.id) + 1
    const evRef = `EV-${String(evNo || 1).padStart(3, '0')}`

    return NextResponse.json({
      evRef,
      evidence: {
        id: evidence.id,
        originalName: evidence.originalName,
        sha256: evidence.sha256,
        updatedAt: evidence.updatedAt,
      },
      versions: versions.map((v) => ({
        ...v,
        ref: `${evRef}:v${v.version}`,
        current: v.sha256 === evidence.sha256,
      })),
    })
  } catch (err) {
    console.error('[versions GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const evidence = await db.evidence.findFirst({ where: { id: evid, caseId } })
    if (!evidence) return NextResponse.json({ error: 'evidence not found' }, { status: 404 })

    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'expected multipart/form-data with a "file" field' }, { status: 400 })
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'missing "file" field' }, { status: 400 })
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: `file too large (${(file.size / 1024 / 1024).toFixed(1)} MB > 25 MB limit)` }, { status: 413 })
    }
    const note = String(form.get('note') ?? '').slice(0, 1000) || null
    const actor = String(form.get('actor') ?? '').trim() || 'investigator'

    const originalName = file.name || evidence.originalName
    const bytes = new Uint8Array(await file.arrayBuffer())

    let text: string
    let mime: string
    try {
      const parsed = await parseFile(originalName, bytes)
      text = parsed.text
      mime = parsed.mime
    } catch (err) {
      text = `[BINARY FILE — automatic text extraction failed for ${originalName}. Manual review / OCR required.]`
      mime = 'application/octet-stream'
      void err
    }

    const newSha = sha256Hex(text)

    // Nothing changed? Refuse politely — no empty supersessions.
    if (newSha === evidence.sha256) {
      return NextResponse.json(
        { error: 'submitted file is byte-identical to the current version — nothing to supersede', currentSha256: newSha },
        { status: 409 },
      )
    }

    const existingVersions = await db.evidenceVersion.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { version: 'desc' },
      take: 1,
    })

    // Lazily materialise v1 from the pre-supersede content so history is complete.
    let prev = existingVersions[0] ?? null
    let prevId: string | null = prev?.id ?? null
    if (!prev) {
      prev = await db.evidenceVersion.create({
        data: {
          evidenceId: evidence.id,
          version: 1,
          sha256: evidence.sha256,
          storedPath: evidence.storedPath,
          size: evidence.size,
          note: 'v1 backfilled at first supersede (original ingest)',
          createdBy: 'system',
          supersedesId: null,
        },
      })
      prevId = prev.id
    }

    const created = await db.evidenceVersion.create({
      data: {
        evidenceId: evidence.id,
        version: prev.version + 1,
        sha256: newSha,
        size: bytes.byteLength,
        note,
        createdBy: actor,
        supersedesId: prevId,
      },
    })

    // Point the canonical row at the newest version's content.
    await db.evidence.update({
      where: { id: evidence.id },
      data: {
        originalName,
        sha256: newSha,
        size: bytes.byteLength,
        mime: mime ?? evidence.mime,
        content: text.slice(0, 4_000_000),
        extractionStatus: 'pending',
        // Derived AI analysis is stale for the new content.
        intelJson: null,
      },
    })

    await db.chainOfCustody.create({
      data: {
        evidenceId: evidence.id,
        action: `superseded_by_version:v${created.version}`,
        sha256: newSha,
        actor,
      },
    })

    await logActivity(
      db,
      caseId,
      `Evidence "${originalName}" superseded → :v${created.version} (sha256 ${newSha.slice(0, 12)}…); re-scan required`,
    )

    await recordDecision(db, {
      caseId,
      action: 'supersede_evidence',
      objectType: 'evidence',
      objectRef: evidence.id,
      objectLabel: originalName,
      beforeState: `sha256:${evidence.sha256.slice(0, 12)}…`,
      afterState: `sha256:${newSha.slice(0, 12)}…`,
      reason: note,
      actor,
      metadata: { version: created.version },
    })

    return NextResponse.json({
      ok: true,
      version: created.version,
      ref: `EV:v${created.version}`,
      supersedes: prev.version,
      reScanRequired: true,
    })
  } catch (err) {
    console.error('[versions POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
