/**
 * temporal.ts — Temporal Intelligence Engine (architecture §6).
 *
 * Every relevant object gets an activity window derived from real data:
 *   first_observed / last_observed (evidence ingest + relationship timestamps
 *   + timeline events). On top of those windows the engine provides:
 *
 *   1. Playback  — bucket the case into N chronological frames; each frame
 *                  carries cumulative entity/edge sets and what is NEW in it,
 *                  so the UI can scrub through "Jul 01: A—Phone1, …" style
 *                  snapshots.
 *   2. Overlap   — pairwise co-activity between entities whose windows overlap
 *                  AND who share a direct edge (or share an evidence file),
 *                  with the overlap duration → "Person A at Location X
 *                  10:42–11:05 · Person B at Location X 10:51–11:12 ·
 *                  OVERLAP = 14 minutes".
 */

import type { PrismaClient } from '@prisma/client'

export interface PlaybackFrame {
  index: number
  label: string // e.g. "2025-07"
  from: string | null
  to: string | null
  newEntities: number
  newEdges: number
  newEntityLabels: string[]
  newEdgeLabels: string[]
  cumEntities: number
  cumEdges: number
}

export interface EntityWindow {
  entityId: string
  label: string
  type: string
  firstObserved: string | null
  lastObserved: string | null
  evidenceCount: number
}

export interface OverlapResult {
  a: { id: string; label: string }
  b: { id: string; label: string }
  overlapStart: string
  overlapEnd: string
  overlapMs: number
  overlapHuman: string
  basis: 'direct-edge' | 'shared-evidence'
  relationType?: string
}

