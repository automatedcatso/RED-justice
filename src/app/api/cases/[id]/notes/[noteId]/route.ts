/**
 * DELETE /api/cases/[id]/notes/[noteId] — delete an investigator note.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; noteId: string }> }

export async function DELETE(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, noteId } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }
    const note = await db.investigatorNote.findFirst({
      where: { id: noteId, caseId },
    })
    if (!note) {
      return NextResponse.json({ error: 'note not found' }, { status: 404 })
    }
    await db.investigatorNote.delete({ where: { id: noteId } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/cases/[id]/notes/[noteId] DELETE] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'delete failed' },
      { status: 500 },
    )
  }
}
