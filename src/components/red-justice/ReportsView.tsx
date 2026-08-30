'use client'

import { useEffect, useState } from 'react'
import {
  FileText,
  Download,
  RefreshCw,
  FileJson,
  FileCode,
  GitBranch,
  Plus,
  ShieldCheck,
  ShieldAlert,
  Loader2,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { api, type ClaimGraph, type ClaimNode } from '@/lib/api-client'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'
import { EvidenceMatrixPanel } from './EvidenceMatrixPanel'
import { DecisionsAuditPanel } from './DecisionsAuditPanel'

interface Props {
  caseId: string
}

const LEVEL_META: Record<string, { label: string; color: string }> = {
  evidence: { label: 'Evidence', color: 'border-slate-600 bg-slate-950/30 text-slate-300' },
  observation: { label: 'Observation', color: 'border-sky-700 bg-sky-950/30 text-sky-300' },
  finding: { label: 'Finding', color: 'border-amber-700 bg-amber-950/30 text-amber-300' },
  hypothesis: { label: 'Hypothesis', color: 'border-violet-700 bg-violet-950/30 text-violet-300' },
  claim: { label: 'Claim', color: 'border-crimson-700 bg-crimson-950/30 text-crimson-300' },
  report: { label: 'Report', color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300' },
}

const CLAIM_STATUS_META: Record<string, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300' },
  supported: { label: 'Supported', color: 'border-lime-700 bg-lime-950/30 text-lime-300' },
  unsupported: { label: 'Unsupported', color: 'border-rose-700 bg-rose-950/30 text-rose-300' },
  rejected: { label: 'Rejected', color: 'border-slate-600 bg-slate-950/30 text-slate-400' },
}

export function ReportsView({ caseId }: Props) {
  const { toast } = useToast()
  const [markdown, setMarkdown] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Claim graph state
  const [claimGraph, setClaimGraph] = useState<ClaimGraph | null>(null)
  const [claimLoading, setClaimLoading] = useState(true)
  const [newClaim, setNewClaim] = useState('')
  const [creatingClaim, setCreatingClaim] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.reportSummary(caseId)
      setMarkdown(r.markdown)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load report')
    } finally {
      setLoading(false)
    }
  }

  const loadClaims = async () => {
    setClaimLoading(true)
    try {
      setClaimGraph(await api.claims(caseId))
    } catch {
      setClaimGraph(null)
    } finally {
      setClaimLoading(false)
    }
  }

  useEffect(() => {
    load()
    loadClaims()
  }, [caseId])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
    void loadClaims()
  })

  const handleCreateClaim = async () => {
    if (!newClaim.trim() || creatingClaim) return
    setCreatingClaim(true)
    try {
      await api.createClaim(caseId, newClaim.trim())
      setNewClaim('')
      await loadClaims()
      toast({ title: 'Claim recorded', description: 'It starts unsupported until you approve supporting findings.' })
    } catch (e) {
      toast({
        title: 'Failed to record claim',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setCreatingClaim(false)
    }
  }

  const download = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const byLevel = (g: ClaimGraph, level: string) => g.nodes.filter((n) => n.level === level)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Investigation Reports
          </h2>
          <p className="text-sm text-muted-foreground">
            Auto-generated Markdown summary · claim graph gating · facts vs inference clearly distinguished
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-4 w-4" />
            Regenerate
          </Button>
          <Button
            onClick={() => download(`red-justice-report.md`, markdown, 'text/markdown')}
            variant="outline"
            size="sm"
            disabled={!markdown}
          >
            <FileCode className="mr-2 h-4 w-4" />
            Markdown
          </Button>
          <Button
            onClick={async () => {
              try {
                const j = await api.reportJson(caseId)
                download(`red-justice-report.json`, JSON.stringify(j, null, 2), 'application/json')
              } catch (e) {
                setError(e instanceof Error ? e.message : 'failed to export json')
              }
            }}
            variant="outline"
            size="sm"
          >
            <FileJson className="mr-2 h-4 w-4" />
            JSON
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Tabs defaultValue="report">
        <TabsList>
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="claims" className="gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            Claim Graph
          </TabsTrigger>
          <TabsTrigger value="matrix">Evidence Matrix</TabsTrigger>
          <TabsTrigger value="audit">Decisions & Audit</TabsTrigger>
        </TabsList>

        {/* ── Report tab ── */}
        <TabsContent value="report" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-crimson-400" />
                Investigation Summary
              </CardTitle>
              <CardDescription>
                Includes case metadata, evidence inventory (with AI classifications), entity table, transaction summary,
                suspicious patterns, communities, and actor priorities.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="py-12 text-center text-sm text-muted-foreground">Generating report…</div>
              ) : markdown ? (
                <ScrollArea className="scroll-area-tall rounded-md border border-border/40 bg-muted/10 p-4">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                    {markdown}
                  </pre>
                </ScrollArea>
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No report generated.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-amber-700/40 bg-amber-950/20">
            <CardContent className="flex items-start gap-3 p-3 text-xs text-amber-200/80">
              <Download className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                Reports distinguish{' '}
                <Badge variant="outline" className="mx-1 text-[10px]">
                  OBSERVED EVIDENCE
                </Badge>{' '}
                from{' '}
                <Badge variant="outline" className="mx-1 text-[10px]">
                  DETERMINISTIC FINDING
                </Badge>{' '}
                and{' '}
                <Badge variant="outline" className="mx-1 text-[10px]">
                  MODEL INFERENCE
                </Badge>
                . All AI-derived conclusions are advisory and require human review before any action.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Claim Graph tab ── */}
        <TabsContent value="claims">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <GitBranch className="h-4 w-4 text-crimson-400" />
                Claim Graph — Evidence → Observation → Finding → Hypothesis → Claim
              </CardTitle>
              <CardDescription className="text-[11px]">
                {claimGraph?.policy}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Policy banner */}
              {claimGraph && (
                <div
                  className={`flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-xs ${
                    claimGraph.reportReady
                      ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-300'
                      : 'border-rose-800/40 bg-rose-950/20 text-rose-300'
                  }`}
                >
                  {claimGraph.reportReady ? (
                    <ShieldCheck className="h-4 w-4" />
                  ) : (
                    <ShieldAlert className="h-4 w-4" />
                  )}
                  {claimGraph.reportReady ? (
                    <span>All claims are supported — the report is ready for confident sharing.</span>
                  ) : (
                    <span>
                      {claimGraph.unsupportedClaims.length} unsupported claim(s) detected — they are excluded from
                      confident reporting until backed by verified findings or hypothesis verification.
                    </span>
                  )}
                  <span className="ml-auto flex flex-wrap gap-1.5">
                    {Object.entries(claimGraph.counts).map(([level, n]) => (
                      <Badge key={level} variant="outline" className={`text-[9px] ${(LEVEL_META[level] ?? LEVEL_META.evidence).color}`}>
                        {level}: {n}
                      </Badge>
                    ))}
                  </span>
                </div>
              )}

              {/* New claim composer */}
              <div className="rounded-md border border-border/40 bg-muted/10 p-3">
                <div className="mb-1.5 text-[11px] font-medium">Record an investigator claim</div>
                <Textarea
                  rows={2}
                  value={newClaim}
                  onChange={(e) => setNewClaim(e.target.value)}
                  placeholder="e.g. Account X acted as a collection mule for the network between March and May 2024 (based on approved findings F-1, F-3)…"
                  className="text-xs"
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => void handleCreateClaim()}
                    disabled={creatingClaim || !newClaim.trim()}
                  >
                    {creatingClaim ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-2 h-3.5 w-3.5" />}
                    Record claim
                  </Button>
                </div>
              </div>

              {claimLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Assembling claim graph…</div>
              ) : !claimGraph ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Could not load the claim graph.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
                  {(['evidence', 'observation', 'finding', 'hypothesis', 'claim'] as const).map((level) => {
                    const lm = LEVEL_META[level]
                    const items = byLevel(claimGraph, level).slice(0, 25)
                    return (
                      <div key={level} className="rounded-lg border border-border/40 bg-muted/10 p-2">
                        <div className="mb-1.5 flex items-center justify-between">
                          <Badge variant="outline" className={`text-[9px] ${lm.color}`}>
                            {lm.label}
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
                        </div>
                        <ScrollArea className="max-h-80">
                          <div className="space-y-1">
                            {items.length === 0 && (
                              <div className="py-2 text-center text-[10px] text-muted-foreground">none</div>
                            )}
                            {items.map((n: ClaimNode) => {
                              const sm = CLAIM_STATUS_META[n.status] ?? CLAIM_STATUS_META.unsupported
                              return (
                                <div
                                  key={n.id}
                                  className="rounded border border-border/40 bg-card p-1.5"
                                  title={n.text}
                                >
                                  <div className="flex items-center gap-1">
                                    <span
                                      className={`size-1.5 flex-shrink-0 rounded-full ${
                                        n.status === 'verified'
                                          ? 'bg-emerald-400'
                                          : n.status === 'supported'
                                            ? 'bg-lime-400'
                                            : n.status === 'rejected'
                                              ? 'bg-slate-500'
                                              : 'bg-rose-400'
                                      }`}
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[10px]">{n.text}</span>
                                  </div>
                                  <div className="mt-0.5 flex items-center justify-between">
                                    <Badge variant="outline" className={`text-[8px] ${sm.color}`}>
                                      {sm.label}
                                    </Badge>
                                    {n.sufficiency != null && (
                                      <span className="font-mono text-[8px] text-muted-foreground">suff {n.sufficiency}</span>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                            {byLevel(claimGraph, level).length > 25 && (
                              <div className="text-center text-[9px] text-muted-foreground">
                                +{byLevel(claimGraph, level).length - 25} more
                              </div>
                            )}
                          </div>
                        </ScrollArea>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Evidence Matrix tab ── */}
        <TabsContent value="matrix">
          <EvidenceMatrixPanel caseId={caseId} />
        </TabsContent>

        {/* ── Decisions & Audit tab ── */}
        <TabsContent value="audit">
          <DecisionsAuditPanel caseId={caseId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
