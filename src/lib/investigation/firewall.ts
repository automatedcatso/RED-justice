/**
 * firewall.ts — Case-Scoped GraphRAG Firewall.
 *
 * The retrieval layer itself enforces case boundaries BEFORE vector or graph
 * retrieval is used. Every context-building query in the AI / RAG path must
 * go through these helpers:
 *
 *   1. `scopedWhere(caseId)` — wraps a Prisma WHERE so the case predicate is
 *      always ANDed (defence in depth against a forgotten `caseId` filter).
 *   2. `filterScoped(caseId, rows)` — post-filters an already-fetched row set,
 *      counting and reporting every row that belonged to another case. Those
 *      rows are dropped and logged — they can never reach the prompt.
 *   3. `summariseFirewall()` — the structured result embedded in AI responses
 *      so the UI can display "firewall: enforced, N cross-case rows blocked".
 *
 * This makes cross-case context leakage a *measured, visible* event instead
 * of an invisible accident.
 */

export interface FirewallReport {
  enforced: boolean
  caseId: string
  checked: Record<string, number>
  blocked: Record<string, number>
  blockedSamples: string[]
}

interface ScopedRow {
  caseId?: string | null
  id?: string
}

/** AND a case predicate into any Prisma where-clause. */
export function scopedWhere<T extends object>(caseId: string, where: T = {} as T): T & { caseId: string } {
  return { ...(where as object), caseId } as T & { caseId: string }
}

/** Create an empty firewall report for a case. */
export function newFirewallReport(caseId: string): FirewallReport {
  return { enforced: true, caseId, checked: {}, blocked: {}, blockedSamples: [] }
}

/**
 * Post-filter a row set to the active case. Any row whose caseId differs from
 * the active case is blocked, counted, and sampled (max 5) for the audit log.
 * Returns only the rows that passed the firewall.
 */
export function filterScoped<T extends ScopedRow>(
  report: FirewallReport,
  entityName: string,
  caseId: string,
  rows: T[],
): T[] {
  report.checked[entityName] = (report.checked[entityName] ?? 0) + rows.length
  const passed: T[] = []
  for (const row of rows) {
    if (row.caseId && row.caseId !== caseId) {
      report.blocked[entityName] = (report.blocked[entityName] ?? 0) + 1
      if (report.blockedSamples.length < 5) {
        report.blockedSamples.push(`${entityName}:${row.id ?? 'unknown'} (case ${row.caseId})`)
      }
      continue
    }
    passed.push(row)
  }
  return passed
}

/** Merge per-stage reports into one summary. */
export function summariseFirewall(report: FirewallReport): {
  enforced: boolean
  caseId: string
  totalChecked: number
  totalBlocked: number
  blockedSamples: string[]
} {
  const totalChecked = Object.values(report.checked).reduce((a, b) => a + b, 0)
  const totalBlocked = Object.values(report.blocked).reduce((a, b) => a + b, 0)
  return {
    enforced: report.enforced,
    caseId: report.caseId,
    totalChecked,
    totalBlocked,
    blockedSamples: report.blockedSamples,
  }
}

/** Runtime guard: ensures a retrieval where-clause always carries caseId. */
export function assertCaseScoped(where: Record<string, unknown>): boolean {
  return 'caseId' in where && typeof where.caseId === 'string'
}
