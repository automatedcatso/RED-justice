/**
 * observations.ts — Provenance-preserving entity observations helpers.
 */

import type { PrismaClient } from '@prisma/client'

/**
 * Backfill observations for entities that pre-date the observation ledger:
 * one observation per (entity, evidence) EntityLink using the entity's raw
 * value. Idempotent — skips entities that already have observations.
 */
export async function backfillObservations(
  db: PrismaClient,
  caseId: string,
): Promise<{ created: number; entitiesSkipped: number }> {
  const entities = await db.entity.findMany({
    where: { caseId },
    select: { id: true, type: true, value: true, norm: true },
  })
  const links = await db.entityLink.findMany({
    where: { entityId: { in: entities.map((e) => e.id) } },
    include: { evidence: { select: { id: true, originalName: true } } },
  })

  const linksByEntity = new Map<string, typeof links>()
  for (const l of links) {
    const list = linksByEntity.get(l.entityId) ?? []
    list.push(l)
    linksByEntity.set(l.entityId, list)
  }

  const existingObs = await db.entityObservation.findMany({
    where: { caseId },
    select: { entityId: true },
  })
  const hasObs = new Set(existingObs.map((o) => o.entityId))

  let created = 0
  let entitiesSkipped = 0
  for (const e of entities) {
    if (hasObs.has(e.id)) {
      entitiesSkipped++
      continue
    }
    const eLinks = linksByEntity.get(e.id) ?? []
    for (const l of eLinks) {
      await db.entityObservation.create({
        data: {
          caseId,
          entityId: e.id,
          rawType: e.type,
          rawValue: e.value,
          norm: e.norm,
          evidenceId: l.evidenceId,
          evidenceName: l.evidence.originalName,
          locator: 'backfilled from evidence link',
          extractionMethod: 'backfill',
        },
      })
      created++
    }
  }
  return { created, entitiesSkipped }
}
