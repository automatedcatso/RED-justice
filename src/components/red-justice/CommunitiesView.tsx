'use client'

import { useEffect, useState } from 'react'
import { Users, RefreshCw, Network, ShieldAlert, ArrowRightLeft } from 'lucide-react'
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
import { api, type Community, type Entity } from '@/lib/api-client'
import { entityMeta, formatINR, parseJsonArray } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

export function CommunitiesView({ caseId }: Props) {
  const [communities, setCommunities] = useState<Community[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Community | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setCommunities(await api.communities(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load communities')
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
            Community Intelligence
          </h2>
          <p className="text-sm text-muted-foreground">
            {communities.length} communities detected via Label Propagation.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading communities…</div>
      ) : communities.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No communities detected</p>
              <p className="text-xs text-muted-foreground">
                Re-run analytics from the Network tab.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <ScrollArea className="scroll-area-safe pr-3">
              <div className="space-y-2">
                {[...communities]
                  .sort((a, b) => b.size - a.size)
                  .map((c, i) => {
                    const isSel = selected?.id === c.id
                    const domTypes = parseJsonArray<string>(c.dominantTypes)
                    return (
                      <Card
                        key={c.id}
                        className={`cursor-pointer transition-all hover:border-primary/40 ${
                          isSel ? 'border-primary ring-1 ring-primary/30' : ''
                        }`}
                        onClick={() => setSelected(c)}
                      >
                        <CardContent className="p-3">
                          <div className="flex items-start justify-between">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="font-mono text-[10px]">
                                  C-{i + 1}
                                </Badge>
                                <span className="text-sm font-medium">
                                  {c.label ?? `Community ${i + 1}`}
                                </span>
                              </div>
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                {c.size} members · {c.internalRels} internal · {c.externalRels} external
                              </div>
                              {domTypes.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {domTypes.slice(0, 4).map((t, j) => {
                                    const m = entityMeta(t)
                                    return (
                                      <span
                                        key={j}
                                        className="rounded px-1 py-0.5 text-[9px] uppercase"
                                        style={{ background: `${m.color}22`, color: m.color }}
                                      >
                                        {m.label}
                                      </span>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                            {c.suspiciousPatterns > 0 && (
                              <Badge variant="outline" className="border-rose-700 bg-rose-950/40 text-rose-300">
                                <ShieldAlert className="mr-1 h-3 w-3" />
                                {c.suspiciousPatterns}
                              </Badge>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
              </div>
            </ScrollArea>
          </div>

          <div className="lg:col-span-3">
            {selected ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Network className="h-4 w-4 text-crimson-400" />
                    Community detail
                  </CardTitle>
                  <CardDescription>
                    {selected.size} members · {selected.internalRels} internal · {selected.externalRels} external · vol{' '}
                    {formatINR(selected.transactionVolume)}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Mini label="Size" value={selected.size} />
                    <Mini label="Internal" value={selected.internalRels} />
                    <Mini label="External" value={selected.externalRels} />
                    <Mini label="Suspicious" value={selected.suspiciousPatterns} />
                  </div>

                  {selected.members && selected.members.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                        Members ({selected.members.length})
                      </h4>
                      <ScrollArea className="max-h-72">
                        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                          {selected.members.map((m) => {
                            const meta = entityMeta(m.type)
                            return (
                              <div
                                key={m.id}
                                className="flex items-center gap-2 rounded border border-border/40 bg-muted/10 px-2 py-1.5"
                              >
                                <span
                                  className="inline-block h-2 w-2 rounded-full"
                                  style={{ background: meta.color }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-mono text-[11px]">{m.value}</div>
                                  <div className="text-[10px] text-muted-foreground">{meta.label}</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="border-dashed">
                <CardContent className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 py-12 text-center">
                  <ArrowRightLeft className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Select a community</p>
                    <p className="text-xs text-muted-foreground">
                      Click a community card on the left to see its members.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-base font-bold">{value}</div>
    </div>
  )
}
