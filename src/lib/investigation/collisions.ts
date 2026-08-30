/**
 * collisions.ts — Cross-Case Identity Collision Explorer.
 *
 * Searches ALL authorized cases for reused identifiers — phones, accounts,
 * UPI VPAs, emails, devices, IMEIs, addresses, URLs — and reports where the
 * same identity artifact appears in more than one case.
 *
 * The unit of collision is (type, norm): if the same normalised phone number
 * appears in Case A and Case B, that's a collision worth investigating
 * (common suspect, shared mule account, recycled device…).
 */

import type { PrismaClient } from '@prisma/client'
import { CLASS_LABELS } from '@/lib/extractors/classify'

export interface CollisionCaseRef {
  caseId: string
  caseUid: string
  caseTitle: string
  entityIds: string[]
  values: string[]
  evidenceNames: string[]
}

export interface Collision {
  type: string
  norm: string
  displayValue: string
  caseCount: number
  occurrences: number
  cases: CollisionCaseRef[]
}

export interface CollisionReport {
  collisions: Collision[]
  total: number
  byType: Record<string, number>
  casesWithCollisions: number
  typesSearched: string[]
}

/** Identifier types that are meaningful when reused across cases. */
const COLLISION_TYPES = [
  'phone', 'account', 'upi', 'email', 'device', 'imei', 'wallet', 'url',
  'domain', 'address', 'ifsc', 'document_id', 'social', 'mac', 'vehicle',
]

export async function findCollisions(
  db: PrismaClient,
  opts: { q?: string; types?: string[] } = {},
): Promise<CollisionReport> {
  const types = (opts.types && opts.types.length > 0 ? opts.types : COLLISION_TYPES).filter((t) =>
    COLLISION_TYPES.includes(t),
  )
  const where: { type: { in: string[] }; value?: { contains: string } } = {
    type: { in: types },
  }
  if (opts.q && opts.q.trim()) where.value = { contains: opts.q.trim() }

  const rows = await db.entity.findMany({
    where,
    select: {
      id: true,
      caseId: true,
      type: true,
      value: true,
      norm: true,
      links: { select: { evidence: { select: { originalName: true } } } },
    },
  })

  // Pull case metadata.
  const cases = await db.case.findMany({
    select: { id: true, uid: true, title: true },
  })
  const caseById = new Map(cases.map((c) => [c.id, c]))

  // Group by (type, norm) → per-case refs.
  const grouped = new Map<string, Map<string, CollisionCaseRef & { occurrences: number }>>()
  for (const r of rows) {
    if (!r.norm || r.norm.length < 4) continue
    const key = `${r.type}|${r.norm}`
    const perCase = grouped.get(key) ?? new Map()
    const ref = perCase.get(r.caseId) ?? {
      caseId: r.caseId,
      caseUid: caseById.get(r.caseId)?.uid ?? '',
      caseTitle: caseById.get(r.caseId)?.title ?? 'unknown case',
      entityIds: [],
      values: [],
      evidenceNames: [],
      occurrences: 0,
    }
    ref.entityIds.push(r.id)
    if (!ref.values.includes(r.value)) ref.values.push(r.value)
    for (const l of r.links.slice(0, 5)) {
      if (!ref.evidenceNames.includes(l.evidence.originalName)) ref.evidenceNames.push(l.evidence.originalName)
    }
    ref.occurrences++
    perCase.set(r.caseId, ref)
    grouped.set(key, perCase)
  }

  const collisions: Collision[] = []
  for (const [key, perCase] of grouped) {
    if (perCase.size < 2) continue
    const [type, norm] = key.split('|')
    const refs = Array.from(perCase.values()).map(({ occurrences, ...rest }) => ({
      ...rest,
      occurrences,
    }))
    collisions.push({
      type,
      norm,
      displayValue: refs[0]?.values[0] ?? norm,
      caseCount: perCase.size,
      occurrences: refs.reduce((a, r) => a + r.occurrences, 0),
      cases: refs,
    })
  }

  collisions.sort(
    (a, b) => b.caseCount - a.caseCount || b.occurrences - a.occurrences,
  )

  const byType: Record<string, number> = {}
  for (const c of collisions) byType[c.type] = (byType[c.type] ?? 0) + 1
  const casesWithCollisions = new Set(collisions.flatMap((c) => c.cases.map((r) => r.caseId))).size

  return {
    collisions,
    total: collisions.length,
    byType,
    casesWithCollisions,
    typesSearched: types,
  }
}

export { CLASS_LABELS }
