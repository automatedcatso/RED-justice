'use client'

/**
 * TemporalPlaybackPanel — Temporal Intelligence playback (architecture §6).
 *
 * Scrub through the investigation chronologically: each frame carries what is
 * NEW (entities, relationships) plus cumulative counts — the case as a video,
 * not a static page. Also surfaces co-activity overlaps ("A and B were active
 * in the same window for 14 days, sharing an edge").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pause, Play, Radio, SkipForward } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type PlaybackFrameRow, type TemporalOverlapRow } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface Props {
  caseId: string
}

export function TemporalPlaybackPanel({ caseId }: Props) {
  const [frames, setFrames] = useState<PlaybackFrameRow[]>([])
  const [overlaps, setOverlaps] = useState<TemporalOverlapRow[]>([])
  const [windowInfo, setWindowInfo] = useState<{ from: string | null; to: string | null }>({ from: null, to: null })
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api.temporalPlayback(caseId, 10, true)
      setFrames(d.frames)
      setOverlaps(d.overlaps)
      setWindowInfo(d.window)
      setCursor(Math.max(0, d.frames.length - 1))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'playback failed')
    } finally {
      setLoading(false)
    }
  }, [caseId])

  useEffect(() => {
    void load()
  }, [load])

  // Play/pause loop.
  useEffect(() => {
    if (!playing || frames.length === 0) return
    timerRef.current = setInterval(() => {
      setCursor((c) => {
        if (c >= frames.length - 1) {
          setPlaying(false)
          return c
        }
        return c + 1
      })
    }, 1600)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [playing, frames.length])

  const frame: PlaybackFrameRow | undefined = frames[cursor]
  const nextOverlaps = overlaps.filter(
    (o) =>
      windowInfo &&
      cursor >= 0 &&
      new Date(o.overlapEnd).getTime() <= new Date(frame?.to ?? Date.now()).getTime(),
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Radio className="h-4 w-4 text-teal-400" />
          Temporal playback — watch the network form
          {windowInfo.from && (
            <Badge variant="outline" className="ml-auto font-mono text-[9px]">
              {windowInfo.from.slice(0, 10)} → {windowInfo.to?.slice(0, 10)}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Chronological reconstruction from relationship timestamps and ingest dates.
          Every frame shows what NEW evidence entered the case in that window.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Building frames…
          </div>
        )}
        {!loading && error && <div className="py-8 text-center text-sm text-destructive">{error}</div>}
        {!loading && !error && frames.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No dated events yet — upload and scan evidence with timestamps to enable playback.
          </div>
        )}

        {!loading && !error && frames.length > 0 && (
          <>
            {/* Transport controls */}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant={playing ? 'default' : 'outline'} onClick={() => setPlaying((p) => !p)} disabled={frames.length <= 1}>
                {playing ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setCursor((c) => Math.min(frames.length - 1, c + 1)) }} disabled={cursor >= frames.length - 1}>
                <SkipForward className="h-3.5 w-3.5" />
              </Button>
              <div className="mx-2 flex min-w-[200px] flex-1 items-center gap-1">
                {frames.map((f, i) => (
                  <button
                    key={f.index}
                    type="button"
                    onClick={() => { setPlaying(false); setCursor(i) }}
                    title={f.label}
                    className={cn(
                      'h-1.5 min-w-[10px] flex-1 rounded-full transition-all',
                      i <= cursor ? 'bg-primary' : 'bg-muted hover:bg-accent',
                    )}
                  />
                ))}
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                frame {cursor + 1}/{frames.length}
              </span>
            </div>

            {/* Active frame */}
            {frame && (
              <div className="rounded-lg border bg-muted/10 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-primary">{frame.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    +{frame.newEntities} entities · +{frame.newEdges} links · cumulative {frame.cumEntities}e / {frame.cumEdges}r
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">New entities</div>
                    <div className="space-y-0.5">
                      {frame.newEntityLabels.slice(0, 6).map((l, i) => (
                        <div key={i} className="truncate text-[11px]" title={l}>• {l}</div>
                      ))}
                      {frame.newEntityLabels.length === 0 && <div className="text-[11px] text-muted-foreground/50">—</div>}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">New relationships</div>
                    <div className="space-y-0.5">
                      {frame.newEdgeLabels.slice(0, 6).map((l, i) => (
                        <div key={i} className="truncate font-mono text-[10.5px]" title={l}>• {l}</div>
                      ))}
                      {frame.newEdgeLabels.length === 0 && <div className="text-[11px] text-muted-foreground/50">—</div>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Co-activity overlaps so far */}
            {nextOverlaps.length > 0 && (
              <div className="rounded-md border border-border/40 p-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Co-activity overlaps · top {Math.min(3, nextOverlaps.length)} of {nextOverlaps.length}
                </div>
                <div className="space-y-1">
                  {nextOverlaps.slice(0, 3).map((o, i) => (
                    <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                      <span className="font-medium">{o.a.label}</span>
                      <span className="text-muted-foreground">×</span>
                      <span className="font-medium">{o.b.label}</span>
                      <span className="ml-auto rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">
                        overlap {o.overlapHuman}
                        {o.relationType ? ` · ${o.relationType.replace(/_/g, ' ').toLowerCase()}` : o.basis === 'shared-evidence' ? ' · shared file' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
