/**
 * GET /api/cases/[id]/explain — Explainable AI case analysis.
 *
 * Deterministic, citation-first explanation of WHAT the system knows, HOW it
 * reached each conclusion, and HOW MUCH to trust it:
 *
 *   - overview       corpus statistics + coverage/integrity scores + narrative
 *   - files          per-evidence-file role, extraction quality, contributions
 *   - actors         top risk-ranked suspicious actors with the FULL reasoning
 *                    trace (weighted score components + human-readable reasons
 *                    + supporting evidence file names)
 *   - keyFindings    highest-severity pattern detections with involved entities
 *   - contradictions open conflicts in the evidence
 *   - gaps           what is still missing (from the gap engine)
 *   - methodology    the pipeline steps + exact scoring weights (auditable)
 *
 * With ?ai=1 it additionally asks the configured local LLM to write an
 * executive narrative GROUNDED on these computed facts (never inventing data);
 * when the local model is offline the deterministic output still works.
 */
import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { resolveCaseId } from '@/lib/api/helpers'
import { computeGaps } from '@/lib/investigation/gapEngine'
import { CLASS_LABELS, type EvidenceClass } from '@/lib/extractors/classify'
import { DEFAULT_COMPONENT_WEIGHTS } from '@/lib/analytics/actorRisk'
import { localChat, isLocalAiConfigured } from '@/lib/localAi'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

// ─────────────────────────────────────────────────────────────────────────────

const COMPONENT_LABELS: Record<string, string> = {
  networkCentrality: 'Network centrality (betweenness)',
  degree: 'Degree centrality',
  txnVolume: 'Transaction volume',
  txnVelocity: 'Transaction velocity',
  linkedEntities: 'Linked entity count',
  suspiciousPatterns: 'Suspicious pattern involvement',
  communityPosition: 'Community / bridge position',
  bridgeScore: 'Bridge percentile',
  sharedIds: 'Shared identifiers',
  temporalCorrelation: 'Temporal co-occurrence',
  evidenceConfidence: 'Evidence confidence',
}

