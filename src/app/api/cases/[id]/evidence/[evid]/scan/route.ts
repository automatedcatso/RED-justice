/**
 * POST /api/cases/[id]/evidence/[evid]/scan — AI Scan route.
 *
 * v3.0 — thin wrapper over the shared Fully-AI engine
 * (`src/lib/investigation/aiScan.ts`). The same engine runs AUTOMATICALLY
 * right after every upload (`queueAiScan`); this manual route is the
 * explicit "re-scan / retry" entry point for the UI button.
 *
 * AI-ONLY contract: entities and connections come from the local AI alone.
 * When the AI is unreachable the scan records aiScanStatus='failed' (with
 * the error surfaced to the UI) and wires NOTHING — there is no
 * deterministic fallback entity dump anymore.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { runAiScanForEvidence } from '@/lib/investigation/aiScan'

export const dynamic = 'force-dynamic'
// Large documents may be scanned in multiple map-reduce passes.
export const maxDuration = 300

type Params = { params: Promise<{ id: string; evid: string }> }

export async function POST(
  _req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const evidence = await db.evidence.findFirst({
      where: { id: evid, caseId },
      select: { id: true },
    })
    if (!evidence) {
      return NextResponse.json({ error: 'evidence not found' }, { status: 404 })
    }

    try {
      const r = await runAiScanForEvidence(db, caseId, evid, { trigger: 'manual rescan' })
      return NextResponse.json({
        scan: r.scan,
        evidenceId: evid,
        graph: r.graph,
        crossLinks: r.crossLinks
          ? {
              mergeEvents: r.crossLinks.mergeEvents,
              aliasLinks: r.crossLinks.aliasLinks,
              accepted: r.crossLinks.accepted,
              rejected: r.crossLinks.rejected,
              links: r.crossLinks.links,
              caseInterpretation: r.crossLinks.caseInterpretation,
              newLeads: r.crossLinks.newLeads,
            }
          : undefined,
      })
    } catch (err) {
      // AI-only: failures are a first-class, user-visible outcome.
      const msg = err instanceof Error ? err.message : 'scan failed'
      return NextResponse.json(
        {
          error: msg,
          aiScanStatus: 'failed',
          hint: 'The local AI could not analyze this file. Check that the AI server is running, then press Retry AI scan. No deterministic entities were created (AI-only mode).',
        },
        { status: 502 },
      )
    }
  } catch (err) {
    console.error('[api/cases/[id]/evidence/[evid]/scan POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'scan failed' },
      { status: 500 },
    )
  }
}
