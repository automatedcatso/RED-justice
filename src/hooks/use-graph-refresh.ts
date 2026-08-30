'use client'

import { useEffect, useRef } from 'react'

/**
 * use-graph-refresh.ts — shared graph-change pub/sub.
 *
 * Problem it fixes: the automatic AI scan pipeline (EvidenceView) only told
 * NetworkGraph when new entities/relationships landed, so every other view
 * (Dashboard, Entities, Patterns, Actors, …) kept rendering stale data until
 * it was manually re-mounted. This hook gives every data view a one-liner
 * subscription; `notifyGraphUpdated()` is the single dispatch helper used by
 * producers (AI queue drain, entity merges, finding decisions, …).
 */

export const GRAPH_UPDATED_EVENT = 'rj:graph-updated'

/**
 * Notify every mounted view that graph-adjacent data changed
 * (entities, relationships, findings, case counts, …).
 * Safe on the server (no-op).
 */
export function notifyGraphUpdated(detail?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GRAPH_UPDATED_EVENT, { detail }))
}

/**
 * Subscribe to graph-change notifications for the lifetime of the component.
 *
 * The callback is stored in a ref that is refreshed after every commit, so
 * callers can pass an inline closure (e.g. `() => void load()`) without
 * capturing a stale `load` from the first render.
 */
export function useGraphRefresh(callback: () => void): void {
  const cbRef = useRef(callback)
  // Keep the ref pointing at the latest callback (after each commit) so
  // listeners never fire a stale closure.
  useEffect(() => {
    cbRef.current = callback
  })

  useEffect(() => {
    const handler = (): void => {
      cbRef.current()
    }
    window.addEventListener(GRAPH_UPDATED_EVENT, handler)
    return () => window.removeEventListener(GRAPH_UPDATED_EVENT, handler)
  }, [])
}
