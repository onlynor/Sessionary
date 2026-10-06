import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LANGS, LangProvider, setLang, t, useLang, useT } from './i18n'
import { AgentPage } from './AgentPage'
import { launchTerminal } from './actions'
import { host } from './api'
import { Confirm, type ConfirmSpec } from './Confirm'
import { HomePage } from './HomePage'
import { Icon } from './Icon'
import { LayoutCtx } from './layout'
import { useHotkeys } from './hotkeys'
import { useMedia, usePersisted, useWindowActive } from './hooks'
import { MachinePage } from './MachinePage'
import { MachineProvider, MachinesProvider, useMachine, useMachines } from './machines'
import { MachinesPage } from './MachinesPage'
import { Nav } from './Nav'
import { NotifyProvider } from './notify'
import { NodesPage } from './NodesPage'
import { Palette } from './Palette'
import { Prompt, type PromptSpec } from './Prompt'
import { go, href, useRoute, type Route } from './route'
import { SessionPage } from './SessionPage'
import { ChatPage } from './ChatPage'
import { SettingsMenu } from './SettingsMenu'
import { Toast, type ToastMsg } from './Toast'
import { useTheme } from './theme'
import { UiContext } from './ui'
import type { Machine } from './types'

const SHORTCUTS: [string, string][] = [
  ['Ctrl K', 'Search all sessions and messages'], ['Ctrl F', 'Find in this conversation'], ['/', 'Filter the session list'],
  ['Delete', 'Move session to Trash (also Ctrl ⌫)'], ['Alt ↑ / ↓', 'Previous / next prompt'], ['E', 'Expand or collapse all steps'], ['P', 'Pin or unpin the session'],
  ['Shift R', 'Resume in a terminal'], ['[', 'Collapse or expand the sidebar'], [']', 'Toggle project context'], ['?', 'This sheet'],
]

/** the machine the page is about: the one in the URL, else the last one used */
function currentMachine(route: Route, machines: Machine[], last: string): Machine | undefined {
  const wanted = 'machine' in route ? route.machine : last
  return machines.find((m) => m.id === wanted) ?? machines.find((m) => m.id === last) ?? machines[0]
}

export function App() {
  useWindowActive()
  const lang = useLang()
  return (
    <LangProvider lang={lang}>
      <MachinesProvider><Shell /></MachinesProvider>
    </LangProvider>
  )
}

function Shell() {
  useT()
  const lang = useLang()
  const [theme, setTheme] = useTheme()
  const route = useRoute()
  const { machines, loaded, down } = useMachines()
  const [last, setLast] = usePersisted<string>('machine', 'local')
  const machine = currentMachine(route, machines, last)
  useEffect(() => { if (machine && 'machine' in route && route.machine === machine.id && last !== machine.id) setLast(machine.id) }, [machine?.id, route])

  if (!loaded || !machine) return <div className="splash">{down ? <span className="offline"><span className="spinner" />{t('Sessionary isn’t responding — reconnecting…')}</span> : <span className="spinner" />}</div>
  // a link to a machine that is gone
  if ('machine' in route && !machines.some((m) => m.id === route.machine)) return (
    <div className="splash"><div className="empty-state"><b>{t('Machine not found')}</b><span>{t('It may have been removed.')}</span><button className="btn primary" onClick={() => go(href.machines)}>{t('All machines')}</button></div></div>
  )
  return (
    <MachineProvider key={machine.id} machine={machine}>
      <Window route={route} machine={machine} lang={lang} theme={theme} setTheme={setTheme} down={down} />
    </MachineProvider>
  )
}

