'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Banknote,
  RefreshCw,
  Search,
  ArrowRight,
  GitFork,
  Repeat,
  TrendingUp,
  AlertTriangle,
  Filter,
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type Transaction, type MoneyFlowStats } from '@/lib/api-client'
import { formatINR, formatDateTime } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

export function TransactionsView({ caseId }: Props) {
  const [txns, setTxns] = useState<Transaction[]>([])
  const [flow, setFlow] = useState<MoneyFlowStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [t, f] = await Promise.all([
        api.listTransactions(caseId),
        api.moneyFlow(caseId).catch(() => null),
      ])
      setTxns(t)
      setFlow(f)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load transactions')
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const min = minAmount ? Number(minAmount) : -Infinity
    const max = maxAmount ? Number(maxAmount) : Infinity
    const acc = account.trim().toLowerCase()
    return txns.filter((t) => {
      if (t.amount != null && (t.amount < min || t.amount > max)) return false
      if (acc) {
        const sender = (t.senderAccount ?? '').toLowerCase()
        const receiver = (t.receiverAccount ?? '').toLowerCase()
        const upi = (t.upi ?? '').toLowerCase()
        const utr = (t.utr ?? '').toLowerCase()
        if (!sender.includes(acc) && !receiver.includes(acc) && !upi.includes(acc) && !utr.includes(acc))
          return false
      }
      if (!q) return true
      const hay = [
        t.utr,
        t.senderAccount,
        t.receiverAccount,
        t.upi,
        t.bank,
        t.merchant,
        t.remarks,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [txns, query, account, minAmount, maxAmount])

  const totalVolume = useMemo(
    () => filtered.reduce((sum, t) => sum + (t.amount ?? 0), 0),
    [filtered],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Money Flow Analysis
          </h2>
          <p className="text-sm text-muted-foreground">
            {txns.length} transactions · volume {formatINR(txns.reduce((s, t) => s + (t.amount ?? 0), 0))}
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

      {/* Flow summary cards */}
      {flow && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            icon={<GitFork className="h-4 w-4" />}
            label="Circular Flows"
            value={(flow.circularFlows ?? []).length}
            accent="text-rose-300"
          />
          <SummaryCard
            icon={<Repeat className="h-4 w-4" />}
            label="Recurring Transfers"
            value={(flow.recurringTransfers ?? []).length}
            accent="text-amber-300"
          />
          <SummaryCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Unusual Sequences"
            value={(flow.unusualSequences ?? []).length}
            accent="text-orange-300"
          />
          <SummaryCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Total Volume"
            value={formatINR(flow.stats?.totalVolume ?? 0)}
            accent="text-emerald-300"
          />
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex-1 min-w-[200px]">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Search
            </Label>
            <div className="relative mt-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="UTR / account / UPI / remarks…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Account / UPI
            </Label>
            <Input
              placeholder="acc1234 / user@upi"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="mt-1 w-48"
            />
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Min ₹
            </Label>
            <Input
              type="number"
              placeholder="0"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              className="mt-1 w-24"
            />
          </div>
          <div>
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Max ₹
            </Label>
            <Input
              type="number"
              placeholder="100000"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className="mt-1 w-28"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('')
              setAccount('')
              setMinAmount('')
              setMaxAmount('')
            }}
          >
            <Filter className="mr-2 h-3 w-3" />
            Clear
          </Button>
          <div className="ml-auto text-right text-[11px] text-muted-foreground">
            {filtered.length} of {txns.length} · vol {formatINR(totalVolume)}
          </div>
        </CardContent>
      </Card>

      {/* Transaction table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="h-4 w-4 text-emerald-400" />
            Transaction Ledger
          </CardTitle>
          <CardDescription>
            Click a transaction to inspect its evidence provenance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">No transactions match.</div>
          ) : (
            <ScrollArea className="scroll-area-shortest">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Sender</th>
                    <th className="px-2 py-2"></th>
                    <th className="px-2 py-2">Receiver</th>
                    <th className="px-2 py-2 text-right">Amount</th>
                    <th className="px-2 py-2">UTR / UPI</th>
                    <th className="px-2 py-2">Bank / IFSC</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr
                      key={t.id}
                      className="border-t border-border/40 transition-colors hover:bg-muted/20"
                    >
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px]">
                        {t.txnDate ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">
                        {t.senderAccount ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        <ArrowRight className="h-3 w-3" />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">
                        {t.receiverAccount ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {formatINR(t.amount)}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                        {t.utr ?? t.upi ?? '—'}
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {t.bank ?? '—'}
                        {t.ifsc && <span className="ml-1 font-mono text-[10px]">{t.ifsc}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Unusual sequences */}
      {flow && (flow.unusualSequences ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-orange-400" />
              Unusual Sequences
            </CardTitle>
            <CardDescription>
              Heuristic flags: rapid hops, spikes, dormant-then-active patterns.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(flow.unusualSequences ?? []).slice(0, 15).map((u, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 rounded-md border border-border/40 bg-muted/10 px-3 py-2 text-sm"
                >
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {(u.kind ?? 'unknown').replace(/_/g, ' ')}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{u.description}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number | string
  accent: string
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <span className={accent}>{icon}</span>
        </div>
        <div className="mt-1 font-mono text-lg font-bold">{value}</div>
      </CardContent>
    </Card>
  )
}
