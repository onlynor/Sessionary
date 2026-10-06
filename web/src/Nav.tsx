import { useState } from 'react'
import { t, useT } from './i18n'
import { Icon } from './Icon'
import { useMachines } from './machines'
import { go, href, type MachineTab, type Route } from './route'
import { NotifyPanel, useNotify } from './notify'
import { Popover } from './SettingsMenu'
import { MachineIcon, StatusDot, machineTarget } from './ui'

/** Which machine the scoped entries (Agents, Projects, …) act on: the open one, else the last one used. */
export function Nav({ route, machineId, collapsed, onCollapse, onPalette, onSettings, trashCount }: {
  route: Route; machineId: string; collapsed: boolean; onCollapse: () => void; onPalette: () => void; onSettings: (anchor: HTMLElement) => void; trashCount: number
}) {
  useT()
  const { machines } = useMachines()
  const [pick, setPick] = useState<{ left: number; top: number }>()
  const notify = useNotify()
  const [bell, setBell] = useState<{ left: number; bottom: number }>()
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]
  const tab: MachineTab | null = route.page === 'machine' ? route.tab : route.page === 'agent' ? 'agents' : route.page === 'session' ? 'sessions' : null
  const online = machines.filter((m) => m.state === 'online' || m.kind === 'local').length

  const item = (id: string, icon: string, label: string, to: string, on: boolean, meta?: React.ReactNode) => (
    <a key={id} className={`nav-i ${on ? 'on' : ''}`} href={to} aria-current={on ? 'page' : undefined} title={collapsed ? label : undefined}>
      <Icon name={icon} size={collapsed ? 18 : 16} /><span className="nav-label">{label}</span>{meta != null && <span className="meta">{meta}</span>}
    </a>
  )
  const scoped = (tabId: MachineTab, icon: string, label: string, meta?: React.ReactNode) => item(tabId, icon, label, href.machine(machine?.id ?? 'local', tabId), tab === tabId && route.page !== 'home' && (route.page === 'machine' || route.page === 'agent' || route.page === 'session') && (route as { machine: string }).machine === machine?.id, meta)
  // something is waiting on the machines that are not open
  const elsewhere = machines.filter((m) => m.id !== machine?.id).reduce((n, m) => n + notify.unreadFor(m.id), 0)

  return (
    <nav className="nav" aria-label={t('Navigation')}>
      <div className="nav-head">
        <img className="brand-mark" src="/favicon-32.png" alt="" width={24} height={24} />
        <span className="nav-label brand-name">Sessionary</span>
        <button className="tb-btn nav-collapse" onClick={onCollapse} title={`${collapsed ? t('Expand sidebar') : t('Collapse sidebar')}  [`} aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}><Icon name={collapsed ? 'sidebar-open' : 'sidebar'} /></button>
      </div>

      <button className="nav-search" onClick={onPalette} title={`${t('Search all sessions and messages')}  Ctrl K`}>
        <Icon name="search" size={collapsed ? 18 : 14} /><span className="nav-label">{t('Search')}</span><kbd className="nav-label">Ctrl K</kbd>
      </button>

      <div className="nav-group">
        {item('home', 'home', t('Home'), href.home, route.page === 'home')}
        {item('machines', 'layers', t('Machines'), href.machines, route.page === 'machines', machines.length)}
      </div>

      {machine && (
        <div className="nav-group nav-machine">
          <div className="nav-section nav-label">{t('Machine')}</div>
          <button className="machine-switch" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick(pick ? undefined : { left: r.left, top: r.bottom + 6 }) }}
            aria-haspopup="menu" aria-expanded={!!pick} title={collapsed ? machine.name : t('Switch machine')}>
            <MachineIcon machine={machine} size={collapsed ? 30 : 28} />
            <span className="nav-label ms-text"><span className="ms-name">{machine.name}</span><span className="ms-sub"><StatusDot state={machine.state} />{machineTarget(machine)}</span></span>
            <span className="nav-label ms-chev">{elsewhere > 0 && <span className="alert-dot" title={t('Something on another machine needs you')} />}<Icon name="updown" size={14} /></span>
            {elsewhere > 0 && <span className="alert-dot corner" aria-hidden="true" />}
          </button>
          {scoped('agents', 'task', t('Agents'))}
          {scoped('projects', 'folder', t('Projects'))}
          {scoped('sessions', 'message', t('Sessions'))}
          {scoped('terminal', 'terminal', t('Terminal'), machine && notify.unreadFor(machine.id) > 0 ? <span className="alert-dot" title={t('Something here needs you')} /> : undefined)}
          {scoped('monitor', 'activity', t('Monitor'))}
        </div>
      )}

      <span className="grow" />
      <div className="nav-group nav-foot">
        {item('trash', 'trash', t('Trash'), href.machine(machine?.id ?? 'local', 'trash'), route.page === 'machine' && route.tab === 'trash', trashCount > 0 ? trashCount : undefined)}
        {item('nodes', 'server', t('Nodes'), href.nodes(), route.page === 'nodes')}
        <button className={`nav-i ${notify.unread > 0 ? 'alert' : ''}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setBell(bell ? undefined : { left: r.left, bottom: innerHeight - r.top + 6 }) }} title={collapsed ? t('Notifications') : undefined} aria-haspopup="menu">
          <Icon name={notify.settings.enabled ? 'bell' : 'bell-off'} size={collapsed ? 18 : 16} /><span className="nav-label">{t('Notifications')}</span>{notify.unread > 0 && <span className="meta badge">{notify.unread > 9 ? '9+' : notify.unread}</span>}
        </button>
        <button className="nav-i" onClick={(e) => onSettings(e.currentTarget)} title={collapsed ? t('Settings') : undefined}><Icon name="settings" size={collapsed ? 18 : 16} /><span className="nav-label">{t('Settings')}</span></button>
        <div className="nav-status nav-label"><span className="dot ok" />{t('{n} of {total} machines online', { n: online, total: machines.length })}</div>
      </div>

      {bell && <NotifyPanel at={bell} onClose={() => setBell(undefined)} />}
      {pick && (
        <Popover at={pick} onClose={() => setPick(undefined)} label={t('Switch machine')} width={264}>
          <div className="menu-label">{t('Machines')}</div>
          {machines.map((m) => (
            <button key={m.id} className="menu-item machine-pick" role="menuitemradio" aria-checked={m.id === machine?.id} onClick={() => { setPick(undefined); go(href.machine(m.id, tab ?? 'agents')) }}>
              <StatusDot state={m.state} /><span className="grow"><b>{m.name}</b><span className="mp-sub">{machineTarget(m)}</span></span>
              {notify.unreadFor(m.id) > 0 && m.id !== machine?.id && <span className="meta badge">{notify.unreadFor(m.id)}</span>}
              {m.id === machine?.id && <span className="check"><Icon name="check" size={14} /></span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { setPick(undefined); go(href.nodes({ add: '1' })) }}><Icon name="other" /><span className="grow">{t('Add Node')}</span></button>
          <button className="menu-item" onClick={() => { setPick(undefined); go(href.nodes()) }}><Icon name="server" /><span className="grow">{t('Manage nodes')}</span></button>
        </Popover>
      )}
    </nav>
  )
}
