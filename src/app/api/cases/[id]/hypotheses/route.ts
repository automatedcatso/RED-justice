/**
 * GET  /api/cases/[id]/hypotheses — list investigation hypotheses.
 * POST /api/cases/[id]/hypotheses — create a new hypothesis.
 *
 * Investigators can create hypotheses like:
 *   "Entity A may connect Communities 3 and 5."
 *
 * The system evaluates each hypothesis against available evidence and graph
 * metrics, showing supporting/contradicting evidence and a confidence score.
 *
 * Based on section 25 of the RED Justice research scope document.
 *
 * Hypotheses are stored in the InvestigatorNote table with a special
 * metadataJson structure to distinguish them from regular notes.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

interface Hypothesis {
  id: string
  title: string
  statement: string
  status: 'draft' | 'under_review' | 'supported' | 'contradicted' | 'inconclusive'
  supportingEvidence: string[]
  contradictingEvidence: string[]
  graphSupport: 'strong' | 'moderate' | 'weak' | 'none'
  temporalSupport: 'strong' | 'moderate' | 'weak' | 'none'
  confidence: number // 0-1
  createdAt: string
}

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

    // Hypotheses are stored as InvestigatorNotes with metadataJson.hypothesis = true
    const notes = await db.investigatorNote.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
    })

    const hypotheses: Hypothesis[] = []
    for (const n of notes) {
      try {
        const meta = JSON.parse(n.metadataJson ?? '{}')
        if (meta.hypothesis) {
          hypotheses.push({
            id: n.id,
            title: meta.title ?? 'Untitled hypothesis',
            statement: n.body,
            status: meta.status ?? 'draft',
            supportingEvidence: meta.supportingEvidence ?? [],
            contradictingEvidence: meta.contradictingEvidence ?? [],
            graphSupport: meta.graphSupport ?? 'none',
            temporalSupport: meta.temporalSupport ?? 'none',
            confidence: meta.confidence ?? 0,
            createdAt: n.createdAt.toISOString(),
          })
        }
      } catch {
        // skip non-JSON metadata
      }
    }

    return NextResponse.json({ hypotheses, total: hypotheses.length })
  } catch (err) {
    console.error('[api/cases/[id]/hypotheses GET] failed:', err)
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
    const { title, statement } = body as { title?: string; statement?: string }

    if (!statement || typeof statement !== 'string' || !statement.trim()) {
      return NextResponse.json({ error: 'statement is required' }, { status: 400 })
    }

    // Create the hypothesis as a special investigator note
    const note = await db.investigatorNote.create({
      data: {
        caseId,
        body: statement.trim(),
        metadataJson: JSON.stringify({
          hypothesis: true,
          title: title?.trim() || 'Untitled hypothesis',
          status: 'draft',
          supportingEvidence: [],
          contradictingEvidence: [],
          graphSupport: 'none',
          temporalSupport: 'none',
          confidence: 0,
        }),
      },
    })

    await logActivity(db, caseId, `Created hypothesis: ${title ?? 'Untitled'}`)

    return NextResponse.json({
      hypothesis: {
        id: note.id,
        title: title?.trim() || 'Untitled hypothesis',
        statement: statement.trim(),
        status: 'draft',
        supportingEvidence: [],
        contradictingEvidence: [],
        graphSupport: 'none',
        temporalSupport: 'none',
        confidence: 0,
        createdAt: note.createdAt.toISOString(),
      },
    }, { status: 201 })
  } catch (err) {
    console.error('[api/cases/[id]/hypotheses POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'create failed' },
      { status: 500 },
    )
  }
}
