'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  StickyNote,
  Plus,
  Trash2,
  RefreshCw,
  Clock,
  FileText,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useToast } from '@/hooks/use-toast'
import { api } from '@/lib/api-client'
import { formatDateTime, timeAgo } from '@/lib/ui-helpers'
import { useGraphRefresh } from '@/hooks/use-graph-refresh'

interface Props {
  caseId: string
}

interface Note {
  id: string
  body: string
  createdAt: string
}

export function NotesView({ caseId }: Props) {
  const { toast } = useToast()
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newNote, setNewNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setNotes(await api.listNotes(caseId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load notes')
    } finally {
      setLoading(false)
    }
  }, [caseId])

  useEffect(() => {
    load()
  }, [load])

  // Live refresh when the knowledge graph changes (AI scans, merges…).
  useGraphRefresh(() => {
    void load()
  })

  const handleAdd = async () => {
    if (!newNote.trim()) return
    setSaving(true)
    try {
      await api.addNote(caseId, newNote.trim())
      setNewNote('')
      await load()
      toast({ title: 'Note added' })
    } catch (e) {
      toast({
        title: 'Failed to add note',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (noteId: string) => {
    if (!confirm('Delete this note?')) return
    try {
      await api.deleteNote(caseId, noteId)
      await load()
      toast({ title: 'Note deleted' })
    } catch (e) {
      toast({
        title: 'Delete failed',
        description: e instanceof Error ? e.message : 'unknown error',
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-glow-crimson">
            Investigator Notes
          </h2>
          <p className="text-sm text-muted-foreground">
            Free-form investigation notes. Markdown-formatted text is preserved.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="icon">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Compose */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Plus className="h-4 w-4 text-crimson-400" />
            Add a note
          </div>
          <Textarea
            placeholder="Observations, hypotheses, links to evidence, next steps…"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            rows={4}
            className="resize-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {newNote.length} characters · {newNote.split(/\s+/).filter(Boolean).length} words
            </span>
            <Button onClick={handleAdd} disabled={saving || !newNote.trim()} size="sm">
              {saving ? 'Saving…' : 'Save note'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Notes list */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading notes…</div>
      ) : notes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <StickyNote className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No notes yet</p>
              <p className="text-xs text-muted-foreground">
                Use notes to track observations, hypotheses, and investigation progress.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-360px)] pr-3">
          <div className="space-y-2">
            {notes.map((note) => (
              <Card key={note.id} className="group">
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded bg-muted/40 p-1.5">
                      <FileText className="h-3.5 w-3.5 text-crimson-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span title={formatDateTime(note.createdAt)}>
                          {timeAgo(note.createdAt)}
                        </span>
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                        {note.body}
                      </pre>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(note.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
