'use client'

import { useEffect, useState } from 'react'
import {
  Lightbulb,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Brain,
  FlaskConical,
  Sparkles,
  Loader2,
  SearchX,
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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { api, type GapReport, type VerifyResult } from '@/lib/api-client'
import { timeAgo } from '@/lib/ui-helpers'
import { useGraphRefresh, notifyGraphUpdated } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

interface Hypothesis {
  id: string
  title: string
  statement: string
  status: string
  supportingEvidence: string[]
  contradictingEvidence: string[]
  graphSupport: string
  temporalSupport: string
  confidence: number
  createdAt: string
}

const STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  draft: { label: 'Draft', color: 'text-slate-300', icon: <AlertCircle className="h-3 w-3" /> },
  under_review: { label: 'Under Review', color: 'text-amber-300', icon: <AlertCircle className="h-3 w-3" /> },
  supported: { label: 'Supported', color: 'text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
  contradicted: { label: 'Contradicted', color: 'text-rose-300', icon: <XCircle className="h-3 w-3" /> },
  confirmed: { label: 'Confirmed (verified)', color: 'text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { label: 'Rejected (verified)', color: 'text-rose-300', icon: <XCircle className="h-3 w-3" /> },
  unresolved: { label: 'Unresolved', color: 'text-amber-300', icon: <AlertCircle className="h-3 w-3" /> },
  inconclusive: { label: 'Inconclusive', color: 'text-slate-300', icon: <AlertCircle className="h-3 w-3" /> },
}

const SUPPORT_META: Record<string, { label: string; color: string }> = {
  strong: { label: 'Strong', color: 'text-emerald-300' },
  moderate: { label: 'Moderate', color: 'text-amber-300' },
  weak: { label: 'Weak', color: 'text-slate-300' },
  none: { label: 'None', color: 'text-muted-foreground' },
}

const CHECK_META: Record<string, { color: string; label: string }> = {
  pass: { color: 'text-emerald-300', label: 'PASS' },
  partial: { color: 'text-amber-300', label: 'PARTIAL' },
  fail: { color: 'text-rose-300', label: 'FAIL' },
}

const GAP_FAMILY_LABEL: Record<string, string> = {
  missing_source: 'Missing source evidence',
  unlinked_entity: 'Unlinked entities',
  thin_evidence: 'Thin evidence',
  unresolved_conflicts: 'Unresolved conflicts',
  hypothesis_gaps: 'Hypothesis gaps',
  record_quality: 'Record quality',
}

export function HypothesesView({ caseId }: Props) {
  const { toast } = useToast()
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newStatement, setNewStatement] = useState('')
  const [creating, setCreating] = useState(false)

  // verification loop state: hypothesisId → running/result
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({})
  const [proposing, setProposing] = useState(false)

  // gaps state
  const [gaps, setGaps] = useState<GapReport | null>(null)
  const [gapsLoading, setGapsLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setHypotheses(await api.listHypotheses(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load hypotheses')
    } finally {
      setLoading(false)
    }
  }

  const loadGaps = async () => {
    setGapsLoading(true)
    try {
      setGaps(await api.gaps(caseId))
    } catch {
      setGaps(null)
    } finally {
      setGapsLoading(false)
    }
  }

  useEffect(() => {
    load()
    loadGaps()
  }, [caseId])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
    void loadGaps()
  })

  const handleCreate = async () => {
    if (!newStatement.trim()) return
    setCreating(true)
    try {
      await api.createHypothesis(caseId, newTitle.trim() || 'Untitled hypothesis', newStatement.trim())
      setNewTitle('')
      setNewStatement('')
      await load()
      notifyGraphUpdated({ reason: 'hypothesis-create' })
      toast({ title: 'Hypothesis created' })
    } catch (e) {
      toast({
        title: 'Failed to create hypothesis',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setCreating(false)
    }
  }

  const handleVerify = async (h: Hypothesis) => {
    setVerifyingId(h.id)
    try {
      const result = await api.verifyHypothesis(caseId, h.id)
      setVerifyResults((prev) => ({ ...prev, [h.id]: result }))
      await load()
      notifyGraphUpdated({ reason: 'hypothesis-verify' })
      toast({
        title: `Verification: ${result.status}`,
        description: `${(result.confidence * 100).toFixed(0)}% confidence across ${result.checks.length} deterministic checks`,
      })
    } catch (e) {
      toast({
        title: 'Verification failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setVerifyingId(null)
    }
  }

  const handlePropose = async () => {
    setProposing(true)
    try {
      const r = await api.proposeHypothesis(caseId)
      await load()
      notifyGraphUpdated({ reason: 'hypothesis-propose' })
      toast({
        title: `Hypothesis proposed (${r.hypothesis.proposedBy === 'ai' ? 'AI' : 'deterministic engine'})`,
        description: r.hypothesis.title,
      })
    } catch (e) {
      toast({
        title: 'Proposal failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setProposing(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Hypothesis Workspace
          </h2>
          <p className="text-sm text-muted-foreground">
            Propose → verify (deterministic queries) → confirmed / rejected / unresolved → claim graph.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" size="icon" title="Reload">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => void handlePropose()} disabled={proposing} size="sm" variant="outline">
            {proposing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {proposing ? 'Proposing…' : 'Propose with AI'}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="hypotheses">
        <TabsList>
          <TabsTrigger value="hypotheses">Hypotheses ({hypotheses.length})</TabsTrigger>
          <TabsTrigger value="gaps" className="gap-1.5">
            <SearchX className="h-3.5 w-3.5" />
            Investigation Gaps {gaps ? `(${gaps.total})` : ''}
          </TabsTrigger>
        </TabsList>

        {/* ── Hypotheses tab ── */}
        <TabsContent value="hypotheses" className="space-y-4">
          {/* Create hypothesis */}
          <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <CardContent className="p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Plus className="h-4 w-4 text-crimson-400" />
                Create a new hypothesis
              </div>
              <div className="space-y-2">
                <div>
                  <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Title
                  </Label>
                  <Input
                    placeholder="e.g. Entity A connects Communities 3 and 5"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Hypothesis statement
                  </Label>
                  <Textarea
                    placeholder="Describe what you hypothesize and what evidence would support or contradict it…"
                    value={newStatement}
                    onChange={(e) => setNewStatement(e.target.value)}
                    rows={3}
                    className="resize-none"
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleCreate} disabled={creating || !newStatement.trim()} size="sm">
                    {creating ? 'Creating…' : 'Create hypothesis'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {error && (
            <Card className="border-destructive/40">
              <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {/* Hypothesis list */}
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading hypotheses…</div>
          ) : hypotheses.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Lightbulb className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No hypotheses yet</p>
                  <p className="text-xs text-muted-foreground">
                    Write one above or click &quot;Propose with AI&quot; to get a testable starting point.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <ScrollArea className="scroll-area-safe pr-3">
              <div className="space-y-2">
                {hypotheses.map((h) => {
                  const statusMeta = STATUS_META[h.status] ?? STATUS_META.draft
                  const graphMeta = SUPPORT_META[h.graphSupport] ?? SUPPORT_META.none
                  const temporalMeta = SUPPORT_META[h.temporalSupport] ?? SUPPORT_META.none
                  const verify = verifyResults[h.id]
                  return (
                    <Card key={h.id} className="group">
                      <CardContent className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded bg-crimson-950/40 p-1.5">
                            <Brain className="h-3.5 w-3.5 text-crimson-400" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{h.title}</span>
                              <Badge variant="outline" className={`gap-1 text-[10px] ${statusMeta.color}`}>
                                {statusMeta.icon}
                                {statusMeta.label}
                              </Badge>
                              {h.confidence > 0 && (
                                <Badge variant="outline" className="text-[10px]">
                                  {(h.confidence * 100).toFixed(0)}% confidence
                                </Badge>
                              )}
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {timeAgo(h.createdAt)}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">{h.statement}</p>
                            <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                              <span>
                                Graph support: <span className={graphMeta.color}>{graphMeta.label}</span>
                              </span>
                              <span>
                                Temporal support: <span className={temporalMeta.color}>{temporalMeta.label}</span>
                              </span>
                              {h.supportingEvidence.length > 0 && (
                                <span className="text-emerald-300">
                                  Supporting: {h.supportingEvidence.length}
                                </span>
                              )}
                              {h.contradictingEvidence.length > 0 && (
                                <span className="text-rose-300">
                                  Contradicting: {h.contradictingEvidence.length}
                                </span>
                              )}
                            </div>

                            {/* Verification loop UI */}
                            <div className="mt-2 flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px]"
                                disabled={verifyingId === h.id}
                                onClick={() => void handleVerify(h)}
                              >
                                {verifyingId === h.id ? (
                                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                                ) : (
                                  <FlaskConical className="mr-1.5 h-3 w-3" />
                                )}
                                {verifyingId === h.id ? 'Verifying…' : 'Verify'}
                              </Button>
                              <span className="text-[10px] text-muted-foreground">
                                runs 5 deterministic checks (entity match · evidence · findings · contradictions · graph path)
                              </span>
                            </div>
                            {verify && (
                              <div className="mt-2 space-y-1 rounded-md border border-border/40 bg-muted/10 p-2">
                                {verify.checks.map((c) => {
                                  const cm = CHECK_META[c.result] ?? CHECK_META.partial
                                  return (
                                    <div key={c.check} className="flex items-start gap-2 text-[11px]">
                                      <span className={`w-14 flex-shrink-0 font-mono text-[9px] font-bold ${cm.color}`}>
                                        {cm.label}
                                      </span>
                                      <span className="w-28 flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                                        {c.check}
                                      </span>
                                      <span className="min-w-0 flex-1 text-muted-foreground">{c.detail}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        {/* ── Gaps tab ── */}
        <TabsContent value="gaps">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <SearchX className="h-4 w-4 text-amber-400" />
                    Investigation Gap Engine
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    What is still MISSING — required evidence, unknown links, unresolved conflicts and
                    record-quality issues that block confident conclusions.
                  </CardDescription>
                </div>
                <Button onClick={() => void loadGaps()} variant="outline" size="sm">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Re-analyze
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {gapsLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Analyzing gaps…</div>
              ) : !gaps || gaps.gaps.length === 0 ? (
                <div className="py-8 text-center">
                  <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-400" />
                  <p className="text-sm font-medium">No critical gaps detected</p>
                  <p className="text-xs text-muted-foreground">
                    The current evidence covers the extracted data. Keep ingesting to stay ahead.
                  </p>
                </div>
              ) : (
                <ScrollArea className="scroll-area-short">
                  <div className="space-y-2">
                    {gaps.gaps.map((g) => (
                      <div key={g.id} className="rounded-md border border-border/60 bg-muted/10 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={`text-[10px] uppercase ${
                              g.severity === 'high'
                                ? 'border-rose-700 bg-rose-950/30 text-rose-300'
                                : g.severity === 'medium'
                                  ? 'border-amber-700 bg-amber-950/30 text-amber-300'
                                  : 'border-slate-600 bg-slate-950/30 text-slate-300'
                            }`}
                          >
                            {g.severity}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {GAP_FAMILY_LABEL[g.family] ?? g.family}
                          </Badge>
                        </div>
                        <div className="mt-1.5 text-sm font-medium">{g.title}</div>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{g.description}</p>
                        <p className="mt-1 text-[11px] text-sky-300">
                          <span className="font-semibold">Next step: </span>
                          {g.recommendation}
                        </p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {/* Evidence coverage */}
              {gaps && (
                <div className="mt-3 rounded-md border border-border/40 bg-muted/10 p-3">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Evidence coverage by class
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(gaps.coverage.evidenceByClass).length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">No evidence ingested yet.</span>
                    ) : (
                      Object.entries(gaps.coverage.evidenceByClass).map(([cls, count]) => (
                        <Badge key={cls} variant="outline" className="text-[10px] capitalize">
                          {cls.replace(/_/g, ' ')}: {count}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
