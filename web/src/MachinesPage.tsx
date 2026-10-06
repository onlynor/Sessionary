import { useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { launchTerminal } from './actions'
import { host } from './api'
import { relAgo } from './format'
import { Icon } from './Icon'
import { ActivityRow, useRecent } from './HomePage'
import { useMachines, useSystem, usable } from './machines'
import { go, href } from './route'
import { Bar, MachineIcon, MoreMenu, PageHead, StateBadge, fmtBytes, fmtUptime, machineTarget, syncText, useUi } from './ui'
import type { Machine, Summary } from './types'

/** one machine as a row: what it is, what it holds, what it is doing, and what you can do with it */
function MachineCard({ m, sum, onChanged }: { m: Machine; sum?: Summary; onChanged: () => void }) {
  useT()
  const ui = useUi()
  const { system } = useSystem(m)
  const run = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { ui.say((e as Error).message) } finally { onChanged() } }
  const agentsHere = sum?.agents.filter((a) => a.sessions > 0) ?? []
  const spec = [system?.os && system.os.replace(/\s*\(.*\)$/, ''), system?.cpus ? t('{n} cores', { n: system.cpus }) : undefined, system?.mem ? fmtBytes(system.mem.total) : undefined].filter(Boolean).join(' · ')
  return (
    <div className={`machine-card group-card ${usable(m) ? '' : 'is-off'}`}>
      <a className="mc-main" href={href.machine(m.id)}>
        <MachineIcon machine={m} size={44} />
        <span className="mc-title">
          <span className="mc-name"><span className="ellip">{m.name}</span><StateBadge state={m.state} /></span>
          <span className="mc-sub">{machineTarget(m)}{spec ? ` · ${spec}` : ''}{system?.uptime != null ? ` · ${t('up {t}', { t: fmtUptime(system.uptime) })}` : ''}</span>
          {m.state === 'error' && m.error && <span className="mc-err">{m.error}</span>}
          {(m.state === 'connecting' || m.sync?.phase === 'fetching') && <span className="mc-sub">{syncText(m)}</span>}
        </span>
        <span className="mc-counts">
          <span><b>{agentsHere.length}</b>{t('Agents')}</span>
          <span><b>{sum?.projects ?? '—'}</b>{t('Projects')}</span>
          <span><b>{sum?.sessions ?? '—'}</b>{t('Sessions')}</span>
        </span>
        <span className="mc-load">
          {system?.cpuPercent != null ? <><span className="r-meta">CPU {system.cpuPercent}%</span><Bar value={system.cpuPercent} /></> : null}
          {system?.mem ? <><span className="r-meta">{t('Memory')} {Math.round((system.mem.used / system.mem.total) * 100)}%</span><Bar value={(system.mem.used / system.mem.total) * 100} /></> : null}
        </span>
        <Icon name="chev" size={14} />
      </a>
      <div className="mc-foot">
        <span className="mc-agents">{agentsHere.map((a) => <span key={a.id} className="chip" title={`${a.label} · ${t('{n} sessions', { n: a.sessions })}`}><AgentIcon agent={a.id} size={12} />{a.sessions}</span>)}</span>
        <span className="grow" />
        {sum?.last && <span className="r-meta">{t('active {when}', { when: relAgo(sum.last) })}</span>}
        <MoreMenu items={[
          { label: t('Open'), icon: 'chev', onSelect: () => go(href.machine(m.id)) },
          { label: t('Open a terminal'), icon: 'terminal', onSelect: () => launchTerminal(ui.say, { machine: m.id, kind: 'shell' }), disabled: !usable(m) },
          { label: t('Monitor'), icon: 'activity', onSelect: () => go(href.machine(m.id, 'monitor')), disabled: !usable(m) },
          ...(m.kind === 'local' ? [] : [
            '-' as const,
            m.state === 'online' || m.state === 'connecting'
              ? { label: t('Disconnect'), icon: 'unplug', onSelect: () => run(() => host.disconnectNode(m.id)) }
              : { label: m.state === 'error' ? t('Reconnect') : t('Connect'), icon: 'plug', onSelect: () => run(() => host.connectNode(m.id)) },
            { label: t('Edit'), icon: 'edit2', onSelect: () => go(href.nodes({ edit: m.id })) },
          ]),
        ]} />
      </div>
    </div>
  )
}

/** Every machine, with what it is and what it holds; the way into any of them. */
export function MachinesPage() {
  useT()
  const { machines, reload } = useMachines()
  const { recent, sums } = useRecent(9)
  const [q, setQ] = useState('')
  const shown = useMemo(() => machines.filter((m) => !q.trim() || `${m.name} ${machineTarget(m)}`.toLowerCase().includes(q.trim().toLowerCase())), [machines, q])
  const online = machines.filter(usable).length
  const nSessions = machines.reduce((n, m) => n + (sums[m.id]?.sessions ?? 0), 0)

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Machines') }]}>
          <label className="field node-filter"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search machines')} aria-label={t('Search machines')} spellCheck={false} /></label>
          <button className="btn primary" onClick={() => go(href.nodes({ add: '1' }))}><Icon name="other" size={14} />{t('Add Node')}</button>
        </PageHead>
        <h1 className="page-title">{t('Machines')}</h1>
        <p className="page-lede">{t('Every computer whose agents you can reach from here. Open one to see its agents, projects and sessions.')}</p>

        <div className="two-col">
          <div className="col-main">
            {shown.map((m) => <MachineCard key={m.id} m={m} sum={sums[m.id]} onChanged={reload} />)}
            {!shown.length && <div className="empty-state">{t('No machine matches “{q}”.', { q })}</div>}
            <p className="quiet-note node-note">{t('{n} machines · {online} online · {s} sessions', { n: machines.length, online, s: nSessions })}</p>
          </div>
          <aside className="col-side">
            <div className="section-label">{t('Recent activity')}</div>
            <div className="group-card act-list">
              {recent.length ? recent.map((r) => <ActivityRow key={r.machine.id + r.session.id} r={r} />) : <div className="list-empty pad">{t('Nothing yet.')}</div>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
