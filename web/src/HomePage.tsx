import { useMemo } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { launchTerminal } from './actions'
import { cleanTitle, relTime } from './format'
import { Icon } from './Icon'
import { useMachines, useSummaries, usable } from './machines'
import { go, href } from './route'
import { MachineIcon, PageHead, StateBadge, StatusDot, machineTarget, useUi } from './ui'
import type { Machine, SessionSummary } from './types'

export interface Recent { machine: Machine; session: SessionSummary }

/** the latest sessions of every connected machine, newest first */
export function useRecent(limit = 8): { recent: Recent[]; sums: ReturnType<typeof useSummaries> } {
  const { machines } = useMachines()
  const sums = useSummaries(machines)
  const recent = useMemo(
    () => machines.flatMap((m) => (sums[m.id]?.recent ?? []).map((session) => ({ machine: m, session }))).sort((a, b) => b.session.updatedAt - a.session.updatedAt).slice(0, limit),
    [machines, sums, limit],
  )
  return { recent, sums }
}

export function ActivityRow({ r, action }: { r: Recent; action?: React.ReactNode }) {
  const s = r.session
  return (
    <div className="act-row">
      <a className="act-main" href={href.session(r.machine.id, s.id)}>
        <AgentIcon agent={s.agent} size={16} />
        <span className="t-main">
          <span className="r-title">{cleanTitle(s.title)}{s.active && <span className="live-dot" title={t('Active now')} />}</span>
          <span className="r-meta">{r.machine.name} · {s.project.generic ? t('No project') : s.project.name}</span>
        </span>
        <span className="r-meta">{relTime(s.updatedAt)}</span>
      </a>
      {action}
    </div>
  )
}

/** Where to start the day: what you were doing, on which machine, and a way back into it. */
export function HomePage({ machineId }: { machineId: string }) {
  useT()
  const ui = useUi()
  const { machines, loaded } = useMachines()
  const { recent, sums } = useRecent(7)
  const online = machines.filter(usable)
  const total = (f: (s: NonNullable<(typeof sums)[string]>) => number) => online.reduce((n, m) => n + (sums[m.id] ? f(sums[m.id]!) : 0), 0)
  const current = machines.find((m) => m.id === machineId) ?? machines[0]

  const tiles: [string, string, string][] = [
    [t('Machines online'), `${online.length} / ${machines.length}`, 'server'],
    [t('Sessions'), String(total((s) => s.sessions)), 'message'],
    [t('Projects'), String(total((s) => s.projects)), 'folder'],
    [t('Active now'), String(total((s) => s.active)), 'live'],
  ]

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Home') }]}>
          <button className="btn" onClick={() => go(href.nodes({ add: '1' }))}><Icon name="other" size={14} />{t('Add Node')}</button>
        </PageHead>
        <h1 className="page-title">{t('Home')}</h1>
        <p className="page-lede">{t('What your agents are doing, on every machine you have connected.')}</p>

        <div className="stat-row">{tiles.map(([l, v, icon]) => <div key={l} className="stat-card"><span className="stat-ic"><Icon name={icon} size={16} /></span><span className="stat-v">{v}</span><span className="stat-l">{l}</span></div>)}</div>

        <div className="section-label">{t('Continue where you left off')}</div>
        {!loaded ? <div className="sk-line" /> : !recent.length ? (
          <div className="empty-state"><span className="tile"><Icon name="message" size={28} stroke={1.5} /></span>{t('No sessions yet. Start an agent and it shows up here.')}</div>
        ) : (
          <div className="group-card act-list">
            {recent.map((r) => (
              <ActivityRow key={r.machine.id + r.session.id} r={r} action={
                <button className="btn sm" onClick={() => launchTerminal(ui.say, { machine: r.machine.id, kind: 'resume', sessionId: r.session.id })} title={t('Reopen this session in a terminal here')}><Icon name="play" size={12} />{t('Resume')}</button>
              } />
            ))}
          </div>
        )}

        <div className="section-label">{t('Machines')}</div>
        <div className="mini-machines">
          {machines.map((m) => (
            <a key={m.id} className="mini-machine group-card" href={href.machine(m.id)}>
              <MachineIcon machine={m} size={34} />
              <span className="t-main"><span className="r-title">{m.name}</span><span className="r-meta"><StatusDot state={m.state} />{machineTarget(m)}</span></span>
              <span className="r-meta">{usable(m) && sums[m.id] ? t('{n} sessions', { n: sums[m.id]!.sessions }) : <StateBadge state={m.state} />}</span>
            </a>
          ))}
        </div>

        <div className="section-label">{t('Quick actions')}</div>
        <div className="quick-grid">
          {current && <button className="quick" onClick={() => launchTerminal(ui.say, { machine: current.id, kind: 'shell' })} disabled={!usable(current)}><Icon name="terminal" size={18} /><b>{t('Open a terminal')}</b><span>{current.name}</span></button>}
          {current && <button className="quick" onClick={() => go(href.machine(current.id, 'monitor'))} disabled={!usable(current)}><Icon name="activity" size={18} /><b>{t('Monitor')}</b><span>{current.name}</span></button>}
          <button className="quick" onClick={() => go(href.machines)}><Icon name="layers" size={18} /><b>{t('All machines')}</b><span>{t('{n} connected', { n: machines.length })}</span></button>
          <button className="quick" onClick={() => go(href.nodes({ add: '1' }))}><Icon name="server" size={18} /><b>{t('Add Node')}</b><span>{t('Any machine you can reach over SSH')}</span></button>
          <button className="quick" onClick={() => dispatchEvent(new CustomEvent('sessionary:palette'))}><Icon name="search" size={18} /><b>{t('Search everything')}</b><span>Ctrl K</span></button>
        </div>
      </div>
    </div>
  )
}
