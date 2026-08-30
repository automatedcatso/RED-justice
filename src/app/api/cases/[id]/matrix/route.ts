/**
 * GET /api/cases/[id]/matrix — Evidence Matrix (architecture §26).
 *
 * Claims/hypotheses/findings as columns × evidence files as rows:
 *
 *                  Claim 1  Claim 2  Claim 3
 *   EV-001            ✓        ?        ✗
 *   EV-002            ✓        -        ?
 *   EV-003            -        ✓        ✓
 *
 * Cell semantics (deterministic):
 *   supports    ✓  the file is cited as supporting that claim
 *   contradicts ✗  an open contradiction backed by this file touches it
 *   shared      ?  the file mentions identifiers of that claim but isn't cited
 *   none        -  no detected connection
 *
 * Query: ?maxCols=12&maxRows=40
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'of', 'to', 'in', 'on', 'with', 'that', 'this', 'may', 'might', 'be', 'connect', 'connected', 'same', 'person', 'entity', 'account'])

/** Parse a JSON column defensively; never throws, coerces objects/arrays safely. */
function safeParse(raw: string | null | undefined): unknown {
  if (!raw) return []
  try { return JSON.parse(raw) as unknown } catch { return raw }
}

/** Coerce any parsed JSON into a clean string array (strings/objects/other ignored). */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !STOP.has(t)),
    ),
  ).slice(0, 10)
}

export type MatrixCell = 'supports' | 'contradicts' | 'shared' | 'none'

interface MatrixColumn {
  id: string
  kind: 'hypothesis' | 'finding' | 'claim'
  label: string
  status: string
  sufficiency?: number | null
}

interface MatrixRow {
  evidenceId: string
  evRef: string // EV-001-style display ref
  name: string
  classification: string | null
}

