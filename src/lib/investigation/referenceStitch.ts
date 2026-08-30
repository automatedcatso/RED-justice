/**
 * investigation/referenceStitch.ts — v3.10 cross-file reference stitching.
 *
 * Multi-file cases reference the SAME real-world object through machine-shaped
 * reference tokens: a master inventory row says `PER-002,PERSON,Rohan Kale`
 * while CDR/bank/registry exports speak only of `PER-002`, and the FIR speaks
 * only of `Rohan Kale`. Each file is internally consistent, so the wiring
 * layer (correctly) creates one node per distinct normalized value — leaving
 * the graph FRAGMENTED: the same person exists as an `other`-typed "PER-002"
 * node AND a `person` "Rohan Kale" node with no edge between them.
 *
 * The bridge is already carried by the data itself: structured tables attach
 * their row ids to the entities they define (metadataJson.tableIds), and bare
 * reference-token endpoints carry the token as their own table id. Stitching
 * is therefore a GROUP-BY over reference tokens — fully deterministic, no AI,
 * no vocabulary:
 *
 *   token → { entities that declare it (tableIds) or ARE it (value = token) }
 *   groups of ≥2 → merge into one survivor node
 *
 * Survivor preference (deterministic, scored):
 *   1. genuinely TYPED entities (person/phone/account…) over `other`/
 *      `document_id` placeholders,
 *   2. nodes whose value is a REAL value (name/number) over nodes whose value
 *      is just the reference token,
 *   3. higher graph degree, then older node, then stable id order.
 *
 * Order-independent: whichever file arrives first creates a placeholder that
 * is absorbed (or promoted) when the defining file arrives later. Idempotent:
 * re-running on an already-stitched case finds single-member groups.
 */

import type { PrismaClient, Prisma } from '@prisma/client'

/** Structural reference token (must stay in sync with relTableExtract's
 *  REF_TOKEN_RE): alnum segments separated by -/_ ending in a digit segment
 *  (PER-002, DOC-CDR-003, E0001, LOC-OBS-001). */
const REF_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]{0,11}(?:[-_][A-Za-z0-9]{1,11})*[-_]?[0-9]{1,8}$/

/** Canonical token form: uppercase, keep alnum + - and _ . */
export function canonToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '')
}

const PLACEHOLDER_TYPES = new Set(['other', 'document_id'])

interface StitchCandidate {
  id: string
  type: string
  value: string
  label: string | null
  status: string
  confidence: number
  createdAt: Date
  tableIds: string[]
}

export interface StitchResult {
  /** Reference-token groups that contained ≥2 distinct entities. */
  groupsConsidered: number
  /** Entities absorbed into a survivor node. */
  mergedEntities: number
  /** Relationship endpoints re-pointed from absorbed nodes. */
  movedEdges: number
  /** Edges deleted because both endpoints merged into one node (self-loop)
   *  or because an identical edge already existed on the survivor. */
  collapsedEdges: number
  /** Evidence links re-attached to survivor nodes. */
  movedLinks: number
}

interface MetaShape {
  tableIds?: unknown
  [k: string]: unknown
}

