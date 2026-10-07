import { useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { launchTerminal, projectDir } from './actions'
import { startNewSession } from './NewSession'
import { relAgo } from './format'
import { Icon } from './Icon'
import { useInstalled, useMachine, usable } from './machines'
import { NO_PROJECT, projectKey } from './ProjectScope'
import { projectsOf } from './MachineTabs'
import { go, href, type Route } from './route'
import { SessionList } from './SessionList'
import { useSessionActions } from './sessionActions'
import { MoreMenu, OfflinePanel, PageHead, useUi } from './ui'
import { host } from './api'
import { useMachines } from './machines'

/**
 * One agent on one machine: its projects on the left, the sessions of the chosen project (or all) on the right,
 * and the verbs that start or continue work: a new session in the project, or pick one up.
 */
export function AgentPage({ route }: { route: Extract<Route, { page: 'agent' }> }) {
  useT()
  const { machine, agents, sessions, loaded, api } = useMachine()
  const { reload } = useMachines()
  const ui = useUi()
  const act = useSessionActions()
  const { installed } = useInstalled(machine)
  const [q, setQ] = useState('')
  const agent = agents.find((a) => a.id === route.agent)
  const own = useMemo(() => sessions.filter((s) => s.agent === route.agent), [sessions, route.agent])
  const scope = route.params.get('p')
  const projects = useMemo(() => projectsOf(own), [own])
  const noProject = own.filter((s) => s.project.generic)
  const list = projects.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
  const chosen = scope && scope !== NO_PROJECT ? projects.find((p) => p.key === scope) : undefined
  const inst = installed?.find((i) => i.id === route.agent)
  const goScope = (p: string | null) => go(href.agent(machine.id, route.agent, { p: p ?? undefined }))
  const label = agent?.label ?? route.agent
  // a new session is a chat: in the project on screen, or wherever the sheet is told
  const newSession = () => startNewSession({ agent: route.agent, cwd: chosen?.dir })
  const latest = own.find((s) => !s.parentId)
  if (!usable(machine)) return <div className="page"><div className="page-inner wide"><PageHead crumbs={[{ label: t('Machines'), href: href.machines }, { label: machine.name, href: href.machine(machine.id) }, { label }]} /><OfflinePanel machine={machine} onConnect={async () => { try { await host.connectNode(machine.id) } catch (e) { ui.say((e as Error).message) } reload() }} /></div></div>

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[
          { label: t('Machines'), href: href.machines },
          { label: machine.name, href: href.machine(machine.id) },
          { label, href: chosen ? href.agent(machine.id, route.agent) : undefined },
          ...(chosen ? [{ label: chosen.name }] : []),
        ]}>
          <button className="btn" onClick={() => latest && act.open(latest)} disabled={!latest}><Icon name="play" size={14} />{t('Continue latest')}</button>
          <button className="btn primary" onClick={newSession} disabled={!agent?.canCreate || (!!installed && !inst?.installed)} title={installed && !inst?.installed ? t('This agent was not found on the machine') : t('Talk to {agent} here, with its own model, permissions and commands', { agent: label })}><Icon name="other" size={14} />{chosen ? t('New session here') : t('New session')}</button>
          <MoreMenu items={[
            { label: t('Open a terminal here'), icon: 'terminal', onSelect: () => launchTerminal(ui.say, { machine: machine.id, kind: 'shell', cwd: chosen?.dir }) },
            { label: t('Copy history location'), icon: 'copy', onSelect: () => agent && act.copy(agent.storage, t('path')) },
            { label: t('Rescan history'), icon: 'refresh', onSelect: async () => { await api.scan(); reload(); ui.say(t('Rescanned {agent}', { agent: label })) } },
          ]} />
        </PageHead>

        <div className="ahead">
          <span className={`app-tile at-${route.agent}`}><AgentIcon agent={route.agent} size={30} /></span>
          <div className="mhead-text">
            <h1>{label}<span className={`node-state ${inst?.installed || (agent?.bin === '' && agent.sessionCount) ? 'ns-online' : ''}`}><span className="dot" />{inst?.installed || (agent?.bin === '' && agent.sessionCount) ? t('Available') : agent?.bin === '' ? t('Not installed') : installed ? (agent?.sessionCount ? t('History only') : t('Not installed')) : '…'}</span></h1>
            <div className="mhead-meta">{[agent?.bin === '' ? t('Desktop app') : inst?.version && `v${inst.version}`, inst?.path, `${own.length} ${t('Sessions')}`, `${projects.length} ${t('Projects')}`].filter(Boolean).join(' · ')}</div>
          </div>
        </div>
        {agent && !agent.available && <p className="quiet-note node-note flush">{t('{agent} has no history on this machine', { agent: label })} — {t('Sessionary looked in {path}. Sessions appear here as soon as the agent writes one.', { path: agent.storage })}</p>}
        {agent?.error && <div className="node-error"><b>{t('Could not read {agent}', { agent: label })}</b><span className="mono">{agent.error}</span></div>}

        <div className="agent-cols">
          <aside className="agent-projects">
            <div className="node-toolbar">
              <span className="section-label inline">{t('Projects')} · {projects.length}</span>
              <span className="grow" />
            </div>
            <label className="field"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search projects')} aria-label={t('Search projects')} spellCheck={false} /></label>
            <div className="group-card plist">
              <button className={`pitem ${!scope ? 'on' : ''}`} onClick={() => goScope(null)}><span className="folder-tile"><Icon name="layers" size={14} /></span><span className="t-main"><span className="r-title">{t('All projects')}</span></span><span className="r-meta">{own.length}</span></button>
              {list.map((p) => (
                <button key={p.key} className={`pitem ${scope === p.key ? 'on' : ''}`} onClick={() => goScope(p.key)} title={p.dir}>
                  <span className="folder-tile"><Icon name="folder" size={14} /></span>
                  <span className="t-main"><span className="r-title">{p.name}</span><span className="r-meta">{relAgo(p.last)}</span></span>
                  <span className="r-meta">{p.sessions.length}</span>
                </button>
              ))}
              {noProject.length > 0 && !q && (
                <button className={`pitem ${scope === NO_PROJECT ? 'on' : ''}`} onClick={() => goScope(NO_PROJECT)}><span className="folder-tile"><Icon name="message" size={14} /></span><span className="t-main"><span className="r-title">{t('No project')}</span></span><span className="r-meta">{noProject.length}</span></button>
              )}
              {!list.length && !noProject.length && <div className="list-empty pad">{t('No projects yet.')}</div>}
            </div>
          </aside>

          <section className="agent-sessions">
            <div className="node-toolbar">
              <span className="section-label inline">{chosen ? chosen.name : scope === NO_PROJECT ? t('No project') : t('Recent sessions')}</span>
            </div>
            <SessionList embedded sessions={own} agents={agents} loaded={loaded} api={api} agent={route.agent} project={scope}
              onOpen={(s, hit) => act.open(s, hit ? { q: hit.q, m: String(hit.m) } : undefined)} menuFor={(s) => act.menuFor(s)}
              empty={<div className="empty-state"><span className="tile"><Icon name="message" size={28} stroke={1.5} /></span>{t('No sessions here yet.')}{agent?.canCreate && <button className="btn primary" onClick={newSession}>{t('New session')}</button>}</div>} />
          </section>
        </div>
      </div>
    </div>
  )
}
