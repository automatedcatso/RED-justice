'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  FileSearch,
  FileText,
  File,
  Hash,
  Plus,
  RefreshCw,
  Trash2,
  Database,
  CheckCircle2,
  AlertCircle,
  Clock,
  Upload,
  UploadCloud,
  X,
  FileArchive,
  FileSpreadsheet,
  FileCode,
  Mail,
  FileType,
  Sparkles,
  Brain,
  Lightbulb,
  AlertTriangle,
  ListChecks,
  Tags,
  Workflow,
  Loader2,
  GitMerge,
  Waypoints,
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
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { api, type Evidence } from '@/lib/api-client'
import { notifyGraphUpdated } from '@/hooks/use-graph-refresh'
import { formatDateTime, shortHash, truncate, formatNumber } from '@/lib/ui-helpers'
import { VersionsPanel } from './VersionsPanel'

interface Props {
  caseId: string
  /** When set, auto-selects this evidence item (per-edge provenance deep-link). */
  focusEvidenceId?: string | null
}

const STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending', color: 'text-slate-300', icon: <Clock className="h-3 w-3" /> },
  processing: { label: 'Processing', color: 'text-sky-300', icon: <Clock className="h-3 w-3" /> },
  done: { label: 'Done', color: 'text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
  processed: { label: 'Done', color: 'text-emerald-300', icon: <CheckCircle2 className="h-3 w-3" /> },
  error: { label: 'Error', color: 'text-destructive', icon: <AlertCircle className="h-3 w-3" /> },
}

function mimeIcon(mime: string | null, filename: string = '') {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'zip') return <FileArchive className="h-4 w-4 text-amber-400" />
  if (ext === 'xlsx' || ext === 'csv' || ext === 'tsv') return <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
  if (ext === 'docx' || ext === 'doc') return <FileText className="h-4 w-4 text-sky-400" />
  if (ext === 'pdf') return <FileText className="h-4 w-4 text-rose-400" />
  if (ext === 'eml' || ext === 'msg') return <Mail className="h-4 w-4 text-purple-400" />
  if (ext === 'json' || ext === 'xml' || ext === 'html' || ext === 'js' || ext === 'ts' || ext === 'py') return <FileCode className="h-4 w-4 text-cyan-400" />
  if (!mime) return <File className="h-4 w-4" />
  if (mime.startsWith('image/')) return <File className="h-4 w-4" />
  if (mime.includes('pdf')) return <FileText className="h-4 w-4" />
  if (mime.includes('csv') || mime.includes('sheet')) return <FileSpreadsheet className="h-4 w-4" />
  if (mime.includes('zip') || mime.includes('compressed')) return <FileArchive className="h-4 w-4" />
  return <FileText className="h-4 w-4" />
}

const ACCEPTED_FORMATS = '.txt,.log,.md,.markdown,.csv,.tsv,.json,.ndjson,.jsonl,.xml,.html,.htm,.yaml,.yml,.ini,.conf,.env,.sql,.eml,.msg,.rtf,.vcf,.ics,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ods,.pptx,.zip,.js,.ts,.py,.java,.c,.cpp,.h,.sh,.bash,.png,.jpg,.jpeg,.webp,.gif,.bmp'

