/**
 * POST /api/cases/import — import a previously-exported case JSON.
 *
 * Accepts multipart/form-data with a single `file` field (the .json export),
 * OR a JSON body containing the export directly.
 *
 * Creates a NEW case with a new uid (suffixing the original with "-imported-N")
 * and re-creates all related records. ID mappings are preserved internally so
 * relationships, entity_links, community_members etc. stay consistent.
 *
 * Returns the new case id + summary counts.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/api/helpers'

export const dynamic = 'force-dynamic'

interface ExportData {
  version?: string
  case: {
    uid: string
    title: string
    description: string | null
    status: string
    classification: string
    aiMode: string
    investigators: string | null
    tags: string | null
    sourceMetadata: string | null
    notes: string | null
    metadataJson: string | null
  }
  evidence: Array<Record<string, unknown>>
  entities: Array<Record<string, unknown>>
  entityLinks?: Array<{ entityId: string; evidenceId: string }>
  relationships: Array<Record<string, unknown>>
  transactions: Array<Record<string, unknown>>
  communications: Array<Record<string, unknown>>
  timeline: Array<Record<string, unknown>>
  findings: Array<Record<string, unknown>>
  communities: Array<Record<string, unknown>>
  communityMembers: Array<{ communityId: string; entityId: string }>
  actorRisks: Array<Record<string, unknown>>
  notes: Array<Record<string, unknown>>
  activity?: Array<Record<string, unknown>>
}

export async function POST(req: NextRequest) {
  try {
    let data: ExportData | null = null

    const contentType = req.headers.get('content-type') ?? ''
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: 'no file uploaded (field name must be "file")' },
          { status: 400 },
        )
      }
      const text = await file.text()
      data = JSON.parse(text) as ExportData
    } else {
      const body = await req.json().catch(() => null)
      if (!body) {
        return NextResponse.json(
          { error: 'JSON body or multipart file required' },
          { status: 400 },
        )
      }
      data = body as ExportData
    }

    if (!data.case || !data.case.uid || !data.case.title) {
      return NextResponse.json(
        { error: 'invalid export: missing case.uid or case.title' },
        { status: 400 },
      )
    }

    const baseUid = data.case.uid
    let suffix = 0
    let newUid = `${baseUid}-imported`
    while (await db.case.findUnique({ where: { uid: newUid } })) {
      suffix += 1
      newUid = `${baseUid}-imported-${suffix}`
    }

    const newCase = await db.case.create({
      data: {
        uid: newUid,
        title: data.case.title,
        description: data.case.description,
        status: data.case.status ?? 'open',
        classification: data.case.classification ?? 'unclassified',
        aiMode: data.case.aiMode ?? 'standard',
        investigators: data.case.investigators,
        tags: data.case.tags,
        sourceMetadata: JSON.stringify({
          ...(data.case.sourceMetadata ? JSON.parse(data.case.sourceMetadata) : {}),
          importedFrom: baseUid,
          importedAt: new Date().toISOString(),
        }),
        notes: data.case.notes,
        metadataJson: data.case.metadataJson,
      },
    })

    const caseId = newCase.id
    const idMaps = {
      evidence: new Map<string, string>(),
      entity: new Map<string, string>(),
      community: new Map<string, string>(),
    }

    for (const ev of data.evidence ?? []) {
      const newEv = await db.evidence.create({
        data: {
          caseId,
          originalName: String(ev.originalName ?? 'imported'),
          storedPath: String(ev.storedPath ?? ''),
          mime: String(ev.mime ?? 'text/plain'),
          size: Number(ev.size ?? 0),
          sha256: String(ev.sha256 ?? Math.random().toString(36).slice(2)),
          source: String(ev.source ?? 'import'),
          description: ev.description as string | null,
          status: String(ev.status ?? 'processed'),
          extractionStatus: String(ev.extractionStatus ?? 'complete'),
          ocrStatus: String(ev.ocrStatus ?? 'n/a'),
          content: ev.content as string | null,
          provenance: String(ev.provenance ?? 'import'),
          metadataJson: ev.metadataJson as string | null,
        },
      })
      idMaps.evidence.set(String(ev.id), newEv.id)
    }

    for (const en of data.entities ?? []) {
      const newEn = await db.entity.create({
        data: {
          caseId,
          type: String(en.type ?? 'unknown'),
          value: String(en.value ?? ''),
          norm: String(en.norm ?? ''),
          label: en.label as string | null,
          confidence: Number(en.confidence ?? 1),
          metadataJson: en.metadataJson as string | null,
        },
      })
      idMaps.entity.set(String(en.id), newEn.id)
    }

    for (const rel of data.relationships ?? []) {
      const srcId = idMaps.entity.get(String(rel.srcId))
      const dstId = idMaps.entity.get(String(rel.dstId))
      if (!srcId || !dstId) continue
      try {
        await db.relationship.create({
          data: {
            caseId,
            srcId,
            dstId,
            type: String(rel.type ?? 'CO_OCCURRED'),
            weight: Number(rel.weight ?? 1),
            confidence: Number(rel.confidence ?? 1),
            amount: rel.amount != null ? Number(rel.amount) : null,
            currency: rel.currency as string | null,
            timestamp: rel.timestamp as string | null,
            evidenceRef: rel.evidenceRef as string | null,
            provenance: rel.provenance as string | null,
            extractionMethod: rel.extractionMethod as string | null,
            metadataJson: rel.metadataJson as string | null,
          },
        })
      } catch {
        // skip duplicate
      }
    }

    for (const t of data.transactions ?? []) {
      const evId = idMaps.evidence.get(String(t.evidenceId))
      if (!evId) continue
      await db.transaction.create({
        data: {
          caseId,
          evidenceId: evId,
          sourceFile: t.sourceFile as string | null,
          sourceRef: t.sourceRef as string | null,
          layer: t.layer != null ? Number(t.layer) : null,
          txnDate: t.txnDate as string | null,
          utr: t.utr as string | null,
          amount: t.amount != null ? Number(t.amount) : null,
          disputedAmount: t.disputedAmount != null ? Number(t.disputedAmount) : null,
          senderAccount: t.senderAccount as string | null,
          receiverAccount: t.receiverAccount as string | null,
          accountNo: t.accountNo as string | null,
          ifsc: t.ifsc as string | null,
          bank: t.bank as string | null,
          upi: t.upi as string | null,
          wallet: t.wallet as string | null,
          merchant: t.merchant as string | null,
          status: t.status as string | null,
          remarks: t.remarks as string | null,
          metadataJson: t.metadataJson as string | null,
        },
      })
    }

    for (const c of data.communications ?? []) {
      const evId = idMaps.evidence.get(String(c.evidenceId))
      if (!evId) continue
      await db.communication.create({
        data: {
          caseId,
          evidenceId: evId,
          platform: c.platform as string | null,
          sender: c.sender as string | null,
          receiver: c.receiver as string | null,
          senderHandle: c.senderHandle as string | null,
          receiverHandle: c.receiverHandle as string | null,
          messageText: c.messageText as string | null,
          timestamp: c.timestamp as string | null,
          entitiesJson: c.entitiesJson as string | null,
          attachmentsJson: c.attachmentsJson as string | null,
          urlsJson: c.urlsJson as string | null,
          amountsJson: c.amountsJson as string | null,
          riskFlagsJson: c.riskFlagsJson as string | null,
          sourceRef: c.sourceRef as string | null,
          confidence: Number(c.confidence ?? 1),
        },
      })
    }

    for (const tl of data.timeline ?? []) {
      const evId = tl.sourceEvidenceId
        ? idMaps.evidence.get(String(tl.sourceEvidenceId)) ?? null
        : null
      await db.timelineEvent.create({
        data: {
          caseId,
          ts: tl.ts as string | null,
          sourceEvidenceId: evId,
          kind: tl.kind as string | null,
          summary: tl.summary as string | null,
          metadataJson: tl.metadataJson as string | null,
        },
      })
    }

    // ── Evidence provenance links ────────────────────────────────────────
    // Legacy exports (pre-2.2) carried NO entityLinks, which made every
    // imported entity show "0 evidence" despite relationships surviving.
    const evidenceIdsAll = Array.from(idMaps.evidence.values())
    let restoredLinks = 0
    if (Array.isArray(data.entityLinks) && data.entityLinks.length > 0) {
      for (const l of data.entityLinks) {
        const entityId = idMaps.entity.get(String(l?.entityId))
        const evidenceId = idMaps.evidence.get(String(l?.evidenceId))
        if (!entityId || !evidenceId) continue
        try {
          await db.entityLink.upsert({
            where: { entityId_evidenceId: { entityId, evidenceId } },
            update: {},
            create: { entityId, evidenceId },
          })
          restoredLinks += 1
        } catch {
          // skip duplicate
        }
      }
    } else if ((data.entities ?? []).length > 0 && evidenceIdsAll.length > 0) {
      // Legacy reconstruction heuristic: attach each entity to the evidence
      // documents whose extracted CONTENT actually mentions its value
      // (case-insensitive). Deterministic, auditable, and strictly better
      // than shipping an all-red "no direct evidence link" heatmap.
      const contents = await db.evidence.findMany({
        where: { id: { in: evidenceIdsAll }, content: { not: null } },
        select: { id: true, content: true },
      })
      const lowered = contents.map((c) => ({
        id: c.id,
        text: (c.content ?? '').toLowerCase(),
      }))
      const importedEntities = await db.entity.findMany({
        where: { caseId },
        select: { id: true, value: true, norm: true },
        take: 2000,
      })
      for (const en of importedEntities) {
        const needles = [en.value?.toLowerCase().trim(), en.norm?.toLowerCase().trim()]
          .filter((n): n is string => !!n && n.length >= 4)
        if (!needles.length) continue
        for (const c of lowered) {
          if (needles.some((n) => c.text.includes(n))) {
            try {
              await db.entityLink.upsert({
                where: { entityId_evidenceId: { entityId: en.id, evidenceId: c.id } },
                update: {},
                create: { entityId: en.id, evidenceId: c.id },
              })
              restoredLinks += 1
            } catch {
              // skip duplicate
            }
          }
        }
      }
    }

    for (const f of data.findings ?? []) {
      await db.finding.create({
        data: {
          caseId,
          type: String(f.type ?? 'UNKNOWN'),
          severity: String(f.severity ?? 'medium'),
          confidence: Number(f.confidence ?? 0.5),
          description: String(f.description ?? ''),
          trigger: f.trigger as string | null,
          entitiesJson: f.entitiesJson as string | null,
          relationshipsJson: f.relationshipsJson as string | null,
          transactionsJson: f.transactionsJson as string | null,
          supportingEvidence: f.supportingEvidence as string | null,
          reviewStatus: String(f.reviewStatus ?? 'new'),
          reviewerNote: f.reviewerNote as string | null,
        },
      })
    }

    for (const cm of data.communities ?? []) {
      const newCm = await db.community.create({
        data: {
          caseId,
          label: cm.label as string | null,
          size: Number(cm.size ?? 0),
          dominantTypes: cm.dominantTypes as string | null,
          transactionVolume: cm.transactionVolume != null ? Number(cm.transactionVolume) : null,
          internalRels: Number(cm.internalRels ?? 0),
          externalRels: Number(cm.externalRels ?? 0),
          centralActorsJson: cm.centralActorsJson as string | null,
          bridgeActorsJson: cm.bridgeActorsJson as string | null,
          suspiciousPatterns: Number(cm.suspiciousPatterns ?? 0),
          supportingEvidence: cm.supportingEvidence as string | null,
          metadataJson: cm.metadataJson as string | null,
        },
      })
      idMaps.community.set(String(cm.id), newCm.id)
    }
    for (const cm of data.communityMembers ?? []) {
      const communityId = idMaps.community.get(cm.communityId)
      const entityId = idMaps.entity.get(cm.entityId)
      if (!communityId || !entityId) continue
      try {
        await db.communityMember.create({ data: { communityId, entityId } })
      } catch {
        // skip duplicate
      }
    }

    for (const ar of data.actorRisks ?? []) {
      const entityId = idMaps.entity.get(String(ar.entityId))
      if (!entityId) continue
      await db.actorRisk.create({
        data: {
          caseId,
          entityId,
          score: Number(ar.score ?? 0),
          componentsJson: ar.componentsJson as string | null,
          contributorsJson: ar.contributorsJson as string | null,
        },
      })
    }

    for (const n of data.notes ?? []) {
      await db.investigatorNote.create({
        data: {
          caseId,
          body: String(n.body ?? ''),
        },
      })
    }

    await logActivity(
      db,
      caseId,
      `Imported case from ${baseUid} (${newUid}) — ${restoredLinks} evidence links restored`,
    )

    const summary = {
      case: { id: caseId, uid: newUid, title: newCase.title },
      evidence: idMaps.evidence.size,
      entities: idMaps.entity.size,
      entityLinks: restoredLinks,
      relationships: data.relationships?.length ?? 0,
      transactions: data.transactions?.length ?? 0,
      communications: data.communications?.length ?? 0,
      timeline: data.timeline?.length ?? 0,
      findings: data.findings?.length ?? 0,
      communities: idMaps.community.size,
      actorRisks: data.actorRisks?.length ?? 0,
      notes: data.notes?.length ?? 0,
    }

    return NextResponse.json({ ok: true, summary }, { status: 201 })
  } catch (err) {
    console.error('[api/cases/import POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'import failed' },
      { status: 500 },
    )
  }
}
