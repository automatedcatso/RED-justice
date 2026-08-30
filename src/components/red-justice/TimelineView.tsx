'use client'

import { useEffect, useMemo, useState } from 'react'
import { Calendar, RefreshCw, Filter, Clock } from 'lucide-react'
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
import { api, type TimelineEvent } from '@/lib/api-client'
import { formatDateTime } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'
import { TemporalPlaybackPanel } from './TemporalPlaybackPanel'

interface Props {
  caseId: string
}

const KIND_COLORS: Record<string, string> = {
  transaction: 'bg-emerald-500',
  communication: 'bg-sky-500',
  login: 'bg-purple-500',
  account_creation: 'bg-crimson-500',
  document: 'bg-amber-500',
  evidence_acquired: 'bg-slate-400',
  extracted_date: 'bg-slate-500',
  ip_activity: 'bg-pink-500',
  relationship: 'bg-teal-500',
  default: 'bg-muted-foreground',
}

export function TimelineView({ caseId }: Props) {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setEvents(await api.timeline(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load timeline')
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

  const kinds = useMemo(() => {
    const set = new Set<string>()
    events.forEach((e) => e.kind && set.add(e.kind))
    return Array.from(set).sort()
  }, [events])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return events
      .filter((e) => {
        if (kindFilter !== 'all' && e.kind !== kindFilter) return false
        if (!q) return true
        return (e.summary ?? '').toLowerCase().includes(q)
      })
      .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
  }, [events, query, kindFilter])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Investigation Timeline
          </h2>
          <p className="text-sm text-muted-foreground">
            Chronological merge of transactions, communications, logins, document events.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="w-40">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Search events…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-48"
          />
          <Button onClick={load} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Temporal playback (architecture §6) — scrub the case chronologically */}
      <TemporalPlaybackPanel caseId={caseId} />

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading timeline…</div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Calendar className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No timeline events</p>
              <p className="text-xs text-muted-foreground">Ingest evidence to populate the timeline.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ScrollArea className="scroll-area-tall">
              <div className="relative px-6 py-4">
                {/* vertical line */}
                <div className="absolute left-10 top-0 bottom-0 w-px bg-border" />
                <ol className="space-y-3">
                  {filtered.map((e) => {
                    const color = KIND_COLORS[e.kind ?? ''] ?? KIND_COLORS.default
                    return (
                      <li key={e.id} className="relative flex gap-4">
                        {/* node */}
                        <div className="relative z-10 flex-shrink-0">
                          <div
                            className={`mt-1 h-3 w-3 rounded-full ${color} ring-4 ring-background`}
                          />
                        </div>
                        <div className="flex-1 pb-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {formatDateTime(e.ts)}
                            </span>
                            {e.kind && (
                              <Badge variant="outline" className="text-[10px] uppercase">
                                {e.kind.replace(/_/g, ' ')}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 break-words text-sm">{e.summary}</div>
                          {e.sourceEvidenceId && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              evidence:{' '}
                              <span className="font-mono">
                                {e.evidence?.originalName ?? e.sourceEvidenceId.slice(-8)}
                              </span>
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
