import { useEffect, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { launchTerminal, projectDir } from './actions'
import { relAgo } from './format'
import { Icon } from './Icon'
import { useMachine } from './machines'
import { go, href, type Route } from './route'
import { SessionList } from './SessionList'
import { useSessionActions } from './sessionActions'
import { TrashView } from './TrashView'
import { MoreMenu, ProjectMark, ToolbarTools, shortPath, useUi } from './ui'
import { cleanTitle, plainText, relTime } from './format'
import type { SessionSummary } from './types'

export interface ProjectRow { key: string; name: string; dir?: string; sessions: SessionSummary[]; agents: string[]; last: number; missing: boolean }

/** projects as the sessions imply them: the git root of each session's directory, newest first */
export function projectsOf(sessions: SessionSummary[]): ProjectRow[] {
  const m = new Map<string, ProjectRow>()
  for (const s of sessions) {
    if (s.project.generic) continue
    const r = m.get(s.project.key) ?? m.set(s.project.key, { key: s.project.key, name: s.project.name, dir: projectDir(s.project.key), sessions: [], agents: [], last: 0, missing: !s.project.exists }).get(s.project.key)!
    r.sessions.push(s)
    if (!r.agents.includes(s.agent)) r.agents.push(s.agent)
    r.last = Math.max(r.last, s.updatedAt)
  }
  return [...m.values()].sort((a, b) => b.last - a.last)
}

const DAY = 86_400_000
const STRIP_DAYS = 21

/** how many of a project's sessions were active on each of the last three weeks' days, oldest first */
function activity(r: ProjectRow): number[] {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = new Array<number>(STRIP_DAYS).fill(0)
  for (const s of r.sessions) {
    const ago = Math.floor((today.getTime() + DAY - 1 - s.updatedAt) / DAY)
    if (ago >= 0 && ago < STRIP_DAYS) days[STRIP_DAYS - 1 - ago]!++
  }
  return days
}

/** the folder a project lives in, as people read it: `~/programming` */
const locationOf = (r: ProjectRow) => {
  const dir = shortPath(r.dir ?? r.key).replace(/[\\/]+$/, '')
  const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  return i > 0 ? dir.slice(0, i) : dir.startsWith('~') ? '~' : '/'
}

/**
 * A project is a workspace: what matters is what was last done there and whether it is going on now, then where it
 * lives. Work from this week gets wide cards that carry that context (the latest session reads as "where you left
 * off"); every project is also listed by the folder it lives in, as wide rows, so a long history stays a calm,
 * scannable list instead of a wall of icons.
 */
export function ProjectsTab({ agentId }: { agentId?: string }) {
  useT()
  const { machine, sessions, agents } = useMachine()
  const ui = useUi()
  const act = useSessionActions()
  const [q, setQ] = useState('')
  const all = useMemo(() => projectsOf(agentId ? sessions.filter((s) => s.agent === agentId) : sessions), [sessions, agentId])
  const needle = q.trim().toLowerCase()
  const rows = needle ? all.filter((r) => `${r.name} ${r.key}`.toLowerCase().includes(needle)) : all
  const withTool = agents.filter((a) => a.canCreate && (!agentId || a.id === agentId))
  const weekAgo = Date.now() - 7 * DAY
  // where you left off, not a second list: the four most recent this week
  const recent = needle ? [] : all.filter((r) => r.last >= weekAgo).slice(0, 4)
  // by where they live; a folder holding a single project joins "Elsewhere" rather than making a section of one
  const places = useMemo(() => {
    const m = new Map<string, ProjectRow[]>()
    for (const r of rows) { const k = locationOf(r); m.set(k, [...(m.get(k) ?? []), r]) }
    const many = [...m.entries()].filter(([, l]) => l.length > 1).sort((a, b) => b[1][0]!.last - a[1][0]!.last)
    const lone = [...m.values()].filter((l) => l.length === 1).flat().sort((a, b) => b.last - a.last)
    return [...many.map(([k, l]) => ({ key: k, title: k, items: l })), ...(lone.length ? [{ key: '', title: t('Elsewhere'), items: lone }] : [])]
  }, [rows])
  const openProject = (r: ProjectRow) => go(href.machine(machine.id, 'sessions', { p: r.key, agent: agentId }))
  // the second line of a row says something the name does not: a folder named like the project says nothing
  const folderOf = (r: ProjectRow) => shortPath(r.dir ?? r.key).split('/').pop() ?? ''
  const latestOf = (r: ProjectRow) => r.sessions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  const branchOf = (r: ProjectRow) => latestOf(r).gitBranch ?? r.sessions.find((s) => s.gitBranch)?.gitBranch
  const sessionsText = (n: number) => t(n === 1 ? '{n} session' : '{n} sessions', { n })
  const menu = (r: ProjectRow) => (
    <MoreMenu className="btn icon ghost pj-more" items={[
      { label: t('Open sessions'), icon: 'message', onSelect: () => openProject(r) },
      { label: t('Open a terminal here'), icon: 'terminal', onSelect: () => launchTerminal(ui.say, { machine: machine.id, kind: 'shell', cwd: r.dir }), disabled: !r.dir },
      ...(withTool.length ? ['-' as const] : []),
      ...withTool.map((a) => ({ label: t('New {agent} session here', { agent: a.label }), icon: 'other', onSelect: () => launchTerminal(ui.say, { machine: machine.id, kind: 'new', agent: a.id, cwd: r.dir }), disabled: !r.dir })),
    ]} />
  )
  const state = (r: ProjectRow) => r.sessions.some((s) => s.active)
    ? <span className="ws-state is-live"><span className="live-dot" />{t('Active now')}</span>
    : <span className="ws-state">{relAgo(r.last)}</span>

  // a workspace card: who it is, what was last done there, and how much has happened
  const card = (r: ProjectRow) => {
    const latest = latestOf(r)
    const branch = branchOf(r)
    const strip = r.sessions.length >= 3 ? activity(r) : undefined
    const top = strip ? Math.max(1, ...strip) : 1
    const messages = r.sessions.reduce((n, s) => n + s.messageCount, 0)
    return (
      <article key={r.key} className={`ws-card ${r.missing ? 'missing' : ''}`}>
        <button className="ws-id" onClick={() => openProject(r)} title={r.dir}>
          <ProjectMark name={r.name} id={r.key} size={38} />
          <span className="ws-names">
            <span className="ws-name">{r.name}</span>
            <span className="ws-path"><span className="ellip">{shortPath(r.dir ?? r.key)}</span>{branch && <span className="ws-branch"><Icon name="branch" size={11} />{branch}</span>}{r.missing && <span className="pj-missing"><Icon name="warn" size={11} />{t('Directory no longer exists')}</span>}</span>
          </span>
          {state(r)}
        </button>
        <button className="ws-latest" onClick={() => act.open(latest)} title={t('Open the latest session')}>
          <span className="ws-latest-label">{t('Latest session')}</span>
          <span className="ws-latest-title"><AgentIcon agent={latest.agent} size={13} /><span className="ellip">{cleanTitle(latest.title)}</span><span className="ws-latest-time">{relTime(latest.updatedAt)}</span></span>
          {latest.preview && <span className="ws-latest-preview">{plainText(latest.preview)}</span>}
        </button>
        <div className="ws-foot">
          <span className="pj-agents">{r.agents.map((a) => <AgentIcon key={a} agent={a} size={13} />)}</span>
          <span>{sessionsText(r.sessions.length)}</span>
          <span className="ws-dot">·</span>
          <span>{t('{n} messages', { n: messages })}</span>
          <span className="grow" />
          {strip && (
            <span className="pj-strip" role="img" aria-label={t('Activity in the last 21 days')}>
              {strip.map((n, i) => <span key={i} className={n ? 'on' : ''} style={n ? { height: `${35 + (n / top) * 65}%` } : undefined} />)}
            </span>
          )}
        </div>
        {menu(r)}
      </article>
    )
  }
  // a workspace row: identity, the latest work, who worked there, how much, when
  const row = (r: ProjectRow) => {
    const latest = latestOf(r)
    const branch = branchOf(r)
    const live = r.sessions.some((s) => s.active)
    return (
      <div key={r.key} className={`ws-row ${r.missing ? 'missing' : ''}`}>
        <button className="ws-row-main" onClick={() => openProject(r)} title={r.dir}>
          <ProjectMark name={r.name} id={r.key} size={30} />
          <span className="ws-row-names">
            <span className="ws-name">{r.name}{live && <span className="live-dot" title={t('Active now')} />}</span>
            <span className="ws-path">{r.missing && <span className="pj-missing"><Icon name="warn" size={11} />{t('Directory no longer exists')}</span>}{needle ? <span className="ellip">{shortPath(r.dir ?? r.key)}</span> : branch ? <span className="ws-branch flush"><Icon name="branch" size={11} />{branch}</span> : folderOf(r) !== r.name ? <span className="ellip">{folderOf(r)}</span> : <span className="ellip">{t('{n} messages', { n: r.sessions.reduce((n, x) => n + x.messageCount, 0) })}</span>}</span>
          </span>
          <span className="ws-row-latest"><AgentIcon agent={latest.agent} size={12} /><span className="ellip">{cleanTitle(latest.title)}</span></span>
          <span className="ws-row-agents pj-agents">{r.agents.map((a) => <AgentIcon key={a} agent={a} size={13} />)}</span>
          <span className="ws-row-count">{sessionsText(r.sessions.length)}</span>
          <span className="ws-row-time">{relAgo(r.last)}</span>
        </button>
        {menu(r)}
      </div>
    )
  }

  return (
    <div className="projects">
      <ToolbarTools>
        <label className="field lt-search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search projects')} aria-label={t('Search projects')} spellCheck={false} /></label>
      </ToolbarTools>
      {!rows.length ? <div className="empty-state"><span className="tile"><Icon name="folder" size={28} stroke={1.5} /></span>{q ? t('No project matches.') : t('No projects yet. A project appears when an agent works in a directory.')}</div> : (
        <>
          {recent.length > 0 && (
            <section className="sx-section">
              <h3 className="sx-head static"><span className="sx-head-title">{t('Recent work')}</span><span className="sx-head-count">{recent.length}</span></h3>
              <div className="ws-grid">{recent.map(card)}</div>
            </section>
          )}
          {needle ? (
            <section className="sx-section"><div className="sx-surface ws-list">{rows.map(row)}</div></section>
          ) : places.map((g) => (
            <section key={g.key || 'elsewhere'} className="sx-section">
              <h3 className="sx-head static"><Icon name={g.key ? 'folder' : 'more'} size={14} /><span className="sx-head-title ws-place">{g.title}</span><span className="sx-head-count">{g.items.length}</span></h3>
              <div className="sx-surface ws-list">{g.items.map(row)}</div>
            </section>
          ))}
        </>
      )}
    </div>
  )
}

export function SessionsTab({ params }: { params: URLSearchParams }) {
  useT()
  const { machine, api, agents, sessions, loaded } = useMachine()
  const act = useSessionActions()
  const agent = params.get('agent') ?? ''
  const project = params.get('p')
  const to = (a: string, p: string | null) => go(href.machine(machine.id, 'sessions', { agent: a || undefined, p: p ?? undefined }))
  return (
    <SessionList sessions={sessions} agents={agents} loaded={loaded} api={api} agent={agent} project={project}
      onAgent={(a) => to(a, project)} onProject={(p) => to(agent, p)}
      onOpen={(s, hit) => act.open(s, hit ? { q: hit.q, m: String(hit.m) } : undefined)} menuFor={(s) => act.menuFor(s)} />
  )
}

export function TrashTab() {
  useT()
  const { machine, api, reload } = useMachine()
  const ui = useUi()
  const [rev, setRev] = useState(0)
  const changed = () => { setRev((r) => r + 1); reload() }
  const restoreRemoved = async (id: string) => {
    try { await api.restoreRemoved(id); changed(); ui.say(t("Restored to the agent's storage")) } catch (e) { ui.say(t('Could not restore: {error}', { error: (e as Error).message })) }
  }
  const purge = (id: string, title: string) => ui.confirm({
    title: t('Delete backup permanently?'), danger: true, confirm: t('Delete Permanently'),
    body: <><p><b>{title}</b></p><p>{t("This removes Sessionary's backup. The session can no longer be restored — this is the final delete.")}</p></>,
    onConfirm: async () => { try { await api.purgeRemoved(id); changed() } catch (e) { ui.say((e as Error).message) } },
  })
  return <TrashView rev={rev} onChanged={changed} onOpen={(id) => go(href.session(machine.id, id))} onRestoreRemoved={restoreRemoved} onPurge={purge} embedded />
}

/** the number of things in a machine's trash, for the tab and the nav */
export function useTrashCount(rev: unknown): number {
  const { api, machine } = useMachine()
  const [n, setN] = useState(0)
  useEffect(() => { api.trash().then((tr) => setN(tr.sessions.length + tr.removed.length + tr.partial.reduce((c, p) => c + p.hiddenMessages, 0)), () => setN(0)) }, [api, machine.id, rev])
  return n
}

export type MachineRoute = Extract<Route, { page: 'machine' }>
