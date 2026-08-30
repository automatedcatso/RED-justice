'use client'
/**
 * CollisionExplorer — Cross-Case Identity Collision Explorer.
 *
 * Searches ALL cases for reused identifiers (phones, accounts, UPI VPAs,
 * emails, devices, IMEIs, addresses…) and visualises where the same identity
 * artifact appears across cases — a reused mule account, a common suspect
 * phone, a recycled device are all instant leads.
 */

import { useEffect, useState } from 'react'
import { Crosshair, RefreshCw, FolderOpen, Loader2 } from 'lucide-react'
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
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type CollisionReport } from '@/lib/api-client'

export function CollisionExplorer({ onSelectCase }: { onSelectCase?: (caseId: string) => void }) {
  const [report, setReport] = useState<CollisionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const load = async (query?: string) => {
    setLoading(true)
    try {
      setReport(await api.collisions(query))
    } catch {
      setReport(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      void load(q.trim() || undefined)
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Crosshair className="h-4 w-4 text-amber-400" />
              Cross-Case Identity Collision Explorer
            </CardTitle>
            <CardDescription className="text-[11px]">
              Reused phones, accounts, UPI VPAs, emails, devices and addresses across ALL cases.
              {report && (
                <>
                  {' '}
                  <b className="text-foreground">{report.total}</b> collisions across{' '}
                  <b className="text-foreground">{report.casesWithCollisions}</b> cases.
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Filter by identifier…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 w-48 text-xs"
            />
            <Button onClick={() => void load(q.trim() || undefined)} variant="outline" size="icon" className="h-8 w-8">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !report ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Scanning all cases for shared identifiers…</div>
        ) : !report || report.collisions.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">No cross-case collisions found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Entities are checked by normalised value across every case. Upload evidence to more cases to find reused identities.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {Object.entries(report.byType).map(([t, n]) => (
                <Badge key={t} variant="outline" className="text-[10px] capitalize">
                  {t}: {n}
                </Badge>
              ))}
            </div>
            <ScrollArea className="scroll-area-short">
              <div className="space-y-2">
                {report.collisions.map((c) => (
                  <div key={`${c.type}-${c.norm}`} className="rounded-md border border-amber-900/30 bg-amber-950/10 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-amber-700 text-[10px] uppercase">
                        {c.type}
                      </Badge>
                      <span className="font-mono text-sm font-medium">{c.displayValue}</span>
                      <Badge variant="outline" className="ml-auto border-amber-700 bg-amber-950/30 text-[10px] text-amber-300">
                        {c.caseCount} case{c.caseCount > 1 ? 's' : ''} · {c.occurrences} occurrences
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-col gap-1.5">
                      {c.cases.map((ref) => (
                        <button
                          key={ref.caseId}
                          onClick={() => onSelectCase?.(ref.caseId)}
                          className="flex items-center gap-2 rounded border border-border/40 bg-muted/10 px-2 py-1.5 text-left transition-colors hover:border-primary/40"
                          title={ref.evidenceNames.length ? `Evidence: ${ref.evidenceNames.join(', ')}` : undefined}
                        >
                          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-xs">{ref.caseTitle}</span>
                          <span className="font-mono text-[9px] text-muted-foreground">{ref.caseUid}</span>
                          <Badge variant="outline" className="text-[9px]">
                            {ref.values.length} value{ref.values.length > 1 ? 's' : ''}
                          </Badge>
                        </button>
                      ))}
                    </div>
                    {c.cases.some((r) => r.evidenceNames.length > 0) && (
                      <div className="mt-1.5 truncate text-[10px] text-muted-foreground">
                        source files: {Array.from(new Set(c.cases.flatMap((r) => r.evidenceNames))).slice(0, 4).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
            {report.truncated && (
              <div className="mt-2 text-center text-[10px] text-muted-foreground">
                Showing first 200 collisions — refine the filter to narrow down.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
