'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Search,
  Filter,
  RefreshCw,
  Boxes,
  Link2,
  Network,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type Entity } from '@/lib/api-client'
import { entityMeta, parseJsonArray } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

export function EntitiesView({ caseId }: Props) {
  const [entities, setEntities] = useState<Entity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setEntities(await api.listEntities(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load entities')
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

  const types = useMemo(() => {
    const set = new Set<string>()
    entities.forEach((e) => set.add(e.type))
    return Array.from(set).sort()
  }, [entities])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entities.filter((e) => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false
      if (!q) return true
      return (
        e.value.toLowerCase().includes(q) ||
        (e.label ?? '').toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q)
      )
    })
  }, [entities, query, typeFilter])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Entity Intelligence
          </h2>
          <p className="text-sm text-muted-foreground">
            {entities.length} entities extracted · {types.length} types · normalized &amp; resolved
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search entities…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56 pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-40">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={load} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Type chips */}
      <div className="flex flex-wrap gap-2">
        {types.map((t) => {
          const m = entityMeta(t)
          const count = entities.filter((e) => e.type === t).length
          const active = typeFilter === t
          return (
            <button key={t} onClick={() => setTypeFilter(active ? 'all' : t)}>
              <Badge
                variant="outline"
                className={`cursor-pointer gap-1.5 text-[11px] transition-colors ${
                  active ? 'border-primary/50 bg-primary/10' : ''
                }`}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                <span className="uppercase">{m.label}</span>
                <span className="font-mono">{count}</span>
              </Badge>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading entities…</div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Boxes className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No entities found</p>
              <p className="text-xs text-muted-foreground">
                Ingest evidence first, or relax your filters.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="h-4 w-4 text-crimson-400" />
              {filtered.length} entities
            </CardTitle>
            <CardDescription>
              Click an entity to see its neighbors in the knowledge graph.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="scroll-area-safe">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((e) => {
                  const m = entityMeta(e.type)
                  const aliases = parseJsonArray<string>(e.metadataJson).filter(
                    (x) => typeof x === 'string',
                  )
                  return (
                    <div
                      key={e.id}
                      className="group min-w-0 overflow-hidden rounded-md border border-border/40 bg-muted/10 p-3 transition-colors hover:border-primary/40 hover:bg-muted/20"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5 overflow-hidden">
                            <span
                              className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                              style={{ background: m.color }}
                            />
                            <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                              {m.label}
                            </span>
                            <span className="flex-shrink-0 rounded bg-muted/40 px-1 text-[9px] font-mono text-muted-foreground">
                              conf {(e.confidence * 100).toFixed(0)}%
                            </span>
                            {e.tableIds && e.tableIds.length > 0 && (
                              <span
                                className="flex-shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 font-mono text-[9px] text-amber-500"
                                title={`Source-table ID${e.tableIds.length > 1 ? 's' : ''} from the relationship export: ${e.tableIds.join(', ')}`}
                              >
                                {e.tableIds[0]}
                                {e.tableIds.length > 1 ? `+${e.tableIds.length - 1}` : ''}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 truncate font-mono text-sm" title={e.value}>
                            {e.value}
                          </div>
                          {e.label && (
                            <div className="truncate text-[11px] text-muted-foreground" title={e.label}>
                              {e.label}
                            </div>
                          )}
                        </div>
                      </div>
                      {(e.linkCount || e.neighborCount) && (
                        <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
                          {e.linkCount != null && (
                            <span className="flex items-center gap-1">
                              <Link2 className="h-3 w-3" />
                              {e.linkCount} evidence
                            </span>
                          )}
                          {e.neighborCount != null && (
                            <span className="flex items-center gap-1">
                              <Network className="h-3 w-3" />
                              {e.neighborCount} neighbors
                            </span>
                          )}
                        </div>
                      )}
                      {aliases.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {aliases.slice(0, 3).map((a, i) => (
                            <Badge key={i} variant="outline" className="text-[9px]">
                              alias: {a}
                            </Badge>
                          ))}
                        </div>
                      )}
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
