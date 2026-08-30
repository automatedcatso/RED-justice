/**
 * retrieval.ts — Case-scoped retrieval + context assembly for the AI
 * Investigator (shared by /ai and /api/ai/compare).
 *
 * Triple grounding contract — every AI answer is grounded simultaneously in:
 *   1. GRAPH    — matched entities + their relationships + topology metrics
 *   2. TEXT     — retrieved evidence snippets (keyword retrieval)
 *   3. EVIDENCE — the original evidence files those snippets came from
 *
 * The Case-Scoped GraphRAG Firewall wraps every retrieval query: candidate
 * pools are fetched and then post-filtered through filterScoped(), so any
 * row from another case is counted, sampled and dropped before it can reach
 * a prompt.
 */
import { db } from '@/lib/db'
import { computeAll } from '@/lib/analytics/graphAnalytics'
import { toGraphInput } from '@/lib/api/helpers'
import {
  newFirewallReport,
  filterScoped,
  summariseFirewall,
  type FirewallReport,
} from './firewall'

export { SYSTEM_PROMPT } from './systemPrompt'

const MAX_SNIPPET = 500
const MAX_ENTITIES = 20
const MAX_TXNS = 15
const MAX_FINDINGS = 10
const MAX_EVIDENCE = 5

/**
 * Adaptive retrieval scale — tiny models get the conservative caps above;
 * big-window models (16K+ tokens) get proportionally MORE entities,
 * transactions, findings and much longer evidence excerpts so their huge
 * context is actually fed instead of starved by small-model limits.
 */
async function adaptiveRetrievalCaps(): Promise<{
  maxSnippet: number
  maxEntities: number
  maxTxns: number
  maxFindings: number
  maxEvidence: number
}> {
  try {
    const { getContentBudgetChars } = await import('@/lib/localAi')
    const budget = await getContentBudgetChars(4000)
    // 1x up to ~24K-char prompts, scaling to ~4x at ≥100K chars.
    const mult = Math.max(1, Math.min(4, Math.round(budget.maxCharsPerPrompt / 28_000)))
    return {
      maxSnippet: Math.min(MAX_SNIPPET * (mult + 2), 5_000), // grows faster — text grounding matters most
      maxEntities: MAX_ENTITIES * mult,
      maxTxns: MAX_TXNS * mult,
      maxFindings: MAX_FINDINGS * mult,
      maxEvidence: Math.min(MAX_EVIDENCE * mult, 20),
    }
  } catch {
    return {
      maxSnippet: MAX_SNIPPET,
      maxEntities: MAX_ENTITIES,
      maxTxns: MAX_TXNS,
      maxFindings: MAX_FINDINGS,
      maxEvidence: MAX_EVIDENCE,
    }
  }
}

export interface GraphGrounding {
  nodes: Array<{ id: string; type: string; value: string; label: string | null }>
  edges: Array<{ srcId: string; dstId: string; type: string; weight: number; evidenceRef: string | null }>
  metrics: {
    nodes: number
    edges: number
    communities: number
    topPageRank: Array<{ id: string; value: string; score: number }>
  }
}

export interface RetrievedContext {
  firewall: FirewallReport
  caseSummary: {
    uid: string
    title: string
    description: string | null
    status: string
    classification: string
  }
  entities: Array<{
    id: string
    type: string
    value: string
    label: string | null
    confidence: number
    evidenceCount: number
  }>
  graph: GraphGrounding
  transactions: Array<{
    id: string
    txnDate: string | null
    amount: number | null
    senderAccount: string | null
    receiverAccount: string | null
    utr: string | null
    remarks: string | null
  }>
  findings: Array<{
    id: string
    type: string
    severity: string
    confidence: number
    description: string
  }>
  evidenceSnippets: Array<{
    id: string
    originalName: string
    classification: string | null
    snippet: string
  }>
  neighborEntities: Array<{
    id: string
    type: string
    value: string
    label: string | null
  }>
}

/** Tokenize a message into keyword candidates for `contains` search. */
export function keywordsFrom(message: string): string[] {
  const cleaned = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []
  const STOP = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'in',
    'on', 'at', 'to', 'for', 'with', 'and', 'or', 'not', 'but', 'if', 'then',
    'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'us', 'our',
    'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
    'what', 'who', 'whom', 'when', 'where', 'why', 'how', 'show', 'tell',
    'give', 'find', 'list', 'all', 'any', 'about', 'has', 'have', 'had',
    'do', 'does', 'did', 'would', 'could', 'should', 'will', 'can', 'may',
    'might', 'must', 'sh',
  ])
  const tokens = cleaned.split(' ').filter((t) => t.length > 2 && !STOP.has(t))
  const phrase = cleaned
  return Array.from(new Set([phrase, ...tokens])).filter((t) => t.length > 0)
}