const ROLE_TEXT: Record<string, string> = {
  bank_statement:
    'Primary financial trail — authoritative per-row money movements that feed the money-flow analytics, pattern engine and account-graph edges.',
  fir:
    'Case origin document — establishes the complaint, sections invoked and the suspected actors the rest of the evidence must corroborate.',
  cdr:
    'Call Detail Record — maps who contacted whom and when; drives temporal-correlation scoring and communication-network communities.',
  whatsapp_chat:
    'Chat export — conversational graph source that links identities, exposes planning language, amounts and shared handles.',
  email:
    'Email corpus — sender/receiver identity links plus quoted identifiers (accounts, UPI IDs, phones) and threat/risk flags.',
  invoice:
    'Financial corroboration — invoices tie people/organizations to specific amounts and dates, cross-checking bank-statement flows.',
  receipt:
    'Financial corroboration — receipts confirm smaller-value exchanges that support or contradict ledger entries.',
  id_document:
    'Identity anchor — pins a person name to government identifiers so other files mentioning those identifiers resolve correctly.',
  contract:
    'Agreement context — binding relationships between parties, obligations and signatures useful for proving association.',
  court_document:
    'Legal context — proceedings content that can corroborate timelines and named participants.',
  property_document:
    'Asset trail — ownership records that can expose benami holdings tied to suspect accounts.',
  travel_record:
    'Movement trail — places an actor geographically at specific times, supporting presence claims from other files.',
  social_media:
    'Public-profile intelligence — aliases, connections and posts that extend identity resolution beyond formal documents.',
  medical_record:
    'Auxiliary record — can certify alibi, injury or hospital-visit timing relevant to statements.',
  screenshot:
    'Visual snippet — usually contains chat/payment screenshots whose extracted entities inherit lower confidence.',
  ledger:
    'Manual accounting book — internal view of expected flows to reconcile against bank reality.',
  other:
    'Unclassified document — parsed safely but treated with reduced weight until an investigator confirms its type.',
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

const ACCOUNT_TYPES = new Set(['account', 'bank_account', 'wallet', 'upi'])

function clamp100(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 0
}

function parseJsonArray<T = unknown>(s: string | null | undefined): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function fmtINR(x: number): string {
  if (!Number.isFinite(x)) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(x)
}

function tierOf(score: number): 'high' | 'medium' | 'low' {
  if (score >= 70) return 'high'
  if (score >= 50) return 'medium'
  return 'low'
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id: idOrUid } = await params
    const caseId = await resolveCaseId(db, idOrUid)
    if (!caseId) {
      return NextResponse.json({ error: 'case not found' }, { status: 404 })
    }

    const [
      caseRow,
      evidence,
      entities,
      relationships,
      transactions,
      commCount,
      findings,
      actorRisks,
      contradictionRows,
      communityRows,
      timelineBounds,
    ] = await Promise.all([
      db.case.findUnique({ where: { id: caseId } }),
      db.evidence.findMany({
        where: { caseId },
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { entityLinks: true, transactions: true, communications: true } },
        },
      }),
      db.entity.findMany({
        where: { caseId },
        select: { id: true, type: true, value: true, norm: true, label: true },
      }),
      db.relationship.findMany({ where: { caseId }, select: { srcId: true, dstId: true } }),
      db.transaction.findMany({
        where: { caseId },
        select: {
          amount: true,
          senderAccount: true,
          receiverAccount: true,
          txnDate: true,
          utr: true,
        },
      }),
      db.communication.count({ where: { caseId } }),
      db.finding.findMany({ where: { caseId }, orderBy: [{ severity: 'asc' }, { confidence: 'desc' }] }),
      db.actorRisk.findMany({
        where: { caseId },
        orderBy: { score: 'desc' },
        take: 10,
        include: { entity: { select: { id: true, type: true, value: true, label: true } } },
      }),
      db.contradiction.findMany({ where: { caseId }, orderBy: { updatedAt: 'desc' } }),
      db.community.findMany({
        where: { caseId },
        orderBy: { size: 'desc' },
        select: { id: true, label: true, size: true, transactionVolume: true },
        take: 6,
      }),
      db.timelineEvent
        .aggregate({ _min: { ts: true }, _max: { ts: true }, where: { caseId } })
        .then((r: { _min: { ts: string | null }; _max: { ts: string | null } }) => ({
          _min: r._min,
          _max: r._max,
        }))
        .catch(() => ({ _min: { ts: null }, _max: { ts: null } })),
    ])

    const entityById = new Map(entities.map((e) => [e.id, e]))

    // ── Neighbor map over raw relationships (for actor→account attribution).
    const neighbors = new Map<string, Set<string>>()
    const ensureN = (id: string) => {
      if (!neighbors.has(id)) neighbors.set(id, new Set())
    }
    for (const e of entities) ensureN(e.id)
    for (const r of relationships) {
      ensureN(r.srcId)
      ensureN(r.dstId)
      neighbors.get(r.srcId)!.add(r.dstId)
      neighbors.get(r.dstId)!.add(r.srcId)
    }

    // ── Evidence-file quality + role analysis ──
    // Findings may reference evidence via supportingEvidence JSON.
    const findingEvidenceNames = new Map<string, number>() // fileName → count
    for (const f of findings) {
      const refs = parseJsonArray<string>(f.supportingEvidence)
      for (const ref of refs) {
        if (typeof ref === 'string') {
          findingEvidenceNames.set(ref, (findingEvidenceNames.get(ref) ?? 0) + 1)
        }
      }
    }

    interface FileCard {
      id: string
      name: string
      classificationKey: string
      classificationLabel: string
      classConfidence: number | null
      classSource: string | null
      status: string
      extractionStatus: string
      sizeKB: number
      shaShort: string
      roleText: string
      contributed: { entities: number; transactions: number; communications: number }
      findingLinks: number
      issues: string[]
      qualityScore: number
    }
    const fileCards: FileCard[] = evidence.map((e) => {
      const issues: string[] = []
      let quality = 100
      const clsKey = (e.classification ?? 'other') as EvidenceClass
      if (e.status !== 'processed' && e.status !== 'done') {
        quality -= 45
        issues.push(`Processing status is "${e.status}"`)
      }
      if ((e.extractionStatus ?? 'pending') === 'pending') {
        quality -= 10
        issues.push('Extraction has not completed')
      }
      if (e.processingErrors && e.processingErrors.trim()) {
        quality -= 25
        issues.push(e.processingErrors.trim().split('\n')[0].slice(0, 160))
      }
      if (!e.classification) {
        quality -= 10
        issues.push('No AI classification — treated as unclassified')
      }
      const nameMatch =
        findingEvidenceNames.get(e.originalName) ??
        [...findingEvidenceNames.entries()].find(([k]) => k.includes(e.originalName))?.[1] ??
        0
      if (nameMatch === 0) {
        issues.push('Not yet cited by any detected pattern')
      }
      const totalContrib =
        e._count.entityLinks + e._count.transactions + e._count.communications
      if (totalContrib === 0 && e.status === 'processed') {
        quality -= 20
        issues.push('Processed but produced no extractable intelligence')
      }
      return {
        id: e.id,
        name: e.originalName,
        classificationKey: clsKey,
        classificationLabel: CLASS_LABELS[clsKey] ?? clsKey,
        classConfidence: e.classificationConfidence,
        classSource: e.classificationSource,
        status: e.status,
        extractionStatus: e.extractionStatus ?? '—',
        sizeKB: Math.round((e.size ?? 0) / 102.4) / 10,
        shaShort: e.sha256.slice(0, 12),
        roleText: ROLE_TEXT[clsKey] ?? ROLE_TEXT.other,
        contributed: {
          entities: e._count.entityLinks,
          transactions: e._count.transactions,
          communications: e._count.communications,
        },
        findingLinks: nameMatch,
        issues,
        qualityScore: clamp100(quality),
      }
    })

    // ── Actor explanations ──
    const amountOf = (a: unknown): number =>
      typeof a === 'number' && Number.isFinite(a) ? a : 0

    interface ActorCard {
      entityId: string
      name: string
      value: string
      type: string
      score: number
      tier: 'high' | 'medium' | 'low'
      topComponents: Array<{
        key: string
        label: string
        weightPct: number
        componentScore: number
        contribution: number
      }>
      reasons: string[]
      evidenceFiles?: string[]
      moneyIn: number
      moneyOut: number
      txnCount: number
    }

    const actorCards: ActorCard[] = actorRisks.map((ar) => {
      let components: Record<string, number> = {}
      try {
        const p = JSON.parse(ar.componentsJson ?? '{}')
        if (p && typeof p === 'object') components = p as Record<string, number>
      } catch {
        /* ignore */
      }
      const reasons = parseJsonArray<string>(ar.contributorsJson)

      // Top components by weighted contribution to the final score.
      const compList = Object.entries(DEFAULT_COMPONENT_WEIGHTS)
        .map(([key, w]) => ({
          key,
          label: COMPONENT_LABELS[key] ?? key,
          weightPct: Math.round(w * 100),
          componentScore: clamp100(components[key] ?? 0),
          contribution: Math.round(clamp100(components[key] ?? 0) * w * 10) / 10,
        }))
        .sort((a, b) => b.contribution - a.contribution)
        .slice(0, 5)

      // Account values attributable to this actor (own + neighbor accounts).
      const acctValues = new Set<string>()
      const ent = ar.entity
      if (ent) {
        if (ACCOUNT_TYPES.has(ent.type)) {
          acctValues.add(ent.value)
          const own = entityById.get(ent.id)
          if (own?.norm) acctValues.add(own.norm)
        }
        for (const nbId of neighbors.get(ent.id) ?? []) {
          const nb = entityById.get(nbId)
          if (nb && ACCOUNT_TYPES.has(nb.type)) {
            acctValues.add(nb.value)
            acctValues.add(nb.norm)
          }
        }
      }
      let moneyIn = 0
      let moneyOut = 0
      let txnCount = 0
      if (acctValues.size > 0) {
        for (const t of transactions) {
          const s = t.senderAccount
          const r = t.receiverAccount
          const isSender = s != null && acctValues.has(s)
          const isReceiver = r != null && acctValues.has(r)
          if (!isSender && !isReceiver) continue
          txnCount++
          if (isSender) moneyOut += amountOf(t.amount)
          if (isReceiver) moneyIn += amountOf(t.amount)
        }
      }

      return {
        entityId: ar.entityId,
        name: ent?.label || ent?.value || ar.entityId,
        value: ent?.value ?? '',
        type: ent?.type ?? 'unknown',
        score: Math.round((ar.score ?? 0) * 10) / 10,
        tier: tierOf(ar.score ?? 0),
        topComponents: compList,
        reasons:
          reasons.length > 0
            ? reasons.slice(0, 6)
            : ['Baseline actor — no strong risk contributors recorded'],
        moneyIn,
        moneyOut,
        txnCount,
      }
    })

    // Batch-resolve supporting evidence names for all top actors at once.
    const actorEntityIds = actorCards.map((a) => a.entityId)
    const entityLinkRows =
      actorEntityIds.length > 0
        ? await db.entityLink.findMany({
            where: { entityId: { in: actorEntityIds } },
            select: { entityId: true, evidence: { select: { originalName: true } } },
            take: 400,
          })
        : []
    const evidenceByActor = new Map<string, string[]>()
    for (const row of entityLinkRows) {
      const list = evidenceByActor.get(row.entityId) ?? []
      if (!list.includes(row.evidence.originalName)) list.push(row.evidence.originalName)
      evidenceByActor.set(row.entityId, list)
    }
    for (const card of actorCards) {
      card.evidenceFiles = (evidenceByActor.get(card.entityId) ?? []).slice(0, 5)
    }

    // ── Key findings ──
    const sortedFindings = [...findings].sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )
    const keyFindings = sortedFindings.slice(0, 12).map((f) => {
      const ids = parseJsonArray<string>(f.entitiesJson).filter((x) => typeof x === 'string')
      return {
        id: f.id,
        type: f.type,
        typeLabel: f.type.replace(/_/g, ' ').toLowerCase(),
        severity: f.severity,
        confidence: Math.round((f.confidence ?? 0) * 100),
        description: f.description,
        entities: ids
          .map((id) => entityById.get(id)?.label || entityById.get(id)?.value)
          .filter(Boolean)
          .slice(0, 8),
        reviewStatus: f.reviewStatus,
        decision: f.decision ?? null,
      }
    })

    // ── Contradictions summary ──
    const openContradictions = contradictionRows.filter((c) => c.status === 'open')

    // ── Overview aggregates ──
    const findingsBySeverity: Record<string, number> = {}
    for (const f of findings) {
      findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] ?? 0) + 1
    }
    const findingsByDecision: Record<string, number> = {}
    for (const f of findings) {
      const d = f.decision ?? f.reviewStatus ?? 'new'
      findingsByDecision[d] = (findingsByDecision[d] ?? 0) + 1
    }
    const totalVolume = transactions.reduce((s, t) => s + amountOf(t.amount), 0)
    const processedFiles = evidence.filter(
      (e) => e.status === 'processed' || e.status === 'done',
    ).length
    const integrityScore = evidence.length
      ? Math.round((processedFiles / evidence.length) * 100)
      : 0
    const classesSeen = new Set(fileCards.map((f) => f.classificationKey))
    const CLASS_COVERAGE = [
      'fir', 'bank_statement', 'cdr', 'whatsapp_chat', 'email', 'id_document',
    ]
    const presentCore = CLASS_COVERAGE.filter((c) => classesSeen.has(c)).length
    const coverageScore = clamp100(
      (presentCore / CLASS_COVERAGE.length) * 70 +
        (evidence.length >= 3 ? 30 : evidence.length * 10),
    )
    const txDates = transactions
      .map((t) => t.txnDate)
      .filter((d): d is string => Boolean(d))
      .sort()
    const timeSpan = {
      from: timelineBounds?._min.ts ?? txDates[0] ?? null,
      to: timelineBounds?._max.ts ?? txDates[txDates.length - 1] ?? null,
    }
    const uncitedFiles = fileCards.filter((f) => f.findingLinks === 0).length

    const overviewNarrative: string[] = []
    if (evidence.length === 0) {
      overviewNarrative.push(
        'This case has no evidence files yet. Every conclusion produced by RED Justice is derived exclusively from uploaded evidence, so the analysis will remain empty until documents are ingested.',
      )
    } else {
      overviewNarrative.push(
        `The case corpus contains ${evidence.length} evidence file${evidence.length === 1 ? '' : 's'} covering ${classesSeen.size} distinct document class${classesSeen.size === 1 ? '' : 'es'} (${[...classesSeen].map((c) => CLASS_LABELS[c as EvidenceClass] ?? c).join(', ')}). Parsing them yielded ${entities.length} unique entities, ${relationships.length} relationship${relationships.length === 1 ? '' : 's'} and ${transactions.length} transaction record${transactions.length === 1 ? '' : 's'} totalling ${fmtINR(totalVolume)}${timeSpan.from && timeSpan.to ? `, spanning ${String(timeSpan.from).slice(0, 10)} → ${String(timeSpan.to).slice(0, 10)}` : ''}.`,
      )
      overviewNarrative.push(
        `${processedFiles} of ${evidence.length} files processed cleanly (integrity ${integrityScore}%). The pattern engine raised ${findings.length} suspicious-pattern finding${findings.length === 1 ? '' : 's'} (${Object.entries(findingsBySeverity).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}) across ${communityRows.length > 0 ? `${communityRows.length} detected network communit${communityRows.length === 1 ? 'y' : 'ies'}` : 'no detected communities'}, while the risk engine prioritized ${actorCards.length} principal actor${actorCards.length === 1 ? '' : 's'} headed by ${actorCards[0] ? `"${actorCards[0].name}" at ${actorCards[0].score}/100` : 'n/a'}.`,
      )
      overviewNarrative.push(
        `Trust posture: coverage ${Math.round(coverageScore)}/100 against recommended evidence classes; ${openContradictions.length} unresolved contradiction${openContradictions.length === 1 ? '' : 's'}; ${uncitedFiles} file${uncitedFiles === 1 ? '' : 's'} not yet cited by any pattern. Findings marked "inferred" rely on co-occurrence rather than direct observation and should be verified against the cited source locators before any legal action.`,
      )
    }

    // High-severity count used in the headline.
    const highSev =
      (findingsBySeverity['high'] ?? 0) + (findingsBySeverity['critical'] ?? 0)

    // ── Gaps (reuse investigation gap engine) ──
    let gapsPayload: {
      total: number
      byFamily: Record<string, number>
      items: Array<{
        family: string
        severity: string
        title: string
        description: string
        recommendation: string
      }>
    } = { total: -1, byFamily: {}, items: [] }
    try {
      const gapReport = await computeGaps(db, caseId)
      gapsPayload = {
        total: gapReport.total,
        byFamily: gapReport.byFamily,
        items: gapReport.gaps.slice(0, 12).map((g) => ({
          family: g.family,
          severity: g.severity,
          title: g.title,
          description: g.description,
          recommendation: g.recommendation,
        })),
      }
    } catch {
      /* keep sentinel */
    }

    const payload: Record<string, unknown> = {
      case: caseRow
        ? {
            id: caseRow.id,
            uid: caseRow.uid,
            title: caseRow.title,
            status: caseRow.status,
            classification: caseRow.classification,
            createdAt: caseRow.createdAt,
          }
        : null,
      generatedAt: new Date().toISOString(),
      deterministic: true,
      overview: {
        evidenceFiles: evidence.length,
        entities: entities.length,
        relationships: relationships.length,
        transactions: transactions.length,
        communications: commCount,
        totalVolume,
        findingsTotal: findings.length,
        findingsBySeverity,
        findingsByDecision,
        communities: communityRows.map((c) => ({
          label: c.label ?? 'unnamed',
          size: c.size,
          volume: c.transactionVolume ?? 0,
        })),
        coverageScore: Math.round(coverageScore),
        integrityScore,
        timeSpan,
        headline:
          evidence.length === 0
            ? 'Awaiting evidence ingestion'
            : findings.length === 0
              ? 'Evidence ingested — no suspicious patterns detected yet'
              : `${openContradictions.length > 0 ? 'Contested' : 'Consistent'} picture · ${highSev} high-severity signal${highSev === 1 ? '' : 's'} · lead suspect ${actorCards[0]?.name ?? 'unknown'}`,
        narrative: overviewNarrative,
      },
      files: fileCards,
      actors: actorCards,
      keyFindings,
      contradictions: {
        open: openContradictions.length,
        resolved: contradictionRows.length - openContradictions.length,
        samples: openContradictions.slice(0, 5).map((c) => ({
          id: c.id,
          description: c.description,
          relation: c.relation,
        })),
      },
      gaps: gapsPayload,
      methodology: {
        steps: [
          {
            title: '1 · Ingest & hash',
            detail:
              'Every uploaded file is SHA-256 fingerprinted, safely stored and parsed into text so downstream steps are reproducible from immutable sources.',
          },
          {
            title: '2 · Classify',
            detail:
              'A deterministic keyword/structure classifier assigns each file an evidence class (FIR, bank statement, CDR…); the local AI refines it when available.',
          },
          {
            title: '3 · Extract',
            detail:
              'Type-specific extractors pull entities (people, accounts, UPI IDs, phones), transactions and messages with provenance locators retained.',
          },
          {
            title: '4 · Resolve & link',
            detail:
              'Normalized values merge duplicate mentions into canonical entities; TRANSFERRED_TO, SHARED_IDENTIFIER and CO_OCCURRED relationships build the knowledge graph.',
          },
          {
            title: '5 · Analyze',
            detail:
              'Graph analytics (degree, betweenness, PageRank, community detection), money-flow metrics and rule-based pattern detection run offline deterministically.',
          },
          {
            title: '6 · Score actors',
            detail:
              'Each actor receives a 0–100 risk score as the weighted sum of 11 named components listed below — every contributor line maps back to one of them.',
          },
          {
            title: '7 · Explain',
            detail:
              'This panel converts intermediate artifacts into human-readable reasoning with citations; nothing calls out to a black-box model unless you explicitly request the optional AI brief.',
          },
        ],
        weights: Object.entries(DEFAULT_COMPONENT_WEIGHTS).map(([k, v]) => ({
          key: k,
          label: COMPONENT_LABELS[k] ?? k,
          weightPct: Math.round(v * 100),
        })),
        verStates:
          'observed = seen in exactly one source · corroborated = supported by ≥2 independent files · inferred = derived via co-occurrence/shared identifiers · uncertain = confidence < 0.50.',
        disclaimer:
          'Advisory output only. All conclusions must be reviewed by a qualified investigator before operational use.',
      },
    }

    // ── Optional grounded LLM narrative (?ai=1) ──
    const wantAi = req.nextUrl.searchParams.get('ai') === '1'
    if (wantAi) {
      if (!isLocalAiConfigured()) {
        payload.aiNarrative = null
        payload.aiModel = null
        payload.aiError =
          'Local AI is not configured (Settings → AI backend). The deterministic analysis above remains fully valid.'
      } else {
        const gapsItems = gapsPayload.items.map((g) => g.title)
        const facts = {
          caseUid: caseRow?.uid,
          stats: payload.overview,
          files: fileCards.map((f) => ({
            name: f.name,
            type: f.classificationLabel,
            quality: f.qualityScore,
            contributed: f.contributed,
          })),
          topActors: actorCards.map((a) => ({
            name: a.name,
            score: a.score,
            reasons: a.reasons,
            moneyIn: a.moneyIn,
            moneyOut: a.moneyOut,
          })),
          keyFindings: keyFindings.map((k) => ({
            type: k.typeLabel,
            severity: k.severity,
            description: k.description,
            entities: k.entities,
          })),
          gaps: gapsItems.slice(0, 6),
        }
        const sys =
          'You are a forensic-analysis explainer inside the RED Justice platform. Using ONLY the JSON facts provided, write a tight executive brief in ENGLISH for a senior investigating officer. Structure EXACTLY as: 3 short paragraphs separated by blank lines — (1) Situation & evidence base, (2) Principal suspects with concrete numbers and why they rank highest, (3) Confidence caveats and next investigative steps. Never invent facts not present in the JSON. Plain text, no markdown headings.'
        // v3.3 tier routing: the executive brief is reasoning over case facts
        // → DEEP tier with chain-of-thought ENABLED (quality over latency on
        // an on-demand brief). The larger token budget leaves room for both
        // the thinking channel and the final 3-paragraph answer.
        const { modelForTier } = await import('@/lib/modelTiers')
        const deepModel = await modelForTier('deep')
        const narrative = await localChat(
          [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify(facts) },
          ],
          { temperature: 0.25, maxTokens: 3000, model: deepModel },
        )
        payload.aiNarrative =
          narrative && narrative.trim().length > 40 ? narrative.trim() : null
        payload.aiModel = deepModel
        if (!payload.aiNarrative) {
          payload.aiError =
            'Local AI did not return a usable narrative (server offline or timed out). Deterministic analysis is unaffected.'
        }
      }
    }

    return NextResponse.json(payload)
  } catch (err) {
    console.error('[api/cases/[id]/explain] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'explain failed' },
      { status: 500 },
    )
  }
}
