/**
 * POST /api/cases/[id]/evidence/[evid]/classify — (re)classify one evidence
 * item. Tries the local AI first; falls back to the deterministic classifier.
 * Body (optional): { classification?, confidence? } — manual override.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import {
  arbitrateClassification,
  classifyDeterministic,
  classificationFromAiScan,
  EVIDENCE_CLASSES,
  type EvidenceClass,
} from '@/lib/extractors/classify'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; evid: string }> }

export async function POST(
  req: NextRequest,
  { params }: Params,
) {
  try {
    const { id: idOrUid, evid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const evidence = await db.evidence.findFirst({ where: { id: evid, caseId } })
    if (!evidence) return NextResponse.json({ error: 'evidence not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      classification?: string
      confidence?: number
    }

    // Manual override path.
    if (body.classification) {
      const cls = body.classification.toLowerCase().replace(/[\s-]+/g, '_')
      if (!(EVIDENCE_CLASSES as readonly string[]).includes(cls)) {
        return NextResponse.json(
          { error: `classification must be one of: ${EVIDENCE_CLASSES.join(', ')}` },
          { status: 400 },
        )
      }
      const updated = await db.evidence.update({
        where: { id: evidence.id },
        data: {
          classification: cls as EvidenceClass,
          classificationConfidence: typeof body.confidence === 'number' ? body.confidence : 1,
          classificationSource: 'manual',
        },
      })
      await logActivity(db, caseId, `Evidence "${evidence.originalName}" manually classified as ${cls}`)
      return NextResponse.json({
        classification: {
          classification: updated.classification,
          confidence: updated.classificationConfidence,
          source: updated.classificationSource,
        },
      })
    }

    // AI path — arbitration decides between AI and deterministic verdicts.
    let finalClass = classifyDeterministic(evidence.originalName, evidence.content, {
      mime: evidence.mime,
      isEmail: evidence.mime === 'message/rfc822',
    })
    let usedAi = false
    try {
      const { localChat, pingLocalAi } = await import('@/lib/localAi')
      const { extractJsonObject } = await import('@/lib/aiJson')
      const ping = await pingLocalAi()
      if (ping.available) {
        const { getContentBudgetChars } = await import('@/lib/localAi')
        // v3.3 tier routing: document classification is simple structured
        // work → FAST tier (≤3B models classify as well as 8B ones, much
        // faster), chain-of-thought off.
        const { modelForTier } = await import('@/lib/modelTiers')
        const fastModel = await modelForTier('fast')
        const budget = await getContentBudgetChars(2000, fastModel)
        const content = (evidence.content ?? '').slice(0, budget.maxCharsPerPrompt)
        const prompt = `Classify this evidence file. Respond with ONLY a JSON block:
\`\`\`json
{"classification": one exact value from: fir, bank_statement, cdr, whatsapp_chat, invoice, receipt, id_document, contract, email, court_document, property_document, travel_record, social_media, medical_record, screenshot, ledger, other, "classificationConfidence": 0.0-1.0, "keyFacts": ["fact1", "fact2"]}
\`\`\`

File: ${evidence.originalName} (${evidence.mime})

--- CONTENT ---
${content}`
        const raw = await localChat(
          [
            { role: 'system', content: 'You are a precise document classifier. Respond in ENGLISH.' },
            { role: 'user', content: prompt },
          ],
          { temperature: undefined, maxTokens: 1200, thinking: false, model: fastModel },
        )
        const parsed = extractJsonObject<Record<string, unknown>>(raw)
        if (parsed) {
          const aiClass = classificationFromAiScan(parsed)
          if (aiClass) {
            // Hybrid: AI 'other' never overrides a confident deterministic read.
            finalClass = arbitrateClassification(aiClass, finalClass)
            if (finalClass.source === 'ai') usedAi = true
          }
        }
      }
    } catch { /* deterministic fallback below */ }

    const updated = await db.evidence.update({
      where: { id: evidence.id },
      data: {
        classification: finalClass.classification,
        classificationConfidence: finalClass.confidence,
        classificationSource: finalClass.source,
      },
    })
    await db.evidenceStage.upsert({
      where: { evidenceId_stage: { evidenceId: evidence.id, stage: 'classify' } },
      update: { state: 'complete', detail: `${finalClass.classification} (${finalClass.source})` },
      create: {
        evidenceId: evidence.id,
        stage: 'classify',
        state: 'complete',
        detail: `${finalClass.classification} (${finalClass.source})`,
      },
    })
    await logActivity(
      db,
      caseId,
      `Evidence "${evidence.originalName}" classified as ${finalClass.classification} (${finalClass.source}, ${(finalClass.confidence * 100).toFixed(0)}%)${usedAi ? '' : ' — AI unavailable'}`,
    )

    return NextResponse.json({
      classification: {
        classification: updated.classification,
        confidence: updated.classificationConfidence,
        source: updated.classificationSource,
        signals: finalClass.signals,
      },
      usedAi,
    })
  } catch (err) {
    console.error('[classify POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 })
  }
}
