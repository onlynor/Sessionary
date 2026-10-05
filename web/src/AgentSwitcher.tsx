import { useEffect, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { Icon } from './Icon'
import type { Agent } from './types'

/** Source selector: one compact control instead of three permanent cards. Keys 1–n switch directly. */
export function AgentSwitcher({ agents, value, onChange, onOverview }: { agents: Agent[]; value: string; onChange: (id: string) => void; onOverview: () => void }) {
  useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = agents.find((a) => a.id === value)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', off); addEventListener('keydown', key)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key) }
  }, [open])

  return (
    <div className="switcher" ref={ref}>
      <button className={`switcher-btn ${open ? 'pressed' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {value === 'all' ? <span className="all-tile"><Icon name="layers" size={14} /></span> : current && <AgentIcon agent={current.id} size={18} />}
        <span className="switcher-name">{value === 'all' ? t('All agents') : current?.label ?? t('Agents')}</span>
        <Icon name="updown" size={14} />
      </button>
      {open && (
        <div className="menu pop-in" role="menu">
          <div className="menu-label">{t('Source')}</div>
          <button role="menuitemradio" aria-checked={value === 'all'} className="menu-item" onClick={() => { onChange('all'); setOpen(false) }}>
            <Icon name="layers" /><span className="grow">{t('All agents')}</span>
            <span className="menu-meta">{agents.reduce((n, a) => n + a.sessionCount, 0)}</span>
            {value === 'all' ? <span className="check"><Icon name="check" size={14} /></span> : <kbd>0</kbd>}
          </button>
          {agents.map((a, i) => (
            <button key={a.id} role="menuitemradio" aria-checked={a.id === value} className="menu-item" disabled={!a.sessionCount && a.available}
              onClick={() => { onChange(a.id); setOpen(false) }} title={a.available ? undefined : t('Not found in {path}', { path: a.storage })}>
              <AgentIcon agent={a.id} size={16} />
              <span className="grow">{a.label}</span>
              <span className="menu-meta">{a.available ? a.sessionCount : t('not installed')}</span>
              {a.id === value ? <span className="check"><Icon name="check" size={14} /></span> : <kbd>{i + 1}</kbd>}
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onOverview(); setOpen(false) }}>
            <Icon name="layers" /><span className="grow">{t('Overview')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
