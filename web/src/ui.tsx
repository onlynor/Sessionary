import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { ContextMenu, type MenuItem } from './ContextMenu'
import type { ConfirmSpec } from './Confirm'
import type { PromptSpec } from './Prompt'
import { Icon } from './Icon'
import { go } from './route'
import type { Machine } from './types'

/** Toasts and confirmations, available to every page without passing them down. */
export const UiContext = createContext<{ say: (text: string, undo?: () => void) => void; confirm: (c: ConfirmSpec) => void; prompt: (p: PromptSpec) => void }>({ say: () => {}, confirm: () => {}, prompt: () => {} })
export const useUi = () => useContext(UiContext)

// ---------- formatting ----------
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
export function fmtUptime(sec?: number): string {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d ? t('{d}d {h}h', { d, h }) : h ? t('{h}h {m}m', { h, m }) : t('{m}m', { m })
}
/** `user@host`, the address, or "this computer" */
export const machineTarget = (m: Pick<Machine, 'kind' | 'host' | 'user' | 'url'>) => (m.kind === 'url' ? m.url ?? '' : m.kind === 'local' ? t('This computer') : `${m.user ? `${m.user}@` : ''}${m.host ?? ''}`)

// ---------- state ----------
export const STATE_LABEL: Record<Machine['state'], string> = { offline: 'Offline', connecting: 'Connecting…', online: 'Online', error: 'Connection failed' }

export function StateBadge({ state }: { state: Machine['state'] }) {
  useT()
  return <span className={`node-state ns-${state}`}>{state === 'connecting' ? <span className="spinner" /> : <span className="dot" />}{t(STATE_LABEL[state])}</span>
}
export const StatusDot = ({ state }: { state: Machine['state'] }) => <span className={`sdot sd-${state}`} aria-hidden="true" />

/** A machine's picture: a laptop for this computer, a server for every node. */
export function MachineIcon({ machine, size = 40 }: { machine: Pick<Machine, 'kind'>; size?: number }) {
  return <span className={`machine-tile ${machine.kind === 'local' ? 'is-local' : ''}`} style={{ width: size, height: size }}><Icon name={machine.kind === 'local' ? 'laptop' : 'server'} size={Math.round(size * 0.5)} stroke={1.5} /></span>
}

// ---------- meters ----------
const tone = (v: number) => (v >= 90 ? 'hot' : v >= 70 ? 'warm' : 'ok')

/** A ring with the number inside, for the handful of figures that matter at a glance */
export function Gauge({ label, value, sub }: { label: string; value?: number; sub?: string }) {
  const r = 24, c = 2 * Math.PI * r
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className="gauge" title={sub}>
      <svg width="62" height="62" viewBox="0 0 62 62" aria-hidden="true">
        <circle cx="31" cy="31" r={r} className="g-track" />
        {value != null && <circle cx="31" cy="31" r={r} className={`g-fill ${tone(v)}`} strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 31 31)" />}
        <text x="31" y="35" textAnchor="middle" className="g-num">{value == null ? '—' : `${Math.round(v)}%`}</text>
      </svg>
      <span className="g-label">{label}</span>
      {sub && <span className="g-sub">{sub}</span>}
    </div>
  )
}

export function Bar({ value }: { value: number }) {
  return <span className="bar"><span className={`bar-fill ${tone(value)}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>
}

/** a short history as a line; `max` fixes the scale so a quiet machine does not look busy */
export function Spark({ values, max = 100, label }: { values: (number | undefined)[]; max?: number; label?: string }) {
  const pts = values.map((v, i) => (v == null ? null : [i, v] as const)).filter((p): p is readonly [number, number] => !!p)
  const w = 160, h = 40
  const n = Math.max(values.length - 1, 1)
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * w).toFixed(1)} ${(h - 2 - (Math.min(v, max) / max) * (h - 4)).toFixed(1)}`).join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {pts.length > 1 && <path d={`${d} L${((pts[pts.length - 1]![0] / n) * w).toFixed(1)} ${h} L${((pts[0]![0] / n) * w).toFixed(1)} ${h} Z`} className="spark-area" />}
      {pts.length > 1 && <path d={d} className="spark-line" />}
    </svg>
  )
}

