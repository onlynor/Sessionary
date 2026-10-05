import { useEffect, useMemo, useRef, useState } from 'react'
import { getLang, t, useT } from './i18n'
import { AgentSwitcher } from './AgentSwitcher'
import { api } from './api'
import { cleanTitle, dayBucket, fullTime, plainText, relTime } from './format'
import { usePersisted } from './hooks'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { NO_PROJECT, projectKey, ProjectScope } from './ProjectScope'
import { Reveal } from './Reveal'
import { AgentIcon } from './AgentIcon'
import { Popover } from './SettingsMenu'
import { Snippet } from './Snippet'
import type { Agent, SearchHit, SessionSummary } from './types'

interface Props {
  agents: Agent[]
  sessions: SessionSummary[]
  loaded: boolean
  selected?: string
  onSelect: (id: string) => void
  onOpenHit: (id: string, q: string, msgIndex: number) => void
  onPalette: () => void
  refreshing: boolean
  onCollapse: () => void
  onSettings: (anchor: HTMLElement) => void
  /** an agent id, or 'all' for every agent's sessions in one list */
  agent: string
  onAgent: (id: string) => void
  onOverview: () => void
  scope: string | null
  onScope: (key: string | null) => void
  menuFor: (s: SessionSummary) => (MenuItem | '-')[]
  live: 'events' | 'polling' | 'offline'
}

export type Sort = 'updated' | 'created' | 'messages' | 'title'
export type GroupBy = 'date' | 'project' | 'none'
export type Show = 'all' | 'pinned' | 'live' | 'edited'
type Group = { key: string; title: string; items: SessionSummary[]; pinned?: boolean }

const SORTS: [Sort, string][] = [['updated', 'Last activity'], ['created', 'Date started'], ['messages', 'Most messages'], ['title', 'Title']]
const GROUPS: [GroupBy, string][] = [['date', 'Date'], ['project', 'Project'], ['none', 'No grouping']]
const SHOWS: [Show, string][] = [['all', 'All sessions'], ['pinned', 'Pinned'], ['live', 'Active now'], ['edited', 'Edited files']]

const sorters: Record<Sort, (a: SessionSummary, b: SessionSummary) => number> = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  messages: (a, b) => b.messageCount - a.messageCount || b.updatedAt - a.updatedAt,
  title: (a, b) => cleanTitle(a.title).localeCompare(cleanTitle(b.title), getLang()),
}

export function groupSessions(list: SessionSummary[], by: GroupBy, sort: Sort): Group[] {
  if (by === 'none') return list.length ? [{ key: 'all', title: '', items: list }] : []
  if (by === 'project') {
    const m = new Map<string, Group>()
    for (const s of list) {
      const k = projectKey(s)
      const g = m.get(k) ?? m.set(k, { key: 'p:' + k, title: k === NO_PROJECT ? t('No project') : s.project.name, items: [] }).get(k)!
      g.items.push(s)
    }
    // projects in order of their most recent session; "No project" last
    return [...m.values()].sort((a, b) => Number(a.key === 'p:' + NO_PROJECT) - Number(b.key === 'p:' + NO_PROJECT) || Math.max(...b.items.map((x) => x.updatedAt)) - Math.max(...a.items.map((x) => x.updatedAt)))
  }
  // by date: buckets follow the sort's own time when it is a time; otherwise last activity
  const at = (s: SessionSummary) => (sort === 'created' ? s.createdAt : s.updatedAt)
  const out: Group[] = []
  const sorted = sort === 'updated' || sort === 'created' ? list : [...list].sort((a, b) => at(b) - at(a))
  for (const s of sorted) {
    const day = dayBucket(at(s))
    const g = out.find((x) => x.key === day)
    if (g) g.items.push(s)
    else out.push({ key: day, title: day, items: [s] })
  }
  if (sort !== 'updated' && sort !== 'created') for (const g of out) g.items.sort(sorters[sort])
  return out
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable)

