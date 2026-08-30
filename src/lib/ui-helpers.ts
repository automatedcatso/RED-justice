// Shared UI helpers for RED Justice frontend.

export const ENTITY_TYPE_META: Record<
  string,
  { label: string; color: string; bg: string; icon: string }
> = {
  person: { label: 'Person', color: '#ef4444', bg: 'bg-red-500/10', icon: 'User' },
  organization: { label: 'Organization', color: '#f97316', bg: 'bg-orange-500/10', icon: 'Building2' },
  account: { label: 'Account', color: '#14b8a6', bg: 'bg-teal-500/10', icon: 'Landmark' },
  upi: { label: 'UPI', color: '#06b6d4', bg: 'bg-cyan-500/10', icon: 'AtSign' },
  phone: { label: 'Phone', color: '#84cc16', bg: 'bg-lime-500/10', icon: 'Phone' },
  email: { label: 'Email', color: '#22c55e', bg: 'bg-green-500/10', icon: 'Mail' },
  ip: { label: 'IP', color: '#a855f7', bg: 'bg-purple-500/10', icon: 'Globe' },
  url: { label: 'URL', color: '#ec4899', bg: 'bg-pink-500/10', icon: 'Link' },
  domain: { label: 'Domain', color: '#ec4899', bg: 'bg-pink-500/10', icon: 'Globe' },
  wallet: { label: 'Wallet', color: '#eab308', bg: 'bg-yellow-500/10', icon: 'Wallet' },
  vehicle: { label: 'Vehicle', color: '#64748b', bg: 'bg-slate-500/10', icon: 'Car' },
  date: { label: 'Date', color: '#94a3b8', bg: 'bg-slate-400/10', icon: 'Calendar' },
  amount: { label: 'Amount', color: '#94a3b8', bg: 'bg-slate-400/10', icon: 'IndianRupee' },
  document_id: { label: 'Document ID', color: '#0ea5e9', bg: 'bg-sky-500/10', icon: 'FileText' },
  ifsc: { label: 'IFSC', color: '#10b981', bg: 'bg-emerald-500/10', icon: 'Hash' },
  imei: { label: 'IMEI', color: '#8b5cf6', bg: 'bg-violet-500/10', icon: 'Smartphone' },
  mac: { label: 'MAC', color: '#8b5cf6', bg: 'bg-violet-500/10', icon: 'Smartphone' },
  device: { label: 'Device', color: '#8b5cf6', bg: 'bg-violet-500/10', icon: 'Smartphone' },
  social: { label: 'Social', color: '#ec4899', bg: 'bg-pink-500/10', icon: 'Users' },
  address: { label: 'Address', color: '#78716c', bg: 'bg-stone-500/10', icon: 'MapPin' },
  location: { label: 'Location', color: '#78716c', bg: 'bg-stone-500/10', icon: 'MapPin' },
}

export function entityMeta(type: string) {
  return ENTITY_TYPE_META[type] ?? {
    label: type,
    color: '#0ea5e9',
    bg: 'bg-sky-500/10',
    icon: 'Circle',
  }
}

export const SEVERITY_META: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  critical: { label: 'Critical', color: 'text-red-300', bg: 'bg-red-950/60', border: 'border-red-700' },
  high: { label: 'High', color: 'text-rose-300', bg: 'bg-rose-950/60', border: 'border-rose-800' },
  medium: { label: 'Medium', color: 'text-amber-300', bg: 'bg-amber-950/60', border: 'border-amber-800' },
  low: { label: 'Low', color: 'text-sky-300', bg: 'bg-sky-950/60', border: 'border-sky-800' },
  info: { label: 'Info', color: 'text-slate-300', bg: 'bg-slate-900/60', border: 'border-slate-700' },
}

export function severityMeta(s: string) {
  return SEVERITY_META[s] ?? SEVERITY_META.info
}

export const FINDING_TYPE_LABELS: Record<string, string> = {
  HIGH_FAN_IN: 'High Fan-In',
  HIGH_FAN_OUT: 'High Fan-Out',
  CIRCULAR_TXNS: 'Circular Transactions',
  RAPID_HOPPING: 'Rapid Account Hopping',
  SHARED_PHONE: 'Shared Phone',
  SHARED_DEVICE: 'Shared Device',
  SHARED_IP: 'Shared IP',
  TXN_SPIKE: 'Transaction Spike',
  VELOCITY_ANOMALY: 'Velocity Anomaly',
  DORMANT_ACTIVATION: 'Dormant Activation',
  BRIDGE_ENTITY: 'Bridge Entity',
  TIGHT_CLUSTER: 'Tight Cluster',
  TEMPORAL_SYNC: 'Temporal Sync',
}

export function formatINR(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount)
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-IN').format(n)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso).getTime()
    const now = Date.now()
    const diff = Math.floor((now - d) / 1000)
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`
    return formatDate(iso)
  } catch {
    return iso
  }
}

export function parseJsonArray<T = unknown>(s: string | null | undefined): T[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function parseJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return '—'
  return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h
}
