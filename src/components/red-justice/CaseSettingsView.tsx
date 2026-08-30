'use client'

import { useState, useRef, useEffect } from 'react'
import {
  Download,
  Upload,
  Settings as SettingsIcon,
  FileJson,
  Database,
  AlertTriangle,
  CheckCircle2,
  Archive,
  Trash2,
  HardDrive,
  Cpu,
  RefreshCw,
  Activity,
  Loader2,
  Zap,
  Scale,
  Brain,
  Wand2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { api, type Case, type ImportSummary, type SystemStatus } from '@/lib/api-client'

interface Props {
  caseId: string
  activeCase: Case | null
  onSelectCase: (id: string) => void
}

type ModelTier = 'fast' | 'standard' | 'deep'

interface OllamaModel {
  name: string
  size?: number
  modifiedAt?: string
  paramSizeB?: number | null
  tier?: ModelTier | null
}

interface TierAssignment {
  fast: string
  standard: string
  deep: string
  source: 'env' | 'auto' | 'fallback'
}

const TIER_CARDS: Array<{
  id: ModelTier
  label: string
  range: string
  purpose: string
  cot: string
  icon: typeof Zap
  accent: string
  ring: string
}> = [
  {
    id: 'fast',
    label: 'Fast',
    range: '10M – 3B params',
    purpose: 'Simple classification, obvious extraction, tiny structured documents (CDR rows, registers).',
    cot: 'Chain-of-thought OFF — pure speed.',
    icon: Zap,
    accent: 'text-emerald-400',
    ring: 'border-emerald-700/30',
  },
  {
    id: 'standard',
    label: 'Standard',
    range: '3B – 7B params',
    purpose: 'Contextual entity extraction, relationship candidates, evidence-chunk enrichment — the default scan brain.',
    cot: 'Chain-of-thought OFF on structured JSON output.',
    icon: Scale,
    accent: 'text-amber-400',
    ring: 'border-amber-700/30',
  },
  {
    id: 'deep',
    label: 'Deep',
    range: '7B+ params',
    purpose: 'Investigation reasoning, narrative explanations, complex relationships, and escalation from lower tiers.',
    cot: 'Chain-of-thought ON where the model supports it.',
    icon: Brain,
    accent: 'text-purple-400',
    ring: 'border-purple-700/30',
  },
]

export function CaseSettingsView({ caseId, activeCase, onSelectCase }: Props) {
  const { toast } = useToast()
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportSummary | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // AI model router state (v3.3 tiered routing)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [tiers, setTiers] = useState<TierAssignment | null>(null)
  const [aiAvailable, setAiAvailable] = useState(false)
  const [aiEndpoint, setAiEndpoint] = useState('')
  const [aiError, setAiError] = useState<string | undefined>()
  const [loadingModels, setLoadingModels] = useState(false)
  const [savingTier, setSavingTier] = useState<ModelTier | null>(null)

  // v3.10.0 — derive the provider label from the LIVE endpoint so the panel
  // never claims "Ollama" while actually serving a cloud bridge (the exact
  // confusion the v3.9.1 build shipped with zai://glm in .env).
  const providerName = aiEndpoint.includes('z-ai')
    ? 'Z.ai GLM'
    : aiEndpoint.includes('gemini')
      ? 'Google Gemini'
      : aiEndpoint
        ? 'Ollama'
        : ''

  const loadModels = async () => {
    setLoadingModels(true)
    try {
      const res = await fetch('/api/ai/models')
      const data = await res.json()
      setModels(data.models ?? [])
      setTiers(data.tiers ?? null)
      setAiAvailable(data.available ?? false)
      setAiEndpoint(data.endpoint ?? '')
      setAiError(data.error)
    } catch (e) {
      toast({
        title: 'Failed to load models',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    loadModels()
  }, [])

  /** Save the full tier trio (one POST keeps the assignment atomic). */
  const saveTiers = async (next: TierAssignment, silent = false) => {
    setSavingTier('fast')
    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Failed to set models')
      }
      setTiers(next)
      if (!silent) {
        toast({
          title: 'Model router updated',
          description: `Fast: ${next.fast} · Standard: ${next.standard} · Deep: ${next.deep}`,
        })
      }
    } catch (e) {
      toast({
        title: 'Failed to set models',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setSavingTier(null)
    }
  }

  const handleTierChange = (tier: ModelTier, model: string) => {
    if (!tiers || tiers[tier] === model) return
    saveTiers({ ...tiers, [tier]: model })
  }

  /**
   * Suggest an assignment from the models' computed tiers (mirrors the
   * server's auto-assignment logic): largest ≤3B → fast, largest 3–7B (or
   * closest to 4B) → standard, largest >7B (or largest overall) → deep.
   */
  const autoAssign = () => {
    if (!tiers || models.length === 0) return
    const params = (m: OllamaModel) =>
      m.paramSizeB ?? (m.tier === 'deep' ? 8 : m.tier === 'standard' ? 4 : m.tier === 'fast' ? 1 : 0)
    const ranked = [...models].sort((a, b) => params(a) - params(b))
    const p = (m: OllamaModel) => params(m)
    const fast = ranked.filter((m) => p(m) > 0 && p(m) <= 3).pop() ?? ranked[0]
    const inStd = ranked.filter((m) => p(m) > 3 && p(m) <= 7)
    const standard =
      inStd.length > 0
        ? inStd[inStd.length - 1]
        : [...models].sort((a, b) => Math.abs(p(a) - 4) - Math.abs(p(b) - 4))[0]
    const deep = ranked.filter((m) => p(m) > 7).pop() ?? ranked[ranked.length - 1]
    saveTiers({
      fast: fast.name,
      standard: standard.name,
      deep: deep.name,
      source: 'env',
    })
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const data = await api.caseExport(caseId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const safeUid = activeCase?.uid ?? caseId
      a.href = url
      a.download = `red-justice-${safeUid}-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast({
        title: 'Case exported',
        description: `Downloaded ${activeCase?.title ?? 'case'} as JSON backup.`,
      })
    } catch (e) {
      toast({
        title: 'Export failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setExporting(false)
    }
  }

  const handleImport = async (file: File) => {
    setImporting(true)
    setImportResult(null)
    try {
      const result = await api.caseImport(file)
      setImportResult(result.summary)
      toast({
        title: 'Case imported',
        description: `Created ${result.summary.case?.title ?? 'new case'} from ${file.name}`,
      })
      // Select the newly imported case
      if (result.summary.case && typeof result.summary.case.id === 'string') {
        onSelectCase(result.summary.case.id)
      }
    } catch (e) {
      toast({
        title: 'Import failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
    }
  }

  const exportStats = activeCase
    ? [
        { label: 'Case UID', value: activeCase.uid },
        { label: 'Title', value: activeCase.title },
        { label: 'Status', value: activeCase.status },
        { label: 'Classification', value: activeCase.classification },
        { label: 'AI Mode', value: activeCase.aiMode },
        { label: 'Created', value: new Date(activeCase.createdAt).toLocaleString() },
        { label: 'Updated', value: new Date(activeCase.updatedAt).toLocaleString() },
      ]
    : []

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
          Case Settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Export the active case as a portable JSON backup, or import a previously-exported case.
        </p>
      </div>

      <CapabilityMap />

      {/* Case metadata */}
      {activeCase && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-crimson-400" />
              Active Case Metadata
            </CardTitle>
            <CardDescription>
              The case currently selected in the sidebar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {exportStats.map((s) => (
                <div key={s.label} className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs" title={s.value}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Export */}
        <Card className="border-emerald-700/30 bg-gradient-to-br from-emerald-950/10 to-transparent">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-emerald-400" />
              Export Case
            </CardTitle>
            <CardDescription>
              Download a complete JSON backup of the active case — evidence, entities, relationships,
              transactions, findings, communities, actor risks, and notes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileJson className="h-3.5 w-3.5" />
              <span>Format: <code className="rounded bg-muted/40 px-1 py-0.5 font-mono">red-justice-1.0</code></span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['case', 'evidence', 'entities', 'relationships', 'transactions', 'communications', 'timeline', 'findings', 'communities', 'actorRisks', 'notes'].map((k) => (
                <Badge key={k} variant="outline" className="text-[9px] uppercase">
                  {k}
                </Badge>
              ))}
            </div>
            <Button onClick={handleExport} disabled={exporting || !activeCase} className="w-full">
              {exporting ? (
                <>
                  <div className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Download JSON backup
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Import */}
        <Card className="border-sky-700/30 bg-gradient-to-br from-sky-950/10 to-transparent">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-sky-400" />
              Import Case
            </CardTitle>
            <CardDescription>
              Upload a previously-exported <code className="font-mono">.json</code> file to create a new case
              with all data restored. A new UID is generated to avoid conflicts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  void handleImport(e.target.files[0])
                  e.target.value = ''
                }
              }}
            />
            {importing ? (
              <div className="rounded-md border border-sky-700/40 bg-sky-950/20 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                  Importing case…
                </div>
              </div>
            ) : (
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                className="w-full border-sky-700/40 hover:bg-sky-950/20"
              >
                <Upload className="mr-2 h-4 w-4" />
                Select .json file to import
              </Button>
            )}
            {importResult && (
              <Card className="border-emerald-700/40 bg-emerald-950/20">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                    <CheckCircle2 className="h-4 w-4" />
                    Import successful
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(importResult).map(([k, v]) => (
                      <div key={k} className="flex justify-between rounded bg-muted/20 px-2 py-1">
                        <span className="text-muted-foreground">{k}:</span>
                        <span className="font-mono">
                          {typeof v === 'object' && v !== null && 'title' in (v as Record<string, unknown>)
                            ? String((v as Record<string, unknown>).title)
                            : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI Model Router (v3.3 tiered routing) */}
      <Card className="border-purple-700/30 bg-gradient-to-br from-purple-950/10 to-transparent">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="h-4 w-4 text-purple-400" />
              AI Model Router{providerName ? ` (${providerName})` : ''}
            </CardTitle>
            <div className="flex items-center gap-2">
              {tiers && (
                <Badge
                  variant="outline"
                  className={`text-[9px] uppercase ${
                    tiers.source === 'env'
                      ? 'border-purple-500/40 text-purple-300'
                      : tiers.source === 'auto'
                        ? 'border-sky-500/40 text-sky-300'
                        : 'border-border/50 text-muted-foreground'
                  }`}
                  title={
                    tiers.source === 'env'
                      ? 'Manually assigned (saved in .env)'
                      : tiers.source === 'auto'
                        ? 'Auto-assigned from installed model sizes'
                        : 'Server unreachable — all tiers use the primary model'
                  }
                >
                  {tiers.source === 'env' ? 'MANUAL' : tiers.source === 'auto' ? 'AUTO' : 'FALLBACK'}
                </Badge>
              )}
              <Button onClick={loadModels} variant="ghost" size="icon" className="h-7 w-7" disabled={loadingModels}>
                <RefreshCw className={`h-3.5 w-3.5 ${loadingModels ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <CardDescription>
            Pick one model per tier. RED Justice routes each task to the cheapest tier that
            can reliably serve it — deterministic extraction never touches a model at all.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Status */}
          <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/10 px-3 py-2">
            <div className={`h-2 w-2 rounded-full ${aiAvailable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            <span className="text-xs">
              {!providerName
                ? 'Detecting AI endpoint…'
                : aiAvailable
                  ? `${providerName} connected`
                  : `${providerName} not available`}
            </span>
            <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-muted-foreground" title={aiEndpoint}>
              {aiEndpoint}
            </span>
          </div>

          {aiError && (
            <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
              {aiError} — make sure Ollama is running: <code className="font-mono">ollama serve</code>
            </div>
          )}

          {loadingModels ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading models…</div>
          ) : models.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center">
              <p className="text-sm text-muted-foreground">
                No models installed. Pull one with:
              </p>
              <code className="mt-2 block rounded bg-muted/40 px-2 py-1 font-mono text-xs">
                ollama pull qwen3:4b
              </code>
            </div>
          ) : (
            <>
              {/* Tier selectors */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {TIER_CARDS.map((t) => {
                  const Icon = t.icon
                  const selected = tiers?.[t.id] ?? ''
                  const selectedModel = models.find((m) => m.name === selected)
                  const mismatch =
                    selectedModel?.tier != null && selectedModel.tier !== t.id
                  return (
                    <div
                      key={t.id}
                      className={`rounded-lg border ${t.ring} bg-muted/10 p-3 ${savingTier ? 'opacity-70' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <Icon className={`h-4 w-4 ${t.accent}`} />
                        <span className="text-sm font-semibold">{t.label}</span>
                        <Badge variant="outline" className="ml-auto text-[9px] text-muted-foreground">
                          {t.range}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        {t.purpose}
                      </p>
                      <p className="mt-0.5 text-[10px] italic text-muted-foreground/80">{t.cot}</p>
                      <div className="mt-2.5">
                        <Select
                          value={selected || undefined}
                          onValueChange={(v) => handleTierChange(t.id, v)}
                          disabled={savingTier != null || !tiers}
                        >
                          <SelectTrigger className="h-9 w-full text-xs" aria-label={`${t.label} tier model`}>
                            <SelectValue placeholder="Select a model" />
                          </SelectTrigger>
                          <SelectContent>
                            <ScrollArea className="max-h-64">
                              {models.map((m) => (
                                <SelectItem key={m.name} value={m.name} className="text-xs">
                                  <span className="flex w-full items-center gap-2">
                                    <span className="truncate font-mono">{m.name}</span>
                                    {m.tier && (
                                      <Badge
                                        variant="outline"
                                        className={`ml-auto shrink-0 text-[8px] uppercase ${
                                          m.tier === 'fast'
                                            ? 'border-emerald-600/50 text-emerald-300'
                                            : m.tier === 'standard'
                                              ? 'border-amber-600/50 text-amber-300'
                                              : 'border-purple-600/50 text-purple-300'
                                        }`}
                                      >
                                        {m.tier}
                                      </Badge>
                                    )}
                                  </span>
                                </SelectItem>
                              ))}
                            </ScrollArea>
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedModel && (
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          {mismatch ? (
                            <span className="text-amber-400" title="The model's parameter size suggests a different tier — allowed, but check your intent">
                              size suggests {selectedModel.tier} tier
                            </span>
                          ) : selectedModel.tier ? (
                            <span className="text-emerald-400">matches tier</span>
                          ) : (
                            <span>size unknown</span>
                          )}
                          {selectedModel.size ? (
                            <span className="ml-auto font-mono">
                              {(selectedModel.size / 1e9).toFixed(1)} GB
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Auto-assign + routing summary */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={autoAssign}
                  disabled={savingTier != null || !tiers || models.length === 0}
                  title="Assign the largest ≤3B model to Fast, the largest 3–7B (or closest to 4B) to Standard, and the largest 7B+ to Deep"
                >
                  {savingTier ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Auto-assign by size
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Tiers persist in <code className="rounded bg-muted/40 px-1 font-mono">.env</code> —
                  the trio above serves every AI feature.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Storage info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-amber-400" />
            Storage & Integrity
          </CardTitle>
          <CardDescription>
            RED Justice uses SQLite (local-first). All data stays in this sandbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Database</div>
              <div className="mt-1 font-mono text-sm">SQLite (WAL)</div>
            </div>
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Evidence storage</div>
              <div className="mt-1 font-mono text-sm">Inline (text)</div>
            </div>
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Dedup method</div>
              <div className="mt-1 font-mono text-sm">SHA-256</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Danger Zone
          </CardTitle>
          <CardDescription>
            Irreversible actions. Export a backup before proceeding.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/10 px-3 py-2">
            <div>
              <div className="text-sm font-medium">Archive case</div>
              <div className="text-[11px] text-muted-foreground">
                Mark this case as archived. Data is preserved but hidden from default views.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (!activeCase) return
                if (!confirm(`Archive case "${activeCase.title}"?`)) return
                try {
                  await api.updateCase(caseId, { status: 'archived' })
                  toast({ title: 'Case archived' })
                } catch (e) {
                  toast({
                    title: 'Archive failed',
                    description: e instanceof Error ? e.message : 'unknown error',
                    variant: 'destructive',
                  })
                }
              }}
            >
              <Archive className="mr-2 h-3.5 w-3.5" />
              Archive
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Offline Capability Degradation Map — shows exactly what remains functional
 * when a backend (local LLM, Gemini, OCR…) is unavailable, instead of a
 * single online/offline flag.
 */
function CapabilityMap() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      setStatus(await api.systemStatus())
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const statusMeta: Record<string, { color: string; label: string }> = {
    operational: { color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300', label: 'OPERATIONAL' },
    degraded: { color: 'border-amber-700 bg-amber-950/30 text-amber-300', label: 'DEGRADED' },
    offline: { color: 'border-rose-700 bg-rose-950/30 text-rose-300', label: 'OFFLINE' },
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-emerald-400" />
              Offline Capability Degradation Map
            </CardTitle>
            <CardDescription className="text-[11px]">
              What keeps working when a backend goes down. Deterministic analysis never goes offline.
              {status?.degradedSummary && (
                <>{' '}
                  <b className="text-foreground">{status.degradedSummary.operational}</b> operational ·{' '}
                  <b className="text-foreground">{status.degradedSummary.degraded}</b> degraded ·{' '}
                  <b className="text-foreground">{status.degradedSummary.offline}</b> offline
                </>
              )}
            </CardDescription>
          </div>
          <Button onClick={() => void load()} variant="outline" size="icon" className="h-8 w-8">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !status ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Probing capabilities…</div>
        ) : !status || !status.capabilities ? (
          <div className="py-6 text-center text-sm text-destructive">Could not reach /api/system/status.</div>
        ) : (
          <div className="space-y-1.5">
            {status.capabilities.map((cap) => {
              const sm = statusMeta[cap.status] ?? statusMeta.degraded
              return (
                <div key={cap.name} className="rounded-md border border-border/40 bg-muted/10 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{cap.label}</span>
                    <Badge variant="outline" className={`ml-auto text-[9px] ${sm.color}`}>
                      {sm.label}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    depends on: {cap.dependsOn}
                  </div>
                  <div className="mt-0.5 text-[10px] text-sky-300/80">
                    when unavailable: {cap.fallback}
                  </div>
                  {cap.detail && <div className="mt-0.5 text-[10px] italic text-muted-foreground">{cap.detail}</div>}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