function Window({ route, machine, lang, theme, setTheme, down }: { route: Route; machine: Machine; lang: ReturnType<typeof useLang>; theme: ReturnType<typeof useTheme>[0]; setTheme: ReturnType<typeof useTheme>[1]; down: boolean }) {
  const { sessions, api, reload } = useMachine()
  const { reload: reloadMachines } = useMachines()
  const [toast, setToast] = useState<ToastMsg>()
  const [confirm, setConfirm] = useState<ConfirmSpec>()
  const [prompt, setPrompt] = useState<PromptSpec>()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [settings, setSettings] = useState<{ left: number; top?: number; bottom?: number }>()
  const [refreshing, setRefreshing] = useState(false)
  const [lastScan, setLastScan] = useState<number>()
  const [navCollapsed, setNavCollapsed] = usePersisted('navCollapsed', false)
  const [navOpen, setNavOpen] = useState(false) // the drawer, on a narrow window
  const [inspPref, setInspPref] = usePersisted<boolean | null>('insp', null)
  const [inspW, setInspW] = usePersisted('inspW', 300)
  const [inspRoot, setInspRoot] = useState<HTMLElement | null>(null)
  const [inspOverlay, setInspOverlay] = useState(false)
  const narrow = useMedia('(max-width: 1100px)') // the inspector floats over the page
  const compact = useMedia('(max-width: 760px)') // the nav floats too
  const wide = useMedia('(min-width: 1360px)')
  const win = useRef<HTMLDivElement>(null)

  const say = useCallback((text: string, undo?: () => void) => setToast({ id: Date.now(), text, undo }), [])
  const ui = useMemo(() => ({ say, confirm: setConfirm, prompt: setPrompt }), [say])

  const hasInsp = route.page === 'session'
  const inspOpen = narrow ? inspOverlay : inspPref ?? wide
  const toggleInsp = useCallback(() => (narrow ? setInspOverlay((o) => !o) : setInspPref(!(inspPref ?? wide))), [narrow, inspPref, wide])
  const layout = useMemo(() => ({ inspOpen: hasInsp && inspOpen, toggleInsp, inspRoot, narrow }), [hasInsp, inspOpen, toggleInsp, inspRoot, narrow])
  const sideOpen = compact ? navOpen : !navCollapsed
  const toggleNav = () => (compact ? setNavOpen(!navOpen) : setNavCollapsed(!navCollapsed))

  // leaving a page closes what floated over it
  useEffect(() => { setNavOpen(false); setInspOverlay(false) }, [route])
  useEffect(() => { const on = () => setPalette(true); addEventListener('sessionary:palette', on); return () => removeEventListener('sessionary:palette', on) }, [])

  const rescan = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await api.scan(); await reload(); await reloadMachines(); setLastScan(Date.now()) } catch (e) { say((e as Error).message) } finally { setRefreshing(false) }
  }

  useHotkeys({ onPalette: () => setPalette((p) => !p), onHelp: () => setHelp((h) => !h), onToggleNav: toggleNav, onEscape: () => { setNavOpen(false); setInspOverlay(false); setHelp(false) } })

  // dragging the inspector's edge: only CSS variables change while moving; the result is committed on release
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget, w = win.current
    if (!w || e.button !== 0) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId); el.classList.add('active')
    document.documentElement.classList.add('resizing')
    const x0 = e.clientX
    const start = inspOpen ? inspW : 0
    let width = inspW, open = inspOpen
    const move = (ev: PointerEvent) => {
      const raw = start - (ev.clientX - x0)
      open = raw >= 200
      w.dataset.insp = open ? 'open' : 'closed'
      if (open) { width = Math.round(Math.max(260, Math.min(480, raw, w.clientWidth - (navCollapsed ? 56 : 232) - 440))); w.style.setProperty('--insp-w', width + 'px') }
    }
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      el.classList.remove('active'); document.documentElement.classList.remove('resizing')
      w.style.setProperty('--insp-w', (open ? width : inspW) + 'px')
      setInspPref(open); if (open) setInspW(width)
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }

  const openSettings = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setSettings(settings ? undefined : { left: sideOpen && !compact ? r.left : r.right + 8, bottom: innerHeight - r.top + 6 })
  }
  const sessionRoute = route.page === 'session' || route.page === 'chat'

  return (
    <UiContext.Provider value={ui}>
      <LayoutCtx.Provider value={layout}>
        <NotifyProvider>
        <div ref={win} className={`window ${narrow ? 'narrow' : ''} ${compact ? 'compact' : ''}`} data-side={navCollapsed ? 'collapsed' : 'expanded'} data-insp={hasInsp && inspOpen ? 'open' : 'closed'}
          style={{ '--side-w': '232px', '--insp-w': `${inspW}px` } as React.CSSProperties}>
          <aside className={`side ${compact && navOpen ? 'shown' : ''}`} aria-label={t('Navigation')}>
            <Nav route={route} machineId={machine.id} collapsed={navCollapsed && !compact} onCollapse={toggleNav} onPalette={() => setPalette(true)} onSettings={openSettings} trashCount={0} />
          </aside>
          {(compact && navOpen || narrow && inspOverlay) && <div className="scrim fade-in" onClick={() => { setNavOpen(false); setInspOverlay(false) }} />}

          <div className="document">
            {down && <div className="offline fade-in" role="status"><span className="spinner" />{t('Sessionary isn’t responding — reconnecting…')}</div>}
            {compact && !navOpen && !sessionRoute && <button className="tb-btn nav-open" onClick={toggleNav} aria-label={t('Show sidebar')} title={t('Show sidebar')}><Icon name="sidebar" /></button>}
            {route.page === 'home' ? <HomePage machineId={machine.id} />
              : route.page === 'machines' ? <MachinesPage />
              : route.page === 'nodes' ? <NodesPage add={route.add} edit={route.edit} />
              : route.page === 'machine' ? <MachinePage route={route} />
              : route.page === 'agent' ? <AgentPage route={route} />
              : route.page === 'chat' ? <ChatPage route={route} />
              : <SessionPage route={route} />}
          </div>

          {hasInsp && !narrow && <div className="split split-insp" onPointerDown={startResize} onDoubleClick={() => setInspW(300)} role="separator" aria-orientation="vertical" aria-label={t('Resize project context')} title={t('Drag to resize · double-click to reset')} />}
          {hasInsp && <aside ref={setInspRoot} className={`inspector ${inspOpen ? 'open' : ''}`} aria-label={t('Project context')} aria-hidden={!inspOpen} />}

          {settings && <SettingsMenu at={settings} onClose={() => setSettings(undefined)} theme={theme} onTheme={setTheme} lang={lang} onLang={setLang}
            onRefresh={rescan} refreshing={refreshing} lastScan={lastScan} indexed={sessions.length} machine={machine.name} onHelp={() => setHelp(true)} />}
          {toast && <Toast msg={toast} onDone={() => setToast(undefined)} />}
          {confirm && <Confirm spec={confirm} onClose={() => setConfirm(undefined)} />}
          {prompt && <Prompt spec={prompt} onClose={() => setPrompt(undefined)} />}
          {palette && <PaletteHost machine={machine} onClose={() => setPalette(false)} toggleNav={toggleNav} rescan={rescan} theme={theme} setTheme={setTheme} lang={lang} onHelp={() => setHelp(true)} />}
          {help && (
            <div className="overlay fade-in" onMouseDown={() => setHelp(false)}>
              <div className="sheet pop-in" role="dialog" aria-label={t('Keyboard shortcuts')} onMouseDown={(e) => e.stopPropagation()}>
                <h2>{t('Keyboard')}</h2>
                <dl className="keys">{SHORTCUTS.map(([k, d]) => <div key={k}><dt>{k.split(' ').map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{t(d)}</dd></div>)}</dl>
              </div>
            </div>
          )}
        </div>
        </NotifyProvider>
      </LayoutCtx.Provider>
    </UiContext.Provider>
  )
}

