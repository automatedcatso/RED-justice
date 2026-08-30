/**
 * GET /api/collisions?q=&types= — Cross-Case Identity Collision Explorer.
 * Scans ALL cases for reused identifiers (phones, accounts, devices, emails,
 * addresses…). This is an inherently cross-case endpoint: the caller (UI) is
 * expected to be an authorised investigator console.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { findCollisions } from '@/lib/investigation/collisions'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get('q') ?? undefined
    const typesParam = req.nextUrl.searchParams.get('types')
    const types = typesParam ? typesParam.split(',').map((t) => t.trim()).filter(Boolean) : undefined

    const report = await findCollisions(db, { q, types })
    return NextResponse.json({
      collisions: report.collisions.slice(0, 200),
      total: report.total,
      byType: report.byType,
      casesWithCollisions: report.casesWithCollisions,
      typesSearched: report.typesSearched,
      truncated: report.total > 200,
    })
  } catch (err) {
    console.error('[collisions GET] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