export async function retrieveContext(caseId: string, message: string): Promise<RetrievedContext> {
  const caps = await adaptiveRetrievalCaps()
  const fw = newFirewallReport(caseId)
  const caseRow = await db.case.findUnique({
    where: { id: caseId },
    select: {
      uid: true,
      title: true,
      description: true,
      status: true,
      classification: true,
    },
  })

  const kws = keywordsFrom(message)
  const kwOr = kws.length
    ? kws.flatMap((k) => [
        { value: { contains: k } },
        { label: { contains: k } },
        { norm: { contains: k } },
      ])
    : []

  // ── Entities (firewall-filtered) ──
  const rawEntities = kwOr.length
    ? await db.entity.findMany({
        where: { OR: kwOr }, // NOTE: intentionally case-agnostic — the firewall filters
        take: caps.maxEntities * 2,
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, value: true, label: true, norm: true, confidence: true, caseId: true },
      })
    : []
  const entities = filterScoped(fw, 'entities', caseId, rawEntities).slice(0, caps.maxEntities)

  const evidenceCountByEntity = new Map<string, number>()
  if (entities.length > 0) {
    const links = await db.entityLink.findMany({
      where: { entityId: { in: entities.map((e) => e.id) } },
      select: { entityId: true },
    })
    for (const l of links) evidenceCountByEntity.set(l.entityId, (evidenceCountByEntity.get(l.entityId) ?? 0) + 1)
  }

  // ── Graph grounding: matched entities + their edges + topology ──
  let graph: GraphGrounding = {
    nodes: [],
    edges: [],
    metrics: { nodes: 0, edges: 0, communities: 0, topPageRank: [] },
  }
  let neighborRows: Array<{ id: string; type: string; value: string; label: string | null }> = []
  if (entities.length > 0) {
    const primaryIds = entities.map((e) => e.id)
    const rels = await db.relationship.findMany({
      where: { caseId, OR: [{ srcId: { in: primaryIds } }, { dstId: { in: primaryIds } }] },
      take: Math.max(60, primaryIds.length * 8),
      select: { srcId: true, dstId: true, type: true, weight: true, evidenceRef: true },
    })
    const neighborIds = new Set<string>()
    for (const r of rels) {
      if (!primaryIds.includes(r.srcId)) neighborIds.add(r.srcId)
      if (!primaryIds.includes(r.dstId)) neighborIds.add(r.dstId)
    }
    const allNodeIds = Array.from(new Set([...primaryIds, ...neighborIds]))
    const nodeRows = allNodeIds.length
      ? await db.entity.findMany({
          where: { id: { in: allNodeIds }, caseId },
        })
      : []
    // Topology metrics over the local subgraph.
    const valueById = new Map(nodeRows.map((n) => [n.id, n]))
    const g = toGraphInput(nodeRows, rels.map((r, i) => ({
      id: `r-${i}`,
      caseId,
      srcId: r.srcId,
      dstId: r.dstId,
      type: r.type,
      weight: r.weight,
      evidenceRef: r.evidenceRef,
      confidence: 1,
    })))
    const metrics = nodeRows.length >= 2 ? computeAll(g) : null
    graph = {
      nodes: nodeRows.map((n) => ({ id: n.id, type: n.type, value: n.value, label: n.label })),
      edges: rels,
      metrics: {
        nodes: nodeRows.length,
        edges: rels.length,
        communities: metrics?.communities.length ?? 0,
        topPageRank: metrics
          ? Object.entries(metrics.pagerank)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([id, score]) => ({
                id,
                value: valueById.get(id)?.value ?? id,
                score: Math.round(score * 1000) / 1000,
              }))
          : [],
      },
    }

    // Neighbors of the first matched entity (for the prompt).
    neighborRows = nodeRows.filter((n) => neighborIds.has(n.id)).slice(0, caps.maxEntities)
  }
  const neighborEntities: RetrievedContext['neighborEntities'] = neighborRows.map((n) => ({
    id: n.id,
    type: n.type,
    value: n.value,
    label: n.label,
  }))

  // ── Transactions (firewall-filtered) ──
  const txnKwOr = kws.length
    ? kws.flatMap((k) => [
        { remarks: { contains: k } },
        { utr: { contains: k } },
        { senderAccount: { contains: k } },
        { receiverAccount: { contains: k } },
        { upi: { contains: k } },
        { wallet: { contains: k } },
      ])
    : []
  const rawTxns = txnKwOr.length
    ? await db.transaction.findMany({
        where: { OR: txnKwOr },
        take: caps.maxTxns * 2,
        orderBy: { txnDate: 'desc' },
        select: {
          id: true, txnDate: true, amount: true, senderAccount: true,
          receiverAccount: true, utr: true, remarks: true, caseId: true,
        },
      })
    : []
  const transactions = filterScoped(fw, 'transactions', caseId, rawTxns).slice(0, caps.maxTxns)

  // ── Findings (firewall-filtered) ──
  const findingKwOr = kws.length
    ? kws.flatMap((k) => [{ description: { contains: k } }, { trigger: { contains: k } }])
    : []
  let rawFindings = findingKwOr.length
    ? await db.finding.findMany({
        where: { OR: findingKwOr },
        take: caps.maxFindings,
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true, type: true, severity: true, confidence: true,
          description: true, caseId: true,
        },
      })
    : []
  if (rawFindings.length === 0) {
    rawFindings = await db.finding.findMany({
      where: {},
      take: 5,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, type: true, severity: true, confidence: true,
        description: true, caseId: true,
      },
    })
  }
  const findings = filterScoped(fw, 'findings', caseId, rawFindings).slice(0, caps.maxFindings)

  // ── Evidence snippets (firewall-filtered) ──
  const evKwOr = kws.length
    ? kws.flatMap((k) => [
        { originalName: { contains: k } },
        { description: { contains: k } },
        { content: { contains: k } },
      ])
    : []
  const rawEvidence = evKwOr.length
    ? await db.evidence.findMany({
        where: { OR: evKwOr },
        take: caps.maxEvidence * 2,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, originalName: true, content: true, description: true,
          classification: true, caseId: true,
        },
      })
    : []
  const evidenceRows = filterScoped(fw, 'evidence', caseId, rawEvidence).slice(0, caps.maxEvidence)
  const evidenceSnippets = evidenceRows.map((e) => {
    const content = e.content ?? ''
    let snippet = ''
    if (content) {
      let idx = -1
      for (const k of kws) {
        const found = content.toLowerCase().indexOf(k.toLowerCase())
        if (found >= 0) {
          idx = found
          break
        }
      }
      if (idx < 0) idx = 0
      const start = Math.max(0, idx - 100)
      snippet = content.slice(start, start + caps.maxSnippet)
      if (start > 0) snippet = '...' + snippet
      if (start + caps.maxSnippet < content.length) snippet = snippet + '...'
    }
    return {
      id: e.id,
      originalName: e.originalName,
      classification: e.classification,
      snippet,
    }
  })

  return {
    firewall: fw,
    caseSummary: caseRow
      ? {
          uid: caseRow.uid,
          title: caseRow.title,
          description: caseRow.description,
          status: caseRow.status,
          classification: caseRow.classification,
        }
      : { uid: '', title: '', description: null, status: '', classification: '' },
    entities: entities.map((e) => ({
      id: e.id,
      type: e.type,
      value: e.value,
      label: e.label,
      confidence: e.confidence,
      evidenceCount: evidenceCountByEntity.get(e.id) ?? 0,
    })),
    graph,
    transactions,
    findings,
    evidenceSnippets,
    neighborEntities,
  }
}

