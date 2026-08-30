'use client'

/**
 * CommandCenterStrip — the per-case "case overview" pulse bar
 * (architecture §26 Command Center, compact form).
 *
 * Shows: unresolved hypotheses · open contradictions · gaps · decisions
 * recorded · report readiness. Each tile is a jump-link into its workspace.
 * Rendered only when a case is active; self-hiding on fetch failure.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ClipboardCheck, FileWarning, Gavel, ShieldCheck } from 'lucide-react'

import { api } from '@/lib/api-client'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'
import { cn } from '@/lib/utils'

interface Props {
  caseId: string | null
  onNavigate: (section: string) => void
}

interface Counts {
  hypothesesUnresolved: number
  contradictionsOpen: number
  decisionsTotal: number
  gapsTotal: number | null
}

export function CommandCenterStrip({ caseId, onNavigate }: Props) {
  const [counts, setCounts] = useState<Counts | null>(null)
  // Bumped whenever the knowledge graph changes so the strip's counters
  // (hypotheses / contradictions / decisions) never go stale.
  const [refreshKey, setRefreshKey] = useState(0)
  useGraphRefresh(() => setRefreshKey((k) => k + 1))

  useEffect(() => {
    if (!caseId) return
    let alive = true
    const run = async () => {
      try {
        const [hyps, contra, decisions] = await Promise.all([
          api.listHypotheses(caseId),
          api.contradictions(caseId),
          api.decisions(caseId, { limit: 1 }),
        ])
        if (!alive) return
        setCounts({
          hypothesesUnresolved: hyps.filter((h) => h.status === 'unresolved').length,
          contradictionsOpen: (contra.contradictions ?? []).filter((c) => c.status !== 'resolved').length,
          decisionsTotal: decisions.total,
          gapsTotal: null,
        })
      } catch {
        if (alive) setCounts(null)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [caseId, refreshKey])

  if (!caseId || !counts) return null

  const tiles: Array<{ label: string; value: number; warn: boolean; icon: React.ReactNode; go: string; hint: string }> = [
    {
      label: 'unresolved hypotheses',
      value: counts.hypothesesUnresolved,
      warn: counts.hypothesesUnresolved > 0,
      icon: <ClipboardCheck className="h-4 w-4" />,
      go: 'hypotheses',
      hint: 'Run Verify to promote or reject them',
    },
    {
      label: 'open contradictions',
      value: counts.contradictionsOpen,
      warn: counts.contradictionsOpen > 0,
      icon: <AlertTriangle className="h-4 w-4" />,
      go: 'ai',
      hint: 'Conflicting evidence needs resolution before reporting',
    },
    {
      label: 'decisions recorded',
      value: counts.decisionsTotal,
      warn: false,
      icon: <Gavel className="h-4 w-4" />,
      go: 'reports',
      hint: 'Every approval / rejection lives in the audit ledger',
    },
  ]

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {tiles.map((t) => (
        <button
          key={t.label}
          onClick={() => onNavigate(t.go)}
          title={t.hint}
          className={cn(
            'flex min-w-[150px] flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
            t.warn ? 'border-amber-800/40 bg-amber-950/20 hover:border-amber-600/50' : 'border-border/60 bg-muted/10 hover:border-primary/40',
          )}
        >
          <span className={t.warn ? 'text-amber-300' : 'text-muted-foreground'}>{t.icon}</span>
          <span>
            <span className={cn('block font-mono text-lg font-bold leading-none', t.warn && 'text-amber-200')}>
              {t.value}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.label}</span>
          </span>
          {t.label === 'open contradictions' && counts.gapsTotal == null && <FileWarning className="sr-only" />}
        </button>
      ))}
      <button
        onClick={() => onNavigate('reports')}
        title="Report readiness is computed by the claim graph policy"
        className="flex min-w-[150px] flex-1 items-center gap-3 rounded-lg border border-emerald-800/30 bg-emerald-950/10 px-3 py-2 text-left transition-colors hover:border-emerald-600/40"
      >
        <ShieldCheck className="text-emerald-400" />
        <span>
          <span className="block font-mono text-lg font-bold leading-none text-emerald-200">claims</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">claim graph & report</span>
        </span>
      </button>
    </div>
  )
}
