/**
 * GET  /api/cases/[id]/notes — list investigator notes for a case.
 * POST /api/cases/[id]/notes — create a new note.
 *        Body: { body: string }
 * DELETE /api/cases/[id]/notes/[noteId] — delete a note.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    const notes = await db.investigatorNote.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ notes })
  } catch (err) {
    console.error('[api/cases/[id]/notes GET] failed:', err)
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
    const { body: noteBody } = body as { body?: string }
    if (!noteBody || typeof noteBody !== 'string' || !noteBody.trim()) {
      return NextResponse.json(
        { error: 'body is required' },
        { status: 400 },
      )
    }
    const note = await db.investigatorNote.create({
      data: { caseId, body: noteBody.trim() },
    })
    await logActivity(db, caseId, 'Added investigator note')
    return NextResponse.json({ note }, { status: 201 })
  } catch (err) {
    console.error('[api/cases/[id]/notes POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'create failed' },
      { status: 500 },
    )
  }
}
