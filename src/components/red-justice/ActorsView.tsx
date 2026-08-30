'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ShieldAlert,
  RefreshCw,
  Play,
  TrendingUp,
  Award,
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
import { api, type ActorRisk } from '@/lib/api-client'
import { entityMeta, parseJson } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

export function ActorsView({ caseId }: Props) {
  const [actors, setActors] = useState<ActorRisk[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setActors(await api.actors(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load actors')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [caseId])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
  })

  const runActors = async () => {
    setRunning(true)
    try {
      await api.runActors(caseId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'run failed')
    } finally {
      setRunning(false)
    }
  }

  const sorted = useMemo(
    () => [...actors].sort((a, b) => b.score - a.score),
    [actors],
  )

  const topActor = sorted[0]
  const maxScore = topActor?.score ?? 100

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Actor Risk Prioritization
          </h2>
          <p className="text-sm text-muted-foreground">
            {actors.length} actors scored · explainable contributors
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={runActors} disabled={running} size="sm">
            <Play className="mr-2 h-4 w-4" />
            {running ? 'Recomputing…' : 'Recompute scores'}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Top actor card */}
      {topActor && (
        <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="relative">
                <div
                  className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-primary/40"
                  style={{
                    background: `conic-gradient(oklch(0.62 0.22 25) ${topActor.score * 3.6}deg, transparent 0)`,
                  }}
                >
                  <div className="flex h-14 w-14 flex-col items-center justify-center rounded-full bg-card">
                    <Award className="h-3 w-3 text-amber-400" />
                    <span className="font-mono text-lg font-bold">{topActor.score.toFixed(0)}</span>
                  </div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Top priority actor
                </div>
                {topActor.entity ? (
                  <>
                    <div className="font-mono text-lg font-bold">
                      {topActor.entity.value}
                    </div>
                    <Badge variant="outline" className="mt-1 text-[10px]">
                      {entityMeta(topActor.entity.type).label}
                    </Badge>
                  </>
                ) : (
                  <div className="font-mono text-xs text-muted-foreground">
                    entity {topActor.entityId}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-[260px]">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Contributors
                </div>
                <div className="mt-1 space-y-0.5">
                  {parseJson<string[]>(topActor.contributorsJson)?.slice(0, 4).map((c, i) => (
                    <div key={i} className="text-xs text-muted-foreground">• {c}</div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* List */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-orange-400" />
            All Actors ({sorted.length})
          </CardTitle>
          <CardDescription>
            Score is a weighted combination of centrality, transaction volume, suspicious patterns, and bridge score.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading actors…</div>
          ) : sorted.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No actors scored yet.</div>
          ) : (
            <ScrollArea className="scroll-area-short">
              <div className="space-y-2">
                {sorted.map((a, i) => {
                  const score = a.score
                  const tier = score >= 70 ? 'high' : score >= 50 ? 'medium' : 'low'
                  const tierColor =
                    tier === 'high'
                      ? 'from-rose-700 to-rose-500'
                      : tier === 'medium'
                        ? 'from-amber-700 to-amber-500'
                        : 'from-sky-700 to-sky-500'
                  const contributors = parseJson<string[]>(a.contributorsJson) ?? []
                  const components = parseJson<Record<string, number>>(a.componentsJson) ?? {}
                  return (
                    <div
                      key={a.id}
                      className="rounded-md border border-border/40 bg-muted/10 p-3 transition-colors hover:border-primary/40"
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-1 w-6 text-right font-mono text-xs text-muted-foreground">
                          #{i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {a.entity && (
                              <>
                                <span
                                  className="inline-block h-2.5 w-2.5 rounded-full"
                                  style={{ background: entityMeta(a.entity.type).color }}
                                />
                                <span className="truncate font-mono text-sm">
                                  {a.entity.value}
                                </span>
                                <Badge variant="outline" className="text-[9px] uppercase">
                                  {entityMeta(a.entity.type).label}
                                </Badge>
                              </>
                            )}
                          </div>
                          <div className="mt-2 flex items-center gap-3">
                            <div className="flex-1">
                              <div className="relative h-2.5 overflow-hidden rounded-full bg-muted/40">
                                <div
                                  className={`h-full rounded-full bg-gradient-to-r ${tierColor}`}
                                  style={{ width: `${(score / maxScore) * 100}%` }}
                                />
                              </div>
                            </div>
                            <span className="font-mono text-sm font-bold">{score.toFixed(1)}</span>
                            <Badge
                              variant="outline"
                              className={
                                tier === 'high'
                                  ? 'border-rose-700 bg-rose-950/40 text-rose-300'
                                  : tier === 'medium'
                                    ? 'border-amber-700 bg-amber-950/40 text-amber-300'
                                    : 'border-sky-700 bg-sky-950/40 text-sky-300'
                              }
                            >
                              {tier}
                            </Badge>
                          </div>
                          {contributors.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {contributors.slice(0, 5).map((c, j) => (
                                <span
                                  key={j}
                                  className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {c}
                                </span>
                              ))}
                            </div>
                          )}
                          {Object.keys(components).length > 0 && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[10px] text-muted-foreground">
                                Show component breakdown
                              </summary>
                              <div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-3">
                                {Object.entries(components).map(([k, v]) => (
                                  <div key={k} className="text-[10px]">
                                    <span className="text-muted-foreground">{k}:</span>{' '}
                                    <span className="font-mono">{(v as number).toFixed(1)}</span>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