export function firewallSummary(ctx: RetrievedContext) {
  return summariseFirewall(ctx.firewall)
}

export function buildContextBlock(ctx: RetrievedContext): string {
  const lines: string[] = []
  lines.push('# CONTEXT BLOCK (OBSERVED EVIDENCE — case-scoped, firewall enforced)')
  lines.push('')
  lines.push('## Case')
  lines.push(`- UID: ${ctx.caseSummary.uid}`)
  lines.push(`- Title: ${ctx.caseSummary.title}`)
  lines.push(`- Status: ${ctx.caseSummary.status}`)
  lines.push(`- Classification: ${ctx.caseSummary.classification}`)
  if (ctx.caseSummary.description) {
    lines.push(`- Description: ${ctx.caseSummary.description}`)
  }
  lines.push('')
  lines.push('## Graph grounding (matched subgraph)')
  if (ctx.graph.nodes.length === 0) {
    lines.push('(no graph matches)')
  } else {
    lines.push(`Subgraph: ${ctx.graph.metrics.nodes} nodes, ${ctx.graph.metrics.edges} edges, ${ctx.graph.metrics.communities} communities.`)
    for (const e of ctx.entities.slice(0, 12)) {
      lines.push(
        `- [ENT:${e.id}] type=${e.type} value="${e.value}" label="${e.label ?? ''}" confidence=${e.confidence.toFixed(2)} evidence_files=${e.evidenceCount}`,
      )
    }
    if (ctx.graph.edges.length > 0) {
      lines.push('Relationships among matched entities:')
      for (const r of ctx.graph.edges.slice(0, 12)) {
        const src = ctx.graph.nodes.find((n) => n.id === r.srcId)
        const dst = ctx.graph.nodes.find((n) => n.id === r.dstId)
        lines.push(`  - ${src?.value ?? r.srcId} --[${r.type} w=${r.weight}]--> ${dst?.value ?? r.dstId} (evidence: ${r.evidenceRef ?? 'n/a'})`)
      }
    }
    if (ctx.graph.metrics.topPageRank.length > 0) {
      lines.push(`Most central in matched subgraph: ${ctx.graph.metrics.topPageRank.map((p) => `${p.value} (${p.score})`).join(', ')}`)
    }
  }
  lines.push('')
  if (ctx.neighborEntities.length > 0) {
    lines.push('## Neighboring entities of the first matched entity')
    for (const e of ctx.neighborEntities) {
      lines.push(`- [ENT:${e.id}] type=${e.type} value="${e.value}" label="${e.label ?? ''}"`)
    }
    lines.push('')
  }
  lines.push('## Transactions retrieved')
  if (ctx.transactions.length === 0) {
    lines.push('(no transactions matched)')
  } else {
    for (const t of ctx.transactions) {
      lines.push(
        `- [TXN:${t.id}] date=${t.txnDate ?? 'unknown'} amount=${t.amount ?? 'unknown'} ${t.senderAccount ?? '?'} → ${t.receiverAccount ?? '?'} utr=${t.utr ?? 'n/a'} remarks="${t.remarks ?? ''}"`,
      )
    }
  }
  lines.push('')
  lines.push('## Findings (DETERMINISTIC FINDING)')
  if (ctx.findings.length === 0) {
    lines.push('(no findings matched)')
  } else {
    for (const f of ctx.findings) {
      lines.push(
        `- [FINDING:${f.type}] severity=${f.severity} confidence=${f.confidence.toFixed(2)} — ${f.description}`,
      )
    }
  }
  lines.push('')
  lines.push('## Evidence snippets (TEXT grounding + provenance)')
  if (ctx.evidenceSnippets.length === 0) {
    lines.push('(no evidence matched)')
  } else {
    for (const e of ctx.evidenceSnippets) {
      lines.push(`- [EVID:${e.id}] ${e.originalName}${e.classification ? ` (classified: ${e.classification})` : ''}`)
      lines.push(`  ${e.snippet.replace(/\n/g, ' ')}`)
    }
  }
  return lines.join('\n')
}

