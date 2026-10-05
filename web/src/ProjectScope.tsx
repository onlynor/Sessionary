import { useEffect, useMemo, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { relTime } from './format'
import { Icon } from './Icon'
import type { SessionSummary } from './types'

export const NO_PROJECT = '~none'
export const projectKey = (s: SessionSummary) => (s.project.generic ? NO_PROJECT : s.project.key)

interface Proj { key: string; name: string; count: number; last: number; missing: boolean }

/**
 * Project is a filter on the current agent's sessions, not a tree: most projects hold a single session.
 * The pop-up lists recent projects first, keeps "No project" pinned below them, and searches the rest.
 */
export function ProjectScope({ sessions, value, onChange }: { sessions: SessionSummary[]; value: string | null; onChange: (key: string | null) => void }) {
  useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const projects = useMemo(() => {
    const m = new Map<string, Proj>()
    for (const s of sessions) {
      const k = projectKey(s)
      const p = m.get(k) ?? m.set(k, { key: k, name: k === NO_PROJECT ? t('No project') : s.project.name, count: 0, last: 0, missing: !s.project.exists && k !== NO_PROJECT }).get(k)!
      p.count++
      p.last = Math.max(p.last, s.updatedAt)
    }
    return [...m.values()].sort((a, b) => Number(a.missing) - Number(b.missing) || b.last - a.last)
  }, [sessions])
  const none = projects.find((p) => p.key === NO_PROJECT)
  const named = projects.filter((p) => p.key !== NO_PROJECT)
  const filtered = q ? named.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : named
  const shown = all || q ? filtered : filtered.slice(0, 7)
  const current = projects.find((p) => p.key === value)

  useEffect(() => {
    if (!open) { setQ(''); setAll(false); return }
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', off); addEventListener('keydown', key)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key) }
  }, [open])

  const pick = (k: string | null) => { onChange(k); setOpen(false) }
  const row = (p: Proj) => (
    <button key={p.key} className="menu-item" onClick={() => pick(p.key)} title={p.missing ? t('Directory no longer exists') : undefined}>
      <Icon name={p.key === NO_PROJECT ? 'message' : 'folder'} />
      <span className={`grow ellip ${p.missing ? 'gone' : ''}`}>{p.name}</span>
      <span className="menu-meta">{p.count}</span>
      {p.key === value && <span className="check"><Icon name="check" size={14} /></span>}
    </button>
  )

  return (
    <div className="scope" ref={ref}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button className={`nav-i ${value ? 'set' : ''} ${open ? 'pressed' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={t('Filter by project')}>
          <Icon name={value ? 'folder-open' : 'folder'} />
          <span className="grow ellip">{current ? current.name : t('All projects')}</span>
          {current ? <span className="meta">{current.count}</span> : <Icon name="updown" size={14} />}
        </button>
        {value && <button className="tb-btn" onClick={() => onChange(null)} aria-label={t('Show all projects')} title={t('Show all projects')}><Icon name="x" size={14} /></button>}
      </div>
      {open && (
        <div className="menu pop-in scope-menu" role="menu">
          {projects.length > 8 && (
            <div className="menu-search"><Icon name="search" size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find a project')} aria-label={t('Find a project')} /></div>
          )}
          {!q && (
            <button className="menu-item" onClick={() => pick(null)}>
              <Icon name="layers" /><span className="grow">{t('All projects')}</span><span className="menu-meta">{sessions.length}</span>{value == null && <span className="check"><Icon name="check" size={14} /></span>}
            </button>
          )}
          <div className="menu-label">{q ? t('Matches') : t('Recent projects')}</div>
          {shown.map(row)}
          {!q && !all && filtered.length > shown.length && <button className="menu-item quiet" onClick={() => setAll(true)}><span className="grow">{t('Show all {n}', { n: filtered.length })}</span></button>}
          {!q && none && <><div className="menu-sep" />{row(none)}</>}
          {q && !shown.length && <div className="menu-empty">{t('No project matches.')}</div>}
        </div>
      )}
    </div>
  )
}