/** Ctrl K: find a session or message on the open machine, or run a command (switch machine, open a terminal, …) */
function PaletteHost({ machine, onClose, toggleNav, rescan, theme, setTheme, lang, onHelp }: {
  machine: Machine; onClose: () => void; toggleNav: () => void; rescan: () => void; theme: ReturnType<typeof useTheme>[0]; setTheme: ReturnType<typeof useTheme>[1]; lang: string; onHelp: () => void
}) {
  const { sessions } = useMachine()
  const { machines } = useMachines()
  const ui = useMemo(() => ({ say: (s: string) => console.warn(s) }), [])
  const [recent] = usePersisted<string[]>('recent', [])
  const usableHere = machine.kind === 'local' || machine.state === 'online'
  return (
    <Palette sessions={sessions} recent={recent} onPick={(id) => go(href.session(machine.id, id))} onClose={onClose}
      onPickHit={(id, q, m) => go(href.session(machine.id, id, { q, m: String(m) }))}
      commands={[
        { id: 'home', label: t('Home'), icon: 'home', run: () => go(href.home) },
        { id: 'machines', label: t('Machines'), icon: 'layers', run: () => go(href.machines) },
        ...machines.filter((m) => m.id !== machine.id).map((m) => ({ id: 'machine:' + m.id, label: t('Switch to {agent}', { agent: m.name }), icon: m.kind === 'local' ? 'laptop' : 'server', run: () => go(href.machine(m.id)) })),
        { id: 'agents', label: `${machine.name}: ${t('Agents')}`, icon: 'task', run: () => go(href.machine(machine.id)) },
        { id: 'projects', label: `${machine.name}: ${t('Projects')}`, icon: 'folder', run: () => go(href.machine(machine.id, 'projects')) },
        { id: 'sessions', label: `${machine.name}: ${t('Sessions')}`, icon: 'message', run: () => go(href.machine(machine.id, 'sessions')) },
        { id: 'terminal', label: t('Open a terminal'), icon: 'terminal', run: () => launchTerminal(ui.say, { machine: machine.id, kind: 'shell' }) },
        { id: 'monitor', label: `${machine.name}: ${t('Monitor')}`, icon: 'activity', run: () => go(href.machine(machine.id, 'monitor')) },
        { id: 'trash', label: t('Open Trash'), icon: 'archive', run: () => go(href.machine(machine.id, 'trash')) },
        { id: 'node-add', label: t('Add Node'), icon: 'server', run: () => go(href.nodes({ add: '1' })) },
        { id: 'nodes', label: t('Manage nodes'), icon: 'server', run: () => go(href.nodes()) },
        ...(usableHere ? [{ id: 'rescan', label: t('Rescan sources'), icon: 'refresh', run: rescan }] : []),
        { id: 'nav', label: t('Collapse sidebar'), icon: 'sidebar', hint: '[', run: toggleNav },
        ...(['paper', 'ember', 'graphite', 'system'] as const).filter((th) => th !== theme).map((th) => ({ id: 'theme:' + th, label: t('Theme: {name}', { name: t({ paper: 'Light', ember: 'Dark', graphite: 'Graphite', system: 'System' }[th]) }), icon: th === 'paper' ? 'sun' : th === 'system' ? 'monitor' : 'moon', run: () => setTheme(th) })),
        ...LANGS.filter((l) => l.id !== lang).map((l) => ({ id: 'lang:' + l.id, label: `${t('Language')}: ${l.label}`, icon: 'languages', run: () => setLang(l.id) })),
        { id: 'keys', label: t('Keyboard shortcuts'), icon: 'keyboard', hint: '?', run: onHelp },
      ]} />
  )
}
