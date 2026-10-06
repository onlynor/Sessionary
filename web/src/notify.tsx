import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { host } from './api'
import { relTime } from './format'
import { usePersisted } from './hooks'
import { Icon } from './Icon'
import { go, href, useRoute, type Route } from './route'
import { Popover } from './SettingsMenu'
import { useUi } from './ui'

/**
 * Notices from the server (an agent went quiet, a node went away…) and what is done with them. The server only
 * reports; here it is decided whether to interrupt. The aim is few, useful interruptions: a notice is dropped if
 * it is switched off or you are already looking at it, the same thing is not said again soon, several at once are
 * said as one, and nothing is said more than once every few seconds. What you have seen or dismissed stays quiet,
 * and a page that is closed hears nothing.
 */
export interface Notice {
  id: string
  type: 'agent' | 'machine' | 'sync'
  code: 'agent.idle' | 'agent.exit' | 'chat.approval' | 'chat.done' | 'machine.down' | 'machine.up' | 'sync.done'
  key: string
  machine: string
  params: Record<string, string | number>
  at: number
}
interface Item extends Notice { read: boolean }

interface Settings { enabled: boolean; system: boolean; types: Record<Notice['type'], boolean>; snoozeUntil: number }
const DEFAULTS: Settings = { enabled: true, system: false, types: { agent: true, machine: true, sync: false }, snoozeUntil: 0 }

/** the same thing is not said again within this long */
const COOLDOWN: Record<Notice['type'], number> = { agent: 90_000, machine: 10 * 60_000, sync: 5 * 60_000 }
/** at most one interruption this often; what arrives meanwhile is said together */
const MIN_GAP = 8000
const KEEP = 40
/** things that deserve to pull you out of what you are doing; the rest wait in the list */
const LOUD = new Set<Notice['code']>(['agent.idle', 'agent.exit', 'chat.approval', 'chat.done', 'machine.down'])

/** what a notice says, in the current language */
export function noticeText(n: Notice): { title: string; body: string } {
  const p = n.params
  switch (n.code) {
    case 'agent.idle': return { title: t('{agent} is waiting for you', { agent: String(p.agent) }), body: `${p.title} · ${p.machineName}` }
    case 'agent.exit': return { title: t('{agent} exited', { agent: String(p.agent) }), body: `${p.title} · ${p.machineName}${Number(p.exit) > 0 ? ` · ${t('exit code {code}', { code: Number(p.exit) })}` : ''}` }
    case 'chat.approval': return { title: t('{agent} needs your approval', { agent: String(p.agent) }), body: `${String(p.title).slice(0, 80)} · ${p.machineName}` }
    case 'chat.done': return { title: t('{agent} finished', { agent: String(p.agent) }), body: `${String(p.preview || p.title).slice(0, 80)} · ${p.machineName}` }
    case 'machine.down': return { title: t('{machine} is not reachable', { machine: String(p.machineName) }), body: String(p.reason ?? '') }
    case 'machine.up': return { title: t('{machine} is back online', { machine: String(p.machineName) }), body: '' }
    case 'sync.done': return { title: t('{machine}: databases copied', { machine: String(p.machineName) }), body: t('Sessions kept in databases are available now.') }
  }
}
const isChat = (n: Notice) => n.code === 'chat.approval' || n.code === 'chat.done'
const hrefOf = (n: Notice) => (isChat(n) ? (n.params.session ? href.session(n.machine, String(n.params.session)) : href.chat(n.machine, String(n.params.chat))) : n.type === 'agent' ? href.machine(n.machine, 'terminal', { t: String(n.params.term) }) : n.code === 'sync.done' ? href.machine(n.machine, 'sessions') : href.machine(n.machine))

/** whether the reader is already looking at what the notice is about */
function watching(n: Notice, route: Route): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false
  if (isChat(n)) return (route.page === 'session' && route.machine === n.machine && route.id === n.params.session) || (route.page === 'chat' && route.machine === n.machine && route.id === n.params.chat)
  if (route.page !== 'machine' || route.machine !== n.machine) return false
  return n.type === 'agent' ? route.tab === 'terminal' && route.params.get('t') === String(n.params.term) : true
}

interface NotifyState {
  items: (Item & { title: string; body: string })[]
  unread: number
  unreadFor: (machine: string) => number
  unreadTerm: (id: string) => boolean
  settings: Settings
  setSettings: (s: Settings) => void
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => Promise<void>
  open: (n: Notice) => void
  markAllRead: () => void
  pause: (minutes: number) => void
}
const Ctx = createContext<NotifyState | null>(null)
export const useNotify = () => { const c = useContext(Ctx); if (!c) throw new Error('no notify'); return c }