// ---------- navigation pieces ----------
export interface Crumb { label: string; href?: string; icon?: React.ReactNode }

/** Machine / Agent / Project / Session: where this page sits, each part a way back up */
export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="crumbs" aria-label="breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="crumb-item">
          {i > 0 && <Icon name="chev" size={11} />}
          {c.href && i < items.length - 1 ? <a href={c.href} className="crumb-link">{c.icon}{c.label}</a> : <span className="crumb-here" aria-current={i === items.length - 1 ? 'page' : undefined}>{c.icon}{c.label}</span>}
        </span>
      ))}
    </nav>
  )
}

/** The same top of every page: the way back up, then the title and its actions */
export function PageHead({ crumbs, children }: { crumbs: Crumb[]; children?: React.ReactNode }) {
  return (
    <header className="page-head">
      <Crumbs items={crumbs} />
      {children}
    </header>
  )
}

export function Tabs({ tabs, current }: { tabs: { id: string; label: string; href: string; count?: number; icon?: string }[]; current: string }) {
  useT()
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((x) => (
        <a key={x.id} role="tab" aria-selected={x.id === current} className={`tab ${x.id === current ? 'on' : ''}`} href={x.href}>
          {x.icon && <Icon name={x.icon} size={14} />}{x.label}{x.count != null && <span className="tab-count">{x.count}</span>}
        </a>
      ))}
    </nav>
  )
}

/** the "⋯" of a row or a header */
export function MoreMenu({ items, label, className = 'btn icon' }: { items: (MenuItem | '-')[]; label?: string; className?: string }) {
  useT()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button className={`${className} ${at ? 'on' : ''}`} aria-label={label ?? t('More actions')} title={label ?? t('More actions')} aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: Math.max(8, r.right - 220), y: r.bottom + 6 }) }}>
        <Icon name="more" size={16} />
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}
    </>
  )
}

/** A command to copy, shown as it would be typed */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  useT()
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked */ }
  }
  return (
    <div className="code node-code">
      <div className="code-head"><span>{label}</span><button onClick={copy}>{done ? t('Copied') : t('Copy')}</button></div>
      <pre>{code}</pre>
    </div>
  )
}

/** what a node is copying, in words: "Copying history… 410 MB of 1.2 GB" */
export function syncText(m: Machine): string | undefined {
  const s = m.sync
  if (!s || s.phase === 'idle') return m.state === 'connecting' ? t('Looking at the node…') : undefined
  if (s.phase === 'listing') return t('Looking at the node…')
  return s.bytesTotal ? t('Copying history… {done} of {total}', { done: fmtBytes(s.bytesDone), total: fmtBytes(s.bytesTotal) }) : t('Copying {n} files from the node…', { n: s.pending })
}

/** shown instead of a page whose machine is not connected */
export function OfflinePanel({ machine, busy, onConnect }: { machine: Machine; busy?: boolean; onConnect: () => void }) {
  useT()
  const msg = machine.state === 'connecting' ? (syncText(machine) ?? t('Connecting…')) : undefined
  return (
    <div className="empty-state offline-panel">
      <span className="tile"><Icon name="server" size={28} stroke={1.5} /></span>
      {msg ? <><span className="spinner" />{msg}</> : (
        <>
          <b>{machine.state === 'error' ? t('Could not connect') : t('This node is not connected.')}</b>
          {machine.error && <span className="offline-why">{machine.error}</span>}
          <button className="btn primary" disabled={busy} onClick={onConnect}>{machine.state === 'error' ? t('Reconnect') : t('Connect')}</button>
        </>
      )}
    </div>
  )
}

/** focuses an element when it appears; used by inline editors */
export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => { ref.current?.focus(); (ref.current as unknown as HTMLInputElement | null)?.select?.() }, [])
  return ref
}

export const open = (h: string) => (e?: React.MouseEvent) => { e?.preventDefault(); go(h) }
