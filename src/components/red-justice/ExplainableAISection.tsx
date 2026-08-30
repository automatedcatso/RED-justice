'use client'

/**
 * ExplainableAISection — structured "Explainable AI" case analysis card for
 * the Investigation Dashboard.
 *
 * Renders the output of GET /api/cases/[id]/explain in six investigator-facing
 * tabs:
 *   1. Overview        — verdict headline, coverage/integrity gauges, narrative
 *   2. Evidence Files  — per-file role, quality score, contributions, issues
 *   3. Suspicious Actors — ranked risk scores with FULL reasoning traces
 *   4. Key Findings    — top pattern detections with involved entities
 *   5. Gaps & Conflicts— missing evidence families + open contradictions
 *   6. Methodology     — pipeline steps, exact score weights, disclaimer
 *
 * An optional "Generate AI brief" button asks the local LLM to summarize the
 * deterministic facts (grounded; falls back gracefully when offline).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  FlaskConical,
  HelpCircle,
  IndianRupee,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  formatINR,
  formatNumber,
  severityMeta,
  FINDING_TYPE_LABELS,
} from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'
import { cn } from '@/lib/utils'

// ── Response types ───────────────────────────────────────────────────────────

interface ExplainFile {
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

interface ExplainActor {
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

interface ExplainFinding {
  id: string
  type: string
  typeLabel: string
  severity: string
  confidence: number
  description: string
  entities: string[]
  reviewStatus: string
  decision: string | null
}

interface ExplainGap {
  family: string
  severity: string
  title: string
  description: string
  recommendation: string
}

interface ExplainPayload {
  case: { id: string; uid: string; title: string; status: string } | null
  generatedAt: string
  deterministic: boolean
  overview: {
    evidenceFiles: number
    entities: number
    relationships: number
    transactions: number
    communications: number
    totalVolume: number
    findingsTotal: number
    findingsBySeverity: Record<string, number>
    findingsByDecision: Record<string, number>
    communities: Array<{ label: string; size: number; volume: number }>
    coverageScore: number
    integrityScore: number
    timeSpan: { from: string | null; to: string | null }
    headline: string
    narrative: string[]
  }
  files: ExplainFile[]
  actors: ExplainActor[]
  keyFindings: ExplainFinding[]
  contradictions: {
    open: number
    resolved: number
    samples: Array<{ id: string; description: string; relation: string }>
  }
  gaps: {
    total: number
    byFamily: Record<string, number>
    items: ExplainGap[]
  } | null
  methodology: {
    steps: Array<{ title: string; detail: string }>
    weights: Array<{ key: string; label: string; weightPct: number }>
    verStates: string
    disclaimer: string
  }
  aiNarrative?: string | null
  aiModel?: string | null
  aiError?: string | null
}

type TabKey = 'overview' | 'files' | 'actors' | 'findings' | 'gaps' | 'method'

const TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'overview', label: 'Overview', icon: <Sparkles className="size-3.5" /> },
  { key: 'files', label: 'Evidence Files', icon: <FileText className="size-3.5" /> },
  { key: 'actors', label: 'Suspicious Actors', icon: <ShieldAlert className="size-3.5" /> },
  { key: 'findings', label: 'Key Findings', icon: <ListChecks className="size-3.5" /> },
  { key: 'gaps', label: 'Gaps & Conflicts', icon: <HelpCircle className="size-3.5" /> },
  { key: 'method', label: 'Methodology', icon: <FlaskConical className="size-3.5" /> },
]

interface Props {
  activeCaseId: string | null
  onNavigate: (section: string) => void
}

export function ExplainableAISection({ activeCaseId }: Props) {
  const [data, setData] = useState<ExplainPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [aiBusy, setAiBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [openActor, setOpenActor] = useState<string | null>(null)

  const load = useCallback(
    async (withAi = false) => {
      if (!activeCaseId) return
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/cases/${encodeURIComponent(activeCaseId)}/explain${withAi ? '?ai=1' : ''}`,
          // The optional LLM brief can take a while — only stretch timeout when asked.
          ...(withAi ? [{ signal: AbortSignal.timeout(90_000) }] : []),
        )
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b?.error || `HTTP ${res.status}`)
        }
        setData((await res.json()) as ExplainPayload)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'explain failed')
      } finally {
        setLoading(false)
        setAiBusy(false)
      }
    },
    [activeCaseId],
  )

  useEffect(() => {
    setData(null)
    setError(null)
    setTab('overview')
    if (activeCaseId) void load()
  }, [activeCaseId, load])

  // Live refresh when the knowledge graph changes (AI scans, merges…) so the
  // ranked suspicious actors / XAI tabs never go stale.
  useGraphRefresh(() => {
    void load()
  })

  const copyJson = useCallback(() => {
    if (!data) return
    try {
      void navigator.clipboard.writeText(JSON.stringify(data, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }, [data])

  const downloadJson = useCallback(() => {
    if (!data) return
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `explainable-analysis-${data.case?.uid ?? 'case'}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* download unavailable */
    }
  }, [data])

  const generateAiBrief = useCallback(async () => {
    if (!data || aiBusy) return
    setOpenActor(null)
    setTab('overview')
    setAiBusy(true)
    await load(true)
  }, [data, aiBusy, load])

  if (!activeCaseId) {
    return (
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
        <CardContent className="flex items-center gap-3 p-4">
          <Brain className="h-5 w-5 text-crimson-400" />
          <div className="flex-1">
            <div className="text-sm font-medium">Explainable AI Analysis</div>
            <div className="text-xs text-muted-foreground">
              Select an active case to see how every conclusion was derived — evidence roles, suspicious-actor reasoning and confidence caveats.
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden border-primary/30 bg-gradient-to-br from-primary/[0.04] via-transparent to-crimson-900/10">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Brain className="h-5 w-5 text-crimson-400" />
          <CardTitle className="text-base">Explainable AI Analysis</CardTitle>
          {data?.case && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {data.case.title} · {data.case.uid}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant={aiBusy ? 'default' : 'outline'}
              onClick={() => void generateAiBrief()}
              disabled={loading || !!error || aiBusy}
              title="Ask the configured local LLM for a grounded executive brief"
            >
              <Sparkles className={cn('mr-1.5 h-3.5 w-3.5', aiBusy && 'animate-pulse')} />
              {aiBusy ? 'Thinking…' : data?.aiNarrative ? 'Regenerate AI brief' : 'Generate AI brief'}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => void load()}
              title="Recompute analysis"
              disabled={loading}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <CardDescription>
          Deterministic reasoning over this case — what the system concluded, why it
          concluded it, and how much to trust each part. No black-box involved unless
          you request the AI brief.
        </CardDescription>

        {/* Tabs */}
        {data && (
          <div className="mt-2 flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors',
                  tab === t.key
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-background text-foreground/75 hover:bg-accent',
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent>
        {loading && !data && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Computing explanation…
          </div>
        )}

        {!loading && error && !data && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
            <div className="font-medium text-destructive">Failed to compute analysis</div>
            <div className="mt-1 font-mono text-xs text-destructive/80">{error}</div>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}

        {data && !error && (
          <>
            {/* AI brief result banner */}
            {(data.aiNarrative || data.aiError) && tab === 'overview' && (
              <div
                className={cn(
                  'mb-4 rounded-lg border p-4',
                  data.aiNarrative
                    ? 'border-sky-800/50 bg-sky-950/30'
                    : 'border-amber-800/50 bg-amber-950/30',
                )}
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
                  <Sparkles className={cn('size-3.5', data.aiNarrative ? 'text-sky-300' : 'text-amber-300')} />
                  {data.aiNarrative ? `Grounded AI brief (${data.aiModel})` : 'AI brief unavailable'}
                </div>
                {data.aiNarrative ? (
                  <div className="space-y-2 whitespace-pre-wrap text-sm leading-relaxed text-sky-50/90">
                    {data.aiNarrative}
                  </div>
                ) : (
                  <div className="text-xs text-amber-200/90">{data.aiError}</div>
                )}
                <Separator className="my-3" />
              </div>
            )}

            {tab === 'overview' && <OverviewTab data={data} />}
            {tab === 'files' && <FilesTab data={data} />}
            {tab === 'actors' && (
              <ActorsTab data={data} openActor={openActor} setOpenActor={setOpenActor} />
            )}
            {tab === 'findings' && <FindingsTab data={data} />}
            {tab === 'gaps' && <GapsTab data={data} />}
            {tab === 'method' && <MethodTab data={data} />}

            {/* Footer actions */}
            <div className="mt-4 flex items-center justify-between gap-2 border-t pt-3">
              <span className="font-mono text-[10px] text-muted-foreground">
                Generated {new Date(data.generatedAt).toLocaleString('en-IN')}
                {' · '}
                {data.deterministic ? 'deterministic pipeline' : ''}
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={copyJson}>
                  {copied ? <Check className="mr-1.5 size-3.5 text-emerald-400" /> : <Copy className="mr-1.5 size-3.5" />}
                  {copied ? 'Copied' : 'Copy JSON'}
                </Button>
                <Button size="sm" variant="ghost" onClick={downloadJson}>
                  <Download className="mr-1.5 size-3.5" />
                  Export
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Shared small pieces ──────────────────────────────────────────────────────

function Gauge({ label, value }: { label: string; value: number }) {
  const color =
    value >= 75 ? 'from-emerald-600 to-emerald-400' : value >= 45 ? 'from-amber-600 to-amber-400' : 'from-rose-700 to-rose-500'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono">{value}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/50">
        <div className={cn('h-full rounded-full bg-gradient-to-r', color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', tone ?? 'border-border bg-muted/30')}>
      {children}
    </span>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: ExplainPayload }) {
  const o = data.overview
  const statChips: Array<[string, string]> = [
    ['Evidence files', String(o.evidenceFiles)],
    ['Entities', formatNumber(o.entities)],
    ['Relationships', formatNumber(o.relationships)],
    ['Transactions', formatNumber(o.transactions)],
    ['Communications', formatNumber(o.communications)],
    ['Money volume', formatINR(o.totalVolume)],
  ]
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-crimson-800/40 bg-crimson-950/25 p-4">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-crimson-300">
          <AlertTriangle className="size-3.5" />
          Verdict headline
        </div>
        <div className="text-sm font-medium">{o.headline}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Gauge label="Evidence coverage" value={o.coverageScore} />
        <Gauge label="Pipeline integrity" value={o.integrityScore} />
        <Gauge
          label="High-severity signals"
          value={Math.min(100, (o.findingsBySeverity.high ?? 0) * 12 + (o.findingsBySeverity.critical ?? 0) * 22)}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {statChips.map(([k, v]) => (
          <Chip key={k}>
            {k}: <b className="font-mono">{v}</b>
          </Chip>
        ))}
      </div>

      <div className="space-y-2.5 rounded-lg border bg-background/60 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Narrative summary (deterministic)
        </div>
        {o.narrative.map((p, i) => (
          <p key={`narr-${i}`} className="text-sm leading-relaxed text-foreground/90">
            {p}
          </p>
        ))}
      </div>

      {o.communities.length > 0 && (
        <div className="rounded-lg border bg-background/60 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Network communities detected
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {o.communities.map((c, i) => (
              <div key={`comm-${i}`} className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs">
                <span className="truncate font-medium">{c.label}</span>
                <Chip>{c.size} members</Chip>
                {c.volume > 0 && (
                  <Chip tone="border-emerald-800/50 bg-emerald-950/30 text-emerald-300">
                    <IndianRupee className="inline size-2.5" />
                    {formatNumber(Math.round(c.volume))}
                  </Chip>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Evidence files ───────────────────────────────────────────────────────────

function FilesTab({ data }: { data: ExplainPayload }) {
  if (data.files.length === 0) {
    return <EmptyRow text="No evidence files ingested yet." />
  }
  return (
    <div className="space-y-3">
      {data.files.map((f) => (
        <div key={f.id} className="rounded-lg border bg-background/60 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="size-4 shrink-0 text-sky-300" />
            <span className="min-w-0 max-w-[46%] truncate text-sm font-medium" title={f.name}>
              {f.name}
            </span>
            <Badge variant="secondary" className="text-[10px] uppercase">
              {f.classificationLabel}
            </Badge>
            {f.classConfidence != null && (
              <Chip tone="border-border">
                classify {(f.classConfidence * 100).toFixed(0)}% ({f.classSource ?? '?'})
              </Chip>
            )}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {f.sizeKB} KB · sha:{f.shaShort}
            </span>
          </div>

          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.roleText}</p>

          <div className="mt-2.5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Extraction quality</span>
                <span className="font-mono">{f.qualityScore}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted/50">
                <div
                  className={cn(
                    'h-full rounded-full bg-gradient-to-r',
                    f.qualityScore >= 80
                      ? 'from-emerald-600 to-emerald-400'
                      : f.qualityScore >= 55
                        ? 'from-amber-600 to-amber-400'
                        : 'from-rose-700 to-rose-500',
                  )}
                  style={{ width: `${f.qualityScore}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip>{f.contributed.entities} entities</Chip>
              <Chip>{f.contributed.transactions} txns</Chip>
              <Chip>{f.contributed.communications} comms</Chip>
              <Chip tone={f.findingLinks > 0 ? 'border-rose-800/60 bg-rose-950/30 text-rose-300' : 'border-border'}>
                {f.findingLinks} pattern citation{f.findingLinks === 1 ? '' : 's'}
              </Chip>
            </div>
          </div>

          {f.issues.length > 0 && (
            <ul className="mt-2 space-y-0.5 border-t pt-2">
              {f.issues.slice(0, 4).map((iss, i) => (
                <li key={i} className="text-[11px] text-amber-300/90">
                  ⚠ {iss}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Suspicious actors ────────────────────────────────────────────────────────

function ActorsTab({
  data,
  openActor,
  setOpenActor,
}: {
  data: ExplainPayload
  openActor: string | null
  setOpenActor: (s: string | null) => void
}) {
  if (data.actors.length === 0) {
    return <EmptyRow text="No actor risk scores yet — run actor prioritization from the Actors view." />
  }
  return (
    <div className="space-y-2.5">
      {data.actors.map((a, idx) => {
        const open = openActor === a.entityId
        const tierColor =
          a.tier === 'high'
            ? 'text-rose-300 border-rose-800 bg-rose-950/50'
            : a.tier === 'medium'
              ? 'text-amber-300 border-amber-800 bg-amber-950/50'
              : 'text-sky-300 border-sky-800 bg-sky-950/50'
        return (
          <div key={a.entityId} className="rounded-lg border bg-background/60">
            <button
              type="button"
              onClick={() => setOpenActor(open ? null : a.entityId)}
              className="flex w-full flex-wrap items-center gap-2.5 p-3 text-left hover:bg-accent/40"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]">
                {idx + 1}
              </span>
              <ShieldAlert
                className={cn(
                  'size-4 shrink-0',
                  a.tier === 'high' ? 'text-rose-400' : a.tier === 'medium' ? 'text-amber-400' : 'text-sky-400',
                )}
              />
              <span className="max-w-[38%] truncate text-sm font-medium" title={a.value}>
                {a.name}
              </span>
              <Badge variant="outline" className="text-[10px] capitalize">
                {a.type}
              </Badge>
              <Chip tone={tierColor}>{a.tier} priority</Chip>
              <div className="ml-auto flex items-center gap-2">
                <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-muted/50 sm:block">
                  <div
                    className={cn(
                      'h-full rounded-full bg-gradient-to-r',
                      a.tier === 'high'
                        ? 'from-rose-700 to-rose-500'
                        : a.tier === 'medium'
                          ? 'from-amber-600 to-amber-400'
                          : 'from-sky-700 to-sky-500',
                    )}
                    style={{ width: `${a.score}%` }}
                  />
                </div>
                <span className="font-mono text-sm font-bold">{a.score}</span>
                <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
              </div>
            </button>

            {open && (
              <div className="space-y-3 border-t p-3.5">
                <div>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Why this score
                  </div>
                  <ul className="space-y-1">
                    {a.reasons.map((r, i) => (
                      <li key={i} className="flex gap-1.5 text-xs leading-relaxed">
                        <span className="text-crimson-400">▸</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Weighted component breakdown (contribution to final score)
                  </div>
                  <div className="space-y-1.5">
                    {a.topComponents.map((c) => (
                      <div key={c.key} className="flex items-center gap-2">
                        <span className="w-56 shrink-0 truncate text-[11px]" title={c.label}>
                          {c.label}
                          <span className="ml-1 text-muted-foreground">({c.weightPct}% weight)</span>
                        </span>
                        <div className="relative h-2 flex-1 overflow-hidden rounded bg-muted/40">
                          <div
                            className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-crimson-700 to-rose-500"
                            style={{ width: `${Math.min(100, c.componentScore)}%` }}
                          />
                        </div>
                        <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                          {c.componentScore.toFixed(0)} → +{c.contribution.toFixed(1)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {a.txnCount > 0 && (
                    <>
                      <Chip tone="border-emerald-800/50 bg-emerald-950/30 text-emerald-300">
                        money in {formatINR(a.moneyIn)}
                      </Chip>
                      <Chip tone="border-rose-800/50 bg-rose-950/30 text-rose-300">
                        money out {formatINR(a.moneyOut)}
                      </Chip>
                      <Chip>{a.txnCount} linked txns</Chip>
                    </>
                  )}
                  {(a.evidenceFiles ?? []).length > 0 && (
                    <Chip tone="border-sky-800/50 bg-sky-950/30 text-sky-300">
                      evidenced by: {(a.evidenceFiles ?? []).join(', ')}
                    </Chip>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Key findings ─────────────────────────────────────────────────────────────

function FindingsTab({ data }: { data: ExplainPayload }) {
  if (data.keyFindings.length === 0) {
    return <EmptyRow text="No pattern findings recorded yet." />
  }
  return (
    <div className="space-y-2">
      {data.keyFindings.map((f) => {
        const sev = severityMeta(f.severity)
        return (
          <div key={f.id} className={cn('rounded-lg border p-3', sev.bg)}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('text-[10px] font-bold uppercase tracking-wider', sev.color)}>
                {sev.label}
              </span>
              <span className="text-xs font-semibold capitalize">
                {FINDING_TYPE_LABELS[f.type] ?? f.typeLabel}
              </span>
              <Chip tone="border-border">confidence {f.confidence}%</Chip>
              {f.decision ? (
                <Chip tone="border-emerald-800/50 bg-emerald-950/30 text-emerald-300">
                  reviewed: {f.decision}
                </Chip>
              ) : (
                <Chip tone="border-border">awaiting review</Chip>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed">{f.description}</p>
            {f.entities.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {f.entities.map((entName) => (
                  <span
                    key={entName}
                    className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    {entName}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Gaps & conflicts ─────────────────────────────────────────────────────────

function GapsTab({ data }: { data: ExplainPayload }) {
  const c = data.contradictions
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background/60 p-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <HelpCircle className="size-3.5" />
          Evidence conflicts
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip tone={c.open > 0 ? 'border-rose-800/60 bg-rose-950/40 text-rose-300' : 'border-emerald-800/50 bg-emerald-950/30 text-emerald-300'}>
            {c.open} open contradiction{c.open === 1 ? '' : 's'}
          </Chip>
          <Chip>{c.resolved} resolved</Chip>
        </div>
        {c.samples.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {c.samples.map((s) => (
              <li key={s.id} className="rounded border-l-2 border-rose-700/60 bg-muted/20 px-2.5 py-1.5 text-xs">
                {s.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.gaps == null ? (
        <EmptyRow text="Gap engine did not run (unexpected)." />
      ) : data.gaps.total <= 0 ? (
        <EmptyRow text="No investigation gaps detected — the corpus covers the recommended evidence classes." />
      ) : (
        <div className="space-y-2">
          {data.gaps.items.map((g, i) => {
            const sev = severityMeta(g.severity)
            return (
              <div key={i} className={cn('rounded-lg border p-3', sev.bg)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-[10px] font-bold uppercase tracking-wider', sev.color)}>
                    {sev.label}
                  </span>
                  <Chip tone="border-border">{g.family.replace(/_/g, ' ')}</Chip>
                  <span className="text-xs font-semibold">{g.title}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed">{g.description}</p>
                <p className="mt-1.5 text-xs text-emerald-300/90">
                  <b>Recommended next step:</b> {g.recommendation}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Methodology ──────────────────────────────────────────────────────────────

function MethodTab({ data }: { data: ExplainPayload }) {
  const m = data.methodology
  const maxWeight = useMemo(
    () => Math.max(...m.weights.map((w) => w.weightPct), 1),
    [m.weights],
  )
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background/60 p-4">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          How conclusions were produced (7-step auditable pipeline)
        </div>
        <ol className="space-y-2.5">
          {m.steps.map((s) => (
            <li key={s.title} className="text-sm leading-relaxed">
              <span className="font-medium text-crimson-300">{s.title.split('·')[0].trim()}.</span>{' '}
              <span className="text-foreground/85">{s.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-lg border bg-background/60 p-4">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Actor risk scoring weights (sum ≈ 100%)
        </div>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {m.weights.map((w) => (
            <div key={w.key} className="flex items-center gap-2">
              <span className="w-52 shrink-0 truncate text-[11px]" title={w.label}>
                {w.label}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded bg-muted/40">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-purple-700 to-purple-500"
                  style={{ width: `${(w.weightPct / maxWeight) * 100}%` }}
                />
              </div>
              <span className="w-9 shrink-0 text-right font-mono text-[10px]">{w.weightPct}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-background/60 p-4 text-xs leading-relaxed">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Verdict-state semantics & disclaimer
        </div>
        <p>{m.verStates}</p>
        <Separator className="my-2.5" />
        <p className="text-muted-foreground">{m.disclaimer}</p>
      </div>
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}
