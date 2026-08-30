/**
 * aiRouter.ts — Deterministic-First AI Router.
 *
 * The system decides whether a question should be answered by:
 *   rules        — counts, lists, thresholds (SQL over case tables)
 *   graph        — centrality / hubs / paths / communities (analytics engine)
 *   fts          — keyword / identifier full-text search (search API)
 *   timeline     — "when did X happen" (timeline table)
 *   ai           — open-ended interpretation (local LLM w/ RAG context)
 *
 * Every deterministic route returns a REAL answer built from the database —
 * not a canned message. The response marks which route served the query so
 * the UI can show the answer source and the investigator can audit why no
 * LLM was involved.
 */

import type { PrismaClient } from '@prisma/client'
import { buildPatternContext, toGraphInput } from '@/lib/api/helpers'
import { computeAll } from '@/lib/analytics/graphAnalytics'

export type RouteKind = 'rules' | 'graph' | 'fts' | 'timeline' | 'ai'

export interface RoutedAnswer {
  route: RouteKind
  reason: string
  answer: string
  citations: string[]
  data?: Record<string, unknown>
}

interface Query {
  lower: string
  caseId: string
}

/** Intent detection. Order matters — first match wins. */
function detectIntent(q: Query): { route: RouteKind; reason: string } {
  const { lower } = q
  // OPEN-ENDED QUESTIONS FIRST: "who is X", "explain", "tell me about",
  // "summarize", "what does this evidence mean" are requests for narrative
  // interpretation — the grounded AI must answer them even when the wording
  // also happens to contain words like "connected" or "how many" deeper in
  // the sentence. Deterministic patterns below only catch questions that are
  // UNAMBIGUOUSLY about counts, topology metrics or lookups.
  if (
    /\b(who|whom)\b.*\??\s*$/.test(lower) ||
    /^(who|what|tell me|explain|describe|summar\w*|interpret|analy[sz]e)\b/.test(lower) ||
    /\b(who is|who was|who are|what is this|tell me about|explain (this|the|why|how)|what does .{0,40} (mean|show|suggest)|summar\w+ (this|the) (case|evidence|file|document))\b/.test(lower)
  ) {
    return { route: 'ai', reason: 'open-ended interpretation → local AI with grounded context' }
  }
  if (/\b(how many|count of|number of|total number|how much (money|amount)|total (amount|volume)|sum of)\b/.test(lower)) {
    return { route: 'rules', reason: 'count/aggregate question → deterministic SQL' }
  }
  if (/\b(most central|centrality|hub|hubs|key player|key players|influential|betweenness|pagerank|bridge|broker|central actor)\b/.test(lower)) {
    return { route: 'graph', reason: 'network-topology question → graph analytics' }
  }
  if (/\b(community|communities|cluster|clusters|group of)\b/.test(lower)) {
    return { route: 'graph', reason: 'community question → label-propagation analytics' }
  }
  if (/\b(shortest path|path from|connected to|linked to|route between|does .* connect)\b/.test(lower)) {
    return { route: 'graph', reason: 'connectivity question → graph path query' }
  }
  if (/\b(circle|circular|round.tripping|layering|fan.in|fan.out|smurf)\b/.test(lower)) {
    return { route: 'rules', reason: 'pattern question → deterministic pattern engine' }
  }
  if (/\b(when|what date|which date|timeline|chronolog|first transaction|last transaction)\b/.test(lower)) {
    return { route: 'timeline', reason: 'temporal question → timeline records' }
  }
  if (/\b(find|search|lookup|show me|list|which (transaction|evidence|entity))\b/.test(lower) && q.lower.length < 220) {
    return { route: 'fts', reason: 'lookup question → full-text search' }
  }
  return { route: 'ai', reason: 'open-ended interpretation → local AI with grounded context' }
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? 'unknown' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** Answer a rules question with real aggregates. */
async function answerRules(db: PrismaClient, q: Query): Promise<RoutedAnswer> {
  const { caseId, lower } = q
  const [entities, txns, evidence, findings, rels, comms] = await Promise.all([
    db.entity.count({ where: { caseId } }),
    db.transaction.findMany({ where: { caseId }, select: { amount: true } }),
    db.evidence.count({ where: { caseId } }),
    db.finding.count({ where: { caseId } }),
    db.relationship.count({ where: { caseId } }),
    db.communication.count({ where: { caseId } }),
  ])
  const volume = txns.reduce((a, t) => a + (t.amount ?? 0), 0)
  const lines: string[] = [
    '**Deterministic answer (rules route — no AI involved)**',
    '',
    `Current case totals:`,
    `- Entities: ${entities}`,
    `- Relationships: ${rels}`,
    `- Transactions: ${txns.length} · total volume ${fmtMoney(volume)}`,
    `- Communications: ${comms}`,
    `- Evidence files: ${evidence}`,
    `- Findings: ${findings}`,
  ]
  if (/\b(fan.in|fan.out|circular|layering|round)\b/.test(lower)) {
    const findings2 = await db.finding.findMany({
      where: { caseId, type: { in: ['HIGH_FAN_IN', 'HIGH_FAN_OUT', 'CIRCULAR_TXNS', 'RAPID_HOPPING'] } },
      select: { type: true, severity: true, description: true },
      take: 10,
    })
    if (findings2.length > 0) {
      lines.push('', 'Relevant deterministic findings:')
      for (const f of findings2) lines.push(`- [${f.severity.toUpperCase()}] ${f.type}: ${f.description}`)
    } else {
      lines.push('', 'No fan-in/out/circular/rapid-hop findings are currently detected in this case.')
    }
  }
  return {
    route: 'rules',
    reason: 'count/aggregate question → deterministic SQL',
    answer: lines.join('\n'),
    citations: [],
    data: { entities, transactions: txns.length, volume, evidence, findings, relationships: rels, communications: comms },
  }
}

/** Answer a graph question with real analytics. */
async function answerGraph(db: PrismaClient, q: Query): Promise<RoutedAnswer> {
  const { caseId, lower } = q
  const ctx = await buildPatternContext(db, caseId)
  if (!ctx || ctx.entities.length === 0) {
    return {
      route: 'graph',
      reason: 'network-topology question → graph analytics',
      answer: 'The case graph is empty — ingest evidence first, then topology questions can be answered deterministically.',
      citations: [],
    }
  }
  const g = toGraphInput(ctx.entities, ctx.relationships)
  const metrics = computeAll(g)

  // Join ids → values for readable answers.
  const valueOf = new Map(ctx.entities.map((e) => [e.id, `${e.type}:${e.value}`]))
  const topCentral = Object.entries(metrics.pagerank)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, v]) => `${valueOf.get(id) ?? id} (pagerank ${v.toFixed(3)})`)
  const topBetween = Object.entries(metrics.betweenness)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, v]) => `${valueOf.get(id) ?? id} (betweenness ${v.toFixed(2)})`)

  const lines: string[] = ['**Deterministic answer (graph route — analytics engine, no AI involved)**', '']

  if (/communit|cluster|group/.test(lower)) {
    lines.push(`Label-propagation found ${metrics.communities.length} communities:`)
    for (const c of metrics.communities.slice(0, 6)) {
      lines.push(`- ${c.label ?? 'community'}: ${c.members.length} members — ${c.members.slice(0, 6).map((m) => valueOf.get(m) ?? m).join(', ')}${c.members.length > 6 ? '…' : ''}`)
    }
  } else if (/bridge|broker/.test(lower)) {
    lines.push('Top bridge candidates (highest betweenness):')
    for (const t of topBetween) lines.push(`- ${t}`)
  } else {
    lines.push('Most central actors (PageRank):')
    for (const t of topCentral) lines.push(`- ${t}`)
    lines.push('', 'Strongest bridges (betweenness):')
    for (const t of topBetween) lines.push(`- ${t}`)
  }
  lines.push('', `Graph size: ${g.nodes.length} nodes · ${g.edges.length} edges · ${metrics.components.length} components · ${metrics.communities.length} communities.`)
  return {
    route: 'graph',
    reason: 'network-topology question → graph analytics',
    answer: lines.join('\n'),
    citations: [],
    data: {
      topCentral,
      topBetween,
      communities: metrics.communities.length,
      components: metrics.components.length,
    },
  }
}

