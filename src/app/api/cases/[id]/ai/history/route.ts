/**
 * GET /api/cases/[id]/ai/history — list AiChat messages for the case (newest 50).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'

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

    const messages = await db.aiChat.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    const result = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      citations: (() => {
        try {
          return JSON.parse(m.citations ?? '[]')
        } catch {
          return []
        }
      })(),
      metadata: (() => {
        try {
          return JSON.parse(m.metadataJson ?? '{}')
        } catch {
          return {}
        }
      })(),
      createdAt: m.createdAt,
    }))

    // Reverse to oldest-first for chat display.
    result.reverse()

    return NextResponse.json({ messages: result, total: result.length })
  } catch (err) {
    console.error('[api/cases/[id]/ai/history GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'history failed' },
      { status: 500 },
    )
  }
}
