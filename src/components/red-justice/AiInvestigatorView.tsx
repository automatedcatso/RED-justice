'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Flame,
  Send,
  RefreshCw,
  Sparkles,
  Bot,
  User,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  FileText,
  Lightbulb,
  Route,
  Network,
  Scale,
  Zap,
  Loader2,
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
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type AiChatMessage } from '@/lib/api-client'
import { formatDateTime } from '@/lib/ui-helpers'

interface Props {
  caseId: string
}

const QUICK_PROMPTS = [
  'How many entities and transactions are in this case?',
  'Who are the most central entities in this network?',
  'Which communities exist in the graph?',
  'Trace money flow from the highest-risk account.',
  'Summarize the suspicious patterns detected.',
  'What evidence gaps remain in this investigation?',
]

interface AiChatResponse {
  response: string
  citations: string[]
  aiAvailable: boolean
  aiModel?: string
  router?: { route: string; reason: string; deterministic?: boolean }
  grounding?: { graph?: number; graphEdges?: number; text?: number; evidence: number }
  firewall?: { enforced: boolean; caseId: string; totalChecked: number; totalBlocked: number; blockedSamples: string[] }
  context: { entities: number; transactions: number; evidence: number; findings: number }
}

interface CompareResult {
  prompt: string
  local: { available: boolean; model: string; latencyMs: number; answer: string; usedFallback?: boolean; error?: string; citations: string[] }
  gemini: { available: boolean; model: string; latencyMs: number; answer: string; error?: string; citations: string[] }
  comparison: {
    overlapCitations: string[]
    localLatencyMs: number
    geminiLatencyMs: number
    localChars: number
    geminiChars: number
    totalLatencyMs: number
  }
}

const ROUTE_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  rules: { label: 'Deterministic · rules', color: 'border-emerald-700 bg-emerald-950/30 text-emerald-300', icon: <Zap className="h-3 w-3" /> },
  graph: { label: 'Deterministic · graph analytics', color: 'border-sky-700 bg-sky-950/30 text-sky-300', icon: <Network className="h-3 w-3" /> },
  fts: { label: 'Deterministic · search', color: 'border-violet-700 bg-violet-950/30 text-violet-300', icon: <FileText className="h-3 w-3" /> },
  timeline: { label: 'Deterministic · timeline', color: 'border-amber-700 bg-amber-950/30 text-amber-300', icon: <Route className="h-3 w-3" /> },
  ai: { label: 'Local AI · RAG', color: 'border-crimson-700 bg-crimson-950/30 text-crimson-300', icon: <Bot className="h-3 w-3" /> },
}

