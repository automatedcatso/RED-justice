'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  RefreshCw,
  Play,
  Filter,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  GitBranch,
  Check,
  X,
  Pencil,
  History,
  Scale,
  Loader2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import {
  api,
  type Finding,
  type Contradiction,
  type SufficiencyScore,
  type ReplayTrace,
} from '@/lib/api-client'
import { severityMeta, FINDING_TYPE_LABELS, parseJsonArray, timeAgo } from '@/lib/ui-helpers'
import { useGraphRefresh, notifyGraphUpdated } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

interface FindingWithExtras extends Finding {
  sufficiency?: SufficiencyScore | null
  decision?: string | null
  decidedAt?: string | null
  decidedBy?: string | null
  decisionNote?: string | null
}

const SUFF_BAND_COLOR: Record<string, string> = {
  strong: 'bg-emerald-500',
  sufficient: 'bg-lime-500',
  partial: 'bg-amber-500',
  insufficient: 'bg-rose-500',
}

const RELATION_META: Record<string, { label: string; color: string }> = {
  contradicts: { label: 'Contradicts', color: 'border-rose-700 bg-rose-950/30 text-rose-300' },
  supports: { label: 'Supports', color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300' },
  supersedes: { label: 'Supersedes', color: 'border-amber-700 bg-amber-950/30 text-amber-300' },
  unresolved: { label: 'Unresolved', color: 'border-slate-600 bg-slate-950/30 text-slate-300' },
}

export function PatternsView({ caseId }: Props) {
  const { toast } = useToast()
  const [findings, setFindings] = useState<FindingWithExtras[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Decision record dialog
  const [decideTarget, setDecideTarget] = useState<FindingWithExtras | null>(null)
  const [decisionKind, setDecisionKind] = useState<'approved' | 'rejected' | 'modified'>('approved')
  const [decisionNote, setDecisionNote] = useState('')
  const [modifiedDesc, setModifiedDesc] = useState('')
  const [deciding, setDeciding] = useState(false)

  // Replay dialog
  const [replayTarget, setReplayTarget] = useState<FindingWithExtras | null>(null)
  const [replayTrace, setReplayTrace] = useState<ReplayTrace | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)

  // ── Contradictions state ──
  const [contradictions, setContradictions] = useState<Contradiction[]>([])
  const [contradictionsLoading, setContradictionsLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setFindings(((await api.patterns(caseId)) as unknown) as FindingWithExtras[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load findings')
    } finally {
      setLoading(false)
    }
  }

  const loadContradictions = async () => {
    setContradictionsLoading(true)
    try {
      const r = await api.contradictions(caseId)
      setContradictions(r.contradictions)
    } catch {
      setContradictions([])
    } finally {
      setContradictionsLoading(false)
    }
  }

  useEffect(() => {
    load()
    loadContradictions()
  }, [caseId])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
    void loadContradictions()
  })

  const runPatterns = async () => {
    setRunning(true)
    try {
      await api.runPatterns(caseId)
      await load()
      notifyGraphUpdated({ reason: 'patterns-run' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'run failed')
    } finally {
      setRunning(false)
    }
  }

  const runDetection = async () => {
    setDetecting(true)
    try {
      const r = await api.runContradictionDetection(caseId)
      toast({
        title: 'Contradiction detection complete',
        description: `${r.created} new of ${r.detected} detected`,
      })
      await loadContradictions()
    } catch (e) {
      toast({
        title: 'Detection failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setDetecting(false)
    }
  }

  const handleDecide = async () => {
    if (!decideTarget) return
    setDeciding(true)
    try {
      await api.decideFinding(
        caseId,
        decideTarget.id,
        decisionKind,
        decisionNote.trim() || undefined,
        decisionKind === 'modified' ? modifiedDesc.trim() || undefined : undefined,
      )
      toast({ title: `Decision recorded: ${decisionKind}` })
      setDecideTarget(null)
      setDecisionNote('')
      setModifiedDesc('')
      await load()
      notifyGraphUpdated({ reason: 'finding-decision' })
    } catch (e) {
      toast({
        title: 'Decision failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setDeciding(false)
    }
  }

  const openReplay = async (f: FindingWithExtras) => {
    setReplayTarget(f)
    setReplayTrace(null)
    setReplayLoading(true)
    try {
      setReplayTrace(await api.replayFinding(caseId, f.id))
    } catch {
      setReplayTrace(null)
    } finally {
      setReplayLoading(false)
    }
  }

  const handleResolve = async (c: Contradiction, status: 'resolved' | 'accepted') => {
    setResolvingId(c.id)
    try {
      await api.resolveContradiction(caseId, c.id, status)
      await loadContradictions()
      notifyGraphUpdated({ reason: 'contradiction-resolve' })
      toast({ title: `Contradiction ${status}` })
    } catch (e) {
      toast({
        title: 'Resolve failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setResolvingId(null)
    }
  }

  const types = useMemo(() => {
    const set = new Set<string>()
    findings.forEach((f) => set.add(f.type))
    return Array.from(set).sort()
  }, [findings])

  const filtered = useMemo(() => {
    return findings.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) return false
      if (typeFilter !== 'all' && f.type !== typeFilter) return false
      return true
    })
  }, [findings, severityFilter, typeFilter])

  const bySeverity = useMemo(() => {
    const m: Record<string, number> = {}
    findings.forEach((f) => {
      m[f.severity] = (m[f.severity] ?? 0) + 1
    })
    return m
  }, [findings])

  const openContradictions = contradictions.filter((c) => c.status === 'open')

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Suspicious Pattern Engine
          </h2>
          <p className="text-sm text-muted-foreground">
            {findings.length} findings · {openContradictions.length} open contradictions · explainable detection with sufficiency scoring.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={runPatterns} disabled={running} size="sm">
            <Play className="mr-2 h-4 w-4" />
            {running ? 'Running…' : 'Re-run detection'}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Tabs defaultValue="findings">
        <TabsList>
          <TabsTrigger value="findings">
            Findings ({findings.length})
          </TabsTrigger>
          <TabsTrigger value="contradictions" className="gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            Contradictions ({contradictions.length})
          </TabsTrigger>
        </TabsList>

        {/* ── Findings tab ── */}
        <TabsContent value="findings" className="space-y-4">
          {/* Severity summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {['critical', 'high', 'medium', 'low', 'info'].map((sev) => {
              const m = severityMeta(sev)
              const count = bySeverity[sev] ?? 0
              return (
                <Card key={sev} className={`${m.bg} ${m.border}`}>
                  <CardContent className="p-3">
                    <div className={`text-[10px] uppercase tracking-wider ${m.color}`}>{m.label}</div>
                    <div className={`mt-1 font-mono text-xl font-bold ${m.color}`}>{count}</div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* Filters */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 p-3">
              <Select value={severityFilter} onValueChange={setSeverityFilter}>
                <SelectTrigger className="w-40">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {FINDING_TYPE_LABELS[t] ?? t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="ml-auto text-[11px] text-muted-foreground">
                {filtered.length} of {findings.length}
              </div>
            </CardContent>
          </Card>

          {/* Findings */}
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading findings…</div>
          ) : filtered.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No findings match</p>
                  <p className="text-xs text-muted-foreground">Adjust filters or re-run detection.</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <ScrollArea className="scroll-area-short">
                  <div className="divide-y divide-border/40">
                    {filtered.map((f) => {
                      const m = severityMeta(f.severity)
                      const isOpen = expanded.has(f.id)
                      const entityIds = parseJsonArray<string>(f.entitiesJson)
                      const txnIds = parseJsonArray<string>(f.transactionsJson)
                      const evidenceIds = parseJsonArray<string>(f.supportingEvidence)
                      const suff = f.sufficiency
                      return (
                        <div key={f.id} className="px-4 py-3">
                          <button
                            onClick={() => toggle(f.id)}
                            className="flex w-full items-start gap-3 text-left"
                          >
                            <div className="mt-0.5">
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                            </div>
                            <div className={`mt-0.5 flex-shrink-0 rounded ${m.bg} ${m.border} border p-1`}>
                              <ShieldAlert className={`h-3.5 w-3.5 ${m.color}`} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className={`text-[10px] ${m.color}`}>
                                  {m.label}
                                </Badge>
                                <Badge variant="outline" className="text-[10px] uppercase">
                                  {FINDING_TYPE_LABELS[f.type] ?? f.type}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  conf {(f.confidence * 100).toFixed(0)}%
                                </span>
                                {f.decision && (
                                  <Badge
                                    variant="outline"
                                    className={`text-[9px] uppercase ${
                                      f.decision === 'approved'
                                        ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
                                        : f.decision === 'rejected'
                                          ? 'border-rose-700 bg-rose-950/30 text-rose-300'
                                          : 'border-amber-700 bg-amber-950/30 text-amber-300'
                                    }`}
                                    title={
                                      f.decisionNote
                                        ? `${f.decidedBy ?? 'investigator'} @ ${f.decidedAt ?? ''}: ${f.decisionNote}`
                                        : `Decision record: ${f.decision} by ${f.decidedBy ?? 'investigator'}`
                                    }
                                  >
                                    {f.decision}
                                  </Badge>
                                )}
                                {/* Evidence Sufficiency Score */}
                                {suff && (
                                  <span
                                    className="flex items-center gap-1.5"
                                    title={`Sufficiency ${suff.score}/100 (${suff.band}) — sources: ${suff.independentSources}, quality: ${suff.sourceQuality}, corroboration: ${suff.corroboration}, contradiction penalty: ${suff.contradictionPenalty}. ${suff.reasons.join('; ')}`}
                                  >
                                    <span className="text-[10px] text-muted-foreground">sufficiency</span>
                                    <span className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                      <span
                                        className={`absolute inset-y-0 left-0 rounded-full ${SUFF_BAND_COLOR[suff.band] ?? 'bg-muted'}`}
                                        style={{ width: `${suff.score}%` }}
                                      />
                                    </span>
                                    <span className="font-mono text-[10px]">{suff.score}</span>
                                  </span>
                                )}
                                <span className="ml-auto text-[10px] text-muted-foreground">
                                  {timeAgo(f.createdAt)}
                                </span>
                              </div>
                              <div className="mt-1 text-sm">{f.description}</div>
                              {f.trigger && (
                                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                                  trigger: {f.trigger}
                                </div>
                              )}
                            </div>
                          </button>
                          {isOpen && (
                            <div className="mt-2 ml-10 space-y-2">
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <div className="rounded border border-border/40 bg-muted/10 p-2">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    Entities ({entityIds.length})
                                  </div>
                                  <div className="mt-1 space-y-0.5">
                                    {entityIds.slice(0, 5).map((id, i) => (
                                      <div key={i} className="font-mono text-[10px]">{id}</div>
                                    ))}
                                    {entityIds.length > 5 && (
                                      <div className="text-[10px] text-muted-foreground">
                                        +{entityIds.length - 5} more
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="rounded border border-border/40 bg-muted/10 p-2">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    Transactions ({txnIds.length})
                                  </div>
                                  <div className="mt-1 space-y-0.5">
                                    {txnIds.slice(0, 5).map((id, i) => (
                                      <div key={i} className="font-mono text-[10px]">{id}</div>
                                    ))}
                                    {txnIds.length > 5 && (
                                      <div className="text-[10px] text-muted-foreground">
                                        +{txnIds.length - 5} more
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="rounded border border-border/40 bg-muted/10 p-2">
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    Evidence ({evidenceIds.length})
                                  </div>
                                  <div className="mt-1 space-y-0.5">
                                    {evidenceIds.slice(0, 5).map((id, i) => (
                                      <div key={i} className="font-mono text-[10px]">{id}</div>
                                    ))}
                                    {evidenceIds.length > 5 && (
                                      <div className="text-[10px] text-muted-foreground">
                                        +{evidenceIds.length - 5} more
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Sufficiency breakdown */}
                              {suff && (
                                <div className="rounded border border-border/40 bg-muted/10 p-2 text-[11px]">
                                  <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                                    Sufficiency breakdown
                                  </span>
                                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                                    <span>independent sources: <b className="text-foreground">{suff.independentSources}</b></span>
                                    <span>source quality: <b className="text-foreground">{suff.sourceQuality}</b></span>
                                    <span>corroboration: <b className="text-foreground">{suff.corroboration}</b></span>
                                    <span>provenance: <b className="text-foreground">{suff.provenance}</b></span>
                                    <span>contradiction penalty: <b className="text-foreground">−{suff.contradictionPenalty}</b></span>
                                  </div>
                                  {suff.reasons.length > 0 && (
                                    <div className="mt-0.5 text-[10px] text-muted-foreground">{suff.reasons.join(' · ')}</div>
                                  )}
                                </div>
                              )}

                              {/* Decision record + replay actions */}
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] text-emerald-500 hover:text-emerald-400"
                                  disabled={deciding}
                                  onClick={() => {
                                    setDecideTarget(f)
                                    setDecisionKind('approved')
                                    setDecisionNote('')
                                    setModifiedDesc('')
                                  }}
                                >
                                  <Check className="mr-1 h-3 w-3" />
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] text-rose-500 hover:text-rose-400"
                                  disabled={deciding}
                                  onClick={() => {
                                    setDecideTarget(f)
                                    setDecisionKind('rejected')
                                    setDecisionNote('')
                                    setModifiedDesc('')
                                  }}
                                >
                                  <X className="mr-1 h-3 w-3" />
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] text-amber-500 hover:text-amber-400"
                                  disabled={deciding}
                                  onClick={() => {
                                    setDecideTarget(f)
                                    setDecisionKind('modified')
                                    setDecisionNote('')
                                    setModifiedDesc(f.description)
                                  }}
                                >
                                  <Pencil className="mr-1 h-3 w-3" />
                                  Modify
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[11px]"
                                  onClick={() => void openReplay(f)}
                                >
                                  <History className="mr-1 h-3 w-3" />
                                  Investigation replay
                                </Button>
                                {f.decidedAt && (
                                  <span className="text-[10px] text-muted-foreground">
                                    decided {timeAgo(f.decidedAt)} by {f.decidedBy ?? 'investigator'}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Contradictions tab ── */}
        <TabsContent value="contradictions" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <GitBranch className="h-4 w-4 text-rose-400" />
                    Evidence Contradiction Graph
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    Conflicting claims between records: contradicts · supports · supersedes · unresolved.
                    Detected deterministically (UTR amount/date/direction conflicts, entity type conflicts, severity divergence) plus AI-flagged ones.
                  </CardDescription>
                </div>
                <Button onClick={runDetection} disabled={detecting} size="sm">
                  {detecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Scale className="mr-2 h-4 w-4" />}
                  {detecting ? 'Detecting…' : 'Detect contradictions'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {contradictionsLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Loading contradictions…</div>
              ) : contradictions.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm font-medium">No contradictions recorded</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Run detection (or upload more evidence) — the engine cross-checks UTRs, dates, directions, entity types and finding severities.
                  </p>
                </div>
              ) : (
                <ScrollArea className="scroll-area-short">
                  <div className="space-y-2">
                    {contradictions.map((c) => {
                      const rm = RELATION_META[c.relation] ?? RELATION_META.unresolved
                      return (
                        <div
                          key={c.id}
                          className={`rounded-md border p-3 ${
                            c.status === 'open'
                              ? 'border-border/60 bg-muted/10'
                              : 'border-emerald-800/40 bg-emerald-950/10 opacity-75'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] ${rm.color}`}>
                              {rm.label}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] capitalize">
                              {c.subjectType}
                            </Badge>
                            {c.detector && (
                              <Badge variant="outline" className="text-[9px] uppercase text-muted-foreground">
                                {c.detector}
                              </Badge>
                            )}
                            {c.status !== 'open' && (
                              <Badge variant="outline" className="border-emerald-700 text-[9px] uppercase text-emerald-300">
                                {c.status}
                              </Badge>
                            )}
                            <span className="ml-auto text-[10px] text-muted-foreground">{timeAgo(c.createdAt)}</span>
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed">{c.description}</p>
                          {(c.subjectARef || c.subjectBRef) && (
                            <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                              {c.subjectARef && <span className="rounded bg-muted/20 px-1.5 py-0.5">A: {c.subjectARef}</span>}
                              {c.subjectBRef && <span className="rounded bg-muted/20 px-1.5 py-0.5">B: {c.subjectBRef}</span>}
                            </div>
                          )}
                          {c.status === 'open' && (
                            <div className="mt-2 flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                disabled={resolvingId === c.id}
                                onClick={() => void handleResolve(c, 'resolved')}
                              >
                                Mark resolved
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                disabled={resolvingId === c.id}
                                onClick={() => void handleResolve(c, 'accepted')}
                              >
                                Accept as-is
                              </Button>
                            </div>
                          )}
                          {c.resolutionNote && (
                            <div className="mt-1 text-[10px] italic text-muted-foreground">note: {c.resolutionNote}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Decision record dialog */}
      <Dialog open={!!decideTarget} onOpenChange={(open) => !open && setDecideTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="capitalize">Decision record — {decisionKind}</DialogTitle>
            <DialogDescription>
              Your decision is stored as structured case knowledge with a timestamp and an audit-trail
              entry. Approved findings with sufficiency ≥ 50 enter the claim graph as verified claims.
            </DialogDescription>
          </DialogHeader>
          {decideTarget && (
            <div className="space-y-3">
              <div className="rounded border border-border/40 bg-muted/10 p-2 text-xs">
                <Badge variant="outline" className="mr-2 text-[9px] uppercase">
                  {FINDING_TYPE_LABELS[decideTarget.type] ?? decideTarget.type}
                </Badge>
                {decideTarget.description}
              </div>
              {decisionKind === 'modified' && (
                <div>
                  <label className="text-[11px] font-medium">Modified description</label>
                  <Textarea
                    rows={3}
                    value={modifiedDesc}
                    onChange={(e) => setModifiedDesc(e.target.value)}
                    placeholder="Corrected finding statement…"
                    className="mt-1 text-xs"
                  />
                </div>
              )}
              <div>
                <label className="text-[11px] font-medium">Decision note (audit trail)</label>
                <Textarea
                  rows={3}
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="Why this decision was taken…"
                  className="mt-1 text-xs"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDecideTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleDecide()}
              disabled={deciding || (decisionKind === 'modified' && !modifiedDesc.trim())}
              className={decisionKind === 'rejected' ? 'bg-rose-600 hover:bg-rose-700' : ''}
            >
              {deciding ? 'Recording…' : `Record ${decisionKind}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Investigation replay dialog */}
      <Dialog open={!!replayTarget} onOpenChange={(open) => !open && setReplayTarget(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Investigation Replay</DialogTitle>
            <DialogDescription>
              How this finding was produced: evidence → extraction → resolution → graph → analytics → AI → decision → report.
            </DialogDescription>
          </DialogHeader>
          {replayLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reconstructing…
            </div>
          ) : replayTrace ? (
            <ScrollArea className="max-h-[55vh] pr-3">
              <div className="relative space-y-3 pl-5">
                <div className="absolute bottom-2 left-[7px] top-2 w-px bg-border" />
                {replayTrace.steps.map((s, i) => (
                  <div key={i} className="relative">
                    <span
                      className={`absolute -left-5 top-1 size-3.5 rounded-full border-2 ${
                        s.at || s.stage === 'analytics'
                          ? 'border-crimson-500 bg-crimson-500/30'
                          : 'border-border bg-muted'
                      }`}
                    />
                    <div className="rounded-md border border-border/40 bg-muted/10 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[9px] uppercase">
                          {i + 1}. {s.stage.replace(/_/g, ' ')}
                        </Badge>
                        {s.at && (
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(s.at).toLocaleString('en-IN')}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs font-medium">{s.title}</div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{s.detail}</div>
                    </div>
                  </div>
                ))}
                {!replayTrace.integrity.allSourcesPresent && (
                  <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-2 text-[11px] text-amber-300">
                    Integrity note: some source records referenced by this finding no longer resolve ({replayTrace.integrity.missing.join(', ')}).
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Could not build the replay trace.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
