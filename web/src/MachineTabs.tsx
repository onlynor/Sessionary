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
import { MoreMenu, useUi } from './ui'
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

export function ProjectsTab({ agentId }: { agentId?: string }) {
  useT()
  const { machine, sessions, agents } = useMachine()
  const ui = useUi()
  const [q, setQ] = useState('')
  const rows = useMemo(() => projectsOf(agentId ? sessions.filter((s) => s.agent === agentId) : sessions).filter((r) => !q.trim() || `${r.name} ${r.key}`.toLowerCase().includes(q.trim().toLowerCase())), [sessions, agentId, q])
  const withTool = agents.filter((a) => a.canCreate && (!agentId || a.id === agentId))
  return (
    <>
      <div className="node-toolbar">
        <span className="section-label inline">{t('Projects')} · {rows.length}</span>
        <span className="grow" />
        <label className="field node-filter"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search projects')} aria-label={t('Search projects')} spellCheck={false} /></label>
      </div>
      {!rows.length ? <div className="empty-state"><span className="tile"><Icon name="folder" size={28} stroke={1.5} /></span>{q ? t('No project matches.') : t('No projects yet. A project appears when an agent works in a directory.')}</div> : (
        <div className="group-card">
          {rows.map((r) => (
            <div key={r.key} className="prow">
              <button className="prow-main" onClick={() => go(href.machine(machine.id, 'sessions', { p: r.key, agent: agentId }))} title={r.dir}>
                <span className="folder-tile"><Icon name="folder" size={16} /></span>
                <span className="t-main"><span className="r-title">{r.name}</span><span className="r-meta ellip">{r.dir ?? r.key}{r.missing ? ` · ${t('Directory no longer exists')}` : ''}</span></span>
                <span className="prow-agents">{r.agents.map((a) => <AgentIcon key={a} agent={a} size={14} />)}</span>
                <span className="r-meta">{t('{n} sessions', { n: r.sessions.length })}</span>
                <span className="r-meta prow-time">{relAgo(r.last)}</span>
              </button>
              <MoreMenu items={[
                { label: t('Open sessions'), icon: 'message', onSelect: () => go(href.machine(machine.id, 'sessions', { p: r.key, agent: agentId })) },
                { label: t('Open a terminal here'), icon: 'terminal', onSelect: () => launchTerminal(ui.say, { machine: machine.id, kind: 'shell', cwd: r.dir }), disabled: !r.dir },
                ...(withTool.length ? ['-' as const] : []),
                ...withTool.map((a) => ({ label: t('New {agent} session here', { agent: a.label }), icon: 'other', onSelect: () => launchTerminal(ui.say, { machine: machine.id, kind: 'new', agent: a.id, cwd: r.dir }), disabled: !r.dir })),
              ]} />
            </div>
          ))}
        </div>
      )}
    </>
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
