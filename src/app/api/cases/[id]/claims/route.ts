/**
 * GET  /api/cases/[id]/claims — assemble the claim graph.
 * POST /api/cases/[id]/claims — investigator-authored claim.
 *      Body: { text, sources?: string[] (node ids), parentId? }
 *
 * Ladder: Evidence → Observation → Finding → Hypothesis → Claim → Report.
 * Unsupported claims are flagged so they can never silently become report facts.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { buildClaimGraph } from '@/lib/investigation/claims'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const graph = await buildClaimGraph(db, caseId)
    return NextResponse.json(graph)
  } catch (err) {
    console.error('[claims GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      text?: string
      sources?: string[]
      parentId?: string
    }
    if (!body.text || !body.text.trim()) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }

    const created = await db.claim.create({
      data: {
        caseId,
        level: 'claim',
        text: body.text.trim(),
        // A manual claim is 'supported' only when the investigator cites
        // sources; otherwise it starts unsupported by policy.
        status: body.sources && body.sources.length > 0 ? 'supported' : 'unsupported',
        sourcesJson: JSON.stringify(body.sources ?? []),
        parentId: body.parentId ?? null,
      },
    })

    await logActivity(db, caseId, `Claim recorded: ${created.text.slice(0, 80)}`)
    return NextResponse.json(
      {
        claim: {
          id: created.id,
          level: created.level,
          text: created.text,
          status: created.status,
          sources: body.sources ?? [],
          createdAt: created.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[claims POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