const CLASS_META: Record<string, { label: string; color: string }> = {
  fir: { label: 'FIR / Police Report', color: 'border-rose-700 bg-rose-950/30 text-rose-300' },
  bank_statement: { label: 'Bank Statement', color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300' },
  cdr: { label: 'Call Detail Record', color: 'border-sky-700 bg-sky-950/30 text-sky-300' },
  whatsapp_chat: { label: 'Chat Export', color: 'border-lime-700 bg-lime-950/30 text-lime-300' },
  invoice: { label: 'Invoice / Bill', color: 'border-amber-700 bg-amber-950/30 text-amber-300' },
  receipt: { label: 'Receipt', color: 'border-amber-700 bg-amber-950/30 text-amber-300' },
  id_document: { label: 'ID Document', color: 'border-violet-700 bg-violet-950/30 text-violet-300' },
  contract: { label: 'Contract', color: 'border-teal-700 bg-teal-950/30 text-teal-300' },
  email: { label: 'Email', color: 'border-purple-700 bg-purple-950/30 text-purple-300' },
  court_document: { label: 'Court Document', color: 'border-orange-700 bg-orange-950/30 text-orange-300' },
  property_document: { label: 'Property Document', color: 'border-cyan-700 bg-cyan-950/30 text-cyan-300' },
  travel_record: { label: 'Travel Record', color: 'border-indigo-700 bg-indigo-950/30 text-indigo-300' },
  social_media: { label: 'Social Media', color: 'border-fuchsia-700 bg-fuchsia-950/30 text-fuchsia-300' },
  medical_record: { label: 'Medical Record', color: 'border-red-700 bg-red-950/30 text-red-300' },
  screenshot: { label: 'Screenshot', color: 'border-slate-600 bg-slate-900/40 text-slate-300' },
  ledger: { label: 'Ledger', color: 'border-yellow-700 bg-yellow-950/30 text-yellow-300' },
  letter: { label: 'Letter', color: 'border-stone-600 bg-stone-900/40 text-stone-300' },
  certificate: { label: 'Certificate', color: 'border-lime-700 bg-lime-950/30 text-lime-300' },
  academic_document: { label: 'Academic Document', color: 'border-teal-700 bg-teal-950/30 text-teal-300' },
  application: { label: 'Application', color: 'border-cyan-700 bg-cyan-950/30 text-cyan-300' },
  other: { label: 'Unclassified', color: 'border-border bg-muted/30 text-muted-foreground' },
}

function ClassificationBadge({ evidence }: { evidence: Evidence }) {
  const cls = evidence.classification ?? 'other'
  const meta = CLASS_META[cls] ?? CLASS_META.other
  const pct = evidence.classificationConfidence != null ? `${Math.round(evidence.classificationConfidence * 100)}%` : ''
  return (
    <Badge variant="outline" className={`gap-1 text-[9px] ${meta.color}`} title={`Classified ${meta.label}${pct ? ` (${pct})` : ''} via ${evidence.classificationSource ?? 'unknown'}`}>
      <Tags className="h-2.5 w-2.5" />
      {meta.label}{pct ? ` · ${pct}` : ''}
    </Badge>
  )
}

/**
 * Live AI-scan status badge (v3 Fully-AI pipeline). Status state machine:
 * pending → queued → running → complete | failed. The list polls while any
 * row is active, so these chips advance in real time without a refresh.
 */
function AiScanBadge({ status, error }: { status: string | null; error?: string | null }) {
  if (!status || status === 'pending') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Waiting in the automatic AI analysis queue">
        <Brain className="h-3 w-3" />
        AI queued
      </span>
    )
  }
  if (status === 'queued') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-sky-300" title="Queued for automatic AI analysis">
        <Clock className="h-3 w-3 animate-pulse" />
        AI queued
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-crimson-300" title="The AI is reading this file right now — entities and connections will appear automatically">
        <Loader2 className="h-3 w-3 animate-spin" />
        AI analyzing…
      </span>
    )
  }
  if (status === 'complete') {
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-300" title="AI analysis complete — entities and story connections added to the graph">
        <CheckCircle2 className="h-3 w-3" />
        AI analyzed
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-rose-300" title={error ?? 'AI analysis failed'}>
      <AlertCircle className="h-3 w-3" />
      AI failed
    </span>
  )
}

