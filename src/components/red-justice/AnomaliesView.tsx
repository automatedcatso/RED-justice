'use client'

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Activity,
  Network,
  Clock,
  Zap,
  RefreshCw,
  TrendingUp,
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
import { api } from '@/lib/api-client'
import { severityMeta } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

const FAMILY_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  node: { label: 'Node Anomalies', icon: <Network className="h-4 w-4" />, color: 'text-purple-300' },
  edge: { label: 'Edge Anomalies', icon: <TrendingUp className="h-4 w-4" />, color: 'text-emerald-300' },
  subgraph: { label: 'Subgraph Anomalies', icon: <AlertTriangle className="h-4 w-4" />, color: 'text-rose-300' },
  temporal: { label: 'Temporal Anomalies', icon: <Clock className="h-4 w-4" />, color: 'text-amber-300' },
}

export function AnomaliesView({ caseId }: Props) {
  const [data, setData] = useState<{
    anomalies: Array<{
      id: string
      family: 'node' | 'edge' | 'subgraph' | 'temporal'
      type: string
      severity: string
      description: string
      entityId?: string
    }>
    total: number
    byFamily: { node: number; edge: number; subgraph: number; temporal: number }
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.anomalies(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load anomalies')
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Graph Anomaly Detection
          </h2>
          <p className="text-sm text-muted-foreground">
            Node, edge, subgraph, and temporal anomalies detected across the network.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Re-scan
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Summary by family */}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(FAMILY_META).map(([key, meta]) => {
            const count = data.byFamily[key as keyof typeof data.byFamily] ?? 0
            return (
              <Card key={key} className="overflow-hidden">
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {meta.label}
                    </span>
                    <span className={meta.color}>{meta.icon}</span>
                  </div>
                  <div className="mt-1 font-mono text-2xl font-bold">{count}</div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Anomaly list */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Scanning for anomalies…</div>
      ) : !data || data.anomalies.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="rounded-full bg-emerald-950/40 p-4">
              <Activity className="h-8 w-8 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium">No anomalies detected</p>
              <p className="text-xs text-muted-foreground">
                The network appears structurally normal. Upload more evidence to enable deeper analysis.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-crimson-400" />
              {data.total} anomalies detected
            </CardTitle>
            <CardDescription>
              Sorted by severity. Each anomaly is a structural observation, not a criminal accusation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="scroll-area-short pr-3">
              <div className="space-y-2">
                {data.anomalies.map((a) => {
                  const m = severityMeta(a.severity)
                  const famMeta = FAMILY_META[a.family] ?? FAMILY_META.node
                  return (
                    <div
                      key={a.id}
                      className="flex items-start gap-3 rounded-md border border-border/40 bg-muted/10 px-3 py-2"
                    >
                      <div className={`mt-0.5 flex-shrink-0 ${famMeta.color}`}>
                        {famMeta.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={`text-[10px] ${m.color}`}>
                            {m.label}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {a.type.replace(/_/g, ' ')}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {a.family}
                          </Badge>
                        </div>
                        <div className="mt-1 text-sm">{a.description}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