/** Answer an FTS question with real search hits. */
async function answerFts(db: PrismaClient, q: Query): Promise<RoutedAnswer> {
  const { caseId, lower } = q
  // Extract the most identifier-like token (longest alphanumeric run with digits).
  const tokens = lower
    .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4)
    .sort((a, b) => (/\d/.test(b) ? 1 : 0) - (/\d/.test(a) ? 1 : 0))
  const needle = tokens[0] ?? ''
  if (!needle) {
    return {
      route: 'fts',
      reason: 'lookup question → full-text search',
      answer: 'No searchable identifier found in the question. Include an account number, phone, UPI, UTR or name.',
      citations: [],
    }
  }
  const [entities, txns, evidence, findings] = await Promise.all([
    db.entity.findMany({
      where: { caseId, OR: [{ value: { contains: needle } }, { norm: { contains: needle } }, { label: { contains: needle } }] },
      take: 8,
      select: { id: true, type: true, value: true, label: true },
    }),
    db.transaction.findMany({
      where: {
        caseId,
        OR: [
          { utr: { contains: needle } },
          { senderAccount: { contains: needle } },
          { receiverAccount: { contains: needle } },
          { upi: { contains: needle } },
          { remarks: { contains: needle } },
        ],
      },
      take: 8,
      select: { id: true, utr: true, amount: true, txnDate: true, senderAccount: true, receiverAccount: true },
    }),
    db.evidence.findMany({
      where: { caseId, OR: [{ originalName: { contains: needle } }, { content: { contains: needle } }] },
      take: 5,
      select: { id: true, originalName: true, classification: true },
    }),
    db.finding.findMany({
      where: { caseId, OR: [{ description: { contains: needle } }, { trigger: { contains: needle } }] },
      take: 5,
      select: { id: true, type: true, severity: true, description: true },
    }),
  ])
  const lines: string[] = [`**Deterministic answer (search route — keyword "${needle}")**`, '']
  lines.push(`Entities (${entities.length}):`)
  for (const e of entities) lines.push(`- [ENT:${e.id}] ${e.type}: ${e.value}${e.label ? ` (${e.label})` : ''}`)
  lines.push(``, `Transactions (${txns.length}):`)
  for (const t of txns) lines.push(`- ${t.txnDate ?? '?'} ${fmtMoney(t.amount)} ${t.senderAccount ?? '?'} → ${t.receiverAccount ?? '?'} utr=${t.utr ?? '—'}`)
  lines.push(``, `Evidence (${evidence.length}):`)
  for (const e of evidence) lines.push(`- [EVID:${e.id}] ${e.originalName}${e.classification ? ` (${e.classification})` : ''}`)
  lines.push(``, `Findings (${findings.length}):`)
  for (const f of findings) lines.push(`- [${f.severity.toUpperCase()}] ${f.type}: ${f.description}`)
  return {
    route: 'fts',
    reason: 'lookup question → full-text search',
    answer: lines.join('\n'),
    citations: evidence.map((e) => e.id),
    data: { entities: entities.length, transactions: txns.length, evidence: evidence.length, findings: findings.length },
  }
}