const STORE = 'sessionary:notices'
const loadItems = (): Item[] => { try { return JSON.parse(localStorage.getItem(STORE) ?? '[]') } catch { return [] } }

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const route = useRoute()
  const ui = useUi()
  const [settings, setSettings] = usePersisted<Settings>('notify', DEFAULTS)
  const [items, setItems] = useState<Item[]>(loadItems)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
  const s: Settings = { ...DEFAULTS, ...settings, types: { ...DEFAULTS.types, ...settings.types } }
  const live = useRef({ s, route, ui, permission })
  live.current = { s, route, ui, permission }
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(items.slice(0, KEEP))) } catch { /* private mode */ } }, [items])

  const markRead = useCallback((pred: (n: Item) => boolean) => setItems((l) => (l.some((n) => !n.read && pred(n)) ? l.map((n) => (!n.read && pred(n) ? { ...n, read: true } : n)) : l)), [])

  // ---- interrupting: at most one interruption per MIN_GAP, with everything that piled up said together ----
  const queue = useRef<Notice[]>([])
  const lastShown = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((batch: Notice[]) => {
    const { s, ui, permission } = live.current
    const first = noticeText(batch[0]!)
    const title = batch.length === 1 ? first.title : t('{n} updates', { n: batch.length })
    const body = batch.length === 1 ? first.body : batch.slice(0, 3).map((n) => noticeText(n).title).join(' · ')
    const looking = document.visibilityState === 'visible' && document.hasFocus()
    if (!looking) {
      // the page is in the background: a desktop notification, but only for what is worth it, and only if allowed
      if (!s.system || permission !== 'granted' || !batch.some((n) => LOUD.has(n.code))) return
      try {
        const n = new Notification(title, { body, tag: batch.length === 1 ? batch[0]!.key : 'sessionary', silent: false })
        const ids = new Set(batch.map((b) => b.id))
        n.onclick = () => { window.focus(); go(hrefOf(batch[0]!)); markRead((x) => ids.has(x.id)); n.close() }
        // dismissing it counts as having dealt with it
        n.onclose = () => markRead((x) => ids.has(x.id))
        setTimeout(() => n.close(), 10_000)
      } catch { /* a browser that refuses: the list still has it */ }
      return
    }
    ui.say(body ? `${title} — ${body}` : title)
  }, [markRead])
  const flush = useCallback(() => {
    if (timer.current != null) return
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      const batch = queue.current.splice(0)
      if (!batch.length) return
      lastShown.current = Date.now()
      show(batch)
    }, Math.max(0, lastShown.current + MIN_GAP - Date.now()))
  }, [show])

  // ---- hearing from the server ----
  const said = useRef(new Map<string, number>())
  const hear = useCallback((n: Notice) => {
    const { s, route } = live.current
    if (!s.enabled || !s.types[n.type]) return
    const last = said.current.get(n.key)
    if (last && Date.now() - last < COOLDOWN[n.type]) return // the same thing, too soon
    said.current.set(n.key, Date.now())
    if (watching(n, route)) return // you are looking at it
    setItems((l) => [{ ...n, read: false }, ...l].slice(0, KEEP))
    if (Date.now() < s.snoozeUntil) return // paused: it waits in the list
    queue.current.push(n)
    flush()
  }, [flush])

  useEffect(() => {
    if (!s.enabled) return
    let es: EventSource | undefined
    let closed = false
    host.notifications().then((e) => {
      if (closed) return e.close()
      es = e
      e.addEventListener('notice', (ev) => hear(JSON.parse((ev as MessageEvent).data) as Notice))
    })
    return () => { closed = true; es?.close() }
  }, [s.enabled, hear])
  useEffect(() => () => clearTimeout(timer.current), [])

  // going to what a notice is about is reading it, once you are really there to see it
  const [looking, setLooking] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
  useEffect(() => {
    const on = () => setLooking(document.visibilityState === 'visible' && document.hasFocus())
    addEventListener('focus', on); addEventListener('blur', on); document.addEventListener('visibilitychange', on)
    return () => { removeEventListener('focus', on); removeEventListener('blur', on); document.removeEventListener('visibilitychange', on) }
  }, [])
  useEffect(() => {
    if (!looking) return
    markRead((n) => {
      if (route.page !== 'machine' || route.machine !== n.machine) return false
      return n.type === 'agent' ? route.tab === 'terminal' && route.params.get('t') === String(n.params.term) : n.type !== 'sync' || route.tab === 'sessions' || route.tab === 'agents'
    })
  }, [route, markRead, items.length, looking])

  const view = useMemo(() => items.filter((n) => s.types[n.type] || n.read).map((n) => ({ ...n, ...noticeText(n) })), [items, s.types.agent, s.types.machine, s.types.sync, t('Notifications')])
  const unreadItems = view.filter((n) => !n.read)
  useEffect(() => { document.title = unreadItems.length && s.enabled ? `(${unreadItems.length}) Sessionary` : 'Sessionary' }, [unreadItems.length, s.enabled])

  const value: NotifyState = {
    items: view, unread: s.enabled ? unreadItems.length : 0,
    unreadFor: (m) => (s.enabled ? unreadItems.filter((n) => n.machine === m).length : 0),
    unreadTerm: (id) => s.enabled && unreadItems.some((n) => n.type === 'agent' && String(n.params.term) === id),
    settings: s, setSettings: (x) => setSettings(x),
    permission,
    requestPermission: async () => {
      if (typeof Notification === 'undefined') return
      setPermission(await Notification.requestPermission())
    },
    open: (n) => { markRead((x) => x.id === n.id); go(hrefOf(n)) },
    markAllRead: () => markRead(() => true),
    pause: (minutes) => setSettings({ ...s, snoozeUntil: minutes ? Date.now() + minutes * 60_000 : 0 }),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function Switch({ on, label, onChange, hint, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }) {
  return (
    <button className="menu-item switch-row" role="menuitemcheckbox" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="grow"><span>{label}</span>{hint && <span className="sw-hint">{hint}</span>}</span>
      <span className={`switch ${on ? 'on' : ''}`} aria-hidden="true"><span /></span>
    </button>
  )
}

/** the bell's panel: what happened, and how loud to be about it */
export function NotifyPanel({ at, onClose }: { at: { left: number; top?: number; bottom?: number }; onClose: () => void }) {
  useT()
  const n = useNotify()
  const s = n.settings
  const paused = Date.now() < s.snoozeUntil
  return (
    <Popover at={at} onClose={onClose} label={t('Notifications')} width={340} solid>
      <div className="np-head"><b>{t('Notifications')}</b><span className="grow" />{n.unread > 0 && <button className="link" onClick={n.markAllRead}>{t('Mark all read')}</button>}</div>
      <div className="np-list">
        {!n.items.length ? <div className="menu-empty">{s.enabled ? t('Nothing new.') : t('Notifications are off.')}</div> : n.items.slice(0, 12).map((x) => (
          <button key={x.id} className={`np-item ${x.read ? '' : 'unread'}`} onClick={() => { n.open(x); onClose() }}>
            <span className="np-ic"><Icon name={x.code === 'machine.down' || x.code === 'agent.exit' ? 'warn' : x.code === 'agent.idle' || x.code === 'chat.approval' || x.code === 'chat.done' ? 'bell' : 'ok'} size={14} /></span>
            <span className="np-text"><b>{x.title}</b>{x.body && <span>{x.body}</span>}</span>
            <span className="r-meta">{relTime(x.at)}</span>
          </button>
        ))}
      </div>
      <div className="menu-sep" />
      <Switch on={s.enabled} label={t('Notifications')} onChange={(v) => n.setSettings({ ...s, enabled: v })} />
      {s.enabled && (
        <>
          <Switch on={s.types.agent} label={t('An agent is waiting for you or has exited')} onChange={(v) => n.setSettings({ ...s, types: { ...s.types, agent: v } })} />
          <Switch on={s.types.machine} label={t('A machine becomes unreachable or comes back')} onChange={(v) => n.setSettings({ ...s, types: { ...s.types, machine: v } })} />
          <Switch on={s.types.sync} label={t('A large copy from a node finishes')} onChange={(v) => n.setSettings({ ...s, types: { ...s.types, sync: v } })} />
          <Switch on={s.system && n.permission === 'granted'} disabled={n.permission === 'unsupported' || n.permission === 'denied'} label={t('Desktop notifications when this page is in the background')}
            hint={n.permission === 'denied' ? t('Blocked in your browser’s site settings.') : n.permission === 'unsupported' ? t('This browser cannot show them.') : undefined}
            onChange={async (v) => { if (v && n.permission !== 'granted') await n.requestPermission(); n.setSettings({ ...s, system: v }) }} />
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => n.pause(paused ? 0 : 60)}>
            <Icon name={paused ? 'bell' : 'bell-off'} /><span className="grow">{paused ? t('Paused until {time} · Resume', { time: new Date(s.snoozeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('Pause for 1 hour')}</span>
          </button>
        </>
      )}
    </Popover>
  )
}
