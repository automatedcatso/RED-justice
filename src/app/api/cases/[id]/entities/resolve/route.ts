/**
 * GET  /api/cases/[id]/entities/resolve — find entities that likely refer to
 *        the same real-world identity (duplicate candidates).
 *
 * Returns groups of entity IDs that share an identifier, alias, or attribute
 * and could be merged. The investigator reviews these and decides whether to
 *        merge via POST /api/cases/[id]/entities/merge.
 *
 * Detection strategies (Level-0 deterministic):
 *   1. Exact norm match across types (e.g. a `phone` and an `account` both
 *      normalised to the same digits).
 *   2. Alias match — entity.metadataJson.aliases contains a value that
 *      matches another entity's norm.
 *   3. Fuzzy name match — two `person` entities with Levenshtein distance ≤ 2.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { parseJson } from '@/lib/ui-helpers'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

interface ResolveCandidate {
  groupId: string
  reason: string
  confidence: number
  entities: Array<{
    id: string
    type: string
    value: string
    norm: string
    label: string | null
  }>
}

/** Simple Levenshtein distance for fuzzy name matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
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

    // Provenance-preserving ER: make sure every entity has individual source
    // observations (idempotent backfill for entities created before the
    // observation ledger existed).
    try {
      const { backfillObservations } = await import('@/lib/investigation/observations')
      await backfillObservations(db, caseId)
    } catch {
      /* non-fatal — resolution still works without observations */
    }

    const entities = await db.entity.findMany({
      where: { caseId },
      include: { _count: { select: { links: true } } },
    })

    // Group 1: Same norm across different types (e.g. phone digits matching account).
    const byNorm = new Map<string, typeof entities>()
    for (const e of entities) {
      const arr = byNorm.get(e.norm) ?? []
      arr.push(e)
      byNorm.set(e.norm, arr)
    }

    const candidates: ResolveCandidate[] = []
    let groupIdx = 0
    const seenGroups = new Set<string>()

    for (const [norm, group] of byNorm) {
      if (group.length < 2) continue
      const types = new Set(group.map((e) => e.type))
      if (types.size < 2) continue
      const key = group.map((e) => e.id).sort().join('|')
      if (seenGroups.has(key)) continue
      seenGroups.add(key)
      groupIdx += 1
      candidates.push({
        groupId: `norm-${groupIdx}`,
        reason: `Shared normalised value "${norm}" across types: ${Array.from(types).join(', ')}`,
        confidence: 0.85,
        entities: group.map((e) => ({
          id: e.id,
          type: e.type,
          value: e.value,
          norm: e.norm,
          label: e.label,
        })),
      })
    }

    // Group 2: Person name fuzzy match (Levenshtein ≤ 2).
    const persons = entities.filter((e) => e.type === 'person')
    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const a = persons[i]
        const b = persons[j]
        if (a.norm === b.norm) continue
        const dist = levenshtein(a.norm.toLowerCase(), b.norm.toLowerCase())
        if (dist <= 2 && a.norm.length >= 4) {
          groupIdx += 1
          const key = [a.id, b.id].sort().join('|')
          if (seenGroups.has(key)) continue
          seenGroups.add(key)
          candidates.push({
            groupId: `fuzzy-${groupIdx}`,
            reason: `Similar person names: "${a.value}" ≈ "${b.value}" (edit distance ${dist})`,
            confidence: 0.6,
            entities: [
              { id: a.id, type: a.type, value: a.value, norm: a.norm, label: a.label },
              { id: b.id, type: b.type, value: b.value, norm: b.norm, label: b.label },
            ],
          })
        }
      }
    }

    // Group 3: Alias match — metadata.aliases array contains another entity's norm.
    for (const e of entities) {
      const meta = parseJson<Record<string, unknown>>(e.metadataJson)
      const aliases = meta?.aliases
      if (!Array.isArray(aliases)) continue
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue
        const aliasNorm = alias.toLowerCase().trim()
        for (const other of entities) {
          if (other.id === e.id) continue
          if (other.norm === aliasNorm) {
            groupIdx += 1
            const key = [e.id, other.id].sort().join('|')
            if (seenGroups.has(key)) continue
            seenGroups.add(key)
            candidates.push({
              groupId: `alias-${groupIdx}`,
              reason: `Alias match: "${e.value}" has alias "${alias}" matching "${other.value}"`,
              confidence: 0.75,
              entities: [
                { id: e.id, type: e.type, value: e.value, norm: e.norm, label: e.label },
                { id: other.id, type: other.type, value: other.value, norm: other.norm, label: other.label },
              ],
            })
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.entities.length - a.entities.length
    })

    return NextResponse.json({
      candidates,
      total: candidates.length,
      totalEntities: entities.length,
    })
  } catch (err) {
    console.error('[api/cases/[id]/entities/resolve GET] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'resolve failed' },
      { status: 500 },
    )
  }
}
