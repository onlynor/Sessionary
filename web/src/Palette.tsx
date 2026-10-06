import { useEffect, useMemo, useRef, useState } from 'react'
import { t, tx, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { useApi } from './machines'
import { relTime } from './format'
import { Snippet } from './Snippet'
import { Icon } from './Icon'
import type { SearchHit, SessionSummary } from './types'

function score(s: SessionSummary, tokens: string[]): number {
  const hay = `${s.title}\n${s.project.name}\n${s.cwd ?? ''}\n${s.gitBranch ?? ''}\n${s.preview ?? ''}`.toLowerCase()
  let n = 0
  for (const t of tokens) {
    const i = hay.indexOf(t)
    if (i < 0) return -1
    n += i < s.title.length ? 3 : 1 // title hits rank above preview hits
  }
  return n
}

/** Wrap query tokens in <mark> so the reason a row matched is visible. */
function Hl({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length) return <>{text}</>
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig')
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

export interface Command { id: string; label: string; icon: string | React.ReactNode; hint?: string; run: () => void }

export function Palette({ sessions, recent = [], onPick, onPickHit, onClose, commands = [] }: {
  sessions: SessionSummary[]; recent?: string[]; onPick: (id: string) => void; onPickHit: (id: string, q: string, msgIndex: number) => void; onClose: () => void; commands?: Command[]
}) {
  useT()
  const api = useApi()
  const [q, setQ] = useState('')
  const [cur, setCur] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const tokens = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q])
  const results = useMemo(() => {
    if (!tokens.length) {
      // what the reader opened lately, then pins, then the latest activity
      const by = new Map(sessions.map((s) => [s.id, s]))
      const out = [...recent.map((id) => by.get(id)), ...sessions.filter((s) => s.pinned), ...sessions].filter((s): s is SessionSummary => !!s)
      return [...new Map(out.map((s) => [s.id, s])).values()].slice(0, 8)
    }
    return sessions
      .map((s) => ({ s, n: score(s, tokens) }))
      .filter((x) => x.n >= 0)
      .sort((a, b) => b.n - a.n || b.s.updatedAt - a.s.updatedAt)
      .slice(0, 8)
      .map((x) => x.s)
  }, [tokens, sessions])

  // full-text over every message, from the index; titles above stay instant
  useEffect(() => {
    setHits([])
    if (q.trim().length < 2) { setSearching(false); return }
    setSearching(true)
    const ctl = new AbortController()
    const t = setTimeout(() => api.search(q, ctl.signal).then((h) => { setHits(h); setSearching(false) }, () => {}), 180)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q])

  const cmds = useMemo(() => (tokens.length ? commands.filter((c) => tokens.every((t) => c.label.toLowerCase().includes(t))) : commands), [tokens, commands])
  type Row = { kind: 'session'; s: SessionSummary } | { kind: 'hit'; h: SearchHit } | { kind: 'cmd'; c: Command }
  const rows: Row[] = useMemo(() => [...results.map((s) => ({ kind: 'session' as const, s })), ...hits.map((h) => ({ kind: 'hit' as const, h })), ...cmds.map((c) => ({ kind: 'cmd' as const, c }))], [results, hits, cmds])
  useEffect(() => setCur(0), [q])
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [cur])

  const pick = (r: Row) => {
    if (r.kind === 'session') onPick(r.s.id)
    else if (r.kind === 'cmd') r.c.run()
    else onPickHit(r.h.sessionId, q, r.h.snippets[0]?.msgIndex ?? 0)
    onClose()
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { setCur(Math.min(rows.length - 1, cur + 1)); e.preventDefault() }
    else if (e.key === 'ArrowUp') { setCur(Math.max(0, cur - 1)); e.preventDefault() }
    else if (e.key === 'Enter' && rows[cur]) pick(rows[cur]!)
    else if (e.key === 'Escape') onClose()
  }

  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <div className="palette pop-in" role="dialog" aria-label={t('Search')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-field"><Icon name="search" size={20} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder={t('Search sessions, messages and commands')} aria-label={t('Search sessions, messages and commands')} />
        {searching ? <span className="spinner" /> : <kbd>Esc</kbd>}</div>
        <div className="palette-list" ref={list} role="listbox">
          {results.length > 0 && <div className="p-section">{tokens.length ? t('Sessions') : t('Recent')}</div>}
          {rows.map((r, i) => {
            const on = i === cur
            if (r.kind === 'session') {
              const s = r.s
              return (
                <button key={s.id} role="option" aria-selected={on} className={on ? 'on' : ''} onMouseMove={() => setCur(i)} onClick={() => pick(r)}>
                  <AgentIcon agent={s.agent} size={16} />
                  <span className="p-main">
                    <span className="p-title"><Hl text={s.title} tokens={tokens} /></span>
                    <span className="p-sub"><Hl text={`${s.project.name}${s.gitBranch ? ` · ${s.gitBranch}` : ''}${s.preview ? ` — ${s.preview}` : ''}`} tokens={tokens} /></span>
                  </span>
                  <span className="p-time">{relTime(s.updatedAt)}</span>
                </button>
              )
            }
            if (r.kind === 'cmd') {
              const c = r.c
              return (
                <div key={c.id}>
                  {i === results.length + hits.length && <div className="p-section">{t('Commands')}</div>}
                  <button role="option" aria-selected={on} className={on ? 'on' : ''} onMouseMove={() => setCur(i)} onClick={() => pick(r)}>
                    {typeof c.icon === 'string' ? <Icon name={c.icon} /> : c.icon}
                    <span className="p-main"><span className="p-title">{c.label}</span></span>
                    {c.hint && <kbd>{c.hint}</kbd>}
                  </button>
                </div>
              )
            }
            const h = r.h
            const first = i === results.length
            return (
              <div key={h.sessionId}>
                {first && <div className="p-section">{t('In conversations')}</div>}
                <button role="option" aria-selected={on} className={on ? 'on' : ''} onMouseMove={() => setCur(i)} onClick={() => pick(r)}>
                  <AgentIcon agent={h.session.agent} size={16} />
                  <span className="p-main">
                    <span className="p-title">{h.session.title}</span>
                    {h.snippets[0] && <span className="p-snip">{h.snippets[0].role === 'user' ? `${t('You')}: ` : ''}<Snippet s={h.snippets[0]} /></span>}
                  </span>
                  <span className="p-hits">{h.hits > 1 ? t('{n} matches', { n: h.hits }) : relTime(h.session.updatedAt)}</span>
                </button>
              </div>
            )
          })}
          {!rows.length && !searching && <div className="empty-group">{tokens.length ? t('Nothing matches “{q}”.', { q }) : t('No sessions yet.')}</div>}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t('Navigate')}</span><span><kbd>↵</kbd> {t('Open')}</span><span className="grow" /><span>{tx('{key} finds inside the open session', { key: <kbd>Ctrl F</kbd> })}</span></div>
      </div>
    </div>
  )
}
