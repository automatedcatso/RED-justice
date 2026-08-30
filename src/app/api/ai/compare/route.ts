/**
 * POST /api/ai/compare — Local-AI / Gemini Equivalence Mode.
 *
 * Runs the EXACT same investigation prompt against (1) the local AI and
 * (2) Gemini, and returns both answers with latency, model, citations and a
 * grounding-overlap metric — turning the product into an AI evaluation
 * platform for investigation prompts.
 *
 * Body: { message, mode? } — identical contract to the per-case AI endpoint.
 * Both sides degrade gracefully: whichever backend is unavailable reports
 * `available: false` with the reason instead of failing the whole request.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import {
  retrieveContext,
  buildContextBlock,
  SYSTEM_PROMPT,
  deterministicFallback,
} from '@/lib/investigation/retrieval'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      caseId?: string
      message?: string
      mode?: string
    }
    if (!body.caseId || !body.message) {
      return NextResponse.json({ error: 'caseId and message are required' }, { status: 400 })
    }
    const caseId = await resolveCaseId(db, body.caseId)
    if (!caseId) return NextResponse.json({ error: 'case not found' }, { status: 404 })

    const message = body.message
    const started = Date.now()

    const ctx = await retrieveContext(caseId, message)
    const contextBlock = buildContextBlock(ctx)
    const citations = ctx.evidenceSnippets.map((e) => e.id)
    const userPayload = `User question:\n${message}\n\n${contextBlock}`
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPayload },
    ]

    // Fire both backends concurrently.
    const [localResult, geminiResult] = await Promise.all([
      (async () => {
        const t0 = Date.now()
        try {
          const { localChat, pingLocalAi } = await import('@/lib/localAi')
          const { modelForTier } = await import('@/lib/modelTiers')
          const ping = await pingLocalAi()
          if (!ping.available) {
            return {
              available: false, model: ping.model, latencyMs: Date.now() - t0,
              answer: deterministicFallback(message, ctx),
              usedFallback: true, error: `local AI unavailable: ${ping.error ?? 'connection failed'}`,
            }
          }
          // v3.3: comparison answers are open-ended reasoning → DEEP tier.
          const deepModel = await modelForTier('deep')
          const answer = await localChat(messages, { temperature: 0.3, model: deepModel })
          if (!answer?.trim()) {
            return {
              available: false, model: deepModel, latencyMs: Date.now() - t0,
              answer: deterministicFallback(message, ctx),
              usedFallback: true, error: 'empty response from local AI',
            }
          }
          return { available: true, model: deepModel, latencyMs: Date.now() - t0, answer, usedFallback: false }
        } catch (err) {
          return {
            available: false, model: 'local', latencyMs: Date.now() - t0,
            answer: deterministicFallback(message, ctx),
            usedFallback: true,
            error: err instanceof Error ? err.message : 'local AI failed',
          }
        }
      })(),
      (async () => {
        try {
          const { geminiChat } = await import('@/lib/gemini')
          return await geminiChat(messages, { temperature: 0.3 })
        } catch (err) {
          return {
            available: false, model: 'gemini', latencyMs: 0, answer: '',
            error: err instanceof Error ? err.message : 'gemini failed',
          }
        }
      })(),
    ])

    // Grounding overlap: how many context evidence ids each answer cites.
    const citedIn = (text: string) => citations.filter((id) => text.includes(id))
    const localCited = citedIn(localResult.answer ?? '')
    const geminiCited = geminiResult.answer ? citedIn(geminiResult.answer) : []
    const overlap = localCited.filter((c) => geminiCited.includes(c))

    await logActivity(db, caseId, `Equivalence run: "${message.slice(0, 50)}" (local ${localResult.latencyMs}ms / gemini ${geminiResult.latencyMs}ms)`)

    return NextResponse.json({
      prompt: message,
      contextCounts: {
        entities: ctx.entities.length,
        transactions: ctx.transactions.length,
        findings: ctx.findings.length,
        evidence: ctx.evidenceSnippets.length,
      },
      local: { ...localResult, citations: localCited },
      gemini: { ...geminiResult, citations: geminiCited },
      comparison: {
        overlapCitations: overlap,
        localLatencyMs: localResult.latencyMs,
        geminiLatencyMs: geminiResult.latencyMs,
        localChars: localResult.answer?.length ?? 0,
        geminiChars: geminiResult.answer?.length ?? 0,
        totalLatencyMs: Date.now() - started,
      },
    })
  } catch (err) {
    console.error('[ai/compare POST] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'compare failed' }, { status: 500 })
  }
}
