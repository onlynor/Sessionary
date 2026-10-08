import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, useT } from './i18n'
import { api, controlApi } from './api'
import { Icon } from './Icon'
import { Popover } from './SettingsMenu'
import type { CtlAgent, CtlGroup, CtlPreset, CtlProvider, CtlState, Machine, Protocol, RouteEvent } from './types'

/**
 * Model Control on the page: one copy of the state for every page that shows it (Models, Routing, Gateway, Usage,
 * the agent cards), kept current by the gateway's `route` events. It is this computer's, whichever machine is open.
 */
interface ControlCtx {
  state?: CtlState
  error?: string
  reload: () => Promise<void>
  /** decisions as they happen, newest last; seeded from the server's recent ones */
  events: RouteEvent[]
}
const Ctx = createContext<ControlCtx>({ reload: async () => {}, events: [] })
export const useControl = () => useContext(Ctx)

export function ControlProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CtlState>()
  const [error, setError] = useState<string>()
  const [events, setEvents] = useState<RouteEvent[]>([])
  const seeded = useRef(false)
  const reload = useCallback(async () => {
    try {
      const s = await controlApi.state()
      setState(s); setError(undefined)
      if (!seeded.current) { seeded.current = true; setEvents(s.recent) }
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    const es = api.events()
    let timer: ReturnType<typeof setTimeout> | undefined
    es.addEventListener('route', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as RouteEvent
      setEvents((l) => [...l.slice(-199), e])
      // health (who rests, who answers) changes with each outcome; read it again once things settle
      if (e.phase !== 'trying') { clearTimeout(timer); timer = setTimeout(reload, 400) }
    })
    return () => { es.close(); clearTimeout(timer) }
  }, [reload])
  const value = useMemo(() => ({ state, error, reload, events }), [state, error, reload, events])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// ---------- names and marks ----------
export const AGENT_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', hermes: 'Hermes' }
export const PROTOCOL_NAME: Record<Protocol, string> = { anthropic: 'Anthropic Messages', chat: 'OpenAI Chat', responses: 'OpenAI Responses' }

/** A provider's mark: its initials on a tint of its own. No vendor logos are shipped. */
export function ProviderMark({ provider, presets, size = 28 }: { provider?: Pick<CtlProvider, 'name' | 'preset'> | Pick<CtlPreset, 'name' | 'hue'>; presets?: CtlPreset[]; size?: number }) {
  const name = provider?.name ?? '?'
  const hue = provider && 'hue' in provider ? provider.hue : presets?.find((p) => provider && 'preset' in provider && p.id === provider.preset)?.hue ?? hashHue(name)
  const letters = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean)
  const mono = (letters.length > 1 ? letters[0]![0]! + letters[1]![0]! : (letters[0] ?? '?').slice(0, 2)).toUpperCase()
  return (
    <span className="pmark" style={{ width: size, height: size, fontSize: Math.round(size * (mono.length > 1 ? 0.36 : 0.44)), '--h': hue } as React.CSSProperties} aria-hidden="true">{mono}</span>
  )
}
const hashHue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

export function GroupMark({ size = 28 }: { size?: number }) {
  return <span className="pmark group" style={{ width: size, height: size }} aria-hidden="true"><Icon name="route" size={Math.round(size * 0.55)} /></span>
}

/** a short count: 980 · 12.3K · 4.5M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

/** what a target is called on the page: a group by its name, a model by its name and provider */
/**
 * The routable agents on one machine and the route each starts on there. This computer's come with the state; a
 * node's are asked for, again whenever any route changes (a node inherits from the default for every machine).
 */