export function AiInvestigatorView({ caseId }: Props) {
  const [history, setHistory] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'standard' | 'smart' | 'deep'>('smart')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastMeta, setLastMeta] = useState<AiChatResponse | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Equivalence mode state
  const [eqPrompt, setEqPrompt] = useState(
    'Which accounts show structurally suspicious behaviour and what evidence supports that?'
  )
  const [eqRunning, setEqRunning] = useState(false)
  const [eqResult, setEqResult] = useState<CompareResult | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setHistory(await api.aiHistory(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [caseId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [history])

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || sending) return
    setSending(true)
    setInput('')
    const optimistic: AiChatMessage = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content: msg,
      citations: null,
      createdAt: new Date().toISOString(),
    }
    setHistory((h) => [...h, optimistic])
    try {
      const res = (await api.aiChat(caseId, msg, mode)) as unknown as AiChatResponse
      setLastMeta(res)
      setHistory((h) => [
        ...h,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: res.response,
          citations: JSON.stringify(res.citations),
          createdAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI request failed')
      setHistory((h) => h.filter((m) => m.id !== optimistic.id))
    } finally {
      setSending(false)
    }
  }

  const runEquivalence = async () => {
    if (!eqPrompt.trim() || eqRunning) return
    setEqRunning(true)
    setEqResult(null)
    try {
      setEqResult(await api.aiCompare(caseId, eqPrompt.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'equivalence run failed')
    } finally {
      setEqRunning(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const fw = lastMeta?.firewall

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            AI Investigator
          </h2>
          <p className="text-sm text-muted-foreground">
            Deterministic-first router · triple grounding (graph + text + evidence) · case-scoped firewall
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Reload
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Tabs defaultValue="chat">
        <TabsList>
          <TabsTrigger value="chat">Investigator Chat</TabsTrigger>
          <TabsTrigger value="equivalence" className="gap-1.5">
            <Scale className="h-3.5 w-3.5" />
            Local-AI / Gemini Equivalence
          </TabsTrigger>
        </TabsList>

        {/* ── Chat tab ── */}
        <TabsContent value="chat" className="space-y-4">
          {/* Guardrails + grounding + firewall banner */}
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="flex flex-wrap items-center gap-3 p-3 text-xs">
              <ShieldCheck className="h-4 w-4 flex-shrink-0 text-crimson-400" />
              <div className="flex flex-wrap gap-3 text-muted-foreground">
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Never invents evidence
                </span>
                <span className="flex items-center gap-1">
                  <Network className="h-3 w-3" /> Graph grounding
                </span>
                <span className="flex items-center gap-1">
                  <FileText className="h-3 w-3" /> Text + evidence citations
                </span>
                <span className="flex items-center gap-1">
                  <Lightbulb className="h-3 w-3" /> Inference labelled
                </span>
              </div>
              {/* Case-Scoped GraphRAG Firewall indicator */}
              <Badge
                variant="outline"
                className={`ml-auto text-[10px] ${
                  fw && fw.totalBlocked > 0
                    ? 'border-amber-700 bg-amber-950/30 text-amber-300'
                    : 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
                }`}
                title={
                  fw
                    ? `Case-scoped GraphRAG firewall: enforced for case ${fw.caseId}. Checked ${fw.totalChecked} retrieved rows, blocked ${fw.totalBlocked} cross-case rows.${fw.blockedSamples.length ? ' Samples: ' + fw.blockedSamples.join('; ') : ''}`
                    : 'Case-scoped GraphRAG firewall arms on the first AI query'
                }
              >
                <ShieldAlert className="mr-1 h-3 w-3" />
                Firewall ON{fw ? ` · ${fw.totalChecked} checked · ${fw.totalBlocked} blocked` : ''}
              </Badge>
            </CardContent>
          </Card>

          {/* Router + grounding status of the last query */}
          {lastMeta?.router && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 p-3 text-xs">
                <Route className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Last query served by:</span>
                {(() => {
                  const rm = ROUTE_META[lastMeta.router.route] ?? ROUTE_META.ai
                  return (
                    <Badge variant="outline" className={`gap-1 text-[10px] ${rm.color}`}>
                      {rm.icon}
                      {rm.label}
                    </Badge>
                  )
                })()}
                <span className="text-[10px] text-muted-foreground">{lastMeta.router.reason}</span>
                {lastMeta.grounding && (
                  <span className="ml-auto flex gap-2 text-[10px] text-muted-foreground">
                    <span className="rounded bg-sky-950/40 px-1.5 py-0.5">graph: {lastMeta.grounding.graph ?? 0} nodes / {lastMeta.grounding.graphEdges ?? 0} edges</span>
                    <span className="rounded bg-violet-950/40 px-1.5 py-0.5">text: {lastMeta.grounding.text ?? 0} snippets</span>
                    <span className="rounded bg-emerald-950/40 px-1.5 py-0.5">evidence: {lastMeta.grounding.evidence} files</span>
                  </span>
                )}
              </CardContent>
            </Card>
          )}

          {/* Chat history */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="h-4 w-4 text-crimson-400" />
                Conversation
              </CardTitle>
              <CardDescription>
                {history.length} messages · scoped to this case · counts/lookups answered deterministically without AI
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div ref={scrollRef} className="scroll-area-tall overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-3">
                {loading ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading history…
                  </div>
                ) : history.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <Flame className="h-10 w-10 text-crimson-400" />
                    <div>
                      <p className="text-sm font-medium">Ask the AI Investigator anything</p>
                      <p className="text-xs text-muted-foreground">
                        Counts, centrality and lookups are answered by deterministic engines; open questions go to the local LLM — always grounded in this case only.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {history.map((m) => (
                      <div
                        key={m.id}
                        className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        {m.role !== 'user' && (
                          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-crimson-950 text-crimson-300">
                            <Bot className="h-4 w-4" />
                          </div>
                        )}
                        <div
                          className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                            m.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-card border border-border/40'
                          }`}
                        >
                          <div className="whitespace-pre-wrap break-words">{m.content}</div>
                          {m.role === 'assistant' && m.citations && (
                            <div className="mt-2 border-t border-border/40 pt-1.5">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Citations
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {(() => {
                                  try {
                                    const arr = JSON.parse(m.citations) as string[]
                                    return arr.slice(0, 5).map((c, i) => (
                                      <Badge key={i} variant="outline" className="font-mono text-[9px]">
                                        [EVID:{c.slice(-6)}]
                                      </Badge>
                                    ))
                                  } catch {
                                    return null
                                  }
                                })()}
                              </div>
                            </div>
                          )}
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {formatDateTime(m.createdAt)}
                          </div>
                        </div>
                        {m.role === 'user' && (
                          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <User className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    ))}
                    {sending && (
                      <div className="flex gap-3">
                        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-crimson-950 text-crimson-300">
                          <Bot className="h-4 w-4" />
                        </div>
                        <div className="rounded-lg border border-border/40 bg-card px-3 py-2">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-crimson-400" />
                            Routing query (deterministic first)…
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Quick prompts */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => send(q)}
                    disabled={sending}
                    className="rounded-full border border-border/40 bg-muted/20 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>

              {/* Composer */}
              <div className="mt-3 flex gap-2">
                <Select value={mode} onValueChange={(v) => setMode(v as 'standard' | 'smart' | 'deep')}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="smart">Smart</SelectItem>
                    <SelectItem value="deep">Deep</SelectItem>
                  </SelectContent>
                </Select>
                <Textarea
                  placeholder="Ask anything about this case… (Enter to send, Shift+Enter for newline)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  className="min-h-[40px] flex-1 resize-none"
                  disabled={sending}
                />
                <Button onClick={() => send()} disabled={sending || !input.trim()} size="icon">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Equivalence tab ── */}
        <TabsContent value="equivalence">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Scale className="h-4 w-4 text-amber-400" />
                Local-AI / Gemini Equivalence Mode
              </CardTitle>
              <CardDescription className="text-[11px]">
                The exact same investigation prompt is sent to the local AI and Gemini. Compare answers,
                citations, latency and evidence grounding — turning the product into an AI evaluation platform.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={3}
                value={eqPrompt}
                onChange={(e) => setEqPrompt(e.target.value)}
                placeholder="Investigation prompt to test…"
                className="text-xs"
              />
              <div className="flex items-center gap-2">
                <Button onClick={() => void runEquivalence()} disabled={eqRunning || !eqPrompt.trim()} size="sm">
                  {eqRunning ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Running both backends…
                    </>
                  ) : (
                    <>
                      <Scale className="mr-2 h-3.5 w-3.5" />
                      Run equivalence test
                    </>
                  )}
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  Gemini requires GEMINI_API_KEY in .env; local AI requires the Ollama server.
                </span>
              </div>

              {eqResult && (
                <>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {/* Local AI */}
                    <div className={`rounded-lg border p-3 ${eqResult.local.available ? 'border-crimson-800/50' : 'border-border/40 opacity-80'}`}>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-crimson-700 text-crimson-300">
                          <Bot className="mr-1 h-3 w-3" />
                          Local AI
                        </Badge>
                        <span className="font-mono text-[10px] text-muted-foreground">{eqResult.local.model}</span>
                        <Badge variant="outline" className="ml-auto font-mono text-[9px]">
                          {eqResult.local.latencyMs} ms · {eqResult.local.answer.length} chars
                        </Badge>
                      </div>
                      {!eqResult.local.available && eqResult.local.error && (
                        <div className="mb-2 rounded bg-amber-950/30 p-1.5 text-[10px] text-amber-300">
                          {eqResult.local.error}
                          {eqResult.local.usedFallback ? ' — served deterministic fallback.' : ''}
                        </div>
                      )}
                      <ScrollArea className="max-h-72">
                        <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                          {eqResult.local.answer || '(no answer)'}
                        </div>
                      </ScrollArea>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {eqResult.local.citations.map((c) => (
                          <Badge key={c} variant="outline" className="font-mono text-[9px]">
                            [EVID:{c.slice(-6)}]
                          </Badge>
                        ))}
                        {eqResult.local.citations.length === 0 && (
                          <span className="text-[10px] text-muted-foreground">no evidence citations</span>
                        )}
                      </div>
                    </div>

                    {/* Gemini */}
                    <div className={`rounded-lg border p-3 ${eqResult.gemini.available ? 'border-sky-800/50' : 'border-border/40 opacity-80'}`}>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-sky-700 text-sky-300">
                          <Sparkles className="mr-1 h-3 w-3" />
                          Gemini
                        </Badge>
                        <span className="font-mono text-[10px] text-muted-foreground">{eqResult.gemini.model}</span>
                        <Badge variant="outline" className="ml-auto font-mono text-[9px]">
                          {eqResult.gemini.latencyMs} ms · {eqResult.gemini.answer.length} chars
                        </Badge>
                      </div>
                      {!eqResult.gemini.available && eqResult.gemini.error && (
                        <div className="mb-2 rounded bg-amber-950/30 p-1.5 text-[10px] text-amber-300">
                          {eqResult.gemini.error}
                        </div>
                      )}
                      <ScrollArea className="max-h-72">
                        <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                          {eqResult.gemini.answer || '(no answer)'}
                        </div>
                      </ScrollArea>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {eqResult.gemini.citations.map((c) => (
                          <Badge key={c} variant="outline" className="font-mono text-[9px]">
                            [EVID:{c.slice(-6)}]
                          </Badge>
                        ))}
                        {eqResult.gemini.citations.length === 0 && (
                          <span className="text-[10px] text-muted-foreground">no evidence citations</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Comparison metrics */}
                  <div className="rounded-lg border border-border/40 bg-muted/10 p-3 text-[11px]">
                    <div className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                      Comparison
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                      <span>local latency: <b className="text-foreground">{eqResult.comparison.localLatencyMs} ms</b></span>
                      <span>gemini latency: <b className="text-foreground">{eqResult.comparison.geminiLatencyMs} ms</b></span>
                      <span>shared evidence citations: <b className="text-foreground">{eqResult.comparison.overlapCitations.length}</b></span>
                      <span>answer length: <b className="text-foreground">{eqResult.comparison.localChars} vs {eqResult.comparison.geminiChars} chars</b></span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Grounding note: both models receive the identical triple-grounded context. Cited evidence ids
                      [EVID:*] that appear in an answer count as grounded citations; anything asserted without a
                      citation from this case&apos;s context should be treated as a potential hallucination.
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