export async function GET(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const url = new URL(req.url)
    const maxCols = Math.min(Number(url.searchParams.get('maxCols') ?? 12) || 12, 24)
    const maxRows = Math.min(Number(url.searchParams.get('maxRows') ?? 40) || 40, 100)

    const [notes, findings, evidenceRows] = await Promise.all([
      db.investigatorNote.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' } }),
      db.finding.findMany({ where: { caseId }, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }] }),
      db.evidence.findMany({
        where: { caseId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, originalName: true, classification: true },
      }),
    ])

    // ── Columns: hypotheses first, then findings, then manual claims ─────────
    const columns: MatrixColumn[] = []

    interface HypoMeta {
      title?: string
      status?: string
      supportingEvidence?: string[]
      confidence?: number
    }
    const hypSupportByCol = new Map<string, Set<string>>()
    const hypTokensByCol = new Map<string, string[]>()

    for (const n of notes) {
      let meta: Record<string, unknown> = {}
      try { meta = JSON.parse(n.metadataJson ?? '{}') as Record<string, unknown> } catch { /* ignore */ }
      if (!meta.hypothesis) continue
      if (columns.length >= maxCols) break
      const hm = meta as unknown as HypoMeta
      columns.push({
        id: n.id,
        kind: 'hypothesis',
        label: String(meta.title ?? n.body.slice(0, 60)),
        status: String(meta.status ?? 'unresolved'),
        sufficiency: typeof hm.confidence === 'number' ? Math.round(hm.confidence * 100) : null,
      })
      hypSupportByCol.set(n.id, new Set(asStringArray(hm.supportingEvidence)))
      hypTokensByCol.set(n.id, tokenize(`${String(meta.title ?? '')} ${n.body}`))
    }

    const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
    const findSupportByCol = new Map<string, Set<string>>()
    for (const f of findings) {
      if (columns.length >= maxCols) break
      columns.push({
        id: f.id,
        kind: 'finding',
        label: `${f.type}: ${f.description.slice(0, 60)}`,
        status: f.decision ?? f.reviewStatus,
        sufficiency: null,
      })
      findSupportByCol.set(f.id, new Set(asStringArray(safeParse(f.supportingEvidence))))
    }

    // Manual claims last (they carry sourcesJson of node refs).
    const manualClaims = await db.claim.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' } })
    const claimSupportByCol = new Map<string, Set<string>>()
    for (const c of manualClaims) {
      if (columns.length >= maxCols) break
      columns.push({
        id: c.id,
        kind: 'claim',
        label: c.text.slice(0, 70),
        status: c.status,
        sufficiency: null,
      })
      claimSupportByCol.set(c.id, new Set(asStringArray(safeParse(c.sourcesJson)).map((x) => String(x))))
    }

    if (columns.length === 0 || evidenceRows.length === 0) {
      return NextResponse.json({
        columns,
        rows: [],
        cells: {},
        legend: {
          supports: 'file cited as supporting the claim',
          contradicts: 'open contradiction backed by this file',
          shared: 'identifiers overlap — unconfirmed',
          none: 'no detected connection',
        },
        empty: true,
      })
    }

    // ── Rows: EV-xxx display refs by ingest order ────────────────────────────
    const evIndex = new Map(evidenceRows.map((e, i) => [e.id, `EV-${String(i + 1).padStart(3, '0')}`]))
    const rows: MatrixRow[] = [...evidenceRows]
      .reverse() // newest first in display
      .slice(0, maxRows)
      .map((e) => ({
        evidenceId: e.id,
        evRef: evIndex.get(e.id) ?? e.id.slice(0, 6),
        name: e.originalName,
        classification: e.classification,
      }))
    const rowIds = new Set(rows.map((r) => r.evidenceId))

    // ── Open contradictions indexed by evidence + subject ────────────────────
    const contradictions = await db.contradiction.findMany({
      where: { caseId, status: { not: 'resolved' } },
      select: { subjectAId: true, subjectBId: true, subjectARef: true, subjectBRef: true, evidenceIdsJson: true, description: true },
    })
    const contraEvidence = new Set<string>()
    const contraSubjects = new Set<string>()
    const contraTokens = new Set<string>()
    for (const c of contradictions) {
      for (const x of asStringArray(safeParse(c.evidenceIdsJson))) contraEvidence.add(String(x))
      for (const s of [c.subjectAId, c.subjectBId, c.subjectARef, c.subjectBRef]) if (s) contraSubjects.add(s)
      for (const t of tokenize(c.description)) contraTokens.add(t)
    }

    // ── Cells ────────────────────────────────────────────────────────────────
    const cellValue = async (rowId: string, colIdx: number): Promise<MatrixCell> => {
      const col = columns[colIdx]

      // Contradiction beats support visually only when NOT explicitly cited as
      // support — cited-support wins because the investigator relied on it.
      const explicit =
        (col.kind === 'hypothesis' && hypSupportByCol.get(col.id)?.has(rowId)) ||
        (col.kind === 'finding' && findSupportByCol.get(col.id)?.has(rowId))

      if (explicit) return 'supports'

      // Manual-claim sources may reference evidence ids directly or node ids.
      if (col.kind === 'claim') {
        const srcs = claimSupportByCol.get(col.id)
        if (srcs?.has(rowId) || srcs?.has(`ev-${rowId}`)) return 'supports'
      }

      // Contradiction: open contradiction cites this file AND touches this column.
      if (contraEvidence.has(rowId)) {
        if (col.kind === 'finding' && contraSubjects.has(col.id)) return 'contradicts'
        if (col.kind === 'hypothesis') {
          const toks = hypTokensByCol.get(col.id) ?? []
          if (toks.some((t) => contraTokens.has(t))) return 'contradicts'
          if (contraSubjects.has(col.id)) return 'contradicts'
        }
      }

      // Shared identifiers: hypothesis tokens appear in the file's content?
      if (col.kind === 'hypothesis') {
        const toks = hypTokensByCol.get(col.id) ?? []
        if (toks.length > 0) {
          const hit = await db.evidence.findFirst({
            where: { id: rowId, OR: toks.flatMap((t) => [{ content: { contains: t } }, { originalName: { contains: t } }]) },
            select: { id: true },
          })
          if (hit) return 'shared'
        }
      }

      return 'none'
    }

    const cells: Record<string, MatrixCell> = {}
    for (let ci = 0; ci < columns.length; ci++) {
      for (const r of rows) {
        cells[`${r.evidenceId}|${columns[ci].id}`] = await cellValue(r.evidenceId, ci)
      }
    }

    const counts = {
      supports: Object.values(cells).filter((v) => v === 'supports').length,
      contradicts: Object.values(cells).filter((v) => v === 'contradicts').length,
      shared: Object.values(cells).filter((v) => v === 'shared').length,
    }

    return NextResponse.json({
      columns,
      rows,
      cells,
      counts,
      legend: {
        supports: 'file cited as supporting the claim',
        contradicts: 'open contradiction backed by this file',
        shared: 'identifiers overlap — unconfirmed',
        none: 'no detected connection',
      },
      truncatedColumns: columns.length >= maxCols,
      empty: false,
    })
  } catch (err) {
    console.error('[matrix GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'matrix failed' },
      { status: 500 },
    )
  }
}
