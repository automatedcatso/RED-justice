'use client'

import { useEffect, useState } from 'react'
import { Network, RefreshCw, BarChart3 } from 'lucide-react'
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
import { NetworkGraph } from './NetworkGraph'
import { api, type NetworkAnalytics } from '@/lib/api-client'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
  /** Open a specific evidence item (from edge provenance panel). */
  onOpenEvidence?: (evidenceId: string) => void
}

export function NetworkView({ caseId, onOpenEvidence }: Props) {
  const [analytics, setAnalytics] = useState<NetworkAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setAnalytics(await api.networkAnalytics(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load analytics')
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
            Network Intelligence
          </h2>
          <p className="text-sm text-muted-foreground">
            Interactive knowledge graph · centrality · communities · shortest paths · money flow
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Recompute analytics
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Graph */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-crimson-400" />
            Knowledge Graph
          </CardTitle>
          <CardDescription>
            Click nodes to inspect · drag to reposition · scroll to zoom · use filters and search
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NetworkGraph caseId={caseId} height={560} onOpenEvidence={onOpenEvidence} />
        </CardContent>
      </Card>

      {/* Analytics panels */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-purple-400" />
              Top Central Actors
            </CardTitle>
            <CardDescription>
              Combined degree + betweenness + PageRank ranking.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading || !analytics ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Computing…</div>
            ) : (
              <div className="space-y-2">
                {analytics.centralActors.slice(0, 10).map((a, i) => (
                  <div key={a.entityId} className="flex items-center gap-3">
                    <span className="w-6 text-right font-mono text-xs text-muted-foreground">
                      #{i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{a.entityId}</div>
                    </div>
                    <div className="w-24">
                      <div className="relative h-3 overflow-hidden rounded-full bg-muted/40">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-crimson-700 to-crimson-400"
                          style={{ width: `${a.score}%` }}
                        />
                      </div>
                    </div>
                    <span className="w-10 text-right font-mono text-xs">{a.score.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-amber-400" />
              Network Topology
            </CardTitle>
            <CardDescription>Connected components &amp; communities.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading || !analytics ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Computing…</div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Components" value={analytics.components.length} />
                <Stat
                  label="Largest component"
                  value={Math.max(...analytics.components.map((c) => c.length), 0)}
                />
                <Stat label="Communities" value={analytics.communities.length} />
                <Stat
                  label="Largest community"
                  value={Math.max(...analytics.communities.map((c) => c.members.length), 0)}
                />
                <Stat label="Bridge nodes" value={analytics.bridges.length} />
                <Stat
                  label="Avg component size"
                  value={
                    analytics.components.length === 0
                      ? 0
                      : (
                          analytics.components.reduce((a, c) => a + c.length, 0) /
                          analytics.components.length
                        ).toFixed(1)
                  }
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Communities list */}
      {analytics && analytics.communities.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Detected Communities (LPA)</CardTitle>
            <CardDescription>Label Propagation Algorithm · top 10 by size</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 pr-3">
              <div className="space-y-2">
                {[...analytics.communities]
                  .sort((a, b) => b.members.length - a.members.length)
                  .slice(0, 10)
                  .map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-md border border-border/40 bg-muted/10 px-3 py-2"
                    >
                      <Badge variant="outline" className="font-mono text-[10px]">
                        C-{i + 1}
                      </Badge>
                      <div className="flex-1 text-sm">
                        <span className="font-mono">{c.members.length}</span> members
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        label: {c.label.slice(0, 8)}
                      </div>
                    </div>
                  ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-bold">{value}</div>
    </div>
  )
}
