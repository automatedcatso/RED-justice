'use client'

/**
 * EvidenceMatrixPanel — claims/hypotheses/findings × evidence support grid
 * (architecture §26 "Evidence Matrix").
 *
 *                  Claim 1  Claim 2  Claim 3
 *     EV-001          ✓        ?        ✗
 *     EV-002          ✓        -        ?
 *
 * Deterministic cell semantics from /api/cases/[id]/matrix:
 *   supports    — file cited as supporting that claim
 *   contradicts — open contradiction backed by this file touches it
 *   shared      — identifier overlap, unconfirmed
 *   none        — no detected connection
 */

import { useEffect, useMemo, useState } from 'react'
import { Grid3X3, Loader2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type EvidenceMatrixData } from '@/lib/api-client'
import { cn } from '@/lib/utils'

const CELL_STYLE: Record<string, { glyph: string; cls: string; title: string }> = {
  supports: { glyph: '✓', cls: 'bg-emerald-500/15 text-emerald-400', title: 'supports' },
  contradicts: { glyph: '✗', cls: 'bg-rose-500/15 text-rose-400', title: 'contradicts' },
  shared: { glyph: '?', cls: 'bg-amber-500/15 text-amber-400', title: 'identifier overlap — unconfirmed' },
  none: { glyph: '–', cls: 'text-muted-foreground/30', title: 'no detected connection' },
}

interface Props {
  caseId: string
}

export function EvidenceMatrixPanel({ caseId }: Props) {
  const [data, setData] = useState<EvidenceMatrixData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Kick off inside the effect; async callbacks land after mount so no
    // synchronous setState happens in the effect body itself.
    const run = async () => {
      setLoading(true)
      try {
        const d = await api.evidenceMatrix(caseId)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'failed to load matrix')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [caseId])

  const colWidth = useMemo(() => {
    if (!data) return 200
    const n = data.columns.length
    // Shrink columns as they multiply so the grid stays readable.
    if (n <= 4) return 220
    if (n <= 8) return 150
    return 110
  }, [data])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Grid3X3 className="h-4 w-4 text-sky-400" />
          Evidence Matrix — claim ⇄ evidence coverage at a glance
        </CardTitle>
        <CardDescription>
          Which files support, contradict or merely mention each hypothesis, finding and claim.
          Cells are computed deterministically from citation records, open contradictions and
          identifier overlaps — never from AI opinion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Building matrix…
          </div>
        )}
        {!loading && error && (
          <div className="py-10 text-center text-sm text-destructive">{error}</div>
        )}
        {!loading && !error && data && data.empty && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Not enough material yet — record a hypothesis or run pattern detection to populate columns.
          </div>
        )}
        {!loading && !error && data && !data.empty && (
          <>
            {/* Legend + counts */}
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="gap-1 border-emerald-800/40 bg-emerald-950/20 text-[9px] text-emerald-300">✓ supports</Badge>
              <Badge variant="outline" className="gap-1 border-rose-800/40 bg-rose-950/20 text-[9px] text-rose-300">✗ contradicts</Badge>
              <Badge variant="outline" className="gap-1 border-amber-800/40 bg-amber-950/20 text-[9px] text-amber-300">? shared identifiers</Badge>
              <span>– no connection</span>
              {data.counts && (
                <span className="ml-auto font-mono">
                  {data.counts.supports} supported · {data.counts.contradicts} contradicted · {data.counts.shared} shared
                </span>
              )}
            </div>

            <ScrollArea className="max-w-full">
              <table className="border-separate border-spacing-0 text-[11px]" style={{ minWidth: Math.min(220 + colWidth * (data.columns.length), 1400) }}>
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 min-w-[190px] max-w-[240px] border-b bg-card p-2 text-left align-bottom text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Evidence
                    </th>
                    {data.columns.map((c) => (
                      <th
                        key={c.id}
                        className="border-b bg-card p-2 align-bottom"
                        style={{ width: colWidth }}
                        title={`${c.kind}: ${c.label} — status ${c.status}${c.sufficiency != null ? ` · conf ${c.sufficiency}%` : ''}`}
                      >
                        <div className="mx-auto flex w-full flex-col items-center gap-1">
                          <Badge variant="outline" className={cn('px-1 py-0 text-[8px] uppercase',
                            c.kind === 'hypothesis' ? 'border-violet-800/40 text-violet-300'
                              : c.kind === 'finding' ? 'border-sky-800/40 text-sky-300'
                              : 'border-emerald-800/40 text-emerald-300')}>
                            {c.kind === 'hypothesis' ? 'HYP' : c.kind === 'finding' ? 'FIND' : 'CLM'}
                          </Badge>
                          <span className="line-clamp-2 w-full break-words text-center text-[9.5px] font-normal leading-tight">
                            {truncate(c.label, 90)}
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.evidenceId} className="group">
                      <td className="sticky left-0 z-10 max-w-[240px] border-b border-border/40 bg-card p-2 group-hover:bg-accent/30">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[9px] text-crimson-400">{r.evRef}</span>
                          <span className="min-w-0 flex-1 truncate" title={r.name}>{r.name}</span>
                          {r.classification && (
                            <Badge variant="outline" className="hidden px-1 py-0 text-[7.5px] uppercase lg:inline-block">
                              {r.classification.replace(/_/g, ' ')}
                            </Badge>
                          )}
                        </div>
                      </td>
                      {data.columns.map((c) => {
                        const v = data.cells[`${r.evidenceId}|${c.id}`] ?? 'none'
                        const st = CELL_STYLE[v]
                        return (
                          <td key={c.id} className="border-b border-border/40 p-1 text-center">
                            <span
                              className={cn(
                                'inline-flex h-6 w-6 items-center justify-center rounded font-mono text-xs font-bold',
                                st.cls,
                              )}
                              title={`${st.title} — ${r.evRef} × ${truncate(c.label, 60)}`}
                            >
                              {st.glyph}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>

            {/* Coverage insight strip */}
            {data.counts && data.rows.length > 0 && (
              <div className="rounded-md border border-border/40 bg-muted/10 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                <b className="text-foreground">Reading the matrix:</b> every ✗ deserves attention before
                reporting — an open contradiction backed by real evidence caps confidence regardless of how
                many ✓ exist. A column with only dashes means the claim currently has NO evidence base and
                must not enter the report until something supports it.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