export function useMachineRoutes(machine: Pick<Machine, 'id' | 'kind'>): CtlAgent[] | undefined {
  const { state } = useControl()
  const [agents, setAgents] = useState<CtlAgent[]>()
  useEffect(() => {
    if (machine.kind === 'local') { setAgents(state?.agents); return }
    if (machine.kind !== 'ssh' || !state) { setAgents(undefined); return }
    let live = true
    controlApi.agents(machine.id).then((a) => live && setAgents(a), () => live && setAgents(undefined))
    return () => { live = false }
  }, [machine.id, machine.kind, state])
  return agents
}

export function describeTarget(state: CtlState | undefined, target: string): { title: string; sub: string; provider?: CtlProvider; group?: CtlGroup; missing: boolean } {
  if (target.startsWith('group/')) {
    const g = state?.groups.find((x) => x.id === target.slice(6))
    return { title: g?.name ?? target, sub: target, group: g, missing: !g }
  }
  const i = target.indexOf('/')
  const p = state?.providers.find((x) => x.id === target.slice(0, i))
  const m = p?.models.find((x) => x.id === target.slice(i + 1))
  return { title: m?.name ?? target.slice(i + 1), sub: p ? p.name : target, provider: p, missing: !p }
}

/** the mark for a target */
export function TargetMark({ target, size = 22 }: { target: string; size?: number }) {
  const { state } = useControl()
  const d = describeTarget(state, target)
  return d.group || target.startsWith('group/') ? <GroupMark size={size} /> : <ProviderMark provider={d.provider ?? { name: d.sub, preset: '' }} presets={state?.presets} size={size} />
}

// ---------- the picker ----------
interface PickerProps {
  at: { left: number; top?: number; bottom?: number }
  value?: string
  onPick: (target: string) => void
  onClose: () => void
  /** offer "Default" first, named after what the agent ships with */
  defaultLabel?: string
  /** dim what the gateway could not relay to this protocol */
  protocol?: Protocol
  /** offer routing groups (a group's own members cannot be groups) */
  groups?: boolean
  /** leave out what is already chosen */
  exclude?: string[]
}

