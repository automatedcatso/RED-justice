/**
 * POST /api/cases/[id]/ai — AI Investigator with Deterministic-First Router.
 *
 * Flow:
 *   1. Deterministic-First Router decides the route:
 *      rules / graph / fts / timeline questions are answered by deterministic
 *      engines (no LLM); open-ended questions fall through to the LLM.
 *   2. For the LLM path, retrieval is triple-grounded (graph + text + evidence)
 *      and passes through the Case-Scoped GraphRAG Firewall.
 *   3. Local AI (Ollama-compatible) generates the answer under guardrails.
 *   4. Everything is persisted to AiChat with citations + grounding metadata.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId, logActivity } from '@/lib/api/helpers'
import {
  retrieveContext,
  buildContextBlock,
  deterministicFallback,
  firewallSummary,
  SYSTEM_PROMPT,
} from '@/lib/investigation/retrieval'
import { routeQuestion } from '@/lib/investigation/aiRouter'

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
    const { message, mode, forceAi } = body as {
      message?: string
      mode?: 'standard' | 'smart' | 'deep'
      forceAi?: boolean
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400 },
      )
    }

    // ── Deterministic-First Router ──
    let routerInfo: { route: string; reason: string } | null = null
    let assistantText = ''
    let citations: string[] = []
    let aiAvailable = false
    let aiModel = 'deterministic-fallback'

    if (!forceAi) {
      const routed = await routeQuestion(db, caseId, message)
      if (routed.answer) {
        // Deterministic route served the answer directly.
        routerInfo = { route: routed.route, reason: routed.reason }
        assistantText = routed.answer
        citations = routed.citations
        aiModel = `deterministic:${routed.route}`

        const userMsg = await db.aiChat.create({
          data: {
            caseId,
            role: 'user',
            content: message,
            metadataJson: JSON.stringify({ mode: mode ?? 'standard', router: routed.route }),
          },
        })
        await db.aiChat.create({
          data: {
            caseId,
            role: 'assistant',
            content: assistantText,
            citations: JSON.stringify(citations),
            metadataJson: JSON.stringify({
              aiAvailable: false,
              deterministicRoute: routed.route,
              routerReason: routed.reason,
              mode: mode ?? 'standard',
              userMessageId: userMsg.id,
            }),
          },
        })
        await logActivity(db, caseId, `AI query routed to ${routed.route}: ${message.slice(0, 60)}`)

        return NextResponse.json({
          response: assistantText,
          citations,
          aiAvailable: false,
          router: { route: routed.route, reason: routed.reason, deterministic: true },
          grounding: { graph: 0, text: 0, evidence: citations.length },
          firewall: { enforced: true, caseId, totalChecked: 0, totalBlocked: 0, blockedSamples: [] },
          context: { entities: 0, transactions: 0, evidence: citations.length, findings: 0 },
          userMessageId: userMsg.id,
        })
      }
      routerInfo = { route: 'ai', reason: routed.reason }
    }

    // ── LLM path: triple-grounded retrieval behind the firewall ──
    const ctx = await retrieveContext(caseId, message)
    const contextBlock = buildContextBlock(ctx)
    const fw = firewallSummary(ctx)
    citations = ctx.evidenceSnippets.map((e) => e.id)

    const userMsg = await db.aiChat.create({
      data: {
        caseId,
        role: 'user',
        content: message,
        metadataJson: JSON.stringify({ mode: mode ?? 'standard', router: 'ai' }),
      },
    })

    try {
      const { localChat, pingLocalAi } = await import('@/lib/localAi')
      const { modelForTier } = await import('@/lib/modelTiers')
      const ping = await pingLocalAi()
      if (!ping.available) {
        throw new Error(`local AI unavailable: ${ping.error ?? 'connection failed'}`)
      }
      // v3.3 tier routing: open-ended investigation reasoning is DEEP-tier
      // work — chain-of-thought stays enabled (server default) because answer
      // quality is the point here, not token throughput.
      const deepModel = await modelForTier('deep')
      aiModel = deepModel
      const response = await localChat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `User question:\n${message}\n\n${contextBlock}`,
          },
        ],
        // v3.8: deep-tier investigation reasoning runs with chain-of-thought
        // ON — the routing spec's CoT policy for the 7B+ escalation tier.
        // v3.9: explicit tier → explicit num_ctx contract on Ollama.
        { model: deepModel, thinking: true, maxTokens: 8000, tier: 'deep' },
      )
      if (!response || !response.trim()) {
        throw new Error('empty response from local AI')
      }
      assistantText = response
      aiAvailable = true
    } catch (err) {
      console.error('[api/cases/[id]/ai POST] local AI failed, falling back:', err)
      assistantText = deterministicFallback(message, ctx)
    }

    await db.aiChat.create({
      data: {
        caseId,
        role: 'assistant',
        content: assistantText,
        citations: JSON.stringify(citations),
        metadataJson: JSON.stringify({
          aiAvailable,
          mode: mode ?? 'standard',
          router: routerInfo?.route ?? 'ai',
          grounding: {
            graphNodes: ctx.graph.nodes.length,
            graphEdges: ctx.graph.edges.length,
            textSnippets: ctx.evidenceSnippets.length,
            evidence: citations.length,
          },
          firewall: fw,
          contextCounts: {
            entities: ctx.entities.length,
            transactions: ctx.transactions.length,
            evidence: ctx.evidenceSnippets.length,
            findings: ctx.findings.length,
            neighborEntities: ctx.neighborEntities.length,
          },
          userMessageId: userMsg.id,
        }),
      },
    })

    await logActivity(
      db,
      caseId,
      `AI query${aiAvailable ? '' : ' (fallback)'}: ${message.slice(0, 60)}${fw.totalBlocked > 0 ? ` [firewall blocked ${fw.totalBlocked} cross-case rows]` : ''}`,
    )

    return NextResponse.json({
      response: assistantText,
      citations,
      aiAvailable,
      aiModel,
      router: routerInfo ?? { route: 'ai', reason: 'open-ended interpretation → local AI', deterministic: false },
      grounding: {
        graph: ctx.graph.nodes.length,
        graphEdges: ctx.graph.edges.length,
        text: ctx.evidenceSnippets.length,
        evidence: citations.length,
      },
      firewall: fw,
      context: {
        entities: ctx.entities.length,
        transactions: ctx.transactions.length,
        evidence: ctx.evidenceSnippets.length,
        findings: ctx.findings.length,
      },
      userMessageId: userMsg.id,
    })
  } catch (err) {
    console.error('[api/cases/[id]/ai POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ai failed' },
      { status: 500 },
    )
  }
}
