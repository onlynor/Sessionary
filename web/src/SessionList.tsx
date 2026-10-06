import { useEffect, useMemo, useRef, useState } from 'react'
import { getLang, t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import type { Api } from './api'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { cleanTitle, dayBucket, fullTime, plainText, relTime } from './format'
import { usePersisted } from './hooks'
import { Icon } from './Icon'
import { NO_PROJECT, projectKey, ProjectScope } from './ProjectScope'
import { Popover } from './SettingsMenu'
import { Snippet } from './Snippet'
import type { Agent, SearchHit, SessionSummary } from './types'

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

interface Props {
  sessions: SessionSummary[]
  agents: Agent[]
  loaded: boolean
  api: Api
  onOpen: (s: SessionSummary, hit?: { q: string; m: number }) => void
  menuFor: (s: SessionSummary) => (MenuItem | '-')[]
  /** the agent to show, or '' for all; with `onAgent` the list offers a way to change it */
  agent?: string
  onAgent?: (id: string) => void
  /** the project to show (its key), or null for all */
  project?: string | null
  onProject?: (key: string | null) => void
  /** a list inside a page (an agent's workspace) is shorter and drops its own toolbar title */
  embedded?: boolean
  /** shown when the machine has no sessions at all */
  empty?: React.ReactNode
}

/** A machine's sessions: searchable by title and by message text, grouped, sorted, each with its own menu. */
export function SessionList(p: Props) {
  useT()
  const { sessions, agents } = p
  const [filter, setFilter] = useState('')
  const [sort, setSort] = usePersisted<Sort>('sort', 'updated')
  const [groupBy, setGroupBy] = usePersisted<GroupBy>('groupBy', 'date')
  const [show, setShow] = usePersisted<Show>('show', 'all')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; s: SessionSummary } | null>(null)
  const [viewMenu, setViewMenu] = useState<{ left: number; top: number }>()
  const filterRef = useRef<HTMLInputElement>(null)
  const agent = p.agent ?? ''

  const own = useMemo(() => (agent ? sessions.filter((s) => s.agent === agent) : sessions), [sessions, agent])
  const scope = p.project ?? null
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
    const id = setTimeout(() => p.api.search(q, ctl.signal).then((h) => { setHits(h); setSearching(false) }, () => setSearching(false)), 220)
    return () => { clearTimeout(id); ctl.abort() }
  }, [filter, p.api])
  const contentHits = useMemo(() => {
    const shown = new Set(visible.map((s) => s.id))
    const byId = new Map(sessions.map((s) => [s.id, s]))
    return hits.filter((h) => !shown.has(h.sessionId) && byId.has(h.sessionId) && !h.session.parentId && (!agent || h.session.agent === agent) && (!scope || projectKey(byId.get(h.sessionId)!) === scope)).slice(0, 20)
  }, [hits, visible, sessions, agent, scope])

  const lang = getLang()
  const groups = useMemo(() => {
    const pins = show === 'all' && !tokens.length ? visible.filter((s) => s.pinned) : []
    const rest = pins.length ? visible.filter((s) => !s.pinned) : visible
    const g = groupSessions(rest, groupBy, sort)
    return pins.length ? [{ key: 'pinned', title: t('Pinned'), items: pins, pinned: true }, ...g] : g
  }, [visible, groupBy, sort, show, filter, lang])
  const isOpen = (g: Group) => !!filter || (toggled[g.key] ?? true)

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return
      filterRef.current?.focus(); e.preventDefault()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])

  const custom = sort !== 'updated' || groupBy !== 'date' || show !== 'all'
  const time = (s: SessionSummary) => relTime(sort === 'created' ? s.createdAt : s.updatedAt)
  const row = (s: SessionSummary) => (
    <button key={s.id} className={`srow ${menu?.s.id === s.id ? 'menu-target' : ''}`} onClick={() => p.onOpen(s)}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s }) }}
      title={[s.title, s.preview, fullTime(s.updatedAt)].filter(Boolean).join('\n\n')}>
      <AgentIcon agent={s.agent} size={16} />
      <span className="srow-main">
        <span className="srow-title">{cleanTitle(s.title)}{s.pinned && <span className="row-pin" title={t('Pinned')}><Icon name="pin" size={12} /></span>}{s.active && <span className="live-dot" title={t('Active now')} />}</span>
        <span className="srow-sub">{s.preview ? plainText(s.preview) : s.project.generic ? t('No project') : s.project.name}</span>
      </span>
      <span className="srow-proj">{s.project.generic ? '' : s.project.name}{s.gitBranch && <span className="row-branch"> · {s.gitBranch}</span>}</span>
      <span className="srow-n">{t('{n} messages', { n: s.messageCount })}</span>
      <span className="srow-time">{time(s)}</span>
      <span className="srow-more" role="button" tabIndex={-1} aria-label={t('More actions')} onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: Math.max(8, r.right - 220), y: r.bottom + 4, s }) }}><Icon name="more" size={15} /></span>
    </button>
  )

  const agentsWith = agents.filter((a) => sessions.some((s) => s.agent === a.id))
  return (
    <div className={`slist ${p.embedded ? 'embedded' : ''}`}>
      <div className="node-toolbar">
        {p.onAgent && (
          <span className="seg sm" role="radiogroup" aria-label={t('Agents')}>
            <button role="radio" aria-checked={!agent} className={!agent ? 'on' : ''} onClick={() => p.onAgent!('')}>{t('All agents')}</button>
            {agentsWith.map((a) => <button key={a.id} role="radio" aria-checked={agent === a.id} className={agent === a.id ? 'on' : ''} onClick={() => p.onAgent!(a.id)}><AgentIcon agent={a.id} size={12} />{a.label}</button>)}
          </span>
        )}
        {p.onProject && <ProjectScope sessions={own} value={scope} onChange={p.onProject} />}
        <span className="grow" />
        <label className="field node-filter">
          {searching ? <span className="spinner" /> : <Icon name="search" size={14} />}
          <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Search titles and messages')} aria-label={t('Search titles and messages')} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur() } else if (e.key === 'Enter' && visible[0]) p.onOpen(visible[0]) }} />
          {filter && <button className="field-clear" onClick={() => setFilter('')} aria-label={t('Clear filter')}><Icon name="x" size={14} /></button>}
        </label>
        <button className={`btn icon ${custom ? 'on' : ''}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setViewMenu(viewMenu ? undefined : { left: r.right - 232, top: r.bottom + 6 }) }}
          title={t('Sort, group and filter')} aria-label={t('Sort, group and filter')} aria-expanded={!!viewMenu}><Icon name="sort" size={15} /></button>
      </div>

      {!p.loaded ? <div className="list-loading" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="sk-row"><span className="sk-lines"><span style={{ width: `${70 - i * 7}%` }} /><span style={{ width: `${45 + i * 5}%` }} /></span></div>)}</div>
      : !sessions.length ? (p.empty ?? <div className="empty-state"><span className="tile"><Icon name="message" size={28} stroke={1.5} /></span>{t('No sessions here yet.')}</div>)
      : (
        <div className="group-card slist-card">
          {groups.map((g) => {
            const open = isOpen(g)
            return (
              <section key={g.key} className="sgroup">
                {g.title && (
                  <button className="sgroup-head" onClick={() => setToggled({ ...toggled, [g.key]: !open })} aria-expanded={open}>
                    {g.pinned && <Icon name="pin" size={12} />}
                    <span className="group-title">{g.title}</span>
                    <span className="group-count">{g.items.length}</span>
                    <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={12} /></span>
                  </button>
                )}
                {open && g.items.map(row)}
              </section>
            )
          })}
          {contentHits.length > 0 && (
            <section className="sgroup">
              <div className="sgroup-head static"><span className="group-title">{t('In messages')}</span><span className="group-count" style={{ opacity: 1 }}>{contentHits.length}</span></div>
              {contentHits.map((h) => {
                const s = sessions.find((x) => x.id === h.sessionId)!
                return (
                  <button key={h.sessionId} className="srow hit" onClick={() => p.onOpen(s, { q: filter.trim(), m: h.snippets[0]?.msgIndex ?? 0 })}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, s }) }}>
                    <AgentIcon agent={h.session.agent} size={16} />
                    <span className="srow-main">
                      <span className="srow-title">{cleanTitle(h.session.title)}</span>
                      {h.snippets[0] && <span className="srow-sub">{h.snippets[0].role === 'user' ? `${t('You')}: ` : ''}<Snippet s={h.snippets[0]} /></span>}
                    </span>
                    <span className="srow-time">{t(h.hits === 1 ? '{n} match' : '{n} matches', { n: h.hits })}</span>
                  </button>
                )
              })}
            </section>
          )}
          {!groups.length && !contentHits.length && (
            <div className="list-empty pad">
              {searching ? t('Searching messages…')
                : filter ? t('Nothing matches “{q}”.', { q: filter })
                : show !== 'all' ? <>{show === 'pinned' ? t('Nothing pinned yet. Right-click a session or press P to pin it.') : show === 'live' ? t('No session was written to in the last two minutes.') : t('No session here edited files.')}<button className="more" onClick={() => setShow('all')}>{t('Show all sessions')}</button></>
                : t('No sessions here yet.')}
            </div>
          )}
        </div>
      )}

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
    </div>
  )
}
