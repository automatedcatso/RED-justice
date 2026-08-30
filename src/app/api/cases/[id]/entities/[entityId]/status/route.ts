/**
 * POST /api/cases/[id]/entities/[entityId]/status — v3.9 human review gate.
 *
 * Master prompt §4: candidate entities must remain accessible for HUMAN
 * REVIEW. This endpoint is that surface: an investigator promotes a candidate
 * to confirmed (or demotes a confirmed entity back to candidate) after
 * inspecting the evidence. The graph API surfaces confirmed entities by
 * default; promoted entities therefore appear on the canonical graph.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; entityId: string }> }

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, entityId } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const body = (await req.json().catch(() => ({}))) as { status?: unknown; note?: unknown }
    const status = String(body.status ?? '').toLowerCase()
    if (status !== 'confirmed' && status !== 'candidate') {
      return NextResponse.json(
        { error: 'status must be "confirmed" or "candidate"' },
        { status: 400 },
      )
    }

    const existing = await db.entity.findFirst({
      where: { id: entityId, caseId },
      select: { id: true, status: true, metadataJson: true, value: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'entity not found' }, { status: 404 })
    }
    if (existing.status === status) {
      return NextResponse.json({ ok: true, status, unchanged: true })
    }

    // Preserve the review trail in metadata (append-only note, capped).
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(existing.metadataJson ?? '{}') as Record<string, unknown>
    } catch { /* ignore malformed */ }
    const history = Array.isArray(meta.reviewHistory) ? (meta.reviewHistory as unknown[]) : []
    history.push({
      at: new Date().toISOString(),
      from: existing.status,
      to: status,
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim().slice(0, 200) } : {}),
      actor: 'human-review',
    })
    meta.reviewHistory = history.slice(-10)

    await db.entity.update({
      where: { id: existing.id },
      data: { status, metadataJson: JSON.stringify(meta) },
    })

    console.log(
      `[entity-status] ${existing.value.slice(0, 50)}: ${existing.status} → ${status} (human review)`,
    )
    return NextResponse.json({ ok: true, status })
  } catch (err) {
    console.error('[api/cases/[id]/entities/[entityId]/status POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'status update failed' },
      { status: 500 },
    )
  }
}