/** Deterministic fallback summary (used if the AI model is unavailable). */
export function deterministicFallback(message: string, ctx: RetrievedContext): string {
  const lines: string[] = []
  lines.push(`**Deterministic summary** (AI model unavailable; Level-0 fallback).`)
  lines.push('')
  lines.push(`User query: ${message}`)
  lines.push('')
  lines.push(`Case: ${ctx.caseSummary.title} (${ctx.caseSummary.uid}).`)
  if (ctx.entities.length > 0) {
    lines.push('')
    lines.push('Matched entities:')
    for (const e of ctx.entities.slice(0, 8)) {
      lines.push(`- ${e.type}: ${e.value}${e.label ? ' (' + e.label + ')' : ''} — ${e.evidenceCount} evidence file(s)`)
    }
  }
  if (ctx.graph.edges.length > 0) {
    lines.push('')
    lines.push(`Graph grounding: ${ctx.graph.metrics.nodes}-node subgraph with ${ctx.graph.metrics.edges} relationships.`)
  }
  if (ctx.transactions.length > 0) {
    lines.push('')
    lines.push('Matched transactions:')
    for (const t of ctx.transactions.slice(0, 8)) {
      lines.push(`- ${t.txnDate ?? 'unknown date'}: ₹${t.amount ?? '?'} ${t.senderAccount ?? '?'} → ${t.receiverAccount ?? '?'}`)
    }
  }
  if (ctx.findings.length > 0) {
    lines.push('')
    lines.push('Relevant findings (DETERMINISTIC):')
    for (const f of ctx.findings.slice(0, 6)) {
      lines.push(`- [${f.severity.toUpperCase()}] ${f.type}: ${f.description}`)
    }
  }
  if (ctx.evidenceSnippets.length > 0) {
    lines.push('')
    lines.push('Evidence cited:')
    for (const e of ctx.evidenceSnippets) {
      lines.push(`- [EVID:${e.id}] ${e.originalName}`)
    }
  }
  lines.push('')
  lines.push('Confidence: LOW — generated without AI model; verify manually.')
  return lines.join('\n')
}
