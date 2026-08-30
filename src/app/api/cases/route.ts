/**
 * GET  /api/cases          — list cases (with optional ?status=&q= filters).
 * POST /api/cases          — create a new case (auto-generates uid RED-YYYY-NNN).
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const status = sp.get('status') ?? undefined
    const q = sp.get('q') ?? undefined

    const where: { status?: string; OR?: Array<Record<string, unknown>> } = {}
    if (status) where.status = status
    if (q) {
      where.OR = [
        { title: { contains: q } },
        { description: { contains: q } },
        { uid: { contains: q } },
      ]
    }

    const cases = await db.case.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            evidence: true,
            entities: true,
            transactions: true,
            findings: true,
          },
        },
      },
    })
    return NextResponse.json({ cases })
  } catch (err) {
    console.error('[api/cases GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'list failed' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const {
      title,
      description,
      classification,
      aiMode,
      investigators,
      tags,
    } = body as {
      title?: string
      description?: string
      classification?: string
      aiMode?: string
      investigators?: string[]
      tags?: string[]
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json(
        { error: 'title is required' },
        { status: 400 },
      )
    }

    // Generate uid RED-YYYY-NNN based on existing count for the year.
    const year = new Date().getFullYear()
    const prefix = `RED-${year}-`
    const existing = await db.case.findMany({
      where: { uid: { startsWith: prefix } },
      select: { uid: true },
    })
    let maxN = 0
    for (const c of existing) {
      const m = c.uid.match(new RegExp(`^${prefix}(\\d+)$`))
      if (m) {
        const n = parseInt(m[1], 10)
        if (Number.isFinite(n) && n > maxN) maxN = n
      }
    }
    const uid = `${prefix}${String(maxN + 1).padStart(3, '0')}`

    const created = await db.case.create({
      data: {
        uid,
        title: title.trim(),
        description: description ?? null,
        classification: classification ?? 'unclassified',
        aiMode: aiMode ?? 'standard',
        investigators: investigators
          ? JSON.stringify(investigators)
          : null,
        tags: tags ? JSON.stringify(tags) : null,
        status: 'open',
      },
    })

    await logActivity(db, created.id, `Case ${uid} created`)

    return NextResponse.json({ case: created }, { status: 201 })
  } catch (err) {
    console.error('[api/cases POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'create failed' },
      { status: 500 },
    )
  }
}