/** Every model of every provider, and every routing group, in one searchable list (`provider/model`, `group/name`). */
export function ModelPicker({ at, value, onPick, onClose, defaultLabel, protocol, groups = true, exclude = [] }: PickerProps) {
  useT()
  const { state } = useControl()
  const [q, setQ] = useState('')
  const [rail, setRail] = useState<string>('all')
  const [kb, setKb] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const skip = new Set(exclude)

  type Item = { target: string; title: string; sub: string; section: string; provider?: CtlProvider; usable: boolean; isGroup?: boolean }
  const items = useMemo<Item[]>(() => {
    if (!state) return []
    const out: Item[] = []
    if (groups) for (const g of state.groups) {
      const target = `group/${g.id}`
      // a group can serve the agent when at least one member's provider speaks its protocol
      const serves = !protocol || g.members.some((m) => !!state.providers.find((p) => p.id === m.slice(0, m.indexOf('/')))?.endpoints[protocol])
      out.push({ target, title: g.name, sub: target, section: t('Routing groups'), usable: g.on && g.members.length > 0 && serves, isGroup: true })
    }
    for (const p of state.providers) for (const m of p.models) {
      if (!m.on) continue
      out.push({ target: `${p.id}/${m.id}`, title: m.name ?? m.id, sub: m.name && m.name !== m.id ? m.id : p.name, section: p.name, provider: p, usable: p.on && (!protocol || !!p.endpoints[protocol]) })
    }
    return out.filter((i) => !skip.has(i.target))
  }, [state, groups, protocol, exclude.join()])

  const needle = q.trim().toLowerCase()
  const shown = items.filter((i) => (rail === 'all' || (rail === 'groups' ? i.isGroup : i.provider?.id === rail)) && (!needle || `${i.title} ${i.target} ${i.sub}`.toLowerCase().includes(needle)))
  // a typed id that matches nothing can still be picked: some relays answer models they do not list
  const typed = needle && !shown.length && /^[\w.-]+\/[\w.:@+/-]+$/.test(q.trim()) ? q.trim() : undefined
  const rows: ({ kind: 'default' } | { kind: 'item'; item: Item } | { kind: 'typed'; id: string })[] = [
    ...(defaultLabel && !needle && rail === 'all' ? [{ kind: 'default' as const }] : []),
    ...shown.map((item) => ({ kind: 'item' as const, item })),
    ...(typed ? [{ kind: 'typed' as const, id: typed }] : []),
  ]
  useEffect(() => { setKb(0) }, [q, rail])
  useEffect(() => { listRef.current?.querySelector('.kb')?.scrollIntoView({ block: 'nearest' }) }, [kb])
  const pick = (r: (typeof rows)[number]) => { onPick(r.kind === 'default' ? '' : r.kind === 'typed' ? r.id : r.item.target); onClose() }

  let lastSection = ''
  // in the body, not the page: the page's entrance animation leaves a transform that would capture a fixed popover
  return createPortal(
    <Popover at={at} onClose={onClose} label={t('Choose a model')} width={420} solid>
      <div className="picker" onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setKb((k) => Math.min(rows.length - 1, k + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setKb((k) => Math.max(0, k - 1)) }
        else if (e.key === 'Enter' && rows[kb]) { e.preventDefault(); pick(rows[kb]!) }
      }}>
        <div className="menu-search"><Icon name="search" size={13} /><input ref={(el) => { if (el && document.activeElement !== el) el.focus({ preventScroll: true }) }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Filter, or type any provider/model')} aria-label={t('Filter models')} /></div>
        <div className="picker-body">
          <div className="picker-rail" role="tablist" aria-label={t('Providers')}>
            <button role="tab" aria-selected={rail === 'all'} className={rail === 'all' ? 'on' : ''} onClick={() => setRail('all')} title={t('Everything')}><Icon name="grid" size={15} /></button>
            {groups && !!state?.groups.length && <button role="tab" aria-selected={rail === 'groups'} className={rail === 'groups' ? 'on' : ''} onClick={() => setRail('groups')} title={t('Routing groups')}><Icon name="route" size={15} /></button>}
            <span className="picker-rail-sep" />
            {state?.providers.filter((p) => p.models.some((m) => m.on)).map((p) => (
              <button key={p.id} role="tab" aria-selected={rail === p.id} className={rail === p.id ? 'on' : ''} onClick={() => setRail(p.id)} title={p.name}><ProviderMark provider={p} presets={state.presets} size={22} /></button>
            ))}
          </div>
          <div className="picker-list" ref={listRef} role="listbox" aria-label={t('Models')}>
            {!state ? <div className="menu-empty"><span className="spinner" /></div>
              : !rows.length ? <div className="menu-empty">{items.length ? t('Nothing matches.') : t('No models yet. Add a provider first.')}</div>
              : rows.map((r, i) => {
                if (r.kind === 'default') return (
                  <button key="default" role="option" aria-selected={!value} className={`picker-item ${kb === i ? 'kb' : ''} ${!value ? 'cur' : ''}`} onMouseEnter={() => setKb(i)} onClick={() => pick(r)}>
                    <span className="pmark ghost" style={{ width: 22, height: 22 }}><Icon name="unplug" size={12} /></span>
                    <span className="grow ellip"><b>{t('Default')}</b> <span className="pi-sub">{defaultLabel}</span></span>
                    {!value && <Icon name="check" size={14} />}
                  </button>
                )
                if (r.kind === 'typed') return (
                  <button key="typed" role="option" aria-selected={false} className={`picker-item ${kb === i ? 'kb' : ''}`} onMouseEnter={() => setKb(i)} onClick={() => pick(r)}>
                    <span className="pmark ghost" style={{ width: 22, height: 22 }}><Icon name="other" size={12} /></span>
                    <span className="grow ellip">{t('Use “{id}”', { id: r.id })}</span>
                  </button>
                )
                const it = r.item
                const head = it.section !== lastSection && rail === 'all' ? it.section : undefined
                lastSection = it.section
                return (
                  <div key={it.target}>
                    {head && <div className="menu-label">{head}</div>}
                    <button role="option" aria-selected={value === it.target} className={`picker-item ${kb === i ? 'kb' : ''} ${value === it.target ? 'cur' : ''} ${it.usable ? '' : 'dim'}`} onMouseEnter={() => setKb(i)} onClick={() => pick(r)}
                      title={!it.usable && protocol ? (it.isGroup ? t('No model in this group speaks {protocol}, so this agent cannot use it.', { protocol: PROTOCOL_NAME[protocol] }) : t('Its provider has no {protocol} endpoint, so this agent cannot use it.', { protocol: PROTOCOL_NAME[protocol] })) : it.target}>
                      {it.isGroup ? <GroupMark size={22} /> : <ProviderMark provider={it.provider} presets={state.presets} size={22} />}
                      <span className="grow ellip"><b>{it.title}</b> <span className="pi-sub">{it.sub}</span></span>
                      {value === it.target && <Icon name="check" size={14} />}
                    </button>
                  </div>
                )
              })}
          </div>
        </div>
      </div>
    </Popover>,
    document.body,
  )
}