function tableIdsFromMeta(metaJson: string | null): string[] {
  if (!metaJson) return []
  try {
    const meta = JSON.parse(metaJson) as MetaShape
    if (!Array.isArray(meta.tableIds)) return []
    return meta.tableIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

/** All reference tokens an entity contributes to the stitch index. */
function tokensFor(c: StitchCandidate): string[] {
  const out = new Set<string>()
  for (const t of c.tableIds) out.add(canonToken(t))
  if (REF_TOKEN_RE.test(c.value)) out.add(canonToken(c.value))
  return [...out]
}

/**
 * Run one idempotent stitch pass over a case. Safe to call after every scan;
 * cheap (single indexed entity load + per-group transactional merges).
 */
export async function stitchCaseReferences(
  db: PrismaClient,
  caseId: string,
): Promise<StitchResult> {
  const res: StitchResult = {
    groupsConsidered: 0, mergedEntities: 0, movedEdges: 0, collapsedEdges: 0, movedLinks: 0,
  }

  const rows = await db.entity.findMany({
    where: { caseId },
    select: {
      id: true, type: true, value: true, label: true, status: true,
      confidence: true, createdAt: true, metadataJson: true,
    },
    orderBy: { createdAt: 'asc' },
  })
  const candidates: StitchCandidate[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    label: r.label,
    status: r.status,
    confidence: r.confidence,
    createdAt: r.createdAt,
    tableIds: tableIdsFromMeta(r.metadataJson),
  }))

  // token → distinct entity ids
  const byToken = new Map<string, Set<string>>()
  for (const c of candidates) {
    for (const t of tokensFor(c)) {
      const set = byToken.get(t) ?? new Set<string>()
      set.add(c.id)
      byToken.set(t, set)
    }
  }

  // union-find over co-referent entities (a token joins all its members)
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) ?? root
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    // deterministic root: lexicographically smaller id
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra]
    parent.set(drop, keep)
    if (!parent.has(keep)) parent.set(keep, keep)
  }
  for (const c of candidates) parent.set(c.id, c.id)
  for (const [, ids] of byToken) {
    if (ids.size < 2) continue
    const [first, ...rest] = [...ids]
    for (const other of rest) union(first, other)
  }

  // groups = root → members (≥2 only)
  const groups = new Map<string, StitchCandidate[]>()
  for (const c of candidates) {
    const root = find(c.id)
    const arr = groups.get(root) ?? []
    arr.push(c)
    groups.set(root, arr)
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue
    res.groupsConsidered += 1

    // degree (edge count) — deterministic survivor input
    const degree = new Map<string, number>()
    for (const m of members) {
      degree.set(
        m.id,
        await db.relationship.count({ where: { OR: [{ srcId: m.id }, { dstId: m.id }] } }),
      )
    }
    const score = (m: StitchCandidate): number =>
      (PLACEHOLDER_TYPES.has(m.type) ? 0 : 2) +
      (REF_TOKEN_RE.test(m.value) ? 0 : 2) +
      (m.label && !REF_TOKEN_RE.test(m.label) ? 0.5 : 0) +
      Math.min(2, (degree.get(m.id) ?? 0) / 10)
    const sorted = [...members].sort((a, b) =>
      score(b) - score(a) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    )
    const survivor = sorted[0]

    for (const loser of sorted.slice(1)) {
      try {
        await db.$transaction(async (tx) => {
          // 1. Re-point relationship endpoints.
          const edges = await tx.relationship.findMany({
            where: { OR: [{ srcId: loser.id }, { dstId: loser.id }] },
            select: { id: true, srcId: true, dstId: true, type: true },
          })
          for (const e of edges) {
            const srcId = e.srcId === loser.id ? survivor.id : e.srcId
            const dstId = e.dstId === loser.id ? survivor.id : e.dstId
            if (srcId === dstId) {
              // both endpoints are now the same node — collapsed co-reference
              await tx.relationship.delete({ where: { id: e.id } }).catch(() => undefined)
              res.collapsedEdges += 1
              continue
            }
            const clash = await tx.relationship.findFirst({
              where: { caseId, srcId, dstId, type: e.type, NOT: { id: e.id } },
              select: { id: true },
            })
            if (clash) {
              await tx.relationship.update({
                where: { id: clash.id },
                data: { weight: { increment: 1 } },
              }).catch(() => undefined)
              await tx.relationship.delete({ where: { id: e.id } }).catch(() => undefined)
              res.collapsedEdges += 1
            } else {
              await tx.relationship.update({ where: { id: e.id }, data: { srcId, dstId } })
              res.movedEdges += 1
            }
          }

          // 2. Evidence links → survivor (then cascade removes loser's).
          const links = await tx.entityLink.findMany({
            where: { entityId: loser.id },
            select: { evidenceId: true },
          })
          for (const l of links) {
            await tx.entityLink
              .upsert({
                where: { entityId_evidenceId: { entityId: survivor.id, evidenceId: l.evidenceId } },
                update: {},
                create: { entityId: survivor.id, evidenceId: l.evidenceId },
              })
              .catch(() => undefined)
            res.movedLinks += 1
          }

          // 3. Actor risks / community seats → survivor; unique/PK clashes are
          //    resolved by keeping the lowest id row.
          await tx.actorRisk
            .updateMany({ where: { entityId: loser.id }, data: { entityId: survivor.id } })
            .catch(() => undefined)
          const keepRisk = await tx.actorRisk.findFirst({
            where: { caseId, entityId: survivor.id },
            orderBy: { id: 'asc' },
            select: { id: true },
          })
          if (keepRisk) {
            await tx.actorRisk.deleteMany({
              where: { caseId, entityId: survivor.id, id: { not: keepRisk.id } },
            }).catch(() => undefined)
          }
          await tx.communityMember
            .updateMany({ where: { entityId: loser.id }, data: { entityId: survivor.id } })
            .catch(() => undefined)
          // composite PK [communityId, entityId] clashes after the move —
          // fetch survivors' seats and drop duplicates per community
          const seats = await tx.communityMember.findMany({
            where: { entityId: survivor.id },
            select: { communityId: true, entityId: true },
          })
          const seenCommunities = new Set<string>()
          for (const s of seats) {
            if (seenCommunities.has(s.communityId)) {
              await tx.communityMember
                .delete({
                  where: { communityId_entityId: { communityId: s.communityId, entityId: s.entityId } },
                })
                .catch(() => undefined)
            }
            seenCommunities.add(s.communityId)
          }

          // 4. Survivor metadata: union of reference tokens + status/conf promo.
          const mergedIds = [...new Set([...survivor.tableIds, ...loser.tableIds, ...(REF_TOKEN_RE.test(loser.value) ? [canonToken(loser.value)] : [])])]
            .slice(0, 24)
          const metaOut: Record<string, unknown> = {}
          try {
            const cur = JSON.parse((await tx.entity.findUnique({ where: { id: survivor.id }, select: { metadataJson: true } }))?.metadataJson ?? '{}')
            Object.assign(metaOut, cur)
          } catch { /* fresh meta */ }
          metaOut.tableIds = mergedIds
          const promoted =
            loser.status === 'confirmed' && survivor.status === 'candidate' ? 'confirmed' : undefined
          await tx.entity
            .update({
              where: { id: survivor.id },
              data: {
                ...(promoted ? { status: promoted } : {}),
                ...(survivor.confidence < loser.confidence ? { confidence: loser.confidence } : {}),
                ...(REF_TOKEN_RE.test(survivor.label ?? '') && loser.label && !REF_TOKEN_RE.test(loser.label)
                  ? { label: loser.label.slice(0, 60) }
                  : {}),
                metadataJson: JSON.stringify(metaOut),
              },
            })
            .catch(() => undefined)

          // 5. Absorb the loser (edges/links already re-pointed).
          await tx.entity.delete({ where: { id: loser.id } }).catch(() => undefined)
        })
        res.mergedEntities += 1
      } catch (err) {
        console.warn(
          `[referenceStitch] merge failed for ${loser.value} → ${survivor.value}:`,
          err instanceof Error ? err.message : err,
        )
      }
      // refresh survivor's degree for subsequent losers? scores already fixed
    }
  }

  return res
}
