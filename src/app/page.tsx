'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard,
  FolderOpen,
  FileSearch,
  Boxes,
  GitMerge,
  Network,
  Banknote,
  Calendar,
  Users,
  AlertTriangle,
  ShieldAlert,
  Bot,
  FileText,
  Search,
  Activity,
  ChevronRight,
  ChevronDown,
  Loader2,
  X,
  Menu,
  StickyNote,
  Settings,
  Lightbulb,
  FlaskConical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/toaster'
import { useToast } from '@/hooks/use-toast'
import { api, type Case, type Evidence, type Entity, type Transaction, type Finding } from '@/lib/api-client'
import { DashboardView } from '@/components/red-justice/DashboardView'
import { CasesView } from '@/components/red-justice/CasesView'
import { EvidenceView } from '@/components/red-justice/EvidenceView'
import { EntitiesView } from '@/components/red-justice/EntitiesView'
import { NetworkView } from '@/components/red-justice/NetworkView'
import { TransactionsView } from '@/components/red-justice/TransactionsView'
import { TimelineView } from '@/components/red-justice/TimelineView'
import { CommunitiesView } from '@/components/red-justice/CommunitiesView'
import { PatternsView } from '@/components/red-justice/PatternsView'
import { ActorsView } from '@/components/red-justice/ActorsView'
import { AiInvestigatorView } from '@/components/red-justice/AiInvestigatorView'
import { ReportsView } from '@/components/red-justice/ReportsView'
import { EntityResolutionView } from '@/components/red-justice/EntityResolutionView'
import { CaseSettingsView } from '@/components/red-justice/CaseSettingsView'
import { NotesView } from '@/components/red-justice/NotesView'
import { AnomaliesView } from '@/components/red-justice/AnomaliesView'
import { HypothesesView } from '@/components/red-justice/HypothesesView'
import { cn } from '@/lib/utils'

type Section =
  | 'dashboard'
  | 'cases'
  | 'evidence'
  | 'entities'
  | 'resolution'
  | 'network'
  | 'transactions'
  | 'timeline'
  | 'communities'
  | 'patterns'
  | 'actors'
  | 'anomalies'
  | 'ai'
  | 'hypotheses'
  | 'reports'
  | 'notes'
  | 'settings'
  | 'search'

