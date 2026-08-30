/**
 * ingest.ts — shared evidence ingestion pipeline (v3.2+ hybrid engine).
 *
 * Extracted from the evidence JSON route so BOTH ingest paths share one
 * implementation (they had drifted apart — the multipart upload route went
 * missing entirely at one point, breaking all UI drag & drop uploads):
 *
 *   - POST /api/cases/[id]/evidence           (paste-text JSON body)
 *   - POST /api/cases/[id]/evidence/upload    (multipart file — any format
 *     the fileParser supports: xlsx/csv/md/pdf/docx/zip/vcf/eml/…)
 *
 * HYBRID CONTRACT (v3.2+, superseding the v3.1 records-only contract):
 * this module persists the Evidence row and its structured RECORDS
 * (transaction rows, communication rows + timeline events). The knowledge
 * graph itself is wired by the scan pipeline (lib/investigation/aiScan.ts):
 * Phase A runs DETERMINISTICALLY (relationship tables, registry rows, regex
 * entities, record edges) within seconds of upload, then Phase B enriches
 * with AI (missed entities + story connections). When the AI is unreachable
 * the evidence is marked aiScanStatus='failed' (with a UI retry) while every
 * deterministic entity and edge stays.
 *
 * Pipeline: sha256 dedup → persist Evidence → structured record extractors →
 * timeline event → chain-of-custody → evidence stage → activity log →
 * (caller) queueAiScan → deterministic base + AI enrichment + explanations.
 */
import type { PrismaClient } from '@prisma/client'

import {
  extractCommunications,
  extractTransactions,
  sha256Hex,
} from '@/lib/extractors'

export interface IngestInput {
  originalName: string
  content: string
  mime?: string
  size?: number
  source?: string
  description?: string
  provenance?: string
}

export interface IngestResult {
  evidence: Record<string, unknown>
  dedup: boolean
  extraction: {
    entities: number
    transactions: number
    communications: number
    relationships: number
  }
}