function parseTs(raw: unknown): number | null {
  if (raw == null) return null
  if (raw instanceof Date) {
    const t = raw.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const s = raw.trim().replace(/\s+/g, ' ')
  // ISO first.
  const iso = Date.parse(s)
  if (!Number.isNaN(iso)) return iso
  // Common forensic formats: 18/07/2025, 18-07-2025, 2025.07.18 (+ time).
  const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (dm) {
    const [, d, mo, y, hh, mm, ss] = dm
    const t = Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0))
    return Number.isNaN(t) ? null : t
  }
  return null
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hours`
  return `${Math.round(ms / 86_400_000)} days`
}

/** Frame binning: pick interval so ≤ bins frames cover the span. */
function chooseStep(fromMs: number, toMs: number, bins: number): { unit: 'day' | 'week' | 'month'; n: number } {
  const spanDays = Math.max(1, (toMs - fromMs) / 86_400_000)
  const per = Math.ceil(spanDays / Math.max(1, bins))
  if (per <= 1) return { unit: 'day', n: 1 }
  if (per <= 7 * 6) return { unit: 'week', n: Math.max(1, Math.round(per / 7)) }
  return { unit: 'month', n: Math.max(1, Math.round(per / 30)) }
}

/** Unused after refactor of buildPlayback to fixed-width frames (kept for future seasonal binning). */
function _unusedAddInterval(ms: number, unit: 'day' | 'week' | 'month', n: number): number {
  const d = new Date(ms)
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + n)
  else d.setUTCDate(d.getUTCDate() + n * (unit === 'week' ? 7 : 1))
  return d.getTime()
}
void _unusedAddInterval

/**
 * Build playback frames for a case.
 * Evidence assignment date priority: relationship.t → timeline.ts →
 * evidence.createdAt (entities inherit via links).
 */
export async function buildPlayback(
  db: PrismaClient,
  caseId: string,
  opts?: { bins?: number },
): Promise<{
  frames: PlaybackFrame[]
  window: { from: string | null; to: string | null }
  totalEntities: number
  totalEdges: number
}> {
  const bins = Math.min(Math.max(opts?.bins ?? 8, 3), 24)

  const [entities, rels, timeline] = await Promise.all([
    db.entity.findMany({
      where: { caseId },
      select: {
        id: true, type: true, value: true, label: true, createdAt: true,
        links: { select: { evidenceId: true } },
        srcRels: { select: { timestamp: true } },
        dstRels: { select: { timestamp: true } },
      },
    }),
    db.relationship.findMany({
      where: { caseId },
      select: {
        id: true, srcId: true, dstId: true, type: true, timestamp: true, createdAt: true,
        src: { select: { value: true, type: true } },
        dst: { select: { value: true, type: true } },
      },
    }),
    db.timelineEvent.findMany({
      where: { caseId },
      select: { ts: true, summary: true, kind: true },
    }),
  ])

  // ---- Edge dating -------------------------------------------------------
  const edgeDate = new Map<string, number>()
  for (const r of rels) {
    let t: number | null = parseTs(r.timestamp)
    if (t == null) {
      // fall back to any timeline event summary mentioning both endpoints? too
      // expensive — use createdAt as ingest proxy.
      t = parseTs(r.createdAt)
    }
    if (t != null) edgeDate.set(r.id, t)
  }

  // ---- Entity first-seen dating ------------------------------------------
  // An entity's first appearance = earliest dated edge touching it, or its
  // creation time.
  const entityFirst = new Map<string, number>()
  const touch = (id: string, t: number) => {
    const cur = entityFirst.get(id)
    if (cur == null || t < cur) entityFirst.set(id, t)
  }
  for (const r of rels) {
    const t = edgeDate.get(r.id)
    if (t != null) {
      touch(r.srcId, t)
      touch(r.dstId, t)
    }
  }
  for (const e of entities) {
    const created = parseTs(e.createdAt)
    if (created != null && !entityFirst.has(e.id)) entityFirst.set(e.id, created)
    // If first edge predates row creation, keep the earlier.
    const cur = entityFirst.get(e.id)
    const cr = parseTs(e.createdAt)
    if (cur == null && cr != null) entityFirst.set(e.id, cr)
  }

  // All event dates: edges + entities-first + timeline events.
  const dates: number[] = [
    ...edgeDate.values(),
    ...entityFirst.values(),
    ...timeline.map((te) => parseTs(te.ts)).filter((x): x is number => x != null),
  ].filter((x) => Number.isFinite(x))

  if (dates.length === 0) {
    return {
      frames: [],
      window: { from: null, to: null },
      totalEntities: entities.length,
      totalEdges: rels.length,
    }
  }

  const fromMs = Math.min(...dates)
  const toMs = Math.max(...dates)
  const step = chooseStep(fromMs, toMs, bins)

  const labelOf = (ms: number) => {
    const d = new Date(ms)
    if (step.unit === 'month') return d.toISOString().slice(0, 7)
    return d.toISOString().slice(0, 10)
  }

  // Fixed-width frames: stepMs wide, capped so pathological spans don't explode.
  const DAY = 86_400_000
  const stepMs =
    step.unit === 'month' ? step.n * 30.44 * DAY
    : step.unit === 'week' ? step.n * 7 * DAY
    : step.n * DAY
  const frameCount = Math.max(1, Math.min(48, Math.ceil((toMs - fromMs) / stepMs)))
  const idxOf = (t: number) =>
    Math.min(frameCount - 1, Math.max(0, Math.floor((t - fromMs) / stepMs)))

  const frames: PlaybackFrame[] = Array.from({ length: frameCount }, (_, i) => ({
    index: i,
    label: '',
    from: new Date(fromMs + i * stepMs).toISOString(),
    to: new Date(Math.min(toMs, fromMs + (i + 1) * stepMs)).toISOString(),
    newEntities: 0,
    newEdges: 0,
    newEntityLabels: [],
    newEdgeLabels: [],
    cumEntities: 0,
    cumEdges: 0,
  }))

  for (const r of rels) {
    const t = edgeDate.get(r.id)
    if (t == null) continue
    const f = frames[idxOf(t)]
    if (!f) continue
    f.newEdges += 1
    if (f.newEdgeLabels.length < 8)
      f.newEdgeLabels.push(`${r.src.value} ─${r.type.replace(/_/g, ' ').toLowerCase()}→ ${r.dst.value}`)
  }
  for (const e of entities) {
    const t = entityFirst.get(e.id)
    if (t == null) continue
    const f = frames[idxOf(t)]
    if (!f) continue
    f.newEntities += 1
    if (f.newEntityLabels.length < 10)
      f.newEntityLabels.push(`${e.label || e.value}`)
  }

  // Cumulative counts + labels.
  let ce = 0
  let cx = 0
  for (const f of frames) {
    ce += f.newEntities
    cx += f.newEdges
    f.cumEntities = ce
    f.cumEdges = cx
    f.label = `${labelOf(new Date(f.from as string).getTime())}` +
      ` → ${labelOf(new Date(new Date(f.to as string).getTime() - 1).getTime())}`
    if (f.newEntityLabels.length > 6) f.newEntityLabels = [...f.newEntityLabels.slice(0, 6), `+${f.newEntities - 6} more`]
    if (f.newEdgeLabels.length > 5) f.newEdgeLabels = [...f.newEdgeLabels.slice(0, 5), `+${f.newEdges - 5} more`]
  }

  return {
    frames: frames.filter((f) => f.newEntities > 0 || f.newEdges > 0 || f.index === frames.length - 1),
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    totalEntities: entities.length,
    totalEdges: rels.length,
  }
}

/**
 * Entity activity windows from observations/evidence/timeline data.
 */
export async function computeWindows(
  db: PrismaClient,
  caseId: string,
): Promise<EntityWindow[]> {
  const [entities, rels] = await Promise.all([
    db.entity.findMany({
      where: { caseId },
      select: {
        id: true, type: true, value: true, label: true, createdAt: true,
        links: { select: { evidenceId: true } },
        srcRels: { select: { timestamp: true, createdAt: true } },
        dstRels: { select: { timestamp: true, createdAt: true } },
      },
    }),
    db.relationship.findMany({
      where: { caseId },
      select: { srcId: true, dstId: true, timestamp: true, createdAt: true },
    }),
  ])

  const minMax = new Map<string, { min: number; max: number }>()
  const observe = (id: string, raw: unknown) => {
    const t = parseTs(raw)
    if (t == null) return
    const cur = minMax.get(id) ?? { min: t, max: t }
    cur.min = Math.min(cur.min, t)
    cur.max = Math.max(cur.max, t)
    minMax.set(id, cur)
  }
  for (const r of rels) {
    observe(r.srcId, r.timestamp ?? r.createdAt)
    observe(r.dstId, r.timestamp ?? r.createdAt)
  }

  return entities.map((e) => {
    const w = minMax.get(e.id)
    const created = parseTs(e.createdAt)
    return {
      entityId: e.id,
      label: e.label || e.value,
      type: e.type,
      firstObserved: w ? new Date(w.min).toISOString() : created ? new Date(created).toISOString() : null,
      lastObserved: w ? new Date(w.max).toISOString() : created ? new Date(created).toISOString() : null,
      evidenceCount: e.links.length,
    }
  }).filter((w) => w.firstObserved && w.lastObserved)
}

/**
 * Pairwise temporal co-activity. Only meaningful pairs are considered:
 * directly connected entities, or entities sharing an evidence file
 * (limited to avoid O(n²) blowups on huge cases).
 */
export async function computeOverlaps(
  db: PrismaClient,
  caseId: string,
  opts?: { limitPairs?: number },
): Promise<{ overlaps: OverlapResult[]; windowsCompared: number }> {
  const maxPairs = opts?.limitPairs ?? 4000

  const [windows, rels, linkRows] = await Promise.all([
    computeWindows(db, caseId),
    db.relationship.findMany({
      where: { caseId },
      select: { srcId: true, dstId: true, type: true },
    }),
    db.entityLink.findMany({
      where: { entity: { caseId } },
      select: { entityId: true, evidenceId: true },
    }),
  ])

  const byId = new Map(windows.map((w) => [w.entityId, w]))
  const pairBasis = new Map<string, 'direct-edge' | 'shared-evidence'>()
  const pairRel = new Map<string, string>()

  for (const r of rels) {
    if (byId.has(r.srcId) && byId.has(r.dstId)) {
      const key = [r.srcId, r.dstId].sort().join('~')
      pairBasis.set(key, 'direct-edge')
      if (!pairRel.has(key)) pairRel.set(key, r.type)
    }
  }
  const byEvidence = new Map<string, string[]>()
  for (const l of linkRows) {
    if (!l.evidenceId) continue
    const arr = byEvidence.get(l.evidenceId) ?? []
    arr.push(l.entityId)
    byEvidence.set(l.evidenceId, arr)
  }
  for (const members of byEvidence.values()) {
    if (members.length > 40) continue // skip mega-files to stay sub-quadratic
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]
        const b = members[j]
        if (!byId.has(a) || !byId.has(b)) continue
        const key = [a, b].sort().join('~')
        if (!pairBasis.has(key)) pairBasis.set(key, 'shared-evidence')
      }
    }
  }

  const overlaps: OverlapResult[] = []
  let compared = 0
  for (const [key, basis] of pairBasis) {
    if (compared >= maxPairs) break
    const [aId, bId] = key.split('~')
    const wa = byId.get(aId)!
    const wb = byId.get(bId)!
    compared += 1
    const start = Math.max(new Date(wa.firstObserved!).getTime(), new Date(wb.firstObserved!).getTime())
    const end = Math.min(new Date(wa.lastObserved!).getTime(), new Date(wb.lastObserved!).getTime())
    if (end <= start) continue
    const ms = end - start
    overlaps.push({
      a: { id: aId, label: wa.label },
      b: { id: bId, label: wb.label },
      overlapStart: new Date(start).toISOString(),
      overlapEnd: new Date(end).toISOString(),
      overlapMs: ms,
      overlapHuman: humanDuration(ms),
      basis,
      relationType: pairRel.get(key),
    })
  }

  overlaps.sort((x, y) => y.overlapMs - x.overlapMs)
  return { overlaps: overlaps.slice(0, 200), windowsCompared: compared }
}
