'use client'

/**
 * ReferencePanel.tsx — the "Industry Reference" tab: the live rubric
 * explanation + a curated table of PUBLISHED benchmark scores for well-known
 * models (clearly labeled as reference data, not live-tested here).
 */

import { BookOpen, Info, Scale } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CATEGORY_RUBRIC } from '@/lib/benchmark/types'
import { REFERENCE_FOOTNOTE, REFERENCE_MODELS } from '@/lib/benchmark/referenceScores'

const RUBRIC_DESCRIPTIONS: Record<string, string> = {
  entity_extraction: 'F1 vs ground-truth entities (type-tolerant, value-normalized matching)',
  relationship_extraction: 'F1 over (source, relation, target) triples; relation synonyms accepted, direction preserved',
  evidence_grounding: 'Share of returned claims that cite at least one evidence ID',
  citation_accuracy: 'Share of cited evidence IDs that actually exist in the case',
  contradiction_detection: 'Recall + precision on planted contradictions between documents',
  temporal_reasoning: 'BEFORE / AFTER / VALID / INCONSISTENT questions with known answers',
  hypothesis_quality: 'Verdict + proposed verification tests + disconfirming evidence',
  verification_accuracy: 'CONFIRMED / REJECTED / UNRESOLVED verdict match',
  unknown_handling: 'Unanswerable questions must yield INSUFFICIENT_EVIDENCE / UNRESOLVED',
  structured_output: 'Response parses as JSON with the required contract fields',
  injection_resistance: 'Model must not obey instructions embedded inside evidence documents',
}

export function ReferencePanel() {
  return (
    <div className="space-y-4">
      {/* Live rubric */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-4 w-4 text-crimson-400" />
            Live Benchmark Lab rubric
          </CardTitle>
          <CardDescription>
            How your LIVE runs are scored. Cases are synthetic and deterministic; every category is scored 0–1 and the
            overall score is the weight-renormalized average (quick suite: 7 of 11 categories).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Category</th>
                  <th className="py-2 pr-3 font-medium">Weight</th>
                  <th className="py-2 font-medium">What is measured</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORY_RUBRIC.map((cat) => (
                  <tr key={cat.key} className="border-b border-border/30">
                    <td className="py-2 pr-3 font-medium">{cat.label}</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                        {Math.round(cat.weight * 100)}%
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">{RUBRIC_DESCRIPTIONS[cat.key] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Published reference scores */}
      <Card className="border-border/60 bg-card/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-crimson-400" />
            Published reference scores
          </CardTitle>
          <CardDescription>
            Published reference scores from official model cards / public leaderboards — approximate, not live-tested
            here. Use them to contextualize your LIVE Benchmark Lab results.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Model</th>
                  <th className="py-2 pr-3 font-medium">Params</th>
                  <th className="py-2 pr-3 font-medium">MMLU</th>
                  <th className="py-2 pr-3 font-medium">GPQA (Diamond)</th>
                  <th className="py-2 pr-3 font-medium">MATH</th>
                  <th className="py-2 pr-3 font-medium">HumanEval</th>
                  <th className="py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {REFERENCE_MODELS.map((m) => (
                  <tr key={m.model} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="py-2 pr-3 font-medium">
                      <span className="flex items-center gap-2">
                        {m.model}
                        {m.model.startsWith('Gemini 2.0 Flash') && (
                          <Badge variant="outline" className="border-amber-700/40 bg-amber-950/30 text-[9px] text-amber-300">
                            in your lab
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[10px] text-muted-foreground">{m.params}</td>
                    <td className="py-2 pr-3 font-mono">{fmt(m.mmlu)}</td>
                    <td className="py-2 pr-3 font-mono">{fmt(m.gpqa)}</td>
                    <td className="py-2 pr-3 font-mono">{fmt(m.math)}</td>
                    <td className="py-2 pr-3 font-mono">{fmt(m.humaneval)}</td>
                    <td className="py-2 text-[10px] text-muted-foreground">
                      {m.notes}
                      {m.extra ? ` · ${m.extra}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {REFERENCE_FOOTNOTE}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function fmt(v: number | null): string {
  return v === null ? '—' : v.toFixed(1)
}
