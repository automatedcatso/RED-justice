'use client'

/**
 * RunnerPanel.tsx — the "Run Benchmarks" tab: model picker, run config,
 * live progress (polls the run every 2s) and the completion summary.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronLeft,
  Cpu,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  Scale,
  Server,
  Timer,
  Trophy,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { CATEGORY_RUBRIC } from '@/lib/benchmark/types'
import type { ModelsResponse, ProgressDto, RunFullDto } from './dto'

interface Props {
  onRunComplete: () => void
}

export function RunnerPanel({ onRunComplete }: Props) {
  const [listing, setListing] = useState<ModelsResponse | null>(null)
  const [listingLoading, setListingLoading] = useState(true)
  const [listingError, setListingError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [suite, setSuite] = useState<'quick' | 'full'>('quick')
  const [caseCount, setCaseCount] = useState('2')
  const [seed, setSeed] = useState('')
  const [mode, setMode] = useState<'turbo' | 'quality'>('turbo')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [run, setRun] = useState<RunFullDto | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadModels = useCallback(async () => {
    setListingLoading(true)
    setListingError(null)
    try {
      const res = await fetch('/api/benchmark/models')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ModelsResponse
      setListing(data)
      // Pre-select nothing — user chooses.
    } catch (err) {
      setListingError(err instanceof Error ? err.message : 'failed to load models')
    } finally {
      setListingLoading(false)
    }
  }, [])

  useEffect(() => {
    loadModels()
  }, [loadModels])

  // Poll the active run.
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const id = run.id
    const tick = async () => {
      try {
        const res = await fetch(`/api/benchmark/runs/${id}`)
        if (res.ok) {
          const data = (await res.json()) as { run: RunFullDto }
          setRun(data.run)
          if (data.run.status !== 'running') {
            onRunComplete()
          }
        }
      } catch {
        // transient — keep polling
      }
    }
    pollRef.current = setInterval(tick, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [run, onRunComplete])

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startRun = async () => {
    setStartError(null)
    if (selected.size === 0) {
      setStartError('Select at least one model.')
      return
    }
    setStarting(true)
    try {
      const res = await fetch('/api/benchmark/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelIds: [...selected],
          config: {
            suite,
            caseCount: Number(caseCount),
            seed: seed.trim() ? Number(seed.trim()) : undefined,
            mode,
          },
        }),
      })
      const data = (await res.json()) as { runId?: string; error?: string }
      if (!res.ok || !data.runId) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setRun({
        id: data.runId,
        label: `${[...selected].join(', ')} · ${suite} · ${caseCount} case${caseCount === '1' ? '' : 's'} · ${mode}`,
        status: 'running',
        progress: { done: 0, total: selected.size * Number(caseCount) * (suite === 'quick' ? 7 : 11) },
        results: [],
        models: [...selected].map((id) => ({ id, provider: 'local' })),
        config: { suite, caseCount: Number(caseCount), mode },
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'failed to start run')
    } finally {
      setStarting(false)
    }
  }

  const resetRun = () => {
    setRun(null)
    setStartError(null)
  }

  // ── Active run view ───────────────────────────────────────────────────────
  if (run) {
    const progress: ProgressDto = run.progress ?? {}
    const done = progress.done ?? 0
    const total = progress.total ?? 0
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return (
      <div className="space-y-4">
        <Card className="border-border/60 bg-card/60">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  {run.status === 'running' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-crimson-400" />
                      Benchmark running…
                    </>
                  ) : run.status === 'complete' ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      Run complete
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 text-crimson-400" />
                      Run failed
                    </>
                  )}
                </CardTitle>
                <CardDescription className="mt-1 font-mono text-xs">
                  {run.label ?? run.id} · {run.config?.suite ?? 'quick'} suite · {run.config?.caseCount ?? '?'} case
                  {run.config?.caseCount === 1 ? '' : 's'}
                  {run.config?.seed !== undefined ? ` · seed ${run.config.seed}` : ''}
                </CardDescription>
                <div className="mt-1.5">
                  <ModeBadge mode={(run.config?.mode as 'turbo' | 'quality' | undefined) ?? 'quality'} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                {run.status === 'complete' && (
                  <Button size="sm" variant="outline" onClick={onRunComplete}>
                    <Trophy className="mr-1.5 h-3.5 w-3.5" />
                    View leaderboard
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={resetRun}>
                  <ChevronLeft className="mr-1.5 h-3.5 w-3.5" />
                  New run
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {done} / {total} tests
                </span>
                <span className="font-mono">{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" />
              {run.status === 'running' && (
                <p className="pt-1 text-xs text-muted-foreground">
                  <span className="text-crimson-300">{progress.currentModel ?? '…'}</span>
                  {progress.currentTest ? ` · ${progress.currentTest}` : ''}
                </p>
              )}
            </div>

            {progress.perModel && progress.perModel.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {progress.perModel.map((m) => (
                  <div
                    key={m.model}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] ${
                      m.status === 'running'
                        ? 'border-crimson-500/40 bg-crimson-950/30 text-crimson-200'
                        : m.status === 'complete'
                          ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-300'
                          : 'border-border/50 bg-muted/30 text-muted-foreground'
                    }`}
                  >
                    {m.status === 'running' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : m.status === 'complete' ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <Timer className="h-3 w-3" />
                    )}
                    <span className="font-mono">{m.model}</span>
                    <span className="opacity-70">
                      {m.done}/{m.total}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {run.status === 'failed' && run.error && (
              <div className="rounded-md border border-crimson-800/50 bg-crimson-950/30 p-3 text-xs text-crimson-200">
                <div className="mb-1 font-semibold">Run failed</div>
                <div className="break-words font-mono opacity-80">{run.error}</div>
              </div>
            )}

            {run.status === 'complete' && run.results.length > 0 && (
              <div className="space-y-2">
                {run.results
                  .slice()
                  .sort((a, b) => b.overallScore - a.overallScore)
                  .map((r, i) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                    >
                      <span className="w-6 text-center text-sm font-bold text-muted-foreground">#{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{r.model}</span>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {r.provider}
                      </Badge>
                      <span className="text-lg font-bold text-glow-crimson">
                        {Math.round(r.overallScore * 100)}
                        <span className="text-xs font-normal text-muted-foreground">/100</span>
                      </span>
                      {r.metrics?.latencyAvgMs !== undefined && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Zap className="h-3 w-3" />
                          {(r.metrics.latencyAvgMs / 1000).toFixed(1)}s avg
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Setup view ────────────────────────────────────────────────────────────
  const localModels = listing?.models.filter((m) => m.provider === 'local') ?? []
  const geminiModels = listing?.models.filter((m) => m.provider === 'gemini') ?? []
  const anyAvailable = listing?.models.some((m) => m.available) ?? false

  // v3.3: group local models by tier — exactly how RED Justice's model router
  // classifies them (fast ≤3B / standard 3–7B / deep 7B+). Benchmarking a
  // tier trio side by side is the supported workflow.
  const tierGroups: Array<{
    tier: 'fast' | 'standard' | 'deep'
    label: string
    range: string
    icon: typeof Zap
    accent: string
  }> = [
    { tier: 'fast', label: 'Fast tier', range: '10M – 3B', icon: Zap, accent: 'text-emerald-400' },
    { tier: 'standard', label: 'Standard tier', range: '3B – 7B', icon: Scale, accent: 'text-amber-400' },
    { tier: 'deep', label: 'Deep tier', range: '7B+', icon: Brain, accent: 'text-purple-400' },
  ]
  const unTiered = localModels.filter((m) => !m.tier)
  const tierModelCount = localModels.filter((m) => m.tier).length
  const tierSelectedCount = localModels.filter((m) => m.tier && selected.has(m.id)).length

  return (
    <div className="space-y-4">
      {/* Model picker */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4 text-crimson-400" />
            Models
          </CardTitle>
          <CardDescription>
            Local models run on your Ollama / OpenAI-compatible server; Gemini models are the cloud fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {listingLoading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {listingError && (
            <div className="flex items-center gap-2 rounded-md border border-crimson-800/50 bg-crimson-950/30 p-3 text-xs text-crimson-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Failed to load models: {listingError}
              <Button size="sm" variant="outline" className="ml-auto" onClick={loadModels}>
                <RefreshCw className="mr-1 h-3 w-3" /> Retry
              </Button>
            </div>
          )}

          {!listingLoading && !listingError && !anyAvailable && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                No AI models available
              </div>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                The Benchmark Lab needs at least one reachable model. Pick one of these options:
              </p>
              <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li className="flex gap-2">
                  <Server className="mt-0.5 h-3.5 w-3.5 shrink-0 text-crimson-400" />
                  <span>
                    <span className="font-medium text-foreground">Local (recommended):</span> start your local server
                    — <code className="rounded bg-muted px-1 py-0.5 font-mono">ollama serve</code> then{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">ollama pull llama3.2</code> (or any
                    model). Detected via <code className="font-mono">{listing?.providers.local.endpoint || 'local endpoint'}</code>.
                  </span>
                </li>
                <li className="flex gap-2">
                  <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    <span className="font-medium text-foreground">Gemini fallback:</span> set{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">GEMINI_API_KEY</code> in{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">.env</code> (free key at
                    aistudio.google.com/apikey), then reload this page.
                  </span>
                </li>
              </ul>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border/50 pt-3 text-[11px]">
                <span
                  className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                    listing?.providers.local.available
                      ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-300'
                      : 'border-border/50 bg-muted/30 text-muted-foreground'
                  }`}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                  Local server: {listing?.providers.local.available ? 'online' : 'offline'}
                  {listing?.providers.local.error ? ` (${listing.providers.local.error})` : ''}
                </span>
                <span
                  className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                    listing?.providers.gemini.available
                      ? 'border-emerald-700/40 bg-emerald-950/30 text-emerald-300'
                      : 'border-border/50 bg-muted/30 text-muted-foreground'
                  }`}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                  Gemini: {listing?.providers.gemini.available ? 'online' : 'offline'}
                  {listing?.providers.gemini.error ? ` (${listing.providers.gemini.error})` : ''}
                </span>
              </div>
            </div>
          )}

          {tierModelCount > 0 && (
            <div className="space-y-3">
              {tierGroups.map((g) => {
                const group = localModels.filter((m) => m.tier === g.tier)
                if (group.length === 0) return null
                const GIcon = g.icon
                const groupSelected = group.filter((m) => selected.has(m.id)).length
                return (
                  <div key={g.tier}>
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <GIcon className={`h-3.5 w-3.5 ${g.accent}`} />
                      <span>{g.label}</span>
                      <Badge variant="outline" className="text-[9px] text-muted-foreground">
                        {g.range}
                      </Badge>
                      <span className="ml-auto flex items-center gap-2">
                        {groupSelected > 0 && (
                          <Badge variant="outline" className="border-crimson-700/40 bg-crimson-950/20 text-[9px] text-crimson-300">
                            {groupSelected} selected
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            setSelected((prev) => {
                              const next = new Set(prev)
                              const allOn = group.every((m) => next.has(m.id))
                              for (const m of group) {
                                if (allOn) next.delete(m.id)
                                else next.add(m.id)
                              }
                              return next
                            })
                          }}
                        >
                          {group.every((m) => selected.has(m.id)) ? 'Clear' : 'Select all'}
                        </Button>
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {group.map((m) => (
                        <ModelCard key={m.id} model={m} checked={selected.has(m.id)} onToggle={() => toggleModel(m.id)} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {unTiered.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Server className="h-3.5 w-3.5 text-crimson-400" />
                Other local models
                <Badge variant="outline" className="text-[9px] text-muted-foreground">
                  size unknown
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {unTiered.map((m) => (
                  <ModelCard key={m.id} model={m} checked={selected.has(m.id)} onToggle={() => toggleModel(m.id)} />
                ))}
              </div>
            </div>
          )}

          {tierSelectedCount > 0 && tierSelectedCount <= 3 && (
            <p className="text-[11px] text-muted-foreground">
              Tip: benchmark one model per tier (fast + standard + deep) to compare exactly the trio RED
              Justice's model router would deploy.
            </p>
          )}

          {geminiModels.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Zap className="h-3.5 w-3.5 text-amber-400" />
                Gemini (cloud fallback)
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {geminiModels.map((m) => (
                  <ModelCard key={m.id} model={m} checked={selected.has(m.id)} onToggle={() => toggleModel(m.id)} />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Config + start */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4 text-crimson-400" />
            Run configuration
          </CardTitle>
          <CardDescription>
            Cases are synthetic and seeded — the same seed always reproduces the same case set.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Suite</Label>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border/50 bg-muted/30 p-1">
                {(['quick', 'full'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSuite(s)}
                    className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                      suite === s ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {s === 'quick' ? `Quick (7 tests)` : 'Full (11 tests)'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Speed mode</Label>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border/50 bg-muted/30 p-1">
                <button
                  type="button"
                  onClick={() => setMode('turbo')}
                  aria-pressed={mode === 'turbo'}
                  title="Production scan config: thinking off + JSON grammar — 5-10× faster on Qwen3-class models, no extraction-quality loss"
                  className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                    mode === 'turbo'
                      ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Zap className="h-3 w-3" />
                  Turbo
                </button>
                <button
                  type="button"
                  onClick={() => setMode('quality')}
                  aria-pressed={mode === 'quality'}
                  title="Raw model defaults: full chain-of-thought allowed — slow on hybrid thinking models (hours on a 9B)"
                  className={`flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                    mode === 'quality'
                      ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Brain className="h-3 w-3" />
                  Quality
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="bench-cases">
                Cases
              </Label>
              <Select value={caseCount} onValueChange={setCaseCount}>
                <SelectTrigger id="bench-cases" className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['1', '2', '3', '4', '5'].map((n) => (
                    <SelectItem key={n} value={n} className="text-xs">
                      {n} case{n === '1' ? '' : 's'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="bench-seed">
                Seed (optional)
              </Label>
              <Input
                id="bench-seed"
                placeholder="random"
                inputMode="numeric"
                value={seed}
                onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
                className="h-9 text-xs"
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {mode === 'turbo' ? (
              <>
                <Zap className="mr-1 inline h-3 w-3 text-amber-400" />
                <span className="font-medium text-amber-300">Turbo</span> sends every call exactly like RED Justice's
                production scans — chain-of-thought disabled on thinking models + JSON grammar enforced. 5–10× faster on
                Qwen3-class models with no extraction-quality loss; results reflect how the app actually deploys each
                model.
              </>
            ) : (
              <>
                <Brain className="mr-1 inline h-3 w-3 text-primary" />
                <span className="font-medium text-primary">Quality</span> lets models think freely with their default
                behaviour — the raw-capability measurement. On hybrid thinking models (Qwen3/Qwen3.5/gpt-oss…) this can
                take hours on modest hardware.
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={startRun} disabled={starting || selected.size === 0 || !anyAvailable}>
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Start Benchmark Run
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {selected.size} model{selected.size === 1 ? '' : 's'} ·{' '}
              {selected.size * Number(caseCount) * (suite === 'quick' ? 7 : 11)} model calls ·{' '}
              {mode === 'turbo' ? 'turbo (production scan config)' : 'quality (full thinking)'} · weights renormalized per
              suite
            </span>
          </div>
          {startError && (
            <p className="text-xs text-crimson-300">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {startError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ModelCard({
  model,
  checked,
  onToggle,
}: {
  model: {
    id: string
    label: string
    available: boolean
    detail?: string
    sizeBytes?: number
    paramSizeB?: number | null
    tier?: 'fast' | 'standard' | 'deep' | null
  }
  checked: boolean
  onToggle: () => void
}) {
  const disabled = !model.available
  const tierBadge =
    model.tier === 'fast'
      ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-300'
      : model.tier === 'standard'
        ? 'border-amber-600/50 bg-amber-950/30 text-amber-300'
        : model.tier === 'deep'
          ? 'border-purple-600/50 bg-purple-950/30 text-purple-300'
          : null
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={checked}
      aria-disabled={disabled}
      onClick={() => !disabled && onToggle()}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      title={disabled ? model.detail : model.id}
      className={`group flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed border-border/40 bg-muted/10 opacity-50'
          : checked
            ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/30'
            : 'border-border/50 bg-muted/20 hover:border-border hover:bg-muted/40'
      }`}
    >
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
        }`}
      >
        {checked && <CheckCircle2 className="h-3 w-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{model.label}</span>
          {model.tier && (
            <Badge
              variant="outline"
              className={`shrink-0 text-[8px] uppercase ${tierBadge}`}
              title={`RED Justice tier: ${model.tier} (${model.tier === 'fast' ? '10M–3B' : model.tier === 'standard' ? '3B–7B' : '7B+'} params)`}
            >
              {model.tier}
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {model.id}
          {model.paramSizeB != null
            ? ` · ${model.paramSizeB < 1 ? `${Math.round(model.paramSizeB * 1000)}M` : `${model.paramSizeB}B`} params`
            : ''}
          {model.sizeBytes ? ` · ${(model.sizeBytes / 1e9).toFixed(1)} GB` : ''}
          {disabled && model.detail ? ` · ${model.detail}` : ''}
        </div>
      </div>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${model.available ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`}
        aria-label={model.available ? 'available' : 'unavailable'}
      />
    </div>
  )
}

/** Turbo/Quality run-mode indicator (amber bolt = production scan config). */
export function ModeBadge({ mode }: { mode: 'turbo' | 'quality' }) {
  const turbo = mode === 'turbo'
  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[9px] uppercase tracking-wide ${
        turbo
          ? 'border-amber-600/40 bg-amber-950/30 text-amber-300'
          : 'border-border/50 bg-muted/30 text-muted-foreground'
      }`}
      title={
        turbo
          ? 'Every call used the production scan config: thinking off + JSON grammar'
          : 'Model defaults: full chain-of-thought allowed'
      }
    >
      {turbo ? <Zap className="h-2.5 w-2.5" /> : <Brain className="h-2.5 w-2.5" />}
      {mode}
    </Badge>
  )
}
