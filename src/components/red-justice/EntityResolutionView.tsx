'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  GitMerge,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  Check,
  X,
  Users,
  ArrowRight,
  Sparkles,
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/hooks/use-toast'
import { api, type EntityObservation } from '@/lib/api-client'
// NOTE: 'History' from lucide-react is aliased to avoid the DOM History global.
import { History as HistoryIcon } from 'lucide-react'
import { entityMeta } from '@/lib/ui-helpers'
import { useGraphRefresh, notifyGraphUpdated } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

interface ResolveCandidate {
  groupId: string
  reason: string
  confidence: number
  entities: Array<{
    id: string
    type: string
    value: string
    norm: string
    label: string | null
  }>
}

export function EntityResolutionView({ caseId }: Props) {
  const { toast } = useToast()
  const [candidates, setCandidates] = useState<ResolveCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [merging, setMerging] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [selectedPrimary, setSelectedPrimary] = useState<Record<string, string>>({})
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.entityResolve(caseId)
      setCandidates(r.candidates)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load candidates')
    } finally {
      setLoading(false)
    }
  }, [caseId])

  useEffect(() => {
    load()
  }, [load])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
  })

  const handleMerge = async (candidate: ResolveCandidate) => {
    const primaryId = selectedPrimary[candidate.groupId] ?? candidate.entities[0].id
    const mergeIds = candidate.entities.filter((e) => e.id !== primaryId).map((e) => e.id)
    if (mergeIds.length === 0) return
    setMerging(candidate.groupId)
    try {
      const result = await api.entityMerge(caseId, primaryId, mergeIds)
      setRefreshKey((k) => k + 1)
      toast({
        title: `Merged ${result.merged} ${result.merged === 1 ? 'entity' : 'entities'}`,
        description: `Aliases: ${result.aliases.length > 0 ? result.aliases.slice(0, 3).join(', ') + (result.aliases.length > 3 ? '…' : '') : 'none'}`,
      })
      setDismissed((prev) => new Set([...prev, candidate.groupId]))
      await load()
      // Merges rewrite entities + relationships — tell every other view.
      notifyGraphUpdated({ reason: 'entity-merge' })
    } catch (e) {
      toast({
        title: 'Merge failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setMerging(null)
    }
  }

  const handleDismiss = (groupId: string) => {
    setDismissed((prev) => new Set([...prev, groupId]))
  }

  const visibleCandidates = candidates.filter((c) => !dismissed.has(c.groupId))

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Entity Resolution
          </h2>
          <p className="text-sm text-muted-foreground">
            Review duplicate candidates and merge entities that refer to the same real-world identity.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Re-scan
        </Button>
      </div>

      {/* Guardrail banner */}
      <Card className="border-amber-700/40 bg-amber-950/20">
        <CardContent className="flex items-start gap-3 p-3 text-xs text-amber-200/80">
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div>
            <strong className="text-amber-300">Human-in-the-loop:</strong> The system never auto-merges.
            Each merge is an explicit investigator decision. Merged entities' values are preserved as
            aliases in the primary entity's metadata. All merges are logged in the activity feed.
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <ObservationLedger caseId={caseId} refreshKey={refreshKey} />

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Scanning for duplicates…</div>
      ) : visibleCandidates.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="rounded-full bg-emerald-950/40 p-4">
              <Check className="h-8 w-8 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {candidates.length === 0 ? 'No duplicate candidates found' : 'All candidates resolved'}
              </p>
              <p className="text-xs text-muted-foreground">
                {candidates.length === 0
                  ? 'All entities appear to be distinct. Upload more evidence to surface potential matches.'
                  : 'You have dismissed or resolved all merge candidates.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* Summary */}
          <div className="flex items-center gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm">
            <Sparkles className="h-4 w-4 text-crimson-400" />
            <span className="text-muted-foreground">
              <span className="font-mono font-bold text-foreground">{visibleCandidates.length}</span> merge
              candidate{visibleCandidates.length === 1 ? '' : 's'} detected
            </span>
            <Badge variant="outline" className="ml-auto text-[10px]">
              {candidates.filter((c) => c.confidence >= 0.75).length} high confidence
            </Badge>
          </div>

          {/* Candidates */}
          <ScrollArea className="h-[calc(100vh-340px)] pr-3">
            <div className="space-y-3">
              {visibleCandidates.map((cand) => {
                const primaryId = selectedPrimary[cand.groupId] ?? cand.entities[0].id
                const confPct = Math.round(cand.confidence * 100)
                const confColor =
                  cand.confidence >= 0.75
                    ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
                    : cand.confidence >= 0.6
                      ? 'border-amber-700 bg-amber-950/30 text-amber-300'
                      : 'border-slate-700 bg-slate-950/30 text-slate-300'
                return (
                  <Card key={cand.groupId} className="overflow-hidden">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <GitMerge className="h-4 w-4 text-crimson-400" />
                            <span className="font-mono text-xs">{cand.groupId}</span>
                            <Badge variant="outline" className={`text-[10px] ${confColor}`}>
                              {confPct}% confidence
                            </Badge>
                          </CardTitle>
                          <CardDescription className="mt-1 text-xs">{cand.reason}</CardDescription>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDismiss(cand.groupId)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {cand.entities.map((e, idx) => {
                          const meta = entityMeta(e.type)
                          const isPrimary = e.id === primaryId
                          return (
                            <div key={e.id}>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() =>
                                    setSelectedPrimary((prev) => ({ ...prev, [cand.groupId]: e.id }))
                                  }
                                  className={`flex flex-1 items-center gap-3 rounded-md border px-3 py-2 text-left transition-all ${
                                    isPrimary
                                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                                      : 'border-border/40 bg-muted/10 hover:border-primary/40'
                                  }`}
                                >
                                  <div
                                    className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                                      isPrimary ? 'border-primary bg-primary' : 'border-muted-foreground'
                                    }`}
                                  >
                                    {isPrimary && <Check className="h-3 w-3 text-primary-foreground" />}
                                  </div>
                                  <span
                                    className="h-3 w-3 flex-shrink-0 rounded-full"
                                    style={{ background: meta.color }}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="truncate font-mono text-sm">{e.value}</span>
                                      {isPrimary && (
                                        <Badge variant="outline" className="border-primary/40 text-[9px] text-primary">
                                          PRIMARY
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                      {meta.label}
                                      {e.label ? ` · ${e.label}` : ''}
                                    </div>
                                  </div>
                                  {idx > 0 && (
                                    <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                                  )}
                                </button>
                              </div>
                              {idx < cand.entities.length - 1 && (
                                <div className="ml-7 h-3 w-px bg-border/40" />
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] text-muted-foreground">
                          <Users className="mr-1 inline h-3 w-3" />
                          {cand.entities.length} entities will be merged into the primary
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDismiss(cand.groupId)}
                            disabled={merging === cand.groupId}
                          >
                            Skip
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleMerge(cand)}
                            disabled={merging === cand.groupId}
                          >
                            <GitMerge className="mr-2 h-3.5 w-3.5" />
                            {merging === cand.groupId ? 'Merging…' : `Merge ${cand.entities.length - 1} → 1`}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </ScrollArea>
        </div>
      )}

      {error === null && !loading && candidates.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle className="h-6 w-6 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              Detection strategies: shared normalised values across types, fuzzy person-name matching
              (Levenshtein ≤ 2), and alias matches from entity metadata.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * ObservationLedger — Provenance-Preserving Entity Resolution.
 *
 * Every raw source observation (what was extracted, from which file, at which
 * locator) stays individually inspectable even after entities are merged.
 * Merges re-point observations to the survivor with mergedFromId — nothing
 * collapses into one opaque node.
 */
function ObservationLedger({ caseId, refreshKey }: { caseId: string; refreshKey: number }) {
  const [obs, setObs] = useState<EntityObservation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const r = await api.observations(caseId)
        if (!cancelled) setObs(r.observations)
      } catch {
        if (!cancelled) setObs([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [caseId, refreshKey])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <HistoryIcon className="h-4 w-4 text-sky-400" />
          Observation Ledger
        </CardTitle>
        <CardDescription className="text-[11px]">
          Individual source observations behind every entity (provenance-preserving resolution).
          Merging re-points observations to the surviving entity — the raw occurrences are never collapsed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading observations…</div>
        ) : obs.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            No observations recorded yet. Upload evidence — every extraction writes an observation entry.
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="space-y-1">
              {obs.slice(0, 100).map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-2 rounded border border-border/40 bg-muted/10 px-2 py-1.5 text-[11px]">
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {o.rawType}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono" title={o.rawValue}>
                    {o.rawValue}
                  </span>
                  {o.evidenceName && (
                    <span className="max-w-[180px] truncate text-[10px] text-muted-foreground" title={o.evidenceName}>
                      {o.evidenceName}
                    </span>
                  )}
                  {o.locator && (
                    <span className="font-mono text-[9px] text-muted-foreground">{o.locator}</span>
                  )}
                  {o.mergedFromId && (
                    <Badge variant="outline" className="border-violet-700 text-[8px] text-violet-300">
                      re-pointed by merge
                    </Badge>
                  )}
                </div>
              ))}
              {obs.length > 100 && (
                <div className="pt-1 text-center text-[10px] text-muted-foreground">
                  +{obs.length - 100} more observations
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
