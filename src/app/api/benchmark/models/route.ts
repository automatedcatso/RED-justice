/**
 * GET /api/benchmark/models — list benchmarkable models + provider status.
 */
import { NextResponse } from 'next/server'
import { listBenchmarkModels } from '@/lib/benchmark/runner'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const listing = await listBenchmarkModels()
    return NextResponse.json(listing)
  } catch (err) {
    console.error('[api/benchmark/models GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list models' },
      { status: 500 },
    )
  }
}
