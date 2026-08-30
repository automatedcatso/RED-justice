/**
 * GET /api/jobs — list recent ProcessingJob rows (last 50).
 */
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const jobs = await db.processingJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        case: {
          select: { id: true, uid: true, title: true },
        },
      },
    })
    return NextResponse.json({ jobs, total: jobs.length })
  } catch (err) {
    console.error('[api/jobs GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'jobs failed' },
      { status: 500 },
    )
  }
}
