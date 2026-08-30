/**
 * POST /api/cases/[id]/entities/merge — merge multiple entities into one.
 *
 * Body: { primaryId: string, mergeIds: string[] }
 *
 * The primary entity absorbs the merged entities:
 *   - All EntityLinks are re-pointed to the primary.
 *   - All Relationships (src or dst) are re-pointed to the primary.
 *   - Merged entities' labels/aliases are added to the primary's metadata.aliases.
 *   - Merged entities are soft-deleted (resolvedToId = primaryId) then hard-deleted.
 *   - Duplicate relationships (same src+dst+type) are collapsed with weight sum.
 *
 * This is a human-in-the-loop operation — the investigator explicitly chooses
 * which entity is primary and which to merge. The system never auto-merges.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import { parseJson } from '@/lib/ui-helpers'
import { recordDecision } from '@/lib/investigation/decisions'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

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
    const { primaryId, mergeIds } = body as {
      primaryId?: string
      mergeIds?: string[]
      reason?: string
      actor?: string
    }

    if (!primaryId || typeof primaryId !== 'string') {
      return NextResponse.json(
        { error: 'primaryId is required' },
        { status: 400 },
      )
    }
    if (!Array.isArray(mergeIds) || mergeIds.length === 0) {
      return NextResponse.json(
        { error: 'mergeIds (non-empty array) is required' },
        { status: 400 },
      )
    }

    // Verify all entities exist and belong to this case.
    const primary = await db.entity.findFirst({
      where: { id: primaryId, caseId },
    })
    if (!primary) {
      return NextResponse.json(
        { error: 'primary entity not found in this case' },
        { status: 404 },
      )
    }
    const toMerge = await db.entity.findMany({
      where: { id: { in: mergeIds }, caseId },
    })
    if (toMerge.length !== mergeIds.length) {
      return NextResponse.json(
        { error: 'some merge entities not found in this case' },
        { status: 404 },
      )
    }

    // Collect aliases from merged entities.
    const existingMeta = parseJson<Record<string, unknown>>(primary.metadataJson) ?? {}
    const aliases = new Set<string>(
      Array.isArray(existingMeta.aliases) ? (existingMeta.aliases as string[]) : [],
    )
    for (const m of toMerge) {
      if (m.value && m.value !== primary.value) aliases.add(m.value)
      if (m.label && m.label !== primary.label) aliases.add(m.label)
      const mMeta = parseJson<Record<string, unknown>>(m.metadataJson)
      if (mMeta && Array.isArray(mMeta.aliases)) {
        for (const a of mMeta.aliases as string[]) {
          if (typeof a === 'string' && a !== primary.value) aliases.add(a)
        }
      }
    }

    // Use a transaction to ensure atomicity.
    const result = await db.$transaction(async (tx) => {
      // 1. Re-point all EntityLinks from merged entities to the primary.
      for (const m of toMerge) {
        const links = await tx.entityLink.findMany({
          where: { entityId: m.id },
        })
        for (const link of links) {
          // Upsert: if primary already linked to this evidence, skip; else create.
          const existing = await tx.entityLink.findUnique({
            where: {
              entityId_evidenceId: {
                entityId: primary.id,
                evidenceId: link.evidenceId,
              },
            },
          })
          if (!existing) {
            await tx.entityLink.create({
              data: { entityId: primary.id, evidenceId: link.evidenceId },
            })
          }
        }
        await tx.entityLink.deleteMany({ where: { entityId: m.id } })
      }

      // 2. Re-point all Relationships where merged entity is src or dst.
      for (const m of toMerge) {
        // As src
        const srcRels = await tx.relationship.findMany({
          where: { srcId: m.id },
        })
        for (const rel of srcRels) {
          if (rel.dstId === primary.id) continue // self-loop, skip
          // Try to merge into existing relationship with same (primary, dst, type).
          const existing = await tx.relationship.findUnique({
            where: {
              caseId_srcId_dstId_type: {
                caseId,
                srcId: primary.id,
                dstId: rel.dstId,
                type: rel.type,
              },
            },
          })
          if (existing) {
            await tx.relationship.update({
              where: { id: existing.id },
              data: { weight: { increment: rel.weight } },
            })
            await tx.relationship.delete({ where: { id: rel.id } })
          } else {
            await tx.relationship.update({
              where: { id: rel.id },
              data: { srcId: primary.id },
            })
          }
        }
        // As dst
        const dstRels = await tx.relationship.findMany({
          where: { dstId: m.id },
        })
        for (const rel of dstRels) {
          if (rel.srcId === primary.id) continue // self-loop, skip
          const existing = await tx.relationship.findUnique({
            where: {
              caseId_srcId_dstId_type: {
                caseId,
                srcId: rel.srcId,
                dstId: primary.id,
                type: rel.type,
              },
            },
          })
          if (existing) {
            await tx.relationship.update({
              where: { id: existing.id },
              data: { weight: { increment: rel.weight } },
            })
            await tx.relationship.delete({ where: { id: rel.id } })
          } else {
            await tx.relationship.update({
              where: { id: rel.id },
              data: { dstId: primary.id },
            })
          }
        }
      }

      // 3. Update primary entity's aliases metadata.
      const updatedMeta = {
        ...existingMeta,
        aliases: Array.from(aliases),
        mergedEntities: [
          ...((existingMeta.mergedEntities as string[]) ?? []),
          ...toMerge.map((m) => m.id),
        ],
      }
      const updatedPrimary = await tx.entity.update({
        where: { id: primary.id },
        data: {
          metadataJson: JSON.stringify(updatedMeta),
          confidence: Math.min(1, primary.confidence + 0.1),
        },
      })

      // 3.5 Provenance-preserving resolution: re-point the merged entities'
      // source observations to the survivor (keeping rawType/rawValue and
      // marking mergedFromId), so the individual observations are never
      // collapsed into one opaque node.
      for (const m of toMerge) {
        await tx.entityObservation.updateMany({
          where: { entityId: m.id },
          data: { entityId: primary.id, mergedFromId: m.id },
        })
      }

      // 4. Soft-delete then hard-delete merged entities.
      for (const m of toMerge) {
        await tx.actorRisk.deleteMany({ where: { entityId: m.id } })
        await tx.communityMember.deleteMany({ where: { entityId: m.id } })
        await tx.entity.delete({ where: { id: m.id } })
      }

      return updatedPrimary
    })

    await logActivity(
      db,
      caseId,
      `Merged ${toMerge.length} entit${toMerge.length === 1 ? 'y' : 'ies'} into "${primary.value}" (${primary.type})`,
    )

    // Entity Resolution 2.0 (architecture §12): merge decisions are review
    // outcomes — record WHO approved the identity unification and why.
    const decisionRec = await recordDecision(db, {
      caseId,
      action: 'merge_entities',
      objectType: 'entity',
      objectRef: primary.id,
      objectLabel: `${primary.type}:${primary.value} ← [${toMerge.map((m) => m.value).join(', ')}]`,
      beforeState: `${toMerge.length + 1} distinct entities`,
      afterState: `1 canonical entity (+${aliases.size} aliases)`,
      reason: body.reason ?? null,
      actor: body.actor,
      metadata: { mergedIds: toMerge.map((m) => m.id), aliasCount: aliases.size },
    })

    return NextResponse.json({
      primary: result,
      merged: toMerge.length,
      aliases: Array.from(aliases),
      decisionUid: decisionRec?.uid ?? null,
    })
  } catch (err) {
    console.error('[api/cases/[id]/entities/merge POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'merge failed' },
      { status: 500 },
    )
  }
}
