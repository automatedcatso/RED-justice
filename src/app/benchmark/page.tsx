'use client'

/**
 * /benchmark — RED Justice Benchmark Lab.
 *
 * A controlled benchmark that scores AI models on investigation-reasoning
 * tasks (evidence grounding, extraction, temporal reasoning, contradiction
 * detection, hypothesis testing, uncertainty, structured output and
 * prompt-injection resistance) over deterministic synthetic cases.
 */

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, FlaskConical, Trophy, BookOpen } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RunnerPanel } from '@/components/benchmark/RunnerPanel'
import { LeaderboardPanel } from '@/components/benchmark/LeaderboardPanel'
import { ReferencePanel } from '@/components/benchmark/ReferencePanel'

export default function BenchmarkPage() {
  const [tab, setTab] = useState<string>('run')
  const [leaderboardRefresh, setLeaderboardRefresh] = useState(0)

  const onRunComplete = useCallback(() => {
    setLeaderboardRefresh((n) => n + 1)
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-background bg-investigation-grid">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="flex h-14 items-center gap-3 px-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            title="Back to RED Justice"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Back to RED Justice</span>
          </Link>
          <div className="hidden h-5 w-px bg-border/60 sm:block" aria-hidden />
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <img
                src="/logo-mark.png"
                alt="RED Justice logo"
                className="h-9 w-9 rounded-md border border-border/60 object-cover shadow-lg shadow-crimson-900/30"
              />
              <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-background" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold tracking-wide text-glow-crimson">BENCHMARK LAB</span>
              <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                RED Justice · Model Evaluation
              </span>
            </div>
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-full border border-crimson-800/40 bg-crimson-950/20 px-2.5 py-0.5 text-[10px] text-crimson-300 md:flex">
            <FlaskConical className="h-3 w-3" />
            Controlled · Synthetic · Reproducible
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="mb-4 h-auto w-full justify-start overflow-x-auto bg-muted/40 p-1 sm:w-auto">
            <TabsTrigger value="run" className="gap-1.5 text-xs">
              <FlaskConical className="h-3.5 w-3.5" />
              Run Benchmarks
            </TabsTrigger>
            <TabsTrigger value="leaderboard" className="gap-1.5 text-xs">
              <Trophy className="h-3.5 w-3.5" />
              Results &amp; Leaderboard
            </TabsTrigger>
            <TabsTrigger value="reference" className="gap-1.5 text-xs">
              <BookOpen className="h-3.5 w-3.5" />
              Industry Reference
            </TabsTrigger>
          </TabsList>
          <TabsContent value="run">
            <RunnerPanel onRunComplete={onRunComplete} />
          </TabsContent>
          <TabsContent value="leaderboard">
            <LeaderboardPanel refreshKey={leaderboardRefresh} active={tab === 'leaderboard'} />
          </TabsContent>
          <TabsContent value="reference">
            <ReferencePanel />
          </TabsContent>
        </Tabs>
      </main>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-10 max-w-6xl items-center justify-between px-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="font-mono">RED Justice Benchmark Lab</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">Investigation-Reasoning Model Evaluation</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">Local-first · Evidence-grounded</span>
            <span className="hidden sm:inline">·</span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Deterministic cases
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