export async function ingestExtractedText(
  db: PrismaClient,
  caseId: string,
  input: IngestInput,
): Promise<IngestResult> {
  const originalName = input.originalName
  const content = input.content

  const sha256 = sha256Hex(content)

  // Dedup: if (caseId, sha256) already exists, return it.
  const existing = await db.evidence.findUnique({
    where: { caseId_sha256: { caseId, sha256 } },
  })
  if (existing) {
    return {
      evidence: existing as unknown as Record<string, unknown>,
      dedup: true,
      extraction: { entities: 0, transactions: 0, communications: 0, relationships: 0 },
    }
  }

  // Persist the evidence row. aiScanStatus starts as 'pending' — the upload
  // routes queue the automatic AI scan right after this returns.
  const evRow = await db.evidence.create({
    data: {
      caseId,
      originalName,
      storedPath: `upload://${caseId}/${originalName}`,
      mime: input.mime ?? 'text/plain',
      size: input.size ?? Buffer.byteLength(content, 'utf8'),
      sha256,
      source: input.source ?? null,
      description: input.description ?? null,
      status: 'processed',
      extractionStatus: 'complete',
      ocrStatus: 'n/a',
      aiScanStatus: 'pending',
      content,
      provenance: input.provenance ?? 'api-upload',
      metadataJson: JSON.stringify({
        uploadedAt: new Date().toISOString(),
      }),
    },
  })

  // Mark extract stage complete.
  await db.evidenceStage.upsert({
    where: {
      evidenceId_stage: { evidenceId: evRow.id, stage: 'extract' },
    },
    update: { state: 'complete' },
    create: {
      evidenceId: evRow.id,
      stage: 'extract',
      state: 'complete',
      detail: 'Text parsed — entities pending AI analysis',
    },
  })

  // Add ChainOfCustody entry.
  await db.chainOfCustody.create({
    data: {
      evidenceId: evRow.id,
      action: 'ingest',
      sha256,
      actor: 'api',
    },
  })

  // ── Structured RECORD extraction (table rows only — NOT graph entities) ──
  const extTxns = extractTransactions(content, originalName)
  const extComms = extractCommunications(content, originalName)

  // Persist transaction records (Transactions view / money-flow analytics).
  // NO entity nodes and NO relationships are derived here — the AI scan is
  // the sole authority for the knowledge graph.
  // v3.5: every dated record ALSO becomes a Timeline event so the
  // investigation timeline reflects the document's own chronology.
  let txnCreated = 0
  const txnEvents: Array<{ caseId: string; ts: string; sourceEvidenceId: string; kind: string; summary: string; metadataJson: string }> = []
  for (const t of extTxns) {
    try {
      await db.transaction.create({
        data: {
          caseId,
          evidenceId: evRow.id,
          sourceRef: t.sourceRef ?? originalName,
          txnDate: t.txnDate ?? null,
          utr: t.utr ?? null,
          amount: t.amount ?? null,
          senderAccount: t.senderAccount ?? null,
          receiverAccount: t.receiverAccount ?? null,
          accountNo: t.accountNo ?? null,
          ifsc: t.ifsc ?? null,
          bank: t.bank ?? null,
          upi: t.upi ?? null,
          wallet: t.wallet ?? null,
          merchant: t.merchant ?? null,
          status: t.status ?? null,
          remarks: t.remarks ?? null,
        },
      })
      txnCreated += 1
      if (t.txnDate) {
        const parts = [
          `${t.senderAccount ?? '—'} → ${t.receiverAccount ?? '—'}`,
          t.amount != null ? `₹${t.amount.toLocaleString('en-IN')}` : null,
          t.utr ? `UTR ${t.utr}` : null,
        ].filter(Boolean).join(' · ')
        txnEvents.push({
          caseId,
          ts: t.txnDate.slice(0, 10),
          sourceEvidenceId: evRow.id,
          kind: 'transaction',
          summary: `Transaction: ${parts}`.slice(0, 240),
          metadataJson: JSON.stringify({
            recordRow: true,
            amount: t.amount ?? null,
            utr: t.utr ?? null,
            senderAccount: t.senderAccount ?? null,
            receiverAccount: t.receiverAccount ?? null,
          }),
        })
      }
    } catch (err) {
      console.error('[ingest] txn insert failed:', err)
    }
  }
  if (txnEvents.length > 0) {
    try {
      for (let i = 0; i < Math.min(txnEvents.length, 2000); i += 200) {
        await db.timelineEvent.createMany({ data: txnEvents.slice(i, i + 200) })
      }
    } catch (err) {
      console.error('[ingest] txn timeline events failed:', err)
    }
  }

  // Persist communication records (Communications view).
  // v3.5: dated messages also land on the investigation timeline.
  let commCreated = 0
  const commEvents: Array<{ caseId: string; ts: string; sourceEvidenceId: string; kind: string; summary: string; metadataJson: string }> = []
  for (const c of extComms) {
    try {
      await db.communication.create({
        data: {
          caseId,
          evidenceId: evRow.id,
          platform: c.platform ?? null,
          sender: c.sender ?? null,
          receiver: c.receiver ?? null,
          senderHandle: c.senderHandle ?? null,
          receiverHandle: c.receiverHandle ?? null,
          messageText: c.messageText ?? null,
          timestamp: c.timestamp ?? null,
          sourceRef: c.sourceRef ?? originalName,
          confidence: 0.85,
        },
      })
      commCreated += 1
      if (c.timestamp) {
        const from = c.sender ?? c.senderHandle ?? '—'
        const to = c.receiver ?? c.receiverHandle ?? '—'
        commEvents.push({
          caseId,
          ts: c.timestamp.slice(0, 10),
          sourceEvidenceId: evRow.id,
          kind: 'communication',
          summary: `${c.platform ? c.platform + ': ' : ''}${from} → ${to}${c.messageText ? ` — "${String(c.messageText).slice(0, 60)}"` : ''}`.slice(0, 240),
          metadataJson: JSON.stringify({
            recordRow: true,
            platform: c.platform ?? null,
            sender: c.sender ?? null,
            receiver: c.receiver ?? null,
          }),
        })
      }
    } catch (err) {
      console.error('[ingest] comm insert failed:', err)
    }
  }
  if (commEvents.length > 0) {
    try {
      for (let i = 0; i < Math.min(commEvents.length, 2000); i += 200) {
        await db.timelineEvent.createMany({ data: commEvents.slice(i, i + 200) })
      }
    } catch (err) {
      console.error('[ingest] comm timeline events failed:', err)
    }
  }

  // Timeline event.
  await db.timelineEvent.create({
    data: {
      caseId,
      ts: new Date().toISOString(),
      sourceEvidenceId: evRow.id,
      kind: 'evidence-acquired',
      summary: `Acquired ${originalName} (${input.source ?? 'upload'})`,
      metadataJson: JSON.stringify({ sha256 }),
    },
  })

  await logActivitySafe(db, caseId, originalName, txnCreated, commCreated)

  const refreshed = await db.evidence.findUnique({
    where: { id: evRow.id },
    include: {
      evidenceStages: true,
      _count: {
        select: {
          entityLinks: true,
          transactions: true,
          communications: true,
        },
      },
    },
  })

  return {
    evidence: (refreshed ?? evRow) as unknown as Record<string, unknown>,
    dedup: false,
    extraction: {
      entities: 0, // AI-only: the deterministic layer never creates entities
      transactions: txnCreated,
      communications: commCreated,
      relationships: 0, // AI-only: connections are authored by the AI scan
    },
  }
}

async function logActivitySafe(
  db: PrismaClient,
  caseId: string,
  originalName: string,
  txns: number,
  comms: number,
) {
  try {
    const { logActivity } = await import('@/lib/api/helpers')
    await logActivity(
      db,
      caseId,
      `Ingested evidence "${originalName}" — ${txns} txn records, ${comms} comm records · queued for automatic AI analysis`,
    )
  } catch {
    /* activity log is best-effort */
  }
}
