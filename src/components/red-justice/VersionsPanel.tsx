'use client'

/**
 * VersionsPanel — immutable evidence version chain UI (architecture §2).
 *
 * Shows EV-xxx:v1..vN with sha256, size, note and supersede relationships,
 * and lets the investigator submit a NEW VERSION of the file: never an
 * overwrite — the current content is preserved as v(n) and the upload becomes
 * v(n+1) with its own hash + custody event. Derived intelligence must be
 * re-scanned afterwards (status resets to pending).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileUp, GitCommitVertical, Loader2, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api, type EvidenceVersionRow } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface Props {
  caseId: string
  evidenceId: string
  onChanged?: () => void
}

export function VersionsPanel({ caseId, evidenceId, onChanged }: Props) {
  const [evRef, setEvRef] = useState<string>('EV')
  const [versions, setVersions] = useState<EvidenceVersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [note, setNote] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await api.evidenceVersions(caseId, evidenceId)
      setEvRef(d.evRef)
      setVersions(d.versions)
    } catch (e) {
      // A clean case with no supersedes yet returns zero rows — not an error.
      const msg = e instanceof Error ? e.message : 'failed to load versions'
      setError(/404|not found/i.test(msg) ? null : msg)
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [caseId, evidenceId])

  useEffect(() => {
    void load()
  }, [load])

  const handleUpload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const res = await api.supersedeEvidenceVersion(caseId, evidenceId, file, note || undefined)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setNote('')
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'supersede failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      {/* Supersede composer */}
      <div className="rounded-md border border-border/40 bg-muted/10 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium">
          <GitCommitVertical className="h-3.5 w-3.5 text-violet-400" />
          Submit a corrected / updated version
          <span className="ml-auto rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300">
            supersede · never overwrite
          </span>
        </div>
        <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
          The current file stays intact as <span className="font-mono">{evRef}:v{Math.max(1, versions.length)}</span>.
          The upload becomes <span className="font-mono">{evRef}:v{versions.length + 1}</span> with its own
          SHA-256 and a chain-of-custody entry; re-scan it afterwards.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason for the new version (e.g. page 7 corrected)"
            className="h-8 min-w-[200px] flex-1 text-xs"
          />
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleUpload(f)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <>
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Superseding…
              </>
            ) : (
              <>
                <FileUp className="mr-1.5 h-3 w-3" /> Choose file…
              </>
            )}
          </Button>
        </div>
        {error && <div className="mt-2 text-[11px] text-destructive">{error}</div>}
      </div>

      {/* Version chain */}
      {loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading chain…
        </div>
      ) : versions.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-[11px] text-muted-foreground">
          <ShieldCheck className="mx-auto mb-1 h-5 w-5 opacity-40" />
          Original ingest only ({versions.length === 0 ? 'v1 unmaterialised' : ''}) — no supersessions yet.
          The current sha256 IS the version record until a replacement is submitted.
        </div>
      ) : (
        <ScrollArea className="max-h-64">
          <ol className="relative space-y-2 border-l border-border/50 pl-4">
            {[...versions].reverse().map((v) => (
              <li key={v.id} className="relative">
                <span
                  className={cn(
                    'absolute -left-[21px] top-2 size-2 rounded-full ring-4 ring-background',
                    v.current ? 'bg-emerald-400' : 'bg-muted-foreground/30',
                  )}
                />
                <div
                  className={cn(
                    'rounded-md border p-2',
                    v.current ? 'border-emerald-800/40 bg-emerald-950/10' : 'border-border/40',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold">{v.ref}</span>
                    {v.current && (
                      <Badge className="bg-emerald-500/15 px-1.5 py-0 text-[9px] text-emerald-400">current</Badge>
                    )}
                    {!v.current && v.supersedesId == null && v.version === 1 && (
                      <Badge variant="outline" className="px-1 py-0 text-[9px]">original</Badge>
                    )}
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={v.sha256}>
                    sha256 {v.sha256.slice(0, 16)}… · {(v.size / 1024).toFixed(1)} KB · by {v.createdBy}
                  </div>
                  {v.note && <div className="mt-0.5 text-[10.5px] italic text-muted-foreground">“{v.note}”</div>}
                </div>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}
