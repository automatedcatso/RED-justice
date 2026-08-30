'use client'

/**
 * DecisionsAuditPanel — Decision Record ledger + unified audit feed
 * (architecture §18 Investigator Decision Record + §22 audit trail).
 *
 * Two synchronized views:
 *   LEDGER  — structured decisions: WHO · WHAT · BEFORE → AFTER · REASON
 *   FEED    — merged chronological stream: decisions ∪ custody ∪ activity
 */

import { useCallback, useEffect, useState } from 'react'
import { Gavel, History, Loader2, RefreshCw, ScrollText } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type AuditEventRow, type DecisionRecordRow } from '@/lib/api-client'
import { cn } from '@/lib/utils'

const ACTION_COLOR: Record<string, string> = {
  approve_finding: 'text-emerald-400',
  confirm_hypothesis: 'text-emerald-400',
  resolve_contradiction: 'text-emerald-400',
  merge_entities: 'text-sky-400',
  reject_finding: 'text-rose-400',
  reject_hypothesis: 'text-rose-400',
  reopen_contradiction: 'text-amber-400',
  mark_unresolved: 'text-amber-400',
  supersede_evidence: 'text-violet-400',
  explain_connection: 'text-primary',
}

interface Props {
  caseId: string
}

export function DecisionsAuditPanel({ caseId }: Props) {
  const [decisions, setDecisions] = useState<DecisionRecordRow[]>([])
  const [events, setEvents] = useState<AuditEventRow[]>([])
  const [kindFilter, setKindFilter] = useState<'all' | 'decision' | 'custody' | 'activity'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (filter = kindFilter) => {
      setLoading(true)
      setError(null)
      try {
        const [d, a] = await Promise.all([
          api.decisions(caseId, { limit: 200 }),
          api.auditFeed(caseId, filter),
        ])
        setDecisions(d.decisions)
        setEvents(a.events)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load audit data')
      } finally {
        setLoading(false)
      }
    },
    [caseId, kindFilter],
  )

  useEffect(() => {
    void load(kindFilter)
  }, [caseId])

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      {/* ── Decision Record ledger ── */}
      <Card className="xl:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gavel className="h-4 w-4 text-amber-400" />
            Decision Records
            <Badge variant="outline" className="ml-auto font-mono text-[9px]">
              {decisions.length}
            </Badge>
          </CardTitle>
          <CardDescription>
            Every human (and deterministic-verifier) decision as structured intelligence:
            WHO · WHAT · WHEN · BEFORE → AFTER · REASON.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[520px] px-4 pb-4">
            {loading && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && error && <div className="py-10 text-center text-sm text-destructive">{error}</div>}
            {!loading && !error && decisions.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No decisions recorded yet. Approve/reject findings, verify hypotheses or resolve
                contradictions — each action is captured here permanently.
              </div>
            )}
            {!loading && !error && (
              <div className="space-y-2">
                {decisions.map((d) => (
                  <div key={d.id} className="rounded-md border border-border/40 bg-muted/10 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[9px] text-muted-foreground">{d.uid}</span>
                      <span className={cn('font-mono text-[10px] font-semibold', ACTION_COLOR[d.action] ?? 'text-foreground')}>
                        {d.action.replace(/_/g, ' ')}
                      </span>
                    </div>
                    {d.objectLabel && (
                      <div className="mt-0.5 line-clamp-2 text-[11px]" title={d.objectLabel}>
                        {d.objectLabel}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                      {d.beforeState && d.afterState && d.beforeState !== d.afterState ? (
                        <>
                          <span className="rounded bg-muted/50 px-1.5 py-0.5 line-through opacity-70">{trim(d.beforeState)}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-semibold">{trim(d.afterState)}</span>
                        </>
                      ) : (
                        d.afterState && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5">{trim(d.afterState)}</span>
                        )
                      )}
                    </div>
                    {d.reason && (
                      <div className="mt-1 border-l border-border/60 pl-2 text-[10px] italic leading-relaxed text-muted-foreground">
                        “{trim(d.reason, 220)}”
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground/70">
                      <span>{d.actor}</span>
                      <span>·</span>
                      <span>{new Date(d.at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* ── Unified audit feed ── */}
      <Card className="xl:col-span-3">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-sky-400" />
            Unified Audit Feed
          </CardTitle>
          <CardDescription>
            Tamper-evident style merge of decision records, evidence chain of custody and system activity.
          </CardDescription>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {(['all', 'decision', 'custody', 'activity'] as const).map((k) => (
              <Button
                key={k}
                size="sm"
                variant={kindFilter === k ? 'default' : 'outline'}
                className="h-6 rounded-full px-2.5 text-[10px]"
                onClick={() => {
                  setKindFilter(k)
                  void load(k)
                }}
              >
                {k === 'all' ? <ScrollText className="mr-1 h-3 w-3" /> : null}
                {k}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={() => void load()}>
              <RefreshCw className={cn('mr-1 h-3 w-3', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[520px] px-4 pb-4">
            {!loading && events.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">The audit stream is empty.</div>
            )}
            {!loading && events.length > 0 && (
              <ol className="relative space-y-3 border-l border-border/50 pl-4">
                {events.map((e, i) => (
                  <li key={`${e.kind}-${e.ref}-${i}`} className="relative">
                    <span
                      className={cn(
                        'absolute -left-[21px] top-1 size-2 rounded-full ring-4 ring-background',
                        e.kind === 'decision' ? 'bg-amber-400'
                          : e.kind === 'custody' ? 'bg-crimson-400'
                          : 'bg-muted-foreground/40',
                      )}
                    />
                    <div className="flex items-baseline gap-2">
                      <Badge variant="outline" className="px-1 py-0 text-[8px] uppercase">{e.kind}</Badge>
                      <span className="text-[11px]">{auditLine(e)}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/70">
                        {new Date(e.at).toLocaleTimeString()}
                        {` ${new Date(e.at).toLocaleDateString()}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

function trim(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function auditLine(e: AuditEventRow): string {
  if (e.kind === 'decision') {
    return `${(e.actor ?? 'investigator')} ${e.action.replace(/_/g, ' ')}${e.objectLabel ? ` — ${trim(e.objectLabel, 90)}` : ''}`
  }
  if (e.kind === 'custody') return `${e.action}${e.objectLabel ? ` — ${trim(e.objectLabel, 80)}` : ''}`
  return trim(e.detail ?? '', 130)
}
