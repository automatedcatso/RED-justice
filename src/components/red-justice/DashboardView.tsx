'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Banknote,
  Boxes,
  FileSearch,
  Flame,
  SearchX,
  FolderOpen,
  Network,
  ShieldAlert,
  TrendingUp,
  Users,
  Zap,
  Plus,
  Upload,
  ArrowRight,
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
import { api, type Dashboard as DashboardT, type SystemStatus as SystemStatusT, type GapReport as GapReportT } from '@/lib/api-client'
import { ExplainableAISection } from '@/components/red-justice/ExplainableAISection'
import { CommandCenterStrip } from '@/components/red-justice/CommandCenterStrip'
import {
  formatINR,
  formatNumber,
  timeAgo,
  FINDING_TYPE_LABELS,
} from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  onNavigate: (section: string) => void
  activeCaseId: string | null
}

export function DashboardView({ onNavigate, activeCaseId }: Props) {
  const [data, setData] = useState<DashboardT | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api.dashboard()
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Live refresh: when the automatic AI scan pipeline lands new graph data
  // (or any view mutates entities / relationships / findings), refetch.
  useGraphRefresh(() => {
    void load()
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-pulse text-muted-foreground">Loading dashboard…</div>
      </div>
    )
  }

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Dashboard error</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={load} variant="outline" size="sm">
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  // Empty state — no cases or no evidence
  if (data.cases.total === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Welcome to RED Justice
          </h2>
          <p className="text-sm text-muted-foreground">
            AI-Powered Criminal Network Analysis &amp; Investigation System.
            Create your first case to begin.
          </p>
        </div>
        <Card className="border-dashed border-2 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="rounded-full bg-gradient-to-br from-crimson-600 to-crimson-900 p-4 shadow-lg shadow-crimson-900/30">
              <img src="/logo-mark.png" alt="RED Justice" className="h-16 w-16 rounded-full object-cover" />
            </div>
            <div className="max-w-md">
              <h3 className="text-lg font-semibold">Start your first investigation</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a case, then upload evidence files (CSV bank statements, UPI SMS logs,
                chat exports, emails, PDFs, archives). RED Justice will extract entities,
                build a knowledge graph, detect suspicious patterns, and rank actor priorities.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => onNavigate('cases')} size="lg">
                <Plus className="mr-2 h-4 w-4" />
                Create a case
              </Button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { icon: <FolderOpen className="h-4 w-4" />, label: 'Case Management' },
                { icon: <Network className="h-4 w-4" />, label: 'Knowledge Graph' },
                { icon: <Banknote className="h-4 w-4" />, label: 'Money Flow' },
                { icon: <Flame className="h-4 w-4" />, label: 'AI Investigator' },
              ].map((f) => (
                <div
                  key={f.label}
                  className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs"
                >
                  <span className="text-crimson-400">{f.icon}</span>
                  {f.label}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const stats: Array<{
    label: string
    value: string
    sub?: string
    icon: React.ReactNode
    accent: string
    onClick?: () => void
  }> = [
    {
      label: 'Cases',
      value: formatNumber(data.cases.total),
      sub: `${data.cases.open} open · ${data.cases.active} active`,
      icon: <FolderOpen className="h-5 w-5" />,
      accent: 'text-crimson-300',
      onClick: () => onNavigate('cases'),
    },
    {
      label: 'Evidence Vault',
      value: formatNumber(data.evidence.total),
      sub: `${data.evidence.done} processed · ${data.evidence.error} errors`,
      icon: <FileSearch className="h-5 w-5" />,
      accent: 'text-sky-300',
      onClick: () => onNavigate('evidence'),
    },
    {
      label: 'Entities Discovered',
      value: formatNumber(data.entities.total),
      sub: `${Object.keys(data.entities.byType).length} types`,
      icon: <Boxes className="h-5 w-5" />,
      accent: 'text-emerald-300',
      onClick: () => onNavigate('entities'),
    },
    {
      label: 'Transactions',
      value: formatNumber(data.transactions.total),
      sub: formatINR(data.transactions.totalVolume),
      icon: <Banknote className="h-5 w-5" />,
      accent: 'text-amber-300',
      onClick: () => onNavigate('transactions'),
    },
    {
      label: 'Relationships',
      value: formatNumber(data.relationships.total),
      sub: 'graph edges',
      icon: <Network className="h-5 w-5" />,
      accent: 'text-purple-300',
      onClick: () => onNavigate('network'),
    },
    {
      label: 'Suspicious Patterns',
      value: formatNumber(data.findings.total),
      sub: `${data.findings.bySeverity.high ?? 0} high · ${data.findings.bySeverity.medium ?? 0} medium`,
      icon: <AlertTriangle className="h-5 w-5" />,
      accent: 'text-rose-300',
      onClick: () => onNavigate('patterns'),
    },
    {
      label: 'Priority Actors',
      value: formatNumber(data.actors.high + data.actors.medium),
      sub: `${data.actors.high} high · ${data.actors.medium} medium`,
      icon: <ShieldAlert className="h-5 w-5" />,
      accent: 'text-orange-300',
      onClick: () => onNavigate('actors'),
    },
    {
      label: 'Communities',
      value: formatNumber(data.communities.total),
      sub: `${formatNumber(data.communities.totalMembers)} members`,
      icon: <Users className="h-5 w-5" />,
      accent: 'text-cyan-300',
      onClick: () => onNavigate('communities'),
    },
  ]

  // If a case is selected but it has no evidence yet, show the ingest prompt.
  const showIngestPrompt =
    activeCaseId && data.evidence.total === 0

  // top finding types
  const findingTypes = Object.entries(data.findings.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
  const maxFindingCount = findingTypes.length
    ? Math.max(...findingTypes.map(([, c]) => c))
    : 1

  // entity type top 6
  const entityTypes = Object.entries(data.entities.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
  const maxEntityCount = entityTypes.length
    ? Math.max(...entityTypes.map(([, c]) => c))
    : 1

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
          Investigation Dashboard
        </h2>
        <p className="text-sm text-muted-foreground">
          Aggregate intelligence across all RED Justice cases.
        </p>
      </div>

      {/* Ingest prompt */}
      {showIngestPrompt && (
        <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <Upload className="h-5 w-5 text-crimson-400" />
            <div className="flex-1">
              <div className="text-sm font-medium">No evidence in the active case yet</div>
              <div className="text-xs text-muted-foreground">
                Upload CSV bank statements, UPI SMS logs, chat exports, emails, PDFs, or archives to begin extraction.
              </div>
            </div>
            <Button onClick={() => onNavigate('evidence')} size="sm">
              <Upload className="mr-2 h-4 w-4" />
              Upload evidence
              <ArrowRight className="ml-2 h-3 w-3" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {stats.map((s) => (
          <button
            key={s.label}
            onClick={s.onClick}
            className="group text-left transition-transform hover:scale-[1.015] focus:outline-none"
          >
            <Card className="relative overflow-hidden border-border/60 transition-colors group-hover:border-primary/40">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </span>
                  <span className={s.accent}>{s.icon}</span>
                </div>
                <div className="mt-2 font-mono text-2xl font-bold">{s.value}</div>
                {s.sub && (
                  <div className="mt-1 text-[11px] text-muted-foreground">{s.sub}</div>
                )}
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      {/* Command Center — per-case pulse: hypotheses / contradictions / decisions / report readiness */}
      <CommandCenterStrip caseId={activeCaseId} onNavigate={onNavigate} />

      {/* Explainable AI analysis — structured reasoning about this case */}
      <ExplainableAISection activeCaseId={activeCaseId} onNavigate={onNavigate} />

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              Suspicious Patterns by Type
            </CardTitle>
            <CardDescription>
              {data.findings.total} findings detected by the rule-based engine.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {findingTypes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No findings yet — ingest evidence to trigger pattern detection.
              </p>
            ) : (
              <div className="space-y-2">
                {findingTypes.map(([type, count]) => (
                  <div key={type} className="flex items-center gap-3">
                    <div className="w-32 truncate text-xs text-muted-foreground">
                      {FINDING_TYPE_LABELS[type] ?? type}
                    </div>
                    <div className="relative h-6 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-rose-700 to-rose-500"
                        style={{ width: `${(count / maxFindingCount) * 100}%` }}
                      />
                      <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-mono">
                        {count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4 text-emerald-400" />
              Entities by Type
            </CardTitle>
            <CardDescription>
              Top entity categories discovered during extraction.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {entityTypes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No entities extracted yet.
              </p>
            ) : (
              <div className="space-y-2">
                {entityTypes.map(([type, count]) => (
                  <div key={type} className="flex items-center gap-3">
                    <div className="w-32 truncate text-xs uppercase text-muted-foreground">
                      {type}
                    </div>
                    <div className="relative h-6 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className="absolute inset-y-0 left-0 rounded bg-gradient-to-r from-emerald-700 to-teal-500"
                        style={{ width: `${(count / maxEntityCount) * 100}%` }}
                      />
                      <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-mono">
                        {count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actor risk & recent activity */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-4 w-4 text-orange-400" />
              Actor Risk Tiers
            </CardTitle>
            <CardDescription>
              {data.actors.high + data.actors.medium + data.actors.low} total actors scored.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ActorRow
              label="High Priority"
              count={data.actors.high}
              total={data.actors.high + data.actors.medium + data.actors.low}
              className="from-rose-700 to-rose-500"
            />
            <ActorRow
              label="Medium Priority"
              count={data.actors.medium}
              total={data.actors.high + data.actors.medium + data.actors.low}
              className="from-amber-700 to-amber-500"
            />
            <ActorRow
              label="Low Priority"
              count={data.actors.low}
              total={data.actors.high + data.actors.medium + data.actors.low}
              className="from-sky-700 to-sky-500"
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => onNavigate('actors')}
            >
              <TrendingUp className="mr-2 h-4 w-4" />
              View priority actors
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-crimson-400" />
              Recent Activity
            </CardTitle>
            <CardDescription>
              Live feed of case events, ingestion, and analytics runs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentActivity.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No activity recorded yet. Ingest evidence to populate the activity log.
              </p>
            ) : (
              <ScrollArea className="h-72 pr-3">
                <ol className="space-y-2">
                  {data.recentActivity.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-start gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm"
                    >
                      <span className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-crimson-500 pulse-crimson" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{a.msg}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {timeAgo(a.at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* System capabilities + gaps strip */}
      <SystemStrip activeCaseId={activeCaseId} onNavigate={onNavigate} />

      {/* Quick actions */}
      <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Zap className="h-4 w-4 text-crimson-400" />
            Quick actions
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onNavigate('evidence')}>
              <Upload className="mr-2 h-4 w-4" />
              Upload evidence
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate('network')}>
              <Network className="mr-2 h-4 w-4" />
              Open network graph
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate('ai')}>
              <Flame className="mr-2 h-4 w-4" />
              Ask AI investigator
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate('reports')}>
              <FileSearch className="mr-2 h-4 w-4" />
              Generate report
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ActorRow({
  label,
  count,
  total,
  className,
}: {
  label: string
  count: number
  total: number
  className: string
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">
          {count} <span className="text-muted-foreground">({pct}%)</span>
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted/40">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${className}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/**
 * SystemStrip — capability degradation summary + (when a case is active) the
 * top investigation gaps. Compact single-row version of the Settings map.
 */
function SystemStrip({
  activeCaseId,
  onNavigate,
}: {
  activeCaseId: string | null
  onNavigate: (s: string) => void
}) {
  const [status, setStatus] = useState<SystemStatusT | null>(null)
  const [gaps, setGaps] = useState<GapReportT | null>(null)

  useEffect(() => {
    api
      .systemStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
    if (activeCaseId) {
      api
        .gaps(activeCaseId)
        .then(setGaps)
        .catch(() => setGaps(null))
    }
  }, [activeCaseId])

  const offline = status?.degradedSummary?.offline ?? 0
  const degraded = status?.degradedSummary?.degraded ?? 0

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 p-3 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <Activity className="h-4 w-4 text-emerald-400" />
          Capabilities:
        </span>
        {status?.capabilities?.slice(0, 10).map((c) => (
          <span
            key={c.name}
            title={`${c.label} — ${c.status}. ${c.fallback}`}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              c.status === 'operational'
                ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/50'
                : c.status === 'degraded'
                  ? 'bg-amber-950/40 text-amber-300 border border-amber-800/50'
                  : 'bg-rose-950/40 text-rose-300 border border-rose-800/50'
            }`}
          >
            {c.name}
          </span>
        ))}
        {!status && <span className="text-muted-foreground">probing…</span>}
        {gaps && gaps.total > 0 && (
          <button
            onClick={() => onNavigate('hypotheses')}
            className="ml-auto rounded border border-amber-800/50 bg-amber-950/30 px-2 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950/50"
            title="Open the Investigation Gap Engine in the Hypotheses workspace"
          >
            <SearchX className="mr-1 inline h-3 w-3" />
            {gaps.total} investigation gap{gaps.total > 1 ? 's' : ''} — review
          </button>
        )}
        {(offline > 0 || degraded > 0) && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {offline} offline · {degraded} degraded (deterministic analysis unaffected)
          </span>
        )}
      </CardContent>
    </Card>
  )
}