export function Sidebar(p: Props) {
  useT()
  const { agents, sessions, selected, onSelect, agent, onAgent: setAgent, scope, onScope: setScope } = p
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState<string>()
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionSummary } | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = usePersisted<Sort>('sort', 'updated')
  const [groupBy, setGroupBy] = usePersisted<GroupBy>('groupBy', 'date')
  const [show, setShow] = usePersisted<Show>('show', 'all')
  const [viewMenu, setViewMenu] = useState<{ left: number; top: number }>()
  const filterRef = useRef<HTMLInputElement>(null)
  const all = agent === 'all'
  const current = agents.find((a) => a.id === agent)
  const label = all ? t('All agents') : current?.label ?? t('Sessions')

  const own = useMemo(() => (all ? sessions : sessions.filter((s) => s.agent === agent)), [sessions, agent])
  // a project scope survives an agent switch only if that agent has worked there
  useEffect(() => {
    if (!scope || !own.length) return
    if (!own.some((s) => projectKey(s) === scope)) {
      setScope(null)
      setNote(t('No {agent} sessions there — showing all projects', { agent: label }))
      const id = setTimeout(() => setNote(undefined), 3200)
      return () => clearTimeout(id)
    }
  }, [own, scope])

  const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = useMemo(() => {
    let l = scope ? own.filter((s) => projectKey(s) === scope) : own
    if (show === 'pinned') l = l.filter((s) => s.pinned)
    else if (show === 'live') l = l.filter((s) => s.active)
    else if (show === 'edited') l = l.filter((s) => s.filesChanged)
    if (tokens.length) l = l.filter((s) => { const hay = `${s.title} ${s.project.name} ${s.gitBranch ?? ''} ${s.preview ?? ''} ${s.model ?? ''}`.toLowerCase(); return tokens.every((w) => hay.includes(w)) })
    return [...l].sort(sorters[sort])
  }, [own, scope, filter, show, sort])

  // content matches from the index, for what the titles and previews don't show
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    setHits([])
    const q = filter.trim()
    if ([...q].length < 2) { setSearching(false); return }
    setSearching(true)
    const ctl = new AbortController()
    const id = setTimeout(() => api.search(q, ctl.signal).then((h) => { setHits(h); setSearching(false) }, () => setSearching(false)), 220)
    return () => { clearTimeout(id); ctl.abort() }
  }, [filter])
  const contentHits = useMemo(() => {
    const shown = new Set(visible.map((s) => s.id))
    const mine = new Set(own.map((s) => s.id))
    return hits.filter((h) => !shown.has(h.sessionId) && (mine.has(h.sessionId) || (all && !h.session.parentId)) && (!scope || own.some((s) => s.id === h.sessionId && projectKey(s) === scope))).slice(0, 20)
  }, [hits, visible, own, scope])

  const lang = getLang() // day labels are translated
  const groups = useMemo(() => {
    // pinned sessions lead the list in their own group (unless the list already shows only pins)
    const pins = show === 'all' && !tokens.length ? visible.filter((s) => s.pinned) : []
    const rest = pins.length ? visible.filter((s) => !s.pinned) : visible
    const g = groupSessions(rest, groupBy, sort)
    return pins.length ? [{ key: 'pinned', title: t('Pinned'), items: pins, pinned: true }, ...g] : g
  }, [visible, groupBy, sort, show, filter, lang])
  const isOpen = (g: Group) => !!filter || (toggled[g.key] ?? true)
  const ordered = useMemo(() => groups.flatMap((g) => (isOpen(g) ? g.items : [])), [groups, toggled, filter])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (e.key === '0') { setAgent('all'); e.preventDefault(); return }
      const n = Number(e.key)
      if (n >= 1 && n <= agents.length && agents[n - 1]!.sessionCount) { setAgent(agents[n - 1]!.id); e.preventDefault(); return }
      if (e.key === '/') { filterRef.current?.focus(); e.preventDefault(); return }
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (e.key.startsWith('Arrow') && !(e.target as HTMLElement).closest?.('.sidebar')) return
      const i = ordered.findIndex((s) => s.id === selected)
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, i + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { onSelect(next.id); e.preventDefault() }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [ordered, selected, onSelect, agents])

  useEffect(() => { document.querySelector('.side-full .row.selected')?.scrollIntoView({ block: 'nearest' }) }, [selected, scope, agent])

  const custom = sort !== 'updated' || groupBy !== 'date' || show !== 'all'
  const row = (s: SessionSummary) => (
    <button key={s.id} className={`row ${s.id === selected ? 'selected' : ''} ${menu?.s.id === s.id ? 'menu-target' : ''}`} aria-current={s.id === selected ? 'true' : undefined} onClick={() => onSelect(s.id)}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s }) }}
      title={[s.title, s.preview, fullTime(s.updatedAt)].filter(Boolean).join('\n\n')}>
      <span className="row-top">
        {all && <AgentIcon agent={s.agent} size={13} />}
        <span className="row-title">{cleanTitle(s.title)}</span>
        {s.active && <span className="live-dot" title={t('Active now')} />}
        {s.pinned && <span className="row-pin" title={t('Pinned')}><Icon name="pin" size={12} /></span>}
        <span className="row-time">{relTime(sort === 'created' ? s.createdAt : s.updatedAt)}</span>
      </span>
      {(!scope || groupBy !== 'project') && <span className="row-sub">{s.project.generic ? t('No project') : s.project.name}{s.gitBranch ? <span className="row-branch"> · {s.gitBranch}</span> : null}{sort === 'messages' ? <span className="row-branch"> · {t('{n} messages', { n: s.messageCount })}</span> : null}</span>}
      {s.preview && <span className="row-preview">{plainText(s.preview)}</span>}
      {!scope && !s.project.generic && <span className="row-proj">{s.project.name}</span>}
      <span className="row-time row-end">{relTime(sort === 'created' ? s.createdAt : s.updatedAt)}</span>
    </button>
  )

  const empty = () => {
    if (!p.loaded) return <div className="list-loading" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sk-row"><span className="sk-lines"><span style={{ width: `${70 - i * 7}%` }} /><span style={{ width: `${45 + i * 5}%` }} /></span></div>)}</div>
    if (filter) return null // content hits or the hint below
    if (show !== 'all') return <div className="list-empty">{show === 'pinned' ? t('Nothing pinned yet. Right-click a session or press P to pin it.') : show === 'live' ? t('No session was written to in the last two minutes.') : t('No session here edited files.')}
      <button className="more" onClick={() => setShow('all')}>{t('Show all sessions')}</button></div>
    if (!all && current && !current.available) return <div className="list-empty"><b>{t('{agent} has no history on this machine', { agent: current.label })}</b>
      <span>{t('Sessionary looked in {path}. Sessions appear here as soon as the agent writes one.', { path: current.storage })}</span></div>
    if (!all && current?.error) return <div className="list-empty"><b>{t('Could not read {agent}', { agent: current.label })}</b><span className="mono">{current.error}</span></div>
    return <div className="list-empty">{t('No sessions here yet.')}</div>
  }

  return (
    <div className="sidebar">
      <div className="side-head">
        <AgentSwitcher agents={agents} value={agent} onChange={(id) => { setAgent(id); setFilter('') }} onOverview={p.onOverview} />
        <button className="tb-btn" onClick={p.onCollapse} title={`${t('Collapse sidebar')}  [`} aria-label={t('Collapse sidebar')}><Icon name="sidebar" /></button>
      </div>

      <div className="side-nav">
        <label className="field">
          {searching ? <span className="spinner" /> : <Icon name="search" />}
          <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur() } else if (e.key === 'Enter' && ordered[0]) onSelect(ordered[0].id) }}
            placeholder={t('Search')} aria-label={t('Filter {agent} sessions', { agent: label })} title={`${t('Filter this list')}  /`} />
          {filter
            ? <button className="field-clear" onClick={() => setFilter('')} aria-label={t('Clear filter')}><Icon name="x" size={14} /></button>
            : <button className="field-kbd" onClick={(e) => { e.preventDefault(); p.onPalette() }} title={t('Search all sessions and messages')} aria-label={t('Search all sessions and messages')}><kbd>Ctrl K</kbd></button>}
        </label>
        <div className="scope-row">
          <ProjectScope sessions={own} value={scope} onChange={setScope} />
          <button className={`tb-btn ${custom ? 'pressed' : ''}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setViewMenu(viewMenu ? undefined : { left: r.left, top: r.bottom + 6 }) }}
            title={t('Sort, group and filter')} aria-label={t('Sort, group and filter')} aria-expanded={!!viewMenu}><Icon name="sort" /></button>
        </div>
      </div>
      {note && <div className="side-note fade-in">{note}</div>}

      <nav className={`list ${p.refreshing ? 'busy' : ''} ${scope ? 'scoped' : ''}`} key={agent + (scope ?? '') + groupBy + show} tabIndex={-1} aria-label={t('{agent} sessions', { agent: label })}>
        {groups.map((g) => {
          const open = isOpen(g)
          return (
            <section key={g.key} className="group">
              {g.title && (
                <button className="group-head" onClick={() => setToggled({ ...toggled, [g.key]: !open })} aria-expanded={open}>
                  {g.pinned && <Icon name="pin" size={12} />}
                  <span className="group-title">{g.title}</span>
                  <span className="group-count">{g.items.length}</span>
                  <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={12} /></span>
                </button>
              )}
              <Reveal open={open}>{g.items.map(row)}</Reveal>
            </section>
          )
        })}
        {contentHits.length > 0 && (
          <section className="group">
            <div className="group-head static"><span className="group-title">{t('In messages')}</span><span className="group-count" style={{ opacity: 1 }}>{contentHits.length}</span></div>
            {contentHits.map((h) => (
              <button key={h.sessionId} className="row hit" onClick={() => p.onOpenHit(h.sessionId, filter.trim(), h.snippets[0]?.msgIndex ?? 0)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s: { ...h.session, project: own.find((x) => x.id === h.sessionId)?.project ?? { key: '', name: '', exists: false, generic: true } } }) }}>
                <span className="row-top">
                  {all && <AgentIcon agent={h.session.agent} size={13} />}
                  <span className="row-title">{cleanTitle(h.session.title)}</span>
                  <span className="row-time">{t(h.hits === 1 ? '{n} match' : '{n} matches', { n: h.hits })}</span>
                </span>
                {h.snippets[0] && <span className="row-preview">{h.snippets[0].role === 'user' ? `${t('You')}: ` : ''}<Snippet s={h.snippets[0]} /></span>}
              </button>
            ))}
          </section>
        )}
        {!groups.length && !contentHits.length && (empty() ?? (
          <div className="list-empty">
            {searching ? t('Searching messages…') : <>{t('Nothing matches “{q}”.', { q: filter })}<button className="more" onClick={p.onPalette}>{t('Search all agents')}</button></>}
          </div>
        ))}
      </nav>

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={p.menuFor(menu.s)} />}
      {viewMenu && (
        <Popover at={viewMenu} onClose={() => setViewMenu(undefined)} label={t('Sort, group and filter')} width={232}>
          <div className="menu-label">{t('Sort by')}</div>
          {SORTS.map(([v, l]) => <button key={v} className="menu-item" role="menuitemradio" aria-checked={sort === v} onClick={() => setSort(v)}><span className="grow">{t(l)}</span>{sort === v && <span className="check"><Icon name="check" size={14} /></span>}</button>)}
          <div className="menu-sep" />
          <div className="menu-label">{t('Group by')}</div>
          {GROUPS.map(([v, l]) => <button key={v} className="menu-item" role="menuitemradio" aria-checked={groupBy === v} onClick={() => setGroupBy(v)}><span className="grow">{t(l)}</span>{groupBy === v && <span className="check"><Icon name="check" size={14} /></span>}</button>)}
          <div className="menu-sep" />
          <div className="menu-label">{t('Show')}</div>
          {SHOWS.map(([v, l]) => (
            <button key={v} className="menu-item" role="menuitemradio" aria-checked={show === v} onClick={() => setShow(v)}>
              <span className="grow">{t(l)}</span>
              <span className="menu-meta">{v === 'all' ? own.length : v === 'pinned' ? own.filter((s) => s.pinned).length : v === 'live' ? own.filter((s) => s.active).length : own.filter((s) => s.filesChanged).length}</span>
              {show === v && <span className="check"><Icon name="check" size={14} /></span>}
            </button>
          ))}
          {custom && <><div className="menu-sep" /><button className="menu-item quiet" onClick={() => { setSort('updated'); setGroupBy('date'); setShow('all') }}><span className="grow">{t('Reset to default')}</span></button></>}
        </Popover>
      )}

      <footer className="side-foot">
        <button className="tb-btn" onClick={(e) => p.onSettings(e.currentTarget)} title={t('Settings — Trash, appearance, language, shortcuts')} aria-label={t('Settings')}><Icon name="settings" /></button>
        {p.refreshing
          ? <span className="side-status fade-in"><span className="spinner" />{t('Scanning…')}</span>
          : <span className={`side-status live-${p.live}`} title={p.live === 'events' ? t('New sessions and messages appear as the agents write them') : p.live === 'polling' ? t('File events are unavailable; checking for changes every minute') : t('Sessionary isn’t responding — reconnecting…')}>
              <span className="dot" />{p.live === 'events' ? t('Live') : p.live === 'polling' ? t('Checking every minute') : t('Offline')}
            </span>}
        <span className="grow" />
        <span className="side-count">{t('{n} sessions', { n: visible.length + contentHits.length })}</span>
      </footer>
    </div>
  )
}

/** The collapsed sidebar: core navigation as an icon rail. */
export function Rail({ agents, agent, onAgent, onExpand, onPalette, onOverview, onSettings, refreshing, overview }: {
  agents: Agent[]; agent: string; onAgent: (id: string) => void; onExpand: () => void; onPalette: () => void; onOverview: () => void
  onSettings: (anchor: HTMLElement) => void; refreshing: boolean; overview: boolean
}) {
  useT()
  return (
    <nav className="side-rail" aria-label={t('Navigation')}>
      <button className="rail-btn" onClick={onExpand} title={`${t('Expand sidebar')}  [`} aria-label={t('Expand sidebar')}><Icon name="sidebar-open" size={18} /></button>
      <div className="rail-sep" />
      {agents.map((a, i) => (
        <button key={a.id} className={`rail-btn ${a.id === agent && !overview ? 'on' : ''}`} onClick={() => onAgent(a.id)} disabled={!a.sessionCount}
          title={`${a.label} · ${t('{n} sessions', { n: a.sessionCount })}  ${i + 1}`} aria-label={a.label} aria-current={a.id === agent ? 'true' : undefined}>
          <AgentIcon agent={a.id} size={18} />
        </button>
      ))}
      <button className={`rail-btn ${overview ? 'on' : ''}`} onClick={onOverview} title={t('Overview')} aria-label={t('Overview')}><Icon name="layers" size={18} /></button>
      <div className="rail-sep" />
      <button className="rail-btn" onClick={onPalette} title={`${t('Search')}  Ctrl K`} aria-label={t('Search')}><Icon name="search" size={18} /></button>
      <span className="grow" />
      <button className="rail-btn" onClick={(e) => onSettings(e.currentTarget)} title={t('Settings')} aria-label={t('Settings')}>
        <Icon name="settings" size={18} />{refreshing && <span className="spinner rail-spin" />}
      </button>
    </nav>
  )
}
