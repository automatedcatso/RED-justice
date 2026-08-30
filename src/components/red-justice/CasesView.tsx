'use client'

import { useEffect, useState } from 'react'
import {
  FolderOpen,
  Plus,
  Search,
  Sparkles,
  Trash2,
  RefreshCw,
  ChevronRight,
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
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Crosshair } from 'lucide-react'
import { CollisionExplorer } from './CollisionExplorer'
import { api, type Case } from '@/lib/api-client'
import { formatDateTime, timeAgo } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  activeCaseId: string | null
  onSelectCase: (id: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-sky-500/15 text-sky-300 border-sky-700',
  active: 'bg-emerald-500/15 text-emerald-300 border-emerald-700',
  suspended: 'bg-amber-500/15 text-amber-300 border-amber-700',
  review: 'bg-purple-500/15 text-purple-300 border-purple-700',
  closed: 'bg-slate-500/15 text-slate-300 border-slate-700',
  archived: 'bg-slate-700/30 text-slate-400 border-slate-700',
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  unclassified: 'bg-slate-500/10 text-slate-300 border-slate-700',
  confidential: 'bg-amber-500/10 text-amber-300 border-amber-700',
  secret: 'bg-rose-500/10 text-rose-300 border-rose-700',
  topsecret: 'bg-red-700/15 text-red-200 border-red-800',
}

export function CasesView({ activeCaseId, onSelectCase }: Props) {
  const [cases, setCases] = useState<Case[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newClass, setNewClass] = useState('confidential')
  const [newMode, setNewMode] = useState('standard')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setCases(await api.listCases(query))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load cases')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [query])

  // Case cards show live evidence/entity counts — refresh them whenever the
  // graph changes (e.g. the automatic AI scan pipeline drains).
  useGraphRefresh(() => {
    void load()
  })

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    setCreating(true)
    try {
      const c = await api.createCase({
        title: newTitle.trim(),
        description: newDesc.trim() || undefined,
        classification: newClass,
        aiMode: newMode,
      })
      setNewTitle('')
      setNewDesc('')
      await load()
      onSelectCase(c.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    } finally {
      setCreating(false)
    }
  }

  const handleArchive = async (c: Case) => {
    try {
      await api.updateCase(c.id, { status: 'archived' } as Partial<Case>)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive failed')
    }
  }

  return (
    <div className="space-y-4">
      <Tabs defaultValue="cases">
        <TabsList>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="collisions" className="gap-1.5">
            <Crosshair className="h-3.5 w-3.5" />
            Identity Collisions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="cases" className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Case Management
          </h2>
          <p className="text-sm text-muted-foreground">
            Every case is isolated — select one to scope all evidence, entities, and findings.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search cases…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-56 pl-9"
            />
          </div>
          <Button onClick={load} variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New case
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create new case</DialogTitle>
                <DialogDescription>
                  Each case is fully isolated. Evidence, entities, transactions, and findings
                  are scoped to a single case.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    placeholder="Operation Crimson Ledger"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="desc">Description</Label>
                  <Textarea
                    id="desc"
                    placeholder="Synthetic cyber-fraud network investigation…"
                    rows={3}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Classification</Label>
                    <Select value={newClass} onValueChange={setNewClass}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unclassified">Unclassified</SelectItem>
                        <SelectItem value="confidential">Confidential</SelectItem>
                        <SelectItem value="secret">Secret</SelectItem>
                        <SelectItem value="topsecret">Top Secret</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>AI mode</Label>
                    <Select value={newMode} onValueChange={setNewMode}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard (deterministic)</SelectItem>
                        <SelectItem value="smart">Smart (RAG)</SelectItem>
                        <SelectItem value="deep">Deep (full context)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={creating || !newTitle.trim()}>
                  {creating ? 'Creating…' : 'Create case'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading cases…</div>
      ) : cases.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No cases yet</p>
              <p className="text-xs text-muted-foreground">
                Create a new case to begin your investigation.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cases.map((c) => {
            const isActive = c.id === activeCaseId
            return (
              <Card
                key={c.id}
                className={`group relative cursor-pointer overflow-hidden transition-all hover:border-primary/50 ${
                  isActive ? 'border-primary ring-1 ring-primary/40' : ''
                }`}
                onClick={() => onSelectCase(c.id)}
              >
                <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-crimson-600 to-crimson-900 opacity-60" />
                <CardHeader className="pb-2 pl-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">
                        {c.title}
                      </CardTitle>
                      <CardDescription className="font-mono text-[11px]">
                        {c.uid}
                      </CardDescription>
                    </div>
                    {isActive && (
                      <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">
                        Active
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pl-5">
                  {c.description && (
                    <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">
                      {c.description}
                    </p>
                  )}
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${STATUS_COLORS[c.status] ?? STATUS_COLORS.open}`}
                    >
                      {c.status}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[10px] uppercase ${
                        CLASSIFICATION_COLORS[c.classification] ?? CLASSIFICATION_COLORS.unclassified
                      }`}
                    >
                      {c.classification}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      AI: {c.aiMode}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>Updated {timeAgo(c.updatedAt)}</span>
                    <div className="flex items-center gap-1">
                      <span className="font-mono">{formatDateTime(c.createdAt).split(',')[0]}</span>
                      <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleArchive(c)
                      }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Archive
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
        </TabsContent>

        <TabsContent value="collisions">
          <CollisionExplorer onSelectCase={onSelectCase} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
