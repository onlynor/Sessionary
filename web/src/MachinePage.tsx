import { useEffect, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { launchTerminal } from './actions'
import { host } from './api'
import { relAgo, relTime } from './format'
import { Icon } from './Icon'
import { useInstalled, useMachine, useMachines, useSystem, usable } from './machines'
import { MonitorTab } from './MonitorTab'
import { TargetMark, describeTarget, useControl } from './control'
import { ProjectsTab, SessionsTab, TrashTab, useTrashCount, projectsOf, type MachineRoute } from './MachineTabs'
import { go, href, type MachineTab } from './route'
import { TerminalTab } from './TerminalTab'
import { Bar, Gauge, MachineIcon, MoreMenu, OfflinePanel, PageHead, StateBadge, Tabs, ToolbarSlot, fmtBytes, fmtUptime, machineTarget, useUi } from './ui'

/** The agents this machine has: what is installed, how much history each holds, and a way into each. */
function AgentsTab() {
  useT()
  const { machine, agents, sessions, loaded } = useMachine()
  const ui = useUi()
  const { reload } = useMachines()
  const { installed, at: checkedAt, busy: checking, refresh } = useInstalled(machine)
  const [syncing, setSyncing] = useState(false)
  const projects = projectsOf(sessions)
  const control = useControl()

  return (
    <>
      <div className="section-label installed-head">
        <span>{t('Installed agents')}</span>
        <span className="grow" />
        {checkedAt && <span className="r-meta">{t('checked {when}', { when: relAgo(checkedAt) })}</span>}
        <button className="btn sm" onClick={refresh} disabled={checking} title={t('Look again for what is installed on this machine')}><Icon name="refresh" size={12} />{checking ? t('Checking…') : t('Check again')}</button>
      </div>
      <p className="quiet-note node-note flush">{t('Agents found on this machine, and the history each one has kept.')}</p>
      {!loaded ? <div className="sk-line" /> : (
        <div className="agent-grid agent-cards">
          {agents.map((a) => {
            const inst = installed?.find((i) => i.id === a.id)
            const own = sessions.filter((s) => s.agent === a.id)
            const last = own.reduce((m, s) => Math.max(m, s.updatedAt), 0)
            const nProjects = projectsOf(own).length
            // a desktop app (no program to find on PATH) is judged by whether it has left history
            const desktop = a.bin === ''
            const state = desktop ? (a.sessionCount ? 'desktop' : 'missing') : !installed ? 'checking' : inst?.installed ? 'available' : a.sessionCount ? 'history' : 'missing'
            return (
              <section key={a.id} className={`agent-card ac ${state}`}>
                <a className="agent-card-head" href={href.agent(machine.id, a.id)}>
                  <span className={`app-tile at-${a.id}`}><AgentIcon agent={a.id} size={26} /></span>
                  <span className="agent-card-title">
                    <span className="agent-name">{a.label}</span>
                    <span className="agent-sub">{state === 'desktop' ? t('Desktop app') : inst?.version ? `v${inst.version}` : inst?.installed ? t('Installed') : state === 'history' ? t('History only') : state === 'missing' ? t('Not installed') : '…'}</span>
                  </span>
                </a>
                <div className="ac-status">
                  <span className={`ac-dot ${state === 'desktop' ? 'available' : state}`} />
                  {state === 'available' || state === 'desktop' ? t('Available') : state === 'history' ? t('Not found on PATH') : state === 'missing' ? t('Not installed') : t('Checking…')}
                </div>
                {machine.kind !== 'url' && <AgentRoute agent={a.id} control={control} here={machine.kind === 'local'} />}
                <div className="agent-nums">
                  <div><b>{a.sessionCount}</b><span>{t('Sessions')}</span></div>
                  <div><b>{nProjects}</b><span>{t('Projects')}</span></div>
                  <div><b>{last ? relTime(last) : '—'}</b><span>{t('Last active')}</span></div>
                </div>
                <div className="ac-actions">
                  <button className="btn" onClick={() => go(href.agent(machine.id, a.id))} disabled={!a.sessionCount && state !== 'available'}>{t('Open')}</button>
                  <button className="btn primary" onClick={() => launchTerminal(ui.say, { machine: machine.id, kind: 'new', agent: a.id })} disabled={state !== 'available' || !a.canCreate} title={state !== 'available' ? t('This agent was not found on the machine') : t('Start a new {agent} session in a terminal', { agent: a.label })}><Icon name="other" size={13} />{t('New session')}</button>
                </div>
              </section>
            )
          })}
        </div>
      )}

      <div className="section-label">{t('Quick actions')}</div>
      <div className="quick-grid">
        <button className="quick" onClick={() => go(href.machine(machine.id, 'sessions'))}><Icon name="message" size={18} /><b>{t('View sessions')}</b><span>{t('{n} sessions', { n: sessions.length })}</span></button>
        <button className="quick" onClick={() => go(href.machine(machine.id, 'projects'))}><Icon name="folder" size={18} /><b>{t('Manage projects')}</b><span>{t('{n} projects', { n: projects.length })}</span></button>
        <button className="quick" onClick={() => launchTerminal(ui.say, { machine: machine.id, kind: 'shell' })}><Icon name="terminal" size={18} /><b>{t('Open a terminal')}</b><span>{machine.name}</span></button>
        <button className="quick" onClick={() => go(href.machine(machine.id, 'monitor'))}><Icon name="activity" size={18} /><b>{t('Monitor')}</b><span>{t('CPU, memory, processes')}</span></button>
        {machine.kind === 'ssh' && (
          <button className="quick" disabled={syncing} onClick={async () => { setSyncing(true); try { await host.syncNode(machine.id); ui.say(t('Synced {name}', { name: machine.name })) } catch (e) { ui.say((e as Error).message) } finally { setSyncing(false); reload() } }}>
            <Icon name="refresh" size={18} /><b>{t('Sync now')}</b><span>{machine.sync?.lastSync ? t('last synced {when}', { when: relAgo(machine.sync.lastSync) }) : t('Copy new history from the node')}</span>
          </button>
        )}
      </div>
    </>
  )
}

/**
 * which model a routable agent is started on from Sessionary, and the way to change it; on an ssh node the same
 * binding applies (through a tunnel), but what the agent is set to by itself is only known for this computer
 */
function AgentRoute({ agent, control, here }: { agent: string; control: ReturnType<typeof useControl>; here: boolean }) {
  const a = control.state?.agents.find((x) => x.agent === agent)
  if (!a) return null
  const d = a.target ? describeTarget(control.state, a.target) : undefined
  return (
    <a className="ac-route" href={href.routing()} title={t('Choose the model on Routing')}>
      {a.target ? <TargetMark target={a.target} size={16} /> : <Icon name="route" size={13} />}
      <span className="ellip">{d ? <><b>{d.title}</b> · {t('through the gateway')}</> : here && a.via === 'magpie' ? t('Its own setting, through Magpie') : t('Its own model setting')}</span>
      <Icon name="chev" size={11} />
    </a>
  )
}

const TAB_ICON: Record<MachineTab, string> = { agents: 'task', projects: 'folder', sessions: 'message', terminal: 'terminal', monitor: 'activity', trash: 'archive' }

/** One machine: who it is and how it is doing, then the tabs that go deeper (agents, projects, sessions, terminal, monitor). */
export function MachinePage({ route }: { route: MachineRoute }) {
  useT()
  const { machine, sessions } = useMachine()
  const { reload } = useMachines()
  const ui = useUi()
  const tab = route.tab
  const ok = usable(machine)
  const full = tab === 'agents'
  const { system } = useSystem(machine, full ? 8000 : 0)
  const trashN = useTrashCount(sessions.length)
  const [busy, setBusy] = useState(false)
  // the trailing end of the floating bar, where the open list puts its search and sort
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const projectsN = projectsOf(sessions).length

  const connect = async () => {
    setBusy(true)
    try { await host.connectNode(machine.id) } catch (e) { ui.say((e as Error).message) } finally { setBusy(false); reload() }
  }
  const remove = () => ui.confirm({
    title: t('Remove node?'), danger: true, confirm: t('Remove'),
    body: <><p><b>{machine.name}</b></p><p>{t('Sessionary forgets how to reach this node and deletes its local copy. Nothing on the machine itself is changed.')}</p></>,
    onConfirm: async () => { try { await host.removeNode(machine.id); await reload(); go(href.machines) } catch (e) { ui.say((e as Error).message) } },
  })

  const spec = [system?.os && system.os.replace(/\s*\(.*\)$/, ''), system?.cpus ? t('{n} cores', { n: system.cpus }) : undefined, system?.mem ? fmtBytes(system.mem.total) : undefined, machineTarget(machine)].filter(Boolean).join(' · ')
  const tabs = (['agents', 'projects', 'sessions', 'terminal', 'monitor'] as MachineTab[]).concat(trashN > 0 || tab === 'trash' ? ['trash'] : []).map((id) => ({
    id, icon: TAB_ICON[id], href: href.machine(machine.id, id),
    label: { agents: t('Agents'), projects: t('Projects'), sessions: t('Sessions'), terminal: t('Terminal'), monitor: t('Monitor'), trash: t('Trash') }[id],
    count: id === 'projects' ? projectsN : id === 'sessions' ? sessions.length : id === 'trash' ? trashN : undefined,
  }))

  return (
    <div className="page">
      <div className={`page-inner wide ${tab === 'terminal' ? 'tall' : ''} enter`}>
        <PageHead crumbs={[{ label: t('Machines'), href: href.machines }, { label: machine.name }]}>
          {machine.kind !== 'local' && !ok && <button className="btn primary" onClick={connect} disabled={busy || machine.state === 'connecting'}><Icon name="plug" size={14} />{machine.state === 'error' ? t('Reconnect') : t('Connect')}</button>}
          {ok && <button className="btn" onClick={() => launchTerminal(ui.say, { machine: machine.id, kind: 'shell' })}><Icon name="terminal" size={14} />{t('Terminal')}</button>}
          {machine.kind !== 'local' && (
            <MoreMenu items={[
              { label: t('Edit'), icon: 'edit2', onSelect: () => go(href.nodes({ edit: machine.id })) },
              ok ? { label: t('Disconnect'), icon: 'unplug', onSelect: async () => { await host.disconnectNode(machine.id); reload() } } : { label: t('Connect'), icon: 'plug', onSelect: connect },
              '-',
              { label: t('Remove Node…'), icon: 'trash', danger: true, onSelect: remove },
            ]} />
          )}
        </PageHead>

        <div className={`mhead ${full ? '' : 'compact'}`}>
          <MachineIcon machine={machine} size={full ? 56 : 36} />
          <div className="mhead-text">
            <h1>{machine.name}<StateBadge state={machine.state} /></h1>
            <div className="mhead-meta">{spec}{system?.uptime != null ? ` · ${t('up {t}', { t: fmtUptime(system.uptime) })}` : ''}</div>
          </div>
          {full && ok && (
            <div className="gauges">
              <Gauge label="CPU" value={system?.cpuPercent} sub={system?.cpus ? t('{n} cores', { n: system.cpus }) : undefined} />
              <Gauge label={t('Memory')} value={system?.mem ? (system.mem.used / system.mem.total) * 100 : undefined} sub={system?.mem ? `${fmtBytes(system.mem.used)} / ${fmtBytes(system.mem.total)}` : undefined} />
              <Gauge label={t('Disk')} value={system?.disk ? (system.disk.used / system.disk.total) * 100 : undefined} sub={system?.disk ? `${fmtBytes(system.disk.used)} / ${fmtBytes(system.disk.total)}` : undefined} />
            </div>
          )}
        </div>

        {ok && machine.kind === 'ssh' && machine.sync?.phase === 'fetching' && machine.sync.bytesTotal > 0 && (
          <div className="sync-banner" role="status">
            <span className="spinner" />
            <span className="sync-text">
              <b>{t('Copying databases in the background')}</b>
              <span>{t('{done} of {total}. Sessions kept in databases (OpenCode, Hermes) appear when it is done.', { done: fmtBytes(machine.sync.bytesDone), total: fmtBytes(machine.sync.bytesTotal) })}</span>
            </span>
            <Bar value={(machine.sync.bytesDone / machine.sync.bytesTotal) * 100} />
          </div>
        )}

        {/* one floating bar: where you are in the machine on the leading side, the open list's tools on the trailing
            side; it stays above the content, which scrolls under its edge */}
        <div className="workbar">
          <div className="workbar-glass">
            <Tabs tabs={tabs} current={tab} />
            <div className="workbar-tools" ref={setSlot} />
          </div>
        </div>

        <ToolbarSlot.Provider value={slot}>
        {!ok ? <OfflinePanel machine={machine} busy={busy} onConnect={connect} />
          : tab === 'agents' ? <AgentsTab />
          : tab === 'projects' ? <ProjectsTab />
          : tab === 'sessions' ? <SessionsTab params={route.params} />
          : tab === 'terminal' ? <TerminalTab params={route.params} />
          : tab === 'monitor' ? <MonitorTab />
          : <TrashTab />}
        </ToolbarSlot.Provider>
      </div>
    </div>
  )
}