interface NavItem {
  id: Section
  label: string
  icon: React.ReactNode
  description: string
  requiresCase: boolean
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

/**
 * Grouped navigation — 18 sections folded into 5 collapsible groups so the
 * sidebar reads as a short list instead of a wall of labelled cards.
 * Per-item descriptions live in tooltips / the breadcrumb only.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" />, description: 'Overview', requiresCase: false },
      { id: 'cases', label: 'Cases', icon: <FolderOpen className="h-4 w-4" />, description: 'Case management', requiresCase: false },
    ],
  },
  {
    id: 'evidence-entities',
    label: 'Evidence & Entities',
    items: [
      { id: 'evidence', label: 'Evidence', icon: <FileSearch className="h-4 w-4" />, description: 'Evidence vault', requiresCase: true },
      { id: 'entities', label: 'Entities', icon: <Boxes className="h-4 w-4" />, description: 'Entity intelligence', requiresCase: true },
      { id: 'resolution', label: 'Resolution', icon: <GitMerge className="h-4 w-4" />, description: 'Entity resolution', requiresCase: true },
      { id: 'search', label: 'Search', icon: <Search className="h-4 w-4" />, description: 'Cross-evidence search', requiresCase: true },
    ],
  },
  {
    id: 'graph-intelligence',
    label: 'Graph Intelligence',
    items: [
      { id: 'network', label: 'Network', icon: <Network className="h-4 w-4" />, description: 'Knowledge graph', requiresCase: true },
      { id: 'transactions', label: 'Transactions', icon: <Banknote className="h-4 w-4" />, description: 'Money flow', requiresCase: true },
      { id: 'timeline', label: 'Timeline', icon: <Calendar className="h-4 w-4" />, description: 'Chronological events', requiresCase: true },
      { id: 'communities', label: 'Communities', icon: <Users className="h-4 w-4" />, description: 'Community intelligence', requiresCase: true },
    ],
  },
  {
    id: 'ai-findings',
    label: 'AI & Findings',
    items: [
      { id: 'ai', label: 'AI Investigator', icon: <Bot className="h-4 w-4" />, description: 'Graph + RAG Q&A', requiresCase: true },
      { id: 'hypotheses', label: 'Hypotheses', icon: <Lightbulb className="h-4 w-4" />, description: 'Investigation hypotheses', requiresCase: true },
      { id: 'patterns', label: 'Patterns', icon: <AlertTriangle className="h-4 w-4" />, description: 'Suspicious findings', requiresCase: true },
      { id: 'anomalies', label: 'Anomalies', icon: <Activity className="h-4 w-4" />, description: 'Graph anomaly detection', requiresCase: true },
      { id: 'actors', label: 'Actors', icon: <ShieldAlert className="h-4 w-4" />, description: 'Risk prioritization', requiresCase: true },
    ],
  },
  {
    id: 'output',
    label: 'Output',
    items: [
      { id: 'reports', label: 'Reports', icon: <FileText className="h-4 w-4" />, description: 'Investigation reports', requiresCase: true },
      { id: 'notes', label: 'Notes', icon: <StickyNote className="h-4 w-4" />, description: 'Investigator notes', requiresCase: true },
      { id: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" />, description: 'Case export / import', requiresCase: true },
    ],
  },
]

const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

const SIDEBAR_COLLAPSED_KEY = 'rj:sidebar-collapsed'

/** Tiny matchMedia hook so JS nav rendering agrees with the sm: CSS breakpoint. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    onChange()
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export default function Home() {
  const { toast } = useToast()
  const [section, setSection] = useState<Section>('dashboard')
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null)
  const [activeCase, setActiveCase] = useState<Case | null>(null)
  const [globalSearch, setGlobalSearch] = useState('')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [focusEvidenceId, setFocusEvidenceId] = useState<string | null>(null)
  const [aiStatus, setAiStatus] = useState<{ available: boolean; model: string } | null>(null)

  // ── Sidebar collapse (hamburger) ──
  // Desktop (sm+): toggles between the expanded sidebar and an icon-only rail.
  // Persisted in localStorage; default expanded on md+, collapsed on small
  // screens (where navigation is a slide-in drawer anyway).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const isDesktopNav = useMediaQuery('(min-width: 640px)')
  const railMode = isDesktopNav && sidebarCollapsed

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
      if (stored === '1') setSidebarCollapsed(true)
      else if (stored === null && window.innerWidth < 768) setSidebarCollapsed(true)
    } catch {
      // localStorage unavailable — keep expanded default
    }
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore persistence errors
      }
      return next
    })
  }, [])

  // ── Collapsible nav groups ──
  // The group containing the active section auto-expands on navigation.
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(['workspace']),
  )

  const needsCase = NAV.find((n) => n.id === section)?.requiresCase ?? false
  const effectiveSection: Section = needsCase && !activeCaseId ? 'cases' : section

  useEffect(() => {
    const grp = NAV_GROUPS.find((g) => g.items.some((i) => i.id === effectiveSection))
    if (!grp) return
    setOpenGroups((prev) => {
      if (prev.has(grp.id)) return prev
      const next = new Set(prev)
      next.add(grp.id)
      return next
    })
  }, [effectiveSection])

  const toggleGroup = useCallback((groupId: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileNavOpen])

  // Bootstrap: load the most recent case (if any) so the user lands on it.
  const bootstrap = useCallback(async () => {
    try {
      const cases = await api.listCases()
      if (cases.length > 0) {
        setActiveCaseId(cases[0].id)
        setActiveCase(cases[0])
      }
    } catch {
      // silent — UI will show empty state
    } finally {
      setBootstrapped(true)
    }
  }, [])

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  // Live AI provider status (sidebar badge) — the fully-AI pipeline's brain.
  useEffect(() => {
    let cancelled = false
    api
      .systemStatus()
      .then((s) => {
        if (!cancelled) {
          setAiStatus({ available: Boolean(s.aiAvailable), model: s.aiModel || 'ai' })
        }
      })
      .catch(() => {
        if (!cancelled) setAiStatus({ available: false, model: 'ai' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSelectCase = useCallback(async (id: string) => {
    setActiveCaseId(id)
    try {
      setActiveCase(await api.getCase(id))
    } catch {
      // ignore
    }
    setMobileNavOpen(false)
  }, [])

  const handleNavigate = useCallback((s: string) => {
    setSection(s as Section)
    if (s !== 'evidence') setFocusEvidenceId(null)
    setMobileNavOpen(false)
  }, [])

  // Per-edge provenance: open the exact source file of a graph relationship.
  const handleOpenEvidence = useCallback((evidenceId: string) => {
    setFocusEvidenceId(evidenceId)
    setSection('evidence')
    setMobileNavOpen(false)
  }, [])

  const activeNav = NAV.find((n) => n.id === effectiveSection) ?? null
  const activeGroup = useMemo(
    () => NAV_GROUPS.find((g) => g.items.some((i) => i.id === effectiveSection)) ?? null,
    [effectiveSection],
  )

  const navBody = (
    <nav aria-label="Primary" className="flex h-full flex-col gap-1 overflow-y-auto p-2.5">
      {/* Mobile drawer header (close affordance) */}
      <div className="mb-1 flex items-center justify-between sm:hidden">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Navigation
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation menu"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {NAV_GROUPS.map((g) => {
        const open = openGroups.has(g.id)
        return (
          <div key={g.id} className="space-y-0.5">
            {railMode ? (
              <div className="mx-auto my-1.5 h-px w-6 bg-border/60" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(g.id)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <ChevronDown
                  className={`h-3 w-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                  aria-hidden
                />
                <span className="truncate">{g.label}</span>
              </button>
            )}
            {(railMode || open) &&
              g.items.map((n) => {
                const isActive = effectiveSection === n.id
                const disabled = n.requiresCase && !activeCaseId
                return (
                  <button
                    key={n.id}
                    onClick={() => !disabled && handleNavigate(n.id)}
                    disabled={disabled}
                    aria-current={isActive ? 'page' : undefined}
                    title={railMode ? `${n.label} — ${n.description}` : n.label}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                      railMode && 'sm:justify-center sm:px-0 sm:py-2',
                      isActive
                        ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                        : disabled
                          ? 'text-muted-foreground/40'
                          : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground',
                    )}
                  >
                    <span className={cn('shrink-0', isActive && 'text-crimson-400')}>
                      {n.icon}
                    </span>
                    {!railMode && (
                      <>
                        <span className="flex-1 truncate font-medium leading-tight">
                          {n.label}
                        </span>
                        {isActive && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
                      </>
                    )}
                  </button>
                )
              })}
          </div>
        )
      })}

      {/* Benchmark Lab — standalone model/provider comparison console */}
      <a
        href="/benchmark"
        title="Benchmark Lab — compare AI models and providers on investigation tasks"
        className={cn(
          'mt-1 flex items-center gap-2.5 rounded-md border border-crimson-700/50 bg-crimson-950/20 px-2.5 py-1.5 text-sm text-crimson-300 transition-colors hover:bg-crimson-900/30 hover:text-crimson-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-400/60',
          railMode && 'sm:justify-center sm:px-0 sm:py-2',
        )}
      >
        <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
        {!railMode && (
          <span className="truncate font-medium leading-tight">Benchmark Lab</span>
        )}
      </a>

      {/* Compact AI status — one line */}
      <div className="mt-auto pt-2">
        <div
          className="flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/20 px-2 py-1.5 text-[10px]"
          title={
            aiStatus?.available
              ? `AI online · ${aiStatus.model} — scans every upload automatically, grounded in case evidence only`
              : 'AI offline — deterministic analysis still works. AI answers stay grounded in retrieved case evidence only.'
          }
        >
          <Activity
            className={cn(
              'h-3 w-3 shrink-0 text-crimson-400',
              aiStatus?.available && 'pulse-crimson',
            )}
            aria-hidden
          />
          {!railMode && (
            <span className="truncate text-muted-foreground">
              {aiStatus?.available
                ? `AI online · ${aiStatus.model}`
                : aiStatus
                  ? 'AI offline · deterministic mode'
                  : 'AI checking…'}
            </span>
          )}
        </div>
      </div>
    </nav>
  )

  return (
    <div className="flex min-h-screen flex-col bg-background bg-investigation-grid">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
          {/* Hamburger — collapses the desktop sidebar into an icon rail */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden sm:flex"
            onClick={toggleSidebar}
            aria-label={railMode ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
            aria-expanded={!sidebarCollapsed}
            title="Toggle sidebar"
          >
            <Menu className="h-4 w-4" />
          </Button>

          {/* Brand */}
          <button
            onClick={() => setSection('dashboard')}
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <div className="relative">
              <img
                src="/logo-mark.png"
                alt="RED Justice logo"
                className="h-9 w-9 rounded-md border border-border/60 object-cover shadow-lg shadow-crimson-900/30"
              />
              <div className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-background" />
            </div>
            <div className="hidden flex-col sm:flex">
              <span className="text-sm font-bold tracking-wide text-glow-crimson">
                RED JUSTICE
              </span>
              <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                Investigate · Analyze · Connect
              </span>
            </div>
          </button>

          {/* Case selector */}
          {activeCase && (
            <div className="ml-2 hidden items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1 md:flex">
              <FolderOpen className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Case:</span>
              <button
                onClick={() => setSection('cases')}
                className="max-w-[200px] truncate text-xs font-medium hover:text-primary"
                title={activeCase.title}
              >
                {activeCase.title}
              </button>
              <Badge variant="outline" className="ml-1 font-mono text-[9px]">
                {activeCase.uid}
              </Badge>
            </div>
          )}

          {/* Global search */}
          <div className="relative ml-auto hidden sm:block">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search…"
              value={globalSearch}
              onChange={(e) => {
                setGlobalSearch(e.target.value)
                if (activeCaseId && e.target.value.length > 0) setSection('search')
              }}
              onFocus={() => activeCaseId && setSection('search')}
              className="h-8 w-44 pl-8 text-xs lg:w-56"
            />
          </div>

          {/* Status pill */}
          <div className="hidden items-center gap-2 lg:flex">
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-700/40 bg-emerald-950/30 px-2 py-0.5 text-[10px] text-emerald-300">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-crimson" />
              LIVE
            </div>
          </div>

          {/* Mobile hamburger — opens the slide-in navigation drawer */}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto sm:hidden"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={mobileNavOpen}
          >
            <Menu className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex flex-1">
        {/* Sidebar — slide-in drawer on mobile, collapsible rail/expanded on desktop */}
        <aside
          inert={!isDesktopNav && !mobileNavOpen}
          className={cn(
            'fixed inset-y-14 left-0 z-40 w-64 shrink-0 transform border-r border-border/60 bg-background/95 backdrop-blur transition-all duration-200 sm:sticky sm:top-14 sm:z-20 sm:h-[calc(100vh-3.5rem)] sm:translate-x-0 sm:bg-background/60',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
            railMode ? 'sm:w-14' : 'sm:w-60',
          )}
        >
          {navBody}
        </aside>

        {/* Backdrop for mobile drawer */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 top-14 z-30 bg-background/60 backdrop-blur-sm sm:hidden"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
        )}

        {/* Main content */}
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6">
          {!bootstrapped ? (
            <div className="flex h-[60vh] items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-crimson-400" />
                <span className="text-sm">Initializing RED Justice…</span>
              </div>
            </div>
          ) : (
            <>
              {/* Breadcrumb-ish subtitle for the active section */}
              {activeNav && activeGroup && (
                <div className="mb-4 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="uppercase tracking-[0.14em] text-muted-foreground/70">
                    {activeGroup.label}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="font-medium text-foreground/70">{activeNav.label}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate">{activeNav.description}</span>
                </div>
              )}
              {/* Remount on section OR case change so no view keeps stale
                  internal state / data from the previous case. */}
              <div key={`${effectiveSection}-${activeCaseId ?? 'none'}`} className="animate-fade-in-up">
                {effectiveSection === 'dashboard' ? (
                  <DashboardView onNavigate={handleNavigate} activeCaseId={activeCaseId} />
                ) : effectiveSection === 'cases' ? (
                  <CasesView activeCaseId={activeCaseId} onSelectCase={handleSelectCase} />
                ) : effectiveSection === 'evidence' && activeCaseId ? (
                  <EvidenceView caseId={activeCaseId} focusEvidenceId={focusEvidenceId} />
                ) : effectiveSection === 'entities' && activeCaseId ? (
                  <EntitiesView caseId={activeCaseId} />
                ) : effectiveSection === 'resolution' && activeCaseId ? (
                  <EntityResolutionView caseId={activeCaseId} />
                ) : effectiveSection === 'network' && activeCaseId ? (
                  <NetworkView caseId={activeCaseId} onOpenEvidence={handleOpenEvidence} />
                ) : effectiveSection === 'transactions' && activeCaseId ? (
                  <TransactionsView caseId={activeCaseId} />
                ) : effectiveSection === 'timeline' && activeCaseId ? (
                  <TimelineView caseId={activeCaseId} />
                ) : effectiveSection === 'communities' && activeCaseId ? (
                  <CommunitiesView caseId={activeCaseId} />
                ) : effectiveSection === 'patterns' && activeCaseId ? (
                  <PatternsView caseId={activeCaseId} />
                ) : effectiveSection === 'anomalies' && activeCaseId ? (
                  <AnomaliesView caseId={activeCaseId} />
                ) : effectiveSection === 'actors' && activeCaseId ? (
                  <ActorsView caseId={activeCaseId} />
                ) : effectiveSection === 'ai' && activeCaseId ? (
                  <AiInvestigatorView caseId={activeCaseId} />
                ) : effectiveSection === 'hypotheses' && activeCaseId ? (
                  <HypothesesView caseId={activeCaseId} />
                ) : effectiveSection === 'reports' && activeCaseId ? (
                  <ReportsView caseId={activeCaseId} />
                ) : effectiveSection === 'notes' && activeCaseId ? (
                  <NotesView caseId={activeCaseId} />
                ) : effectiveSection === 'settings' && activeCaseId ? (
                  <CaseSettingsView caseId={activeCaseId} activeCase={activeCase} onSelectCase={handleSelectCase} />
                ) : effectiveSection === 'search' && activeCaseId ? (
                  <SearchView caseId={activeCaseId} query={globalSearch} setQuery={setGlobalSearch} />
                ) : null}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Sticky footer */}
      <footer className="mt-auto border-t border-border/60 bg-background/80 backdrop-blur">
        <div className="flex h-10 items-center justify-between px-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="font-mono">RED Justice v1.0</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">AI-Powered Criminal Network Analysis</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">Local-first · Evidence-grounded</span>
            <span className="hidden sm:inline">·</span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Offline-capable
            </span>
          </div>
        </div>
      </footer>

      <Toaster />
    </div>
  )
}

// Inline search view (uses api.search)
function SearchView({
  caseId,
  query,
  setQuery,
}: {
  caseId: string
  query: string
  setQuery: (q: string) => void
}) {
  const [results, setResults] = useState<{
    evidence: Evidence[]
    entities: Entity[]
    transactions: Transaction[]
    communications: unknown[]
    findings: Finding[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqRef = useRef<{ cancelled: boolean } | null>(null)

  const runSearch = useCallback(
    async (q: string) => {
      // cancel any in-flight request
      if (reqRef.current) reqRef.current.cancelled = true
      const trimmed = q.trim()
      if (!trimmed) {
        setResults(null)
        setError(null)
        setLoading(false)
        return
      }
      const handle = { cancelled: false }
      reqRef.current = handle
      setLoading(true)
      setError(null)
      try {
        const r = await api.search(caseId, trimmed)
        if (!handle.cancelled) setResults(r)
      } catch (e) {
        if (!handle.cancelled)
          setError(e instanceof Error ? e.message : 'search failed')
      } finally {
        if (!handle.cancelled) setLoading(false)
      }
    },
    [caseId],
  )

  // Debounced search on query change.
  useEffect(() => {
    const t = setTimeout(() => {
      void runSearch(query)
    }, 250)
    return () => clearTimeout(t)
  }, [query, runSearch])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
          Cross-Evidence Search
        </h2>
        <p className="text-sm text-muted-foreground">
          Search across evidence, entities, transactions, communications, and findings.
        </p>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          placeholder="Search by name, account, UPI, phone, amount, UTR…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!query.trim() ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Type a query to begin searching across all evidence in this case.
        </div>
      ) : loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
          Searching…
        </div>
      ) : results ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <SearchResultCard title="Entities" count={results.entities.length} items={results.entities.map((e) => ({ primary: e.value, secondary: e.type + (e.label ? ` · ${e.label}` : '') }))} />
          <SearchResultCard title="Evidence" count={results.evidence.length} items={results.evidence.map((e) => ({ primary: e.originalName, secondary: e.description ?? '' }))} />
          <SearchResultCard title="Transactions" count={results.transactions.length} items={results.transactions.map((t) => ({ primary: `${t.utr ?? t.senderAccount ?? '?'} → ${t.receiverAccount ?? '?'}`, secondary: `₹${t.amount ?? 0}` }))} />
          <SearchResultCard title="Findings" count={results.findings.length} items={results.findings.map((f) => ({ primary: f.description, secondary: `${f.type} · ${f.severity}` }))} />
        </div>
      ) : null}
    </div>
  )
}

function SearchResultCard({
  title,
  count,
  items,
}: {
  title: string
  count: number
  items: Array<{ primary: string; secondary: string }>
}) {
  return (
    <div className="rounded-md border border-border/40 bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge variant="outline" className="font-mono text-[10px]">
          {count}
        </Badge>
      </div>
      {items.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">No matches.</div>
      ) : (
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {items.slice(0, 15).map((it, i) => (
            <div
              key={i}
              className="rounded border border-border/40 bg-muted/10 px-2 py-1.5"
            >
              <div className="truncate text-xs font-medium">{it.primary}</div>
              <div className="truncate text-[10px] text-muted-foreground">{it.secondary}</div>
            </div>
          ))}
          {items.length > 15 && (
            <div className="pt-1 text-center text-[10px] text-muted-foreground">
              +{items.length - 15} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}