/** Answer a timeline question with real records. */
async function answerTimeline(db: PrismaClient, q: Query): Promise<RoutedAnswer> {
  const { caseId } = q
  const [events, firstTxn, lastTxn] = await Promise.all([
    db.timelineEvent.findMany({
      where: { caseId },
      orderBy: { ts: 'asc' },
      take: 12,
      select: { id: true, ts: true, kind: true, summary: true },
    }),
    db.transaction.findFirst({ where: { caseId, txnDate: { not: null } }, orderBy: { txnDate: 'asc' }, select: { txnDate: true, amount: true, senderAccount: true, receiverAccount: true } }),
    db.transaction.findFirst({ where: { caseId, txnDate: { not: null } }, orderBy: { txnDate: 'desc' }, select: { txnDate: true, amount: true, senderAccount: true, receiverAccount: true } }),
  ])
  const lines: string[] = ['**Deterministic answer (timeline route — case records)**', '']
  if (firstTxn) lines.push(`First transaction on record: ${firstTxn.txnDate} — ${fmtMoney(firstTxn.amount)} (${firstTxn.senderAccount ?? '?'} → ${firstTxn.receiverAccount ?? '?'})`)
  if (lastTxn) lines.push(`Most recent transaction on record: ${lastTxn.txnDate} — ${fmtMoney(lastTxn.amount)} (${lastTxn.senderAccount ?? '?'} → ${lastTxn.receiverAccount ?? '?'})`)
  lines.push('', 'Earliest timeline events:')
  for (const e of events) lines.push(`- ${e.ts ?? '?'} [${e.kind ?? 'event'}] ${e.summary ?? ''}`)
  return {
    route: 'timeline',
    reason: 'temporal question → timeline records',
    answer: lines.join('\n'),
    citations: [],
  }
}

/**
 * Route a question. Deterministic routes return complete answers; the 'ai'
 * route returns no answer (empty string) and the caller falls through to the
 * RAG + local LLM path.
 */
export async function routeQuestion(
  db: PrismaClient,
  caseId: string,
  message: string,
): Promise<RoutedAnswer> {
  const q: Query = { lower: message.toLowerCase(), caseId }
  const intent = detectIntent(q)
  try {
    switch (intent.route) {
      case 'rules':
        return await answerRules(db, q)
      case 'graph':
        return await answerGraph(db, q)
      case 'fts':
        return await answerFts(db, q)
      case 'timeline':
        return await answerTimeline(db, q)
      default:
        return { route: 'ai', reason: intent.reason, answer: '', citations: [] }
    }
  } catch (err) {
    console.error('[aiRouter] deterministic route failed, falling back to AI:', err)
    return { route: 'ai', reason: `${intent.reason} (deterministic answer failed → AI fallback)`, answer: '', citations: [] }
  }
}