/** Evidence-to-Graph Auto Pipeline: per-file stage tracker. */
function PipelineCard({ evidence }: { evidence: Evidence[] }) {
  const stages = ['extract', 'classify', 'ai_scan']
  const stageLabel: Record<string, string> = {
    extract: 'Parse',
    classify: 'Classify',
    ai_scan: 'AI Analysis',
  }
  const aiBusy = (e: Evidence): boolean =>
    ['pending', 'queued', 'running'].includes(e.aiScanStatus ?? 'pending')
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Workflow className="h-4 w-4 text-crimson-400" />
          Evidence-to-Graph Auto Pipeline
        </CardTitle>
        <CardDescription className="text-[11px]">
          Fully automatic — drop a file and the AI reads it, assigns entities, detects the story, connects the actors and updates the knowledge graph. No clicks needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {evidence.slice(0, 12).map((e) => (
            <div key={e.id} className="flex items-center gap-2 rounded border border-border/40 bg-muted/10 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={e.originalName}>{e.originalName}</span>
              <div className="flex items-center gap-1">
                {stages.map((s) => {
                  const auto = s === 'extract' || (s === 'classify' && e.classification) || (s === 'ai_scan' && e.aiScanStatus === 'complete')
                  const busy = s === 'ai_scan' && aiBusy(e)
                  return (
                    <span
                      key={s}
                      className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                        auto
                          ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/50'
                          : busy
                            ? 'bg-crimson-950/40 text-crimson-300 border border-crimson-800/50 animate-pulse'
                            : 'bg-muted/30 text-muted-foreground border border-border/40'
                      }`}
                      title={stageLabel[s]}
                    >
                      {auto ? '✓ ' : busy ? '… ' : '○ '}{stageLabel[s]}
                    </span>
                  )
                })}
                <span className="rounded bg-crimson-950/40 px-1.5 py-0.5 text-[9px] text-crimson-300 border border-crimson-800/50">
                  → graph
                </span>
              </div>
            </div>
          ))}
          {evidence.length === 0 && (
            <p className="py-2 text-center text-[11px] text-muted-foreground">Upload evidence to see the automatic pipeline run.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function EvidenceView({ caseId, focusEvidenceId }: Props) {
  const { toast } = useToast()
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Evidence | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [uploadResults, setUploadResults] = useState<Array<{ filename: string; ok: boolean; message: string; extraction?: Record<string, number> }>>([])
  const [dragActive, setDragActive] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [classFilter, setClassFilter] = useState<string | null>(null)
  const [classifyingId, setClassifyingId] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setEvidence(await api.listEvidence(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load evidence')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [caseId])

  // ── v3 Fully-AI pipeline: LIVE progress polling ────────────────────────
  // While any file sits in the automatic AI queue (pending/queued/running)
  // the list silently refreshes every 4s so the status chips advance in
  // real time. When the queue drains we announce the graph change so the
  // Network view (and any other listeners) refetch with the new entities
  // and AI connections.
  const activeScans = evidence.filter((e) =>
    ['pending', 'queued', 'running'].includes(e.aiScanStatus ?? ''),
  ).length
  const prevActiveRef = useRef(0)
  useEffect(() => {
    if (activeScans === 0) {
      if (prevActiveRef.current > 0) {
        prevActiveRef.current = 0
        notifyGraphUpdated()
        toast({
          title: 'AI analysis complete',
          description:
            'The AI finished reading your files — entities and story connections were added to the knowledge graph.',
        })
      }
      return
    }
    prevActiveRef.current = activeScans
    const timer = setInterval(() => {
      void api
        .listEvidence(caseId)
        .then((rows) => {
          setEvidence(rows)
          setSelected((prev) => (prev ? rows.find((r) => r.id === prev.id) ?? prev : prev))
        })
        .catch(() => undefined)
    }, 4000)
    return () => clearInterval(timer)
  }, [activeScans, caseId, toast])

  // Deep-link: auto-select a specific evidence item (from graph edge provenance).
  useEffect(() => {
    if (!focusEvidenceId || evidence.length === 0) return
    const target = evidence.find((e) => e.id === focusEvidenceId)
    if (target) setSelected(target)
  }, [focusEvidenceId, evidence])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    if (!files || (files instanceof FileList ? files.length === 0 : files.length === 0)) return
    setUploading(true)
    setUploadResults([])
    setUploadProgress({ done: 0, total: files.length, current: files[0].name })
    try {
      const fileArr = Array.from(files)
      const results = await api.uploadEvidenceFiles(caseId, fileArr, (done, total) => {
        if (done < total) {
          setUploadProgress({ done, total, current: fileArr[done]?.name ?? '' })
        }
      })
      setUploadResults(
        results.map((r) => ({
          filename: r.filename,
          ok: r.evidence !== null,
          message: r.error ?? 'ingested — AI analysis queued automatically',
          extraction: r.extraction,
        })),
      )
      await load()
      const okCount = results.filter((r) => r.evidence).length
      toast({
        title: `Uploaded ${results.length} file${results.length === 1 ? '' : 's'} — the AI is reading them`,
        description:
          `${okCount} ingested · automatic AI analysis is running: entities, story and connections will appear in the knowledge graph without any clicks.`,
      })
    } catch (e) {
      toast({
        title: 'Upload failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }, [caseId, toast])

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files)
    }
  }, [handleFiles])

  const handleDelete = async (e: Evidence) => {
    if (!confirm(`Delete evidence "${e.originalName}"? This will cascade-delete all related entities, transactions, and timeline events.`)) return
    try {
      await api.deleteEvidence(caseId, e.id)
      await load()
      if (selected?.id === e.id) setSelected(null)
      toast({ title: 'Evidence deleted' })
    } catch (e) {
      toast({
        title: 'Delete failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    }
  }

  const handleClassify = async (e: Evidence) => {
    setClassifyingId(e.id)
    try {
      const r = await api.classifyEvidence(caseId, e.id)
      await load()
      if (selected?.id === e.id) {
        setSelected({ ...e, ...r.classification } as Evidence)
      }
      toast({
        title: 'Evidence classified',
        description: `${r.classification.classification} (${r.usedAi ? 'AI' : r.classification.source}, ${Math.round((r.classification.confidence ?? 0) * 100)}%)`,
      })
    } catch (err) {
      toast({
        title: 'Classification failed',
        description: err instanceof Error ? err.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setClassifyingId(null)
    }
  }

  // v3 — retry the automatic AI analysis after a failure (AI offline, etc.).
  const handleRetryAiScan = async (e: Evidence) => {
    setRetryingId(e.id)
    try {
      const r = await api.scanEvidence(caseId, e.id)
      await load()
      if (selected?.id === e.id) {
        const fresh = evidence.find((x) => x.id === e.id)
        if (fresh) setSelected(fresh)
      }
      toast({
        title: 'AI analysis complete',
        description: `${r.scan?.entities?.length ?? 0} entities · +${r.graph?.linked ?? 0} nodes, +${r.graph?.relationships ?? 0} AI connections`,
      })
      notifyGraphUpdated({ reason: 'manual-rescan' })
    } catch (err) {
      await load()
      toast({
        title: 'AI analysis failed',
        description: err instanceof Error ? err.message : 'unknown error — is the local AI server running?',
        variant: 'destructive',
      })
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Evidence Vault
          </h2>
          <p className="text-sm text-muted-foreground">
            Upload any readable file — SHA-256 dedup, provenance tracking, automatic extraction.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FORMATS}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFiles(e.target.files)
                e.target.value = ''
              }
            }}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload className="mr-2 h-4 w-4" />
            Upload files
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Plus className="mr-2 h-4 w-4" />
                Paste text
              </Button>
            </DialogTrigger>
            <PasteTextDialog
              caseId={caseId}
              onDone={() => {
                load()
                setDialogOpen(false)
              }}
            />
          </Dialog>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Upload progress */}
      {uploading && uploadProgress && (
        <Card className="border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <UploadCloud className="h-5 w-5 animate-pulse text-crimson-400" />
              <div className="flex-1">
                <div className="text-sm font-medium">
                  Uploading & extracting… ({uploadProgress.done}/{uploadProgress.total})
                </div>
                <div className="text-xs text-muted-foreground">
                  Current: {uploadProgress.current}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-crimson-600 to-crimson-400 transition-all"
                    style={{ width: `${(uploadProgress.done / Math.max(uploadProgress.total, 1)) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload results */}
      {uploadResults.length > 0 && !uploading && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Upload Results ({uploadResults.length})
              </CardTitle>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setUploadResults([])}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {uploadResults.map((r, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                    r.ok ? 'border-emerald-700/40 bg-emerald-950/20' : 'border-amber-700/40 bg-amber-950/20'
                  }`}
                >
                  {r.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-amber-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{r.filename}</div>
                    <div className="text-[11px] text-muted-foreground">{r.message}</div>
                  </div>
                  {r.extraction && !r.extraction.skipped && (
                    <div className="flex gap-2 text-[10px] text-muted-foreground">
                      {r.extraction.entities != null && (
                        <Badge variant="outline" className="text-[9px]">
                          {r.extraction.entities} entities
                        </Badge>
                      )}
                      {r.extraction.transactions != null && (
                        <Badge variant="outline" className="text-[9px]">
                          {r.extraction.transactions} txns
                        </Badge>
                      )}
                      {r.extraction.communications != null && (
                        <Badge variant="outline" className="text-[9px]">
                          {r.extraction.communications} comms
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Classification filter chips + pipeline */}
      {evidence.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Filter:</span>
          <button
            onClick={() => setClassFilter(null)}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${classFilter === null ? 'border-primary bg-primary/10 text-primary' : 'border-border/50 text-muted-foreground hover:text-foreground'}`}
          >
            All ({evidence.length})
          </button>
          {Array.from(new Set(evidence.map((e) => e.classification ?? 'other'))).map((cls) => {
            const meta = CLASS_META[cls] ?? CLASS_META.other
            const count = evidence.filter((e) => (e.classification ?? 'other') === cls).length
            return (
              <button
                key={cls}
                onClick={() => setClassFilter(cls)}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${classFilter === cls ? meta.color + ' ring-1 ring-primary/40' : 'border-border/50 text-muted-foreground hover:text-foreground'}`}
              >
                {meta.label} ({count})
              </button>
            )
          })}
        </div>
      )}
      {evidence.length > 0 && <PipelineCard evidence={evidence} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Evidence list */}
        <div className="lg:col-span-2">
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading evidence…</div>
          ) : evidence.length === 0 ? (
            <Card
              className={`border-dashed border-2 transition-colors ${
                dragActive ? 'border-primary bg-primary/5' : 'border-border'
              }`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
            >
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="rounded-full bg-muted/40 p-4">
                  <UploadCloud className="h-8 w-8 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No evidence yet</p>
                  <p className="text-xs text-muted-foreground">
                    Drag files here, or click "Upload files"
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-1">
                  {['txt', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'eml', 'zip', 'html', 'xml'].map((ext) => (
                    <Badge key={ext} variant="outline" className="text-[10px] uppercase">
                      .{ext}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card
              className={`transition-colors ${dragActive ? 'border-primary bg-primary/5' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
            >
              <CardContent className="p-0">
                <ScrollArea className="scroll-area-safe">
                  <div className="space-y-1 p-2">
                    {evidence
                      .filter((e) => !classFilter || (e.classification ?? 'other') === classFilter)
                      .map((e) => {
                      const meta = STATUS_META[e.status] ?? STATUS_META.pending
                      const isSel = selected?.id === e.id
                      return (
                        <Card
                          key={e.id}
                          className={`cursor-pointer transition-all hover:border-primary/40 ${
                            isSel ? 'border-primary ring-1 ring-primary/30' : ''
                          }`}
                          onClick={() => setSelected(e)}
                        >
                          <CardContent className="p-3">
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 rounded bg-muted/40 p-2">
                                {mimeIcon(e.mime, e.originalName)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="truncate text-sm font-medium">{e.originalName}</div>
                                  <Badge variant="outline" className={`gap-1 text-[10px] ${meta.color}`}>
                                    {meta.icon}
                                    {meta.label}
                                  </Badge>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                                  <span className="flex items-center gap-1">
                                    <Hash className="h-3 w-3" />
                                    <span className="font-mono">{shortHash(e.sha256)}</span>
                                  </span>
                                  <span>{formatNumber(e.size)} B</span>
                                  <span className="truncate">{e.mime ?? '—'}</span>
                                </div>
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  <ClassificationBadge evidence={e} />
                                  <AiScanBadge status={e.aiScanStatus} error={e.aiScanError} />
                                  {e.aiScanStatus === 'failed' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-5 px-1.5 text-[9px]"
                                      disabled={retryingId === e.id}
                                      onClick={(ev) => {
                                        ev.stopPropagation()
                                        void handleRetryAiScan(e)
                                      }}
                                    >
                                      {retryingId === e.id ? (
                                        <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="mr-1 h-2.5 w-2.5" />
                                      )}
                                      Retry AI
                                    </Button>
                                  )}
                                  {e.ocrStatus === 'ocr-required' && (
                                    <span className="flex items-center gap-1 text-[10px] text-amber-300">
                                      <AlertCircle className="h-3 w-3" />
                                      OCR required
                                    </span>
                                  )}
                                </div>
                                {e.description && (
                                  <div className="mt-1 truncate text-[11px] text-muted-foreground">
                                    {e.description}
                                  </div>
                                )}
                              </div>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  handleDelete(e)
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-3">
          {selected ? (
            <Card>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <div className="rounded bg-muted/40 p-2">
                    {mimeIcon(selected.mime, selected.originalName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-base">{selected.originalName}</CardTitle>
                    <CardDescription className="font-mono text-[11px]">
                      {selected.sha256}
                    </CardDescription>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <ClassificationBadge evidence={selected} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px]"
                        disabled={classifyingId === selected.id}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void handleClassify(selected)
                        }}
                      >
                        {classifyingId === selected.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Sparkles className="mr-1 h-3 w-3" />
                        )}
                        Re-classify (AI)
                      </Button>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <Stat label="Status" value={selected.status} />
                  <Stat label="AI Analysis" value={selected.aiScanStatus ?? '—'} />
                  <Stat label="OCR" value={selected.ocrStatus ?? '—'} />
                  <Stat label="Size" value={`${formatNumber(selected.size)} B`} />
                  <Stat label="Source" value={selected.source ?? '—'} />
                  <Stat label="Created" value={formatDateTime(selected.createdAt)} />
                  <Stat label="Updated" value={formatDateTime(selected.updatedAt)} />
                  <Stat label="Provenance" value={selected.provenance ?? '—'} />
                </div>

                <Tabs defaultValue="content">
                  <TabsList className="mb-2">
                    <TabsTrigger value="content">Content</TabsTrigger>
                    <TabsTrigger value="versions">Versions</TabsTrigger>
                    <TabsTrigger value="ai-scan">
                      <Brain className="mr-1 h-3 w-3" />
                      AI Scan
                    </TabsTrigger>
                    <TabsTrigger value="provenance">Provenance</TabsTrigger>
                  </TabsList>
                  <TabsContent value="content">
                    <ScrollArea className="scroll-area-shortest rounded-md border border-border/40 bg-muted/20 p-3">
                      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                        {selected.content ?? '(no content extracted)'}
                      </pre>
                    </ScrollArea>
                  </TabsContent>
                  <TabsContent value="ai-scan">
                    <AiScanPanel evidence={selected} caseId={caseId} onScanned={() => load()} />
                  </TabsContent>
                  <TabsContent value="versions">
                    <VersionsPanel caseId={caseId} evidenceId={selected.id} onChanged={() => load()} />
                  </TabsContent>
                  <TabsContent value="provenance">
                    <div className="space-y-2 text-xs text-muted-foreground">
                      <p>
                        <span className="font-mono text-foreground">SHA-256:</span> {selected.sha256}
                      </p>
                      <p>
                        <span className="font-mono text-foreground">Acquired:</span>{' '}
                        {formatDateTime(selected.createdAt)}
                      </p>
                      <p>
                        <span className="font-mono text-foreground">Source:</span>{' '}
                        {selected.source ?? 'Direct ingestion'}
                      </p>
                      <p className="text-[11px]">
                        Chain of custody is preserved automatically — original content is never
                        modified after acquisition. Derived extractions (entities, transactions,
                        communications) link back to this evidence via entity_links.
                      </p>
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed">
              <CardContent
                className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 py-12 text-center"
          >
                <FileSearch className="h-10 w-10 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Select evidence to inspect</p>
                  <p className="text-xs text-muted-foreground">
                    Click an evidence card on the left to see extracted content and provenance.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs" title={value}>
        {truncate(value, 24)}
      </div>
    </div>
  )
}

function PasteTextDialog({ caseId, onDone }: { caseId: string; onDone: () => void }) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [desc, setDesc] = useState('')
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!name.trim() || !content.trim()) return
    setCreating(true)
    try {
      await api.addEvidence(caseId, {
        originalName: name.trim(),
        content: content,
        description: desc.trim() || undefined,
        mime: name.toLowerCase().endsWith('.csv')
          ? 'text/csv'
          : name.toLowerCase().endsWith('.json')
            ? 'application/json'
            : 'text/plain',
      })
      toast({ title: 'Evidence ingested' })
      setName('')
      setContent('')
      setDesc('')
      onDone()
    } catch (e) {
      toast({
        title: 'Ingest failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Paste evidence as text</DialogTitle>
        <DialogDescription>
          For quick ingest of small text. For real evidence files, use the Upload button.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label htmlFor="name">Filename</Label>
          <Input
            id="name"
            placeholder="bank_statement.csv"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="desc">Description (optional)</Label>
          <Input
            id="desc"
            placeholder="HDFC account statement — suspect mule account"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="content">Content</Label>
          <textarea
            id="content"
            rows={10}
            placeholder="Date,Amount,Sender,Receiver,UPI,UTR&#10;2024-01-05,5000,Acc1,Acc2,user@upi,123456789012"
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={handleCreate} disabled={creating || !name.trim() || !content.trim()}>
          {creating ? 'Ingesting…' : 'Ingest & extract'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

interface AiScanResult {
  summary: string
  entities: Array<{ type: string; value: string; context: string }>
  suspiciousIndicators: string[]
  narrative: string
  suggestedSteps: string[]
  confidence: string
  aiAvailable: boolean
  model: string
  scannedAt: string
  story?: {
    hasStory?: boolean
    plot?: string
    connections?: Array<{
      from: string
      to: string
      rel: string
      why?: string
      confidence?: number
    }>
  }
  engine?: {
    provider: string
    contextTokens: number
    budgetChars: number
    chunks: number
    strategiesUsed: string[]
  }
  crossLinks?: {
    mergeEvents?: number
    aliasLinks?: number
    accepted?: number
    links?: Array<{ src: string; dst: string; type: string; method?: string; rationale?: string }>
    caseInterpretation?: string
    newLeads?: string[]
    mergedWithFiles?: string[]
  }
}

function AiScanPanel({
  evidence,
  caseId,
  onScanned,
}: {
  evidence: Evidence
  caseId: string
  onScanned: () => void
}) {
  const { toast } = useToast()
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<AiScanResult | null>(null)

  // Load existing scan from intelJson if present.
  useEffect(() => {
    if (evidence.intelJson) {
      try {
        const intel = JSON.parse(evidence.intelJson as string)
        if (intel.aiScan) {
          setScanResult(intel.aiScan as AiScanResult)
        }
      } catch {
        // ignore
      }
    } else {
      setScanResult(null)
    }
  }, [evidence.id, evidence.intelJson])

  const handleScan = async () => {
    setScanning(true)
    try {
      const r = await api.scanEvidence(caseId, evidence.id)
      setScanResult(r.scan as AiScanResult)
      const dots = (r as { crossLinks?: { mergeEvents?: number } }).crossLinks?.mergeEvents ?? 0
      toast({
        title: r.scan.aiAvailable ? 'AI scan complete' : 'Fallback scan complete',
        description: `${r.scan.entities.length} entities, ${r.scan.suspiciousIndicators.length} indicators · +${r.graph?.linked ?? 0} graph nodes, +${r.graph?.relationships ?? 0} links${dots ? ` · ${dots} dot-join${dots > 1 ? 's' : ''} to earlier files` : ''} (${r.scan.model})`,
      })
      onScanned()
    } catch (e) {
      toast({
        title: 'AI scan failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setScanning(false)
    }
  }

  const confidenceColor =
    scanResult?.confidence === 'HIGH'
      ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
      : scanResult?.confidence === 'MEDIUM'
        ? 'border-amber-700 bg-amber-950/30 text-amber-300'
        : 'border-slate-700 bg-slate-950/30 text-slate-300'

  return (
    <div className="space-y-3">
      {/* Scan button + status */}
      <div className="flex items-center gap-3 rounded-md border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent p-3">
        <div className="rounded-md bg-crimson-950/40 p-2">
          <Brain className="h-5 w-5 text-crimson-400" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium">
            {scanning
              ? 'AI scanning evidence…'
              : evidence.aiScanStatus === 'queued' || evidence.aiScanStatus === 'running' || evidence.aiScanStatus === 'pending'
                ? 'Automatic AI analysis in progress…'
                : scanResult
                  ? 'AI analysis results'
                  : evidence.aiScanStatus === 'failed'
                    ? 'Automatic AI analysis failed'
                    : 'Run AI analysis on this evidence'}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {scanResult
              ? `Model: ${scanResult.model} · ${new Date(scanResult.scannedAt).toLocaleString()}`
              : evidence.aiScanStatus === 'failed'
                ? (evidence.aiScanError ?? 'The local AI could not analyze this file.')
                : 'The AI runs automatically on every upload — it assigns entities, detects the story, connects the actors and explains every link.'}
          </div>
        </div>
        <Button onClick={handleScan} disabled={scanning} size="sm">
          {scanning ? (
            <>
              <div className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              Scanning…
            </>
          ) : evidence.aiScanStatus === 'failed' ? (
            <>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Retry AI analysis
            </>
          ) : scanResult ? (
            <>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Re-scan
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              Scan with AI
            </>
          )}
        </Button>
      </div>

      {/* Scan results */}
      {scanResult && (
        <div className="space-y-3">
          {/* Summary + confidence */}
          <Card className="border-primary/20">
            <CardContent className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Summary
                </span>
                <Badge variant="outline" className={`text-[10px] ${confidenceColor}`}>
                  {scanResult.confidence} confidence
                </Badge>
              </div>
              <p className="text-sm">{scanResult.summary}</p>
            </CardContent>
          </Card>

          {/* Connecting-the-dots — cross-document inference */}
          {(scanResult.crossLinks?.caseInterpretation ||
            (scanResult.crossLinks?.mergeEvents ?? 0) > 0 ||
            (scanResult.crossLinks?.accepted ?? 0) > 0) && (
            <Card className="border-sky-800/40 bg-sky-950/10">
              <CardContent className="p-3">
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300/90">
                  <GitMerge className="h-3 w-3" />
                  Connecting the dots
                  {(scanResult.crossLinks?.mergeEvents ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[9px] border-sky-700/50 text-sky-300">
                      {scanResult.crossLinks?.mergeEvents} known entities joined
                    </Badge>
                  )}
                  {(scanResult.crossLinks?.accepted ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[9px] border-sky-700/50 text-sky-300">
                      +{scanResult.crossLinks?.accepted} cross-file links
                    </Badge>
                  )}
                </div>
                {scanResult.crossLinks?.caseInterpretation && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {scanResult.crossLinks.caseInterpretation}
                  </p>
                )}
                {scanResult.crossLinks?.links && scanResult.crossLinks.links.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {scanResult.crossLinks.links.slice(0, 8).map((l, i) => (
                      <div key={i} className="rounded border border-border/40 bg-background/40 px-2 py-1.5">
                        <div className="flex items-center gap-1.5 font-mono text-[11px]">
                          <span className="truncate">{l.src}</span>
                          <span className="shrink-0 rounded bg-sky-900/60 px-1 text-[9px] uppercase text-sky-200">{l.type.replace(/_/g, ' ').toLowerCase()}</span>
                          <span className="truncate">{l.dst}</span>
                        </div>
                        {l.rationale && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">{l.rationale}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {scanResult.crossLinks?.newLeads && scanResult.crossLinks.newLeads.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">New leads</div>
                    <ul className="space-y-0.5">
                      {scanResult.crossLinks.newLeads.map((lead, i) => (
                        <li key={i} className="text-xs text-muted-foreground">• {lead}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Narrative */}
          {scanResult.narrative && (
            <Card>
              <CardContent className="p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Narrative
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{scanResult.narrative}</p>
              </CardContent>
            </Card>
          )}

          {/* Story detection (v2.2) — plot + actor-to-actor connections */}
          {(scanResult.story?.plot || (scanResult.story?.connections?.length ?? 0) > 0) && (
            <Card>
              <CardContent className="p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Waypoints className="h-3 w-3" />
                  Story detected
                  {scanResult.story?.hasStory === false && (
                    <Badge variant="outline" className="text-[9px]">register</Badge>
                  )}
                </div>
                {scanResult.story?.plot && (
                  <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{scanResult.story.plot}</p>
                )}
                {(scanResult.story?.connections?.length ?? 0) > 0 && (
                  <div className="space-y-1">
                    {scanResult.story!.connections!.map((c, i) => (
                      <div key={i} className="rounded border border-border/40 bg-muted/10 px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="font-mono">{c.from}</span>
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {c.rel.replace(/_/g, ' ')}
                          </Badge>
                          <span className="font-mono">{c.to}</span>
                          {typeof c.confidence === 'number' && (
                            <span className="ml-auto text-[9px] text-muted-foreground">
                              {Math.round(c.confidence * 100)}%
                            </span>
                          )}
                        </div>
                        {c.why && (
                          <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{c.why}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Entities */}
          {scanResult.entities.length > 0 && (
            <Card>
              <CardContent className="p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <ListChecks className="h-3 w-3" />
                  AI-extracted entities ({scanResult.entities.length})
                </div>
                <div className="space-y-1.5">
                  {scanResult.entities.map((e, i) => (
                    <div key={i} className="flex items-start gap-2 rounded border border-border/40 bg-muted/10 px-2 py-1.5">
                      <Badge variant="outline" className="text-[9px] uppercase">
                        {e.type}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs">{e.value}</div>
                        {e.context && (
                          <div className="text-[10px] text-muted-foreground">{e.context}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Suspicious indicators */}
          {scanResult.suspiciousIndicators.length > 0 && (
            <Card className="border-amber-700/30 bg-amber-950/10">
              <CardContent className="p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-300">
                  <AlertTriangle className="h-3 w-3" />
                  Suspicious indicators ({scanResult.suspiciousIndicators.length})
                </div>
                <ul className="space-y-1">
                  {scanResult.suspiciousIndicators.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">• {s}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Suggested steps */}
          {scanResult.suggestedSteps.length > 0 && (
            <Card className="border-sky-700/30 bg-sky-950/10">
              <CardContent className="p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-300">
                  <Lightbulb className="h-3 w-3" />
                  Suggested investigative steps
                </div>
                <ol className="space-y-1">
                  {scanResult.suggestedSteps.map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="font-mono text-sky-300">{i + 1}.</span> {s}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {!scanResult && !scanning && (
        <div className="rounded-md border border-dashed border-border/60 p-6 text-center">
          <Brain className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Every uploaded file is analyzed AUTOMATICALLY by the AI — no button
            click needed. The AI is the only entity engine: it assigns the
            entity types, decides whether the document tells a story, connects
            the actors, and explains every connection. Use the button above to
            re-run the analysis at any time.
          </p>
        </div>
      )}
    </div>
  )
}
