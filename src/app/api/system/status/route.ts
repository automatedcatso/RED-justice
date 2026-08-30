/**
 * GET /api/system/status — system health + Offline Capability Degradation Map.
 *
 * Instead of a single "online/offline" flag, this reports each capability
 * separately so the investigator can see exactly what keeps working when a
 * backend (local LLM, Gemini, OCR…) is unavailable:
 *
 *   deterministic-analytics — always operational (pure TS, no I/O)
 *   database                — SQLite via Prisma
 *   graph-queries           — SQLite-backed graph layer
 *   fts-search              — SQL contains() search
 *   pattern-engine          — 13 deterministic detectors
 *   local-llm               — Ollama-compatible server (optional)
 *   gemini                  — Gemini API key configured? (optional)
 *   equivalence-mode        — both backends needed for full compare
 *   ocr                     — image text extraction (offline: flagged, needs OCR tooling)
 *   file-parsing            — all supported formats (xlsx/pdf/docx/…)
 */
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { pingLocalAi, getLocalAiConfig } from '@/lib/localAi'
import { getOcrAvailability } from '@/lib/extractors/ocr'
import { getGeminiConfig } from '@/lib/gemini'

export const dynamic = 'force-dynamic'

let aiAvailableCache: { value: boolean; model: string; endpoint: string; ts: number } | null = null
const AI_CACHE_TTL_MS = 60_000

async function pingAi(): Promise<{ available: boolean; model: string; endpoint: string }> {
  if (aiAvailableCache && Date.now() - aiAvailableCache.ts < AI_CACHE_TTL_MS) {
    return {
      available: aiAvailableCache.value,
      model: aiAvailableCache.model,
      endpoint: aiAvailableCache.endpoint,
    }
  }
  const ping = await pingLocalAi()
  aiAvailableCache = {
    value: ping.available,
    model: ping.model,
    endpoint: ping.endpoint,
    ts: Date.now(),
  }
  return ping
}

export interface Capability {
  name: string
  label: string
  status: 'operational' | 'degraded' | 'offline'
  dependsOn: string
  fallback: string
  detail?: string
}

export async function GET() {
  try {
    const cfg = getLocalAiConfig()
    const gcfg = getGeminiConfig()
    const [caseCount, evidenceCount, entityCount, txCount, aiPing] = await Promise.all([
      db.case.count(),
      db.evidence.count(),
      db.entity.count(),
      db.transaction.count(),
      pingAi(),
    ])

    const geminiConfigured = Boolean(gcfg.apiKey)
    const capabilities: Capability[] = [
      {
        name: 'deterministic-analytics',
        label: 'Deterministic analytics (centrality, communities, money flow)',
        status: 'operational',
        dependsOn: 'none — pure TypeScript engine',
        fallback: 'n/a — this layer never goes down',
      },
      {
        name: 'database',
        label: 'SQLite database (cases, evidence, entities)',
        status: 'operational',
        dependsOn: 'local file (prisma/db/custom.db)',
        fallback: 'n/a',
      },
      {
        name: 'graph-queries',
        label: 'Knowledge-graph queries (SQLite-backed graph layer)',
        status: 'operational',
        dependsOn: 'database',
        fallback: 'n/a — no Neo4j dependency',
      },
      {
        name: 'fts-search',
        label: 'Cross-evidence full-text search',
        status: 'operational',
        dependsOn: 'database',
        fallback: 'n/a',
      },
      {
        name: 'pattern-engine',
        label: 'Deterministic pattern detection (13 rules)',
        status: 'operational',
        dependsOn: 'database',
        fallback: 'n/a',
      },
      {
        name: 'file-parsing',
        label: 'File parsing (PDF, XLSX/XLS/ODS, DOCX, CSV, MD, EML, ZIP…)',
        status: 'operational',
        dependsOn: 'none — server-side parsers',
        fallback: 'binary/unknown files are flagged instead of crashing',
      },
      {
        name: 'local-llm',
        label: `Local AI (${cfg.model} via ${cfg.baseUrl})`,
        status: aiPing.available ? 'operational' : 'offline',
        dependsOn: 'Ollama / LM Studio reachable at the configured endpoint',
        fallback: aiPing.available
          ? 'n/a'
          : 'AI scans + AI answers degrade to deterministic classifiers and the Level-0 fallback summary; all graph/pattern/analytics features keep working',
        detail: aiPing.available ? undefined : (aiPing as { error?: string }).error,
      },
      {
        name: 'gemini',
        label: `Gemini (${gcfg.model})`,
        status: geminiConfigured ? 'operational' : 'offline',
        dependsOn: 'GEMINI_API_KEY environment variable + internet access',
        fallback: 'Equivalence Mode runs local-AI-only; single-AI answers unaffected',
        detail: geminiConfigured ? undefined : 'Set GEMINI_API_KEY in .env to enable',
      },
      {
        name: 'equivalence-mode',
        label: 'Local-AI / Gemini Equivalence Mode',
        status: aiPing.available && geminiConfigured ? 'operational' : 'degraded',
        dependsOn: 'local-llm AND gemini',
        fallback:
          aiPing.available || geminiConfigured
            ? 'runs with the available backend(s); the unavailable side reports the reason'
            : 'unavailable — deterministic fallback answers only',
      },

    ]

    // Real OCR capability probe (tesseract installed on this machine?).
    try {
      const ocr = await getOcrAvailability()
      capabilities.push({
        name: 'ocr',
        label: `OCR (text inside images${ocr.pdftoppm ? ' + scanned PDFs' : ''})`,
        status: ocr.tesseract ? ('operational' as const) : ('degraded' as const),
        dependsOn: 'tesseract CLI' + (ocr.pdftoppm ? ' + pdftoppm' : '') + (ocr.langs ? ` [${ocr.langs}]` : ''),
        fallback:
          ocr.tesseract
            ? `tesseract ${ocr.version ?? ''} active — image and scanned-PDF evidence is transcribed at ingest and flows into extraction + AI scan`
            : 'image files are ingested + classified from metadata and flagged "needs_ocr"; install tesseract (and poppler-utils for scanned PDFs) to enable automatic transcription',
      })
    } catch {
      /* keep capability list without OCR row */
    }


    return NextResponse.json({
      db: 'ok',
      caseCount,
      evidenceCount,
      entityCount,
      transactionCount: txCount,
      aiAvailable: aiPing.available,
      aiModel: aiPing.model,
      aiEndpoint: aiPing.endpoint,
      aiError: aiPing.available ? undefined : (aiPing as { error?: string }).error,
      geminiConfigured,
      capabilities,
      degradedSummary: {
        operational: capabilities.filter((c) => c.status === 'operational').length,
        degraded: capabilities.filter((c) => c.status === 'degraded').length,
        offline: capabilities.filter((c) => c.status === 'offline').length,
        total: capabilities.length,
      },
      ts: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[api/system/status GET] failed:', err)
    return NextResponse.json(
      {
        db: 'error',
        caseCount: 0,
        evidenceCount: 0,
        aiAvailable: false,
        error: err instanceof Error ? err.message : 'status failed',
      },
      { status: 500 },
    )
  }
}
