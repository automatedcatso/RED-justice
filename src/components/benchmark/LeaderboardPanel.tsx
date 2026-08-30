'use client'

/**
 * LeaderboardPanel.tsx — the "Results & Leaderboard" tab: ranked results
 * table across all runs, radar-chart comparison of the top models, expandable
 * per-test breakdowns and per-run delete.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Loader2,
  RefreshCw,
  Trash2,
  Trophy,
  Zap,
} from 'lucide-react'
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CATEGORY_RUBRIC } from '@/lib/benchmark/types'
import { inferModelTier } from '@/lib/modelTiers'
import { ModeBadge } from './RunnerPanel'
import type { ResultFullDto, RunFullDto, RunSummaryDto, RunsResponse } from './dto'

const RADAR_COLORS = ['#ef4444', '#2dd4bf', '#f59e0b', '#10b981']

interface LeaderRow {
  key: string
  runId: string
  runLabel: string
  runDate: string
  suite: string
  mode: 'turbo' | 'quality'
  result: RunSummaryDto['results'][number]
}

export function LeaderboardPanel({ refreshKey, active }: { refreshKey: number; active: boolean }) {
  const [runs, setRuns] = useState<RunSummaryDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detailsCache, setDetailsCache] = useState<Map<string, RunFullDto>>(new Map())
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/benchmark/runs')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as RunsResponse
      setRuns(data.runs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load runs')
    } finally {
      setLoading(false)
    }
  }, [])

  // Refetch whenever the tab becomes active or a run completes.
  // (Radix Tabs keeps inactive panels mounted, so mount-time effects alone
  // would show stale data.)
  useEffect(() => {
    if (active) load()
  }, [active, refreshKey, load])

  const rows = useMemo<LeaderRow[]>(() => {
    const out: LeaderRow[] = []
    for (const run of runs) {
      for (const result of run.results ?? []) {
        out.push({
          key: `${run.id}:${result.id}`,
          runId: run.id,
          runLabel: run.label ?? run.id.slice(0, 8),
          runDate: run.createdAt,
          suite: result.metrics?.suite ?? run.config?.suite ?? 'quick',
          // Runs created before v3.1.2 had no mode — they ran with model
          // defaults (thinking allowed), which is quality-mode semantics.
          mode: result.metrics?.mode === 'turbo' || run.config?.mode === 'turbo' ? 'turbo' : 'quality',
          result,
        })
      }
    }
    out.sort((a, b) => b.result.overallScore - a.result.overallScore)
    return out
  }, [runs])

  // Best result per model (for the radar comparison).
  const radarModels = useMemo(() => {
    const best = new Map<string, { label: string; provider: string; score: number; cats: Record<string, number> }>()
    for (const row of rows) {
      const label = row.result.model
      const existing = best.get(label)
      if (existing && existing.score >= row.result.overallScore) continue
      const cats: Record<string, number> = {}
      for (const cs of row.result.categoryScores ?? []) cats[cs.category] = cs.score
      best.set(label, { label, provider: row.result.provider, score: row.result.overallScore, cats })
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4)
  }, [rows])

  const radarData = useMemo(() => {
    return CATEGORY_RUBRIC.map((cat) => {
      const point: Record<string, string | number | null> = { category: cat.short }
      for (const m of radarModels) {
        point[m.label] = m.cats[cat.key] ?? null
      }
      return point
    })
  }, [radarModels])

  const toggleExpand = async (row: LeaderRow) => {
    if (expanded === row.key) {
      setExpanded(null)
      return
    }
    setExpanded(row.key)
    if (!detailsCache.has(row.runId)) {
      try {
        const res = await fetch(`/api/benchmark/runs/${row.runId}`)
        if (res.ok) {
          const data = (await res.json()) as { run: RunFullDto }
          setDetailsCache((prev) => new Map(prev).set(row.runId, data.run))
        }
      } catch {
        // details stay unavailable; row still expands
      }
    }
  }

  const deleteRun = async (runId: string) => {
    setDeleting(runId)
    try {
      await fetch(`/api/benchmark/runs/${runId}`, { method: 'DELETE' })
      setDetailsCache((prev) => {
        const next = new Map(prev)
        next.delete(runId)
        return next
      })
      setExpanded(null)
      await load()
    } catch {
      // ignore
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  const detailResult = (row: LeaderRow): ResultFullDto | null => {
    const run = detailsCache.get(row.runId)
    if (!run) return null
    return run.results.find((r) => r.id === row.result.id) ?? null
  }

  return (
    <div className="space-y-4">
      {/* Radar comparison */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Crosshair className="h-4 w-4 text-crimson-400" />
            Category comparison — top models
          </CardTitle>
          <CardDescription>
            Best result per model across all runs, on the 11 investigation-reasoning categories (0–1). Turbo and
            quality runs are mixed — check the mode badge per row when comparing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {radarModels.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Trophy className="h-8 w-8 opacity-30" />
              {loading ? 'Loading results…' : 'No benchmark results yet — run a benchmark to populate the leaderboard.'}
            </div>
          ) : (
            <div className="h-[340px] w-full sm:h-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData} outerRadius="72%">
                  <PolarGrid stroke="rgba(255,255,255,0.12)" />
                  <PolarAngleAxis
                    dataKey="category"
                    tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 10 }}
                  />
                  <PolarRadiusAxis
                    domain={[0, 1]}
                    tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 9 }}
                    stroke="rgba(255,255,255,0.12)"
                  />
                  {radarModels.map((m, i) => (
                    <Radar
                      key={m.label}
                      name={m.label}
                      dataKey={m.label}
                      stroke={RADAR_COLORS[i % RADAR_COLORS.length]}
                      fill={RADAR_COLORS[i % RADAR_COLORS.length]}
                      fillOpacity={0.12}
                      strokeWidth={2}
                      connectNulls
                    />
                  ))}
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'rgba(10,10,12,0.95)',
                      border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leaderboard table */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-4 w-4 text-crimson-400" />
                Leaderboard
              </CardTitle>
              <CardDescription className="mt-1">
                All model results across runs, ranked by weighted overall score. Click a row for the per-test breakdown.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-crimson-800/50 bg-crimson-950/30 p-3 text-xs text-crimson-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {loading && rows.length === 0 && (
            <div className="space-y-2">
              <div className="h-12 animate-pulse rounded-md bg-muted/30" />
              <div className="h-12 animate-pulse rounded-md bg-muted/30" />
              <div className="h-12 animate-pulse rounded-md bg-muted/30" />
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Trophy className="h-8 w-8 opacity-30" />
              No results yet. Run a benchmark from the first tab.
            </div>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">#</th>
                    <th className="py-2 pr-2 font-medium">Model</th>
                    <th className="py-2 pr-2 font-medium">Score</th>
                    <th className="py-2 pr-2 font-medium">Categories</th>
                    <th className="py-2 pr-2 font-medium">Avg latency</th>
                    <th className="py-2 pr-2 font-medium">Tests</th>
                    <th className="py-2 pr-2 font-medium">Run</th>
                    <th className="py-2 font-medium" aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const isOpen = expanded === row.key
                    const detail = detailResult(row)
                    return (
                      <Fragment key={row.key}>
                        <tr
                          className={`cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/30 ${
                            isOpen ? 'bg-primary/5' : ''
                          }`}
                          onClick={() => toggleExpand(row)}
                        >
                          <td className="py-2.5 pr-2 font-mono text-muted-foreground">{idx + 1}</td>
                          <td className="py-2.5 pr-2">
                            <div className="flex items-center gap-2">
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              <span className="max-w-[200px] truncate font-mono font-medium">{row.result.model}</span>
                              {(() => {
                                const tier = row.result.provider === 'local' ? inferModelTier(row.result.model) : null
                                if (!tier) return null
                                return (
                                  <Badge
                                    variant="outline"
                                    className={`text-[9px] uppercase ${
                                      tier === 'fast'
                                        ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
                                        : tier === 'standard'
                                          ? 'border-amber-600/50 bg-amber-950/30 text-amber-300'
                                          : 'border-purple-600/50 bg-purple-950/30 text-purple-300'
                                    }`}
                                    title={`RED Justice tier: ${tier} (${tier === 'fast' ? '10M–3B' : tier === 'standard' ? '3B–7B' : '7B+'} params)`}
                                  >
                                    {tier}
                                  </Badge>
                                )
                              })()}
                              <Badge
                                variant="outline"
                                className={`text-[9px] capitalize ${
                                  row.result.provider === 'local'
                                    ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-300'
                                    : 'border-amber-700/40 bg-amber-950/30 text-amber-300'
                                }`}
                              >
                                {row.result.provider}
                              </Badge>
                              <ModeBadge mode={row.mode} />
                            </div>
                          </td>
                          <td className="py-2.5 pr-2">
                            <span className="text-base font-bold text-glow-crimson">
                              {Math.round(row.result.overallScore * 100)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">/100</span>
                          </td>
                          <td className="py-2.5 pr-2">
                            <CategoryBars categoryScores={row.result.categoryScores} />
                          </td>
                          <td className="py-2.5 pr-2 whitespace-nowrap text-muted-foreground">
                            {row.result.metrics?.latencyAvgMs !== undefined ? (
                              <span className="flex items-center gap-1">
                                <Zap className="h-3 w-3" />
                                {(row.result.metrics.latencyAvgMs / 1000).toFixed(1)}s
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 pr-2 whitespace-nowrap text-muted-foreground">
                            {row.result.metrics?.testsRun ?? '—'}
                            {row.result.metrics?.failures ? (
                              <span className="ml-1 text-crimson-400">({row.result.metrics.failures} failed)</span>
                            ) : null}
                          </td>
                          <td className="py-2.5 pr-2 text-[10px] text-muted-foreground">
                            <div className="max-w-[140px] truncate" title={`${row.runLabel} · ${row.suite}`}>
                              {row.runLabel}
                            </div>
                            <div className="opacity-70">{new Date(row.runDate).toLocaleString()}</div>
                          </td>
                          <td className="py-2.5 text-right">
                            {confirmDelete === row.runId ? (
                              <span className="inline-flex items-center gap-1">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 px-2 text-[10px]"
                                  disabled={deleting === row.runId}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    deleteRun(row.runId)
                                  }}
                                >
                                  {deleting === row.runId ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    'Confirm delete'
                                  )}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-[10px]"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setConfirmDelete(null)
                                  }}
                                >
                                  Cancel
                                </Button>
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-crimson-400"
                                title="Delete this run"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setConfirmDelete(row.runId)
                                  window.setTimeout(() => setConfirmDelete((c) => (c === row.runId ? null : c)), 4000)
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-border/40">
                            <td colSpan={8} className="p-0">
                              <TestBreakdown detail={detail} loading={Boolean(!detail)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Tiny inline bar per category, colored by score. */
function CategoryBars({ categoryScores }: { categoryScores: Array<{ category: string; score: number }> | undefined }) {
  const map = new Map((categoryScores ?? []).map((c) => [c.category, c.score]))
  return (
    <div className="flex items-end gap-[3px]" role="img" aria-label="per-category scores">
      {CATEGORY_RUBRIC.map((cat) => {
        const score = map.get(cat.key)
        const color = score === undefined ? 'rgba(255,255,255,0.08)' : score >= 0.75 ? '#10b981' : score >= 0.5 ? '#f59e0b' : '#ef4444'
        return (
          <span
            key={cat.key}
            title={`${cat.label}: ${score === undefined ? 'not run' : `${Math.round(score * 100)}%`}`}
            className="w-1.5 rounded-sm"
            style={{
              height: '22px',
              backgroundColor: color,
              opacity: score === undefined ? 1 : 0.35 + score * 0.65,
            }}
          />
        )
      })}
    </div>
  )
}

/** Expanded per-test breakdown for one model result. */
function TestBreakdown({ detail, loading }: { detail: ResultFullDto | null; loading: boolean }) {
  if (loading && !detail) {
    return (
      <div className="flex items-center gap-2 bg-muted/20 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading test details…
      </div>
    )
  }
  if (!detail || detail.details.length === 0) {
    return <div className="bg-muted/20 p-4 text-xs text-muted-foreground">No per-test details available.</div>
  }
  return (
    <div className="bg-muted/20 p-3">
      <div className="max-h-96 overflow-y-auto rounded-md border border-border/40">
        <table className="w-full min-w-[640px] text-left text-[11px]">
          <thead className="sticky top-0 bg-background/95 backdrop-blur">
            <tr className="border-b border-border/50 text-[9px] uppercase tracking-wider text-muted-foreground">
              <th className="p-2 font-medium">Test</th>
              <th className="p-2 font-medium">Score</th>
              <th className="p-2 font-medium">Notes</th>
              <th className="p-2 font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {detail.details.map((t, i) => (
              <tr key={`${t.category}-${i}`} className="border-b border-border/30 align-top">
                <td className="p-2 whitespace-nowrap">
                  <div className="font-medium">{t.label}</div>
                  <div className="text-[9px] uppercase text-muted-foreground">{t.category}</div>
                </td>
                <td className="p-2 whitespace-nowrap">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                      t.score >= 0.75
                        ? 'bg-emerald-950/50 text-emerald-300'
                        : t.score >= 0.5
                          ? 'bg-amber-950/50 text-amber-300'
                          : 'bg-crimson-950/50 text-crimson-300'
                    }`}
                  >
                    {Math.round(t.score * 100)}%
                  </span>
                  {!t.parsed && !t.error && <div className="mt-0.5 text-[9px] text-amber-500">unparsed JSON</div>}
                </td>
                <td className="p-2">
                  <div className="max-w-[420px] text-muted-foreground">
                    {t.error ? <span className="text-crimson-400">Error: {t.error}</span> : t.notes}
                  </div>
                  {t.responsePreview && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-muted-foreground/70 hover:text-foreground">
                        response preview
                      </summary>
                      <pre className="mt-1 max-h-48 max-w-[560px] overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
                        {t.responsePreview}
                      </pre>
                    </details>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap text-muted-foreground">{(t.latencyMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span>Latency p95: {((detail.metrics?.latencyP95Ms ?? 0) / 1000).toFixed(1)}s</span>
        <span>Suite: {detail.metrics?.suite ?? 'quick'}</span>
        <span>Cases: {detail.metrics?.caseCount ?? '?'}</span>
        {detail.metrics?.seed !== undefined && <span>Seed: {detail.metrics.seed}</span>}
        <span>Mode: {detail.metrics?.mode === 'turbo' ? 'turbo (thinking off + JSON grammar)' : 'quality (full thinking)'}</span>
      </div>
    </div>
  )
}