/** a button showing the chosen model or group that opens the picker */
export function TargetButton({ value, onChange, defaultLabel, protocol, groups, placeholder, disabled }: {
  value?: string; onChange: (target: string) => void; defaultLabel?: string; protocol?: Protocol; groups?: boolean; placeholder?: string; disabled?: boolean
}) {
  useT()
  const { state } = useControl()
  const [at, setAt] = useState<{ left: number; top: number }>()
  const d = value ? describeTarget(state, value) : undefined
  return (
    <>
      <button className={`target-btn ${at ? 'on' : ''} ${d?.missing ? 'missing' : ''}`} disabled={disabled} aria-haspopup="listbox"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? undefined : { left: Math.max(8, r.right - 420), top: r.bottom + 6 }) }}>
        {value ? <TargetMark target={value} size={20} /> : <span className="pmark ghost" style={{ width: 20, height: 20 }}><Icon name="unplug" size={11} /></span>}
        <span className="grow ellip">{d ? <><b>{d.title}</b> <span className="tb-sub">{d.sub}</span></> : <span className="tb-sub">{placeholder ?? t('Default')}</span>}</span>
        <Icon name="updown" size={13} />
      </button>
      {at && <ModelPicker at={at} value={value} onPick={onChange} onClose={() => setAt(undefined)} defaultLabel={defaultLabel} protocol={protocol} groups={groups} />}
    </>
  )
}

/** "rate limited · back in 35 s" */
export function restText(until: number, why?: string): string {
  const s = Math.max(1, Math.round((until - Date.now()) / 1000))
  const when = s < 90 ? t('{n} s', { n: s }) : t('{n} min', { n: Math.round(s / 60) })
  return t('{why} · back in {when}', { why: whyText(why), when })
}
export function whyText(why?: string): string {
  switch (why) {
    case 'rate-limited': return t('rate limited')
    case 'key-refused': return t('key refused')
    case 'out-of-credit': return t('out of credit')
    case 'not-found': return t('model not found')
    case 'unreachable': return t('unreachable')
    case 'upstream-error': return t('upstream error')
    case 'request-refused': return t('request refused')
    case 'cancelled': return t('cancelled')
    default: return why ?? ''
  }
}

/** a 1-second tick, for "back in 35 s" */
export function useTick(on = true, ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => { if (!on) return; const id = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(id) }, [on, ms])
}

/** an on/off switch, as in System Settings */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onChange(!on) }}><span /></button>
}

/** the host of an address, for a list row: `api.deepseek.com` */
export const hostOf = (url?: string) => { try { return url ? new URL(url).host : '' } catch { return url ?? '' } }
