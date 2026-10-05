import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LANGS, LangProvider, setLang, t, useLang, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { api } from './api'
import { Conversation } from './Conversation'
import { cleanTitle, relAgo, relTime } from './format'
import { useMedia, usePersisted, useWindowActive } from './hooks'
import { Icon } from './Icon'
import { Inspector } from './Inspector'
import { Palette } from './Palette'
import { Rail, Sidebar } from './Sidebar'
import { SettingsMenu } from './SettingsMenu'
import { Confirm, type ConfirmSpec } from './Confirm'
import { Toast, type ToastMsg } from './Toast'
import { TrashView } from './TrashView'
import { useTheme, type Density } from './theme'
import type { Agent, ChangeFocus, EditBlock, OpenTarget, ProjectContext, Run, Session, SessionSummary, Status } from './types'
import type { MenuItem } from './ContextMenu'

type View = 'chat' | 'changes'
/** #/s/<session id>[?v=changes] — session and tab live in the URL so back/forward and links work. */
function readRoute(): { id?: string; view: View; q?: string; m?: number; trash?: boolean } {
  if (/^#\/?trash/.test(location.hash)) return { view: 'chat', trash: true }
  const [path = '', query = ''] = location.hash.replace(/^#\/?s\//, '').split('?')
  const sp = new URLSearchParams(query)
  const m = sp.get('m')
  return { id: decodeURIComponent(path) || undefined, view: sp.get('v') === 'changes' ? 'changes' : 'chat', q: sp.get('q') ?? undefined, m: m == null ? undefined : Number(m) }
}
const routeHash = (id: string, view: View) => `/s/${encodeURIComponent(id)}${view === 'changes' ? '?v=changes' : ''}`
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable)

const SHORTCUTS: [string, string][] = [
  ['Ctrl K', 'Search all sessions and messages'], ['Ctrl F', 'Find in this conversation'], ['/', 'Filter the session list'], ['J / K', 'Next / previous session'],
  ['1 2 3', 'Switch agent'], ['0', 'Sessions from all agents'], ['Delete', 'Move session to Trash (also Ctrl ⌫)'], ['Alt ↑ / ↓', 'Previous / next prompt'], ['E', 'Expand or collapse all steps'], ['P', 'Pin or unpin the session'], ['Shift R', 'Resume in a terminal'], ['[', 'Collapse or expand the sidebar'], [']', 'Toggle project context'], ['?', 'This sheet'],
]

export function App() {
  useWindowActive()
  const lang = useLang()
  const [theme, setTheme] = useTheme()
  const [agents, setAgents] = useState<Agent[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [route, setRoute] = useState(readRoute)
  const [session, setSession] = useState<Session>()
  const [ctx, setCtx] = useState<ProjectContext>()
  const [edits, setEdits] = useState<{ id: string; list: EditBlock[] }>()
  const loadingMore = useRef(false)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [lastScan, setLastScan] = useState<number>()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [focus, setFocus] = useState<ChangeFocus>()
  const [toast, setToast] = useState<ToastMsg>()
  const [confirm, setConfirm] = useState<ConfirmSpec>()
  const [trashCount, setTrashCount] = useState(0)
  const [trashRev, setTrashRev] = useState(0)
  const [hiddenRev, setHiddenRev] = useState(0)
  const [run, setRun] = useState<Run>()
  const [pending, setPending] = useState<string>()
  const sessionRef = useRef<Session | undefined>(undefined)
  sessionRef.current = session
  const [sideOpen, setSideOpen] = usePersisted('side', true)
  const [inspPref, setInspPref] = usePersisted<boolean | null>('insp', null)
  const [inspW, setInspW] = usePersisted('inspW', 300)
  const [sideW, setSideW] = usePersisted('sideW', 272)
  const [density, setDensity] = usePersisted<Density>('density', 'comfortable')
  const [settings, setSettings] = useState<{ left: number; top?: number; bottom?: number }>()
  const [overlay, setOverlay] = useState<'side' | 'insp' | null>(null)
  const narrow = useMedia('(max-width: 1100px)') // inspector floats over content
  const compact = useMedia('(max-width: 760px)') // sidebar floats too
  const wide = useMedia('(min-width: 1360px)')
  const selected = route.id
  const [storedAgent, setAgent] = usePersisted<string>('agent', '')
  const agent = storedAgent === 'all' || agents.some((a) => a.id === storedAgent) ? storedAgent : sessions[0]?.agent ?? agents[0]?.id ?? ''
  // opening a session from search, a link or the overview moves the sidebar to that session's agent
  const selectedAgent = sessions.find((s) => s.id === selected)?.agent
  useEffect(() => { if (selectedAgent && storedAgent !== 'all') setAgent(selectedAgent) }, [selectedAgent])
  const [scope, setScope] = usePersisted<string | null>('scope', null)
  const [status, setStatus] = useState<Status>()
  const [offline, setOffline] = useState(false)
  // sessions the reader opened, most recent first (the palette's "Recent")
  const [recent, setRecent] = usePersisted<string[]>('recent', [])
  useEffect(() => { if (selected) setRecent([selected, ...recent.filter((x) => x !== selected)].slice(0, 30)) }, [selected])
  const overview = () => { location.hash = ''; setOverlay(null) }

  const [loaded, setLoaded] = useState(false)
  const loadList = useCallback(async () => {
    const [a, s] = await Promise.all([api.agents(), api.sessions()])
    setAgents(a); setSessions(s); setLastScan(Date.now()); setLoaded(true)
  }, [])
  useEffect(() => { loadList().catch((e) => setError(String(e))) }, [loadList])
  const refreshTrash = useCallback(() => {
    setTrashRev((r) => r + 1)
    api.trash().then((t) => setTrashCount(t.sessions.length + t.removed.length + t.partial.reduce((n, p) => n + p.hiddenMessages, 0)), () => {})
  }, [])
  useEffect(refreshTrash, [refreshTrash])
  const say = (text: string, undo?: () => void) => setToast({ id: Date.now(), text, undo })
  useEffect(() => { const on = () => setRoute(readRoute()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on) }, [])

  useEffect(() => {
    if (!selected) { setSession(undefined); setCtx(undefined); return }
    let live = true
    setError(undefined); setFocus(undefined)
    // keep the previous session on screen only until the new one arrives; the header switches instantly from the summary
    api.session(selected).then((s) => live && setSession(s)).catch((e) => live && setError(String(e)))
    api.context(selected).then((c) => live && setCtx(c)).catch(() => live && setCtx(undefined))
    api.edits(selected).then((l) => live && setEdits({ id: selected, list: l })).catch(() => live && setEdits({ id: selected, list: [] }))
    return () => { live = false }
  }, [selected])

  const select = useCallback((id: string) => { location.hash = routeHash(id, 'chat'); setOverlay(null) }, [])
  // append the next server page (or all of the rest) to the session on screen
  const loadMore = useCallback(async (all = false) => {
    const s = session
    if (!s || s.page.next == null || loadingMore.current) return
    loadingMore.current = true
    try {
      const next = await api.session(s.id, s.page.next, all ? 'all' : undefined)
      setSession((cur) => (cur && cur.id === next.id && cur.page.end === next.page.start ? { ...cur, messages: [...cur.messages, ...next.messages], page: next.page } : cur))
    } finally { loadingMore.current = false }
  }, [session])
  // ---- trash (Sessionary-only hiding) ----
  const reloadSession = async (id: string, count?: number) => {
    const s = await api.session(id, 0, count)
    setSession((cur) => (cur?.id === id || !cur ? s : cur))
    api.edits(id).then((l) => setEdits({ id, list: l }), () => {})
    api.context(id).then(setCtx, () => {})
    setHiddenRev((r) => r + 1)
  }
  const trashSession = async (id: string) => {
    const s = sessions.find((x) => x.id === id)
    const peers = sessions.filter((x) => x.agent === s?.agent)
    const i = peers.findIndex((x) => x.id === id)
    const next = peers[i + 1] ?? peers[i - 1]
    await api.hide(id)
    await loadList(); refreshTrash()
    if (selected === id) { if (next) select(next.id); else location.hash = '' }
    say(t('Moved “{title}” to Trash', { title: (s?.title ?? t('session')).slice(0, 40) }), async () => { await api.restore(id); await loadList(); refreshTrash(); select(id) })
  }
  // ---- delete from disk (agent storage → Sessionary backup; reversible until the backup is purged) ----
  const DISK_NOTE: Record<string, string> = {
    'claude-code': "The transcript and its per-session folders are moved into Sessionary's backup folder. Claude Code will no longer list it for --resume.",
    opencode: 'The session is exported to a backup file, then removed with `opencode session delete` (sub-agent sessions included). OpenCode will no longer show it.',
    pi: "The session file is moved into Sessionary's backup folder. Pi will no longer list it.",
  }
  const deleteFromDisk = (id: string) => {
    const s = sessions.find((x) => x.id === id) ?? (session?.id === id ? session : undefined)
    if (!s) return
    setConfirm({
      title: t('Delete from disk?'),
      danger: true,
      confirm: t('Delete from Disk'),
      body: <>
        <p><b>{s.title}</b></p>
        <p>{t(DISK_NOTE[s.agent] ?? "The session is moved out of the agent's storage.")}</p>
        <p className="muted">{t('You can restore it from the Trash until you delete its backup there.')}</p>
      </>,
      onConfirm: async () => {
        const peers = sessions.filter((x) => x.agent === s.agent)
        const i = peers.findIndex((x) => x.id === id)
        const next = peers[i + 1] ?? peers[i - 1]
        try {
          await api.deleteFromDisk(id)
          await loadList(); refreshTrash()
          if (selected === id) { if (next) select(next.id); else location.hash = '' }
          say(t('Deleted “{title}” from disk — restorable from the Trash', { title: s.title.slice(0, 40) }))
        } catch (e) { say(t('Not deleted: {error}', { error: (e as Error).message })) }
      },
    })
  }
  const restoreRemoved = async (id: string) => {
    try { await api.restoreRemoved(id); await loadList(); refreshTrash(); say(t("Restored to the agent's storage")) }
    catch (e) { say(t('Could not restore: {error}', { error: (e as Error).message })) }
  }
  const purgeRemoved = (id: string, title: string) => setConfirm({
    title: t('Delete backup permanently?'),
    danger: true,
    confirm: t('Delete Permanently'),
    body: <><p><b>{title}</b></p><p>{t("This removes Sessionary's backup. The session can no longer be restored — this is the final delete.")}</p></>,
    onConfirm: async () => { try { await api.purgeRemoved(id); refreshTrash() } catch (e) { say((e as Error).message) } },
  })
  const restoreSession = async (id: string) => {
    await api.restore(id); await loadList(); refreshTrash()
    setSession((cur) => (cur?.id === id ? { ...cur, trashed: false } : cur))
    say(t('Restored from Trash'))
  }
  const hideMessages = async (ids: string[], what: string) => {
    const s = session
    if (!s || !ids.length) return
    await api.hideMessages(s.id, ids)
    const set = new Set(ids)
    setSession((cur) => cur && cur.id === s.id ? { ...cur, messages: cur.messages.map((m) => (set.has(m.id) ? { id: m.id, role: m.role, time: m.time, blocks: [], hidden: true } : m)) } : cur)
    api.edits(s.id).then((l) => setEdits({ id: s.id, list: l }), () => {})
    setHiddenRev((r) => r + 1); refreshTrash()
    say(what, async () => { await api.restoreMessages(s.id, ids); await reloadSession(s.id, s.messages.length); refreshTrash() })
  }
  const restoreMessages = async (ids: string[]) => {
    const s = session
    if (!s) return
    await api.restoreMessages(s.id, ids)
    await reloadSession(s.id, s.messages.length); refreshTrash()
  }
  // ---- continue the session through the agent's CLI ----
  const isTurn = (m: Session['messages'][number]) => m.role === 'user' && !m.hidden && m.blocks.some((b) => b.type !== 'tool')
  /** re-read everything from the last prompt on: agents append, and OpenCode also updates parts in place */
  const refreshTail = async (id: string) => {
    const cur = sessionRef.current
    if (!cur || cur.id !== id) return
    let start = cur.messages.length
    for (let i = cur.messages.length - 1; i >= 0; i--) if (isTurn(cur.messages[i]!)) { start = i; break }
    const next = await api.session(id, start, 'all').catch(() => null)
    if (!next) return
    setSession((c) => c && c.id === id ? { ...c, messages: [...c.messages.slice(0, next.page.start), ...next.messages], page: next.page, messageCount: next.messageCount, updatedAt: next.updatedAt } : c)
    setPending((p) => (p && next.messages.some((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text.trim() === p)) ? undefined : p))
  }
  const events = useRef<EventSource | undefined>(undefined)
  const attach = (r: Run) => {
    events.current?.close()
    setRun(r)
    const es = api.runEvents(r.id)
    events.current = es
    es.addEventListener('update', () => refreshTail(r.sessionId))
    es.addEventListener('end', async (e) => {
      es.close()
      const done = JSON.parse((e as MessageEvent).data) as Run
      setRun(done)
      setPending(undefined)
      await refreshTail(r.sessionId)
      api.edits(r.sessionId).then((l) => setEdits({ id: r.sessionId, list: l }), () => {})
      api.context(r.sessionId).then(setCtx, () => {})
      setHiddenRev((n) => n + 1)
      loadList()
      if (done.status === 'failed') say(done.error ?? t('The agent stopped with an error'))
      else if (done.resultSessionId && done.resultSessionId !== r.sessionId) say(t('The agent continued in a new session'), () => select(done.resultSessionId!))
    })
    es.onerror = () => { /* the browser retries; the run itself is unaffected */ }
  }
  useEffect(() => {
    setRun(undefined); setPending(undefined); events.current?.close()
    if (selected) api.activeRun(selected).then((r) => { if (r?.status === 'running') attach(r) }, () => {})
  }, [selected])
  useEffect(() => () => events.current?.close(), [])
  const sendPrompt = async (prompt: string, allowWrite: boolean) => {
    if (!selected) return false
    try {
      const r = await api.continueSession(selected, prompt, allowWrite)
      setPending(prompt)
      attach(r)
      return true
    } catch (e) { say(t('Not sent: {error}', { error: (e as Error).message })); return false }
  }
  const stopRun = () => { if (run) api.stopRun(run.id).catch(() => {}) }
  const setView = (v: View) => { if (selected) location.hash = routeHash(selected, v) }
  const openChange = (f: ChangeFocus) => { setFocus(f); setView('changes'); if (narrow) setOverlay(null) }
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await api.scan(); await loadList() } finally { setRefreshing(false) }
  }

  const inspOpen = narrow ? overlay === 'insp' : inspPref ?? wide
  const sideShown = compact ? overlay === 'side' : sideOpen
  const toggleInsp = () => (narrow ? setOverlay(overlay === 'insp' ? null : 'insp') : setInspPref(!inspOpen))
  const toggleSide = () => (compact ? setOverlay(overlay === 'side' ? null : 'side') : setSideOpen(!sideOpen))
  const openSettings = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setSettings(settings ? undefined : { left: sideOpen && !compact ? r.left : r.right + 8, bottom: innerHeight - r.top + 6 })
  }
  const openTrash = () => { location.hash = '/trash'; setOverlay(null) }
  // from the rail the list is out of sight, so switching agent also opens that agent's latest session
  const pickAgent = (id: string) => {
    setAgent(id)
    const latest = sessions.find((x) => x.agent === id)
    if (latest && sessions.find((x) => x.id === selected)?.agent !== id) select(latest.id)
  }

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return }
      if (e.key === 'Escape') { setOverlay(null); setHelp(false); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && selected && !isTyping(e.target)) { e.preventDefault(); trashSession(selected); return }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (e.key === '[') toggleSide()
      else if (e.key === ']') toggleInsp()
      else if (e.key === '?') setHelp((h) => !h)
      else if (e.key === 'p' && summary) togglePin(summary)
      else if (e.key === 'R' && e.shiftKey && summary) resume(summary)
      else if (e.key === 'Delete' && selected && session?.id === selected && !session.trashed) { e.preventDefault(); trashSession(selected) }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  // ---- live updates: the server pushes `index` whenever an agent writes; reload the list and the open session ----
  const live = useRef({ loadList, refreshTail: (_id: string) => Promise.resolve(), selected, running: false })
  live.current = { loadList, refreshTail, selected, running: run?.status === 'running' }
  useEffect(() => {
    api.status().then(setStatus, () => {})
    const es = api.events()
    let down: number | undefined
    let reload: number | undefined
    es.addEventListener('hello', () => { clearTimeout(down); setOffline(false); live.current.loadList().catch(() => {}); api.status().then(setStatus, () => {}) })
    es.addEventListener('index', (e) => {
      const { changed } = JSON.parse((e as MessageEvent).data) as { changed: string[] }
      clearTimeout(reload)
      reload = window.setTimeout(() => live.current.loadList().catch(() => {}), 250)
      const cur = live.current.selected
      // a run streams its own updates; otherwise follow the agent writing to the session on screen
      if (cur && changed.includes(cur) && !live.current.running) {
        live.current.refreshTail(cur).catch(() => {})
        api.edits(cur).then((l) => setEdits({ id: cur, list: l }), () => {})
        api.context(cur).then(setCtx, () => {})
        setHiddenRev((n) => n + 1)
      }
    })
    // A failed stream does not mean the server is gone: an older server may simply lack live updates.
    // Ask a plain endpoint before saying "offline"; if it answers, keep the page fresh by polling instead.
    let poll: number | undefined
    const startPolling = () => { if (!poll) poll = window.setInterval(() => live.current.loadList().catch(() => {}), 30_000) }
    es.onerror = () => {
      clearTimeout(down)
      down = window.setTimeout(() => {
        fetch('/api/agents', { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error()
          setOffline(false)
          setStatus((st) => st && { ...st, watch: { ...st.watch, mode: 'polling' } })
          if (es.readyState === EventSource.CLOSED) startPolling() // the browser gave up: the endpoint isn't there
        }).catch(() => setOffline(true))
      }, 2500)
    }
    es.onopen = () => { clearTimeout(down); setOffline(false); clearInterval(poll); poll = undefined }
    return () => { es.close(); clearTimeout(down); clearTimeout(reload); clearInterval(poll) }
  }, [])

  // ---- session actions: one list, used by the row menu, the session header, the palette and shortcuts ----
  const caps = status?.capabilities
  const agentOf = (s: SessionSummary) => agents.find((a) => a.id === s.agent)
  const togglePin = async (s: SessionSummary) => {
    setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, pinned: !s.pinned || undefined } : x)))
    setSession((cur) => (cur?.id === s.id ? { ...cur, pinned: !s.pinned || undefined } : cur))
    try { await api.pin(s.id, !s.pinned) } catch (e) { say((e as Error).message); loadList() }
  }
  const openIn = async (s: SessionSummary, target: OpenTarget, path?: string) => {
    try { await api.open(s.id, target, path) } catch (e) { say((e as Error).message) }
  }
  const resume = (s: SessionSummary) => {
    const go = async () => {
      try { await api.open(s.id, 'resume'); say(t('Opened {agent} in {terminal}', { agent: agentOf(s)?.label ?? s.agent, terminal: caps?.terminal ?? t('a terminal') })) }
      catch (e) { say((e as Error).message) }
    }
    // a session written to moments ago is probably still open somewhere; two writers would interleave
    if (s.active && run?.sessionId !== s.id) setConfirm({
      title: t('Resume a session that looks open?'), confirm: t('Resume anyway'),
      body: <p>{t('{agent} wrote to this session in the last two minutes, so it is probably still open in another terminal. Resuming it twice can interleave both conversations.', { agent: agentOf(s)?.label ?? s.agent })}</p>,
      onConfirm: go,
    })
    else go()
  }
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); say(t('Copied {what}', { what })) } catch { say(t('Could not copy to the clipboard')) }
  }
  const copyResume = async (s: SessionSummary) => {
    try { const c = await api.resumeCommand(s.id); copy(c.line, t('resume command')) } catch (e) { say((e as Error).message) }
  }
  const showProject = (s: SessionSummary) => {
    setScope(s.project.generic ? '~none' : s.project.key)
    if (agent !== 'all' && agent !== s.agent) setAgent(s.agent)
    if (!sideOpen && !compact) setSideOpen(true)
    if (compact) setOverlay('side')
  }
  const menuFor = (s: SessionSummary): (MenuItem | '-')[] => {
    const a = agentOf(s)
    const hasDir = !!s.cwd
    return [
      ...(s.id !== selected ? [{ label: t('Open'), icon: 'message', onSelect: () => select(s.id) }] : []),
      { label: s.pinned ? t('Unpin') : t('Pin'), icon: s.pinned ? 'unpin' : 'pin', hint: 'P', onSelect: () => togglePin(s) },
      '-',
      { label: caps?.terminal ? t('Resume in {terminal}', { terminal: caps.terminal }) : t('Resume in a terminal'), icon: 'play', hint: '⇧R', onSelect: () => resume(s), disabled: !a?.canResume || !hasDir || !caps?.terminal },
      { label: t('Copy resume command'), icon: 'clipboard', onSelect: () => copyResume(s), disabled: !a?.canResume || !hasDir },
      '-',
      { label: t('Open folder'), icon: 'folder-open', onSelect: () => openIn(s, 'folder'), disabled: !hasDir || !caps?.fileManager },
      { label: t('Open terminal here'), icon: 'terminal', onSelect: () => openIn(s, 'terminal'), disabled: !hasDir || !caps?.terminal },
      { label: caps?.editor ? t('Open in {editor}', { editor: caps.editor }) : t('Open in editor'), icon: 'code', onSelect: () => openIn(s, 'editor'), disabled: !hasDir },
      '-',
      { label: t('Show only this project'), icon: 'folder', onSelect: () => showProject(s) },
      { label: t('Copy session ID'), icon: 'copy', onSelect: () => copy(s.nativeId, t('session ID')) },
      ...(hasDir ? [{ label: t('Copy path'), icon: 'copy', onSelect: () => copy(s.cwd!, t('path')) }] : []),
      '-',
      { label: t('Move to Trash'), icon: 'trash', hint: 'Del', onSelect: () => trashSession(s.id) },
      { label: t('Delete from Disk…'), icon: 'trash', onSelect: () => deleteFromDisk(s.id), danger: true },
    ]
  }
  const quick = (s: SessionSummary) => ({
    pinned: !!s.pinned, onPin: () => togglePin(s),
    canResume: !!agentOf(s)?.canResume && !!s.cwd && !!caps?.terminal, onResume: () => resume(s), terminal: caps?.terminal,
    onFolder: s.cwd && caps?.fileManager ? () => openIn(s, 'folder') : undefined,
    onTerminal: s.cwd && caps?.terminal ? () => openIn(s, 'terminal') : undefined,
    onEditor: s.cwd ? () => openIn(s, 'editor') : undefined, editor: caps?.editor,
    onProject: () => showProject(s),
    onOpenFile: (path: string) => openIn(s, 'file', path),
  })

  // ---- resizing: while dragging only CSS variables change (no re-render); the result is committed on release ----
  const win = useRef<HTMLDivElement>(null)
  const MIN_MAIN = 440
  const startResize = (which: 'side' | 'insp') => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget, w = win.current
    if (!w || e.button !== 0) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId); el.classList.add('active')
    document.documentElement.classList.add('resizing')
    const x0 = e.clientX
    let side = sideOpen ? sideW : 0, insp = inspOpen ? inspW : 0
    let expanded = sideOpen, open = inspOpen
    const sideStart = sideOpen ? sideW : 56, inspStart = inspOpen ? inspW : 0
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, W = w.clientWidth
      if (which === 'side') {
        const raw = sideStart + dx
        expanded = raw >= 160 // dragging the edge far enough in collapses to the rail, like a macOS source list
        w.dataset.side = expanded ? 'expanded' : 'collapsed'
        if (expanded) { side = Math.round(Math.max(220, Math.min(360, raw, W - (open ? insp || inspW : 0) - MIN_MAIN))); w.style.setProperty('--side-w', side + 'px') }
      } else {
        const raw = inspStart - dx
        open = raw >= 200
        w.dataset.insp = open ? 'open' : 'closed'
        if (open) { insp = Math.round(Math.max(260, Math.min(480, raw, W - (expanded ? side || sideW : 56) - MIN_MAIN))); w.style.setProperty('--insp-w', insp + 'px') }
      }
    }
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      el.classList.remove('active'); document.documentElement.classList.remove('resizing')
      // React only writes the style when the value changes, so put back what the drag overwrote before committing
      const finalSide = which === 'side' && expanded && side ? side : sideW
      const finalInsp = which === 'insp' && open && insp ? insp : inspW
      w.style.setProperty('--side-w', finalSide + 'px'); w.style.setProperty('--insp-w', finalInsp + 'px')
      if (which === 'side') { setSideOpen(expanded); setSideW(finalSide) }
      else { setInspPref(open); setInspW(finalInsp) }
    }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }
  const resetSize = (which: 'side' | 'insp') => () => (which === 'side' ? setSideW(272) : setInspW(300))

  const summary = useMemo(() => sessions.find((s) => s.id === selected) ?? (session?.id === selected ? session : undefined), [sessions, selected, session])
  const currentEdits = edits && edits.id === selected ? edits.list : undefined
  const current = session?.id === selected ? session : undefined
  const currentCtx = current ? ctx : undefined

  const hasInsp = !!summary && !route.trash
  const sidebarButton = compact && !sideShown ? <button className="tb-btn" onClick={toggleSide} aria-label={t('Show sidebar')} title={`${t('Show sidebar')}  [`}><Icon name="sidebar" /></button> : null
  const total = agents.reduce((n, a) => n + a.sessionCount, 0)
  return (
    <LangProvider lang={lang}>
    <div ref={win} className={`window ${narrow ? 'narrow' : ''} ${compact ? 'compact' : ''}`} data-side={sideOpen ? 'expanded' : 'collapsed'} data-insp={hasInsp && inspOpen ? 'open' : 'closed'} data-density={density}
      style={{ '--side-w': `${sideW}px`, '--insp-w': `${inspW}px` } as React.CSSProperties}>
      <aside className={`side ${compact && sideShown ? 'shown' : ''}`} aria-label={t('Sessions')}>
        <div className="side-full">
          <Sidebar agents={agents} sessions={sessions} loaded={loaded} selected={selected} onSelect={select} onPalette={() => setPalette(true)} refreshing={refreshing}
            onCollapse={toggleSide} onSettings={openSettings} agent={agent} onAgent={setAgent} onOverview={overview}
            scope={scope} onScope={setScope} menuFor={menuFor} live={offline ? 'offline' : status?.watch.mode ?? 'events'}
            onOpenHit={(id, q, m) => { location.hash = `${routeHash(id, 'chat')}?q=${encodeURIComponent(q)}&m=${m}`; setOverlay(null) }} />
        </div>
        {!compact && <Rail agents={agents} agent={agent} onAgent={pickAgent} onExpand={toggleSide} onPalette={() => setPalette(true)} onOverview={overview}
          onSettings={openSettings} refreshing={refreshing} overview={!selected && !route.trash} />}
      </aside>
      {!compact && <div className="split split-side" onPointerDown={startResize('side')} onDoubleClick={resetSize('side')} role="separator" aria-orientation="vertical" aria-label={t('Resize sidebar')} title={t('Drag to resize · double-click to reset')} />}
      {overlay && <div className="scrim fade-in" onClick={() => setOverlay(null)} />}

      <div className="document">
        {offline && <div className="offline fade-in" role="status"><span className="spinner" />{t('Sessionary isn’t responding — reconnecting…')}</div>}
        {route.trash ? (
          <main className="content">
            <header className="toolbar">{sidebarButton}</header>
            <TrashView rev={trashRev} onChanged={() => { loadList(); refreshTrash() }} onOpen={select} onRestoreRemoved={restoreRemoved} onPurge={purgeRemoved} />
          </main>
        ) : summary ? (
          <Conversation summary={summary} session={current} error={error} view={route.view} onView={setView} focus={focus} onFocus={openChange} onOpen={select} onLoadMore={() => loadMore()} onLoadAll={() => loadMore(true)} edits={currentEdits}
            findInit={route.q ? { q: route.q, m: route.m } : undefined}
            hiddenRev={hiddenRev} run={run?.sessionId === summary.id ? run : undefined} pending={run?.sessionId === summary.id ? pending : undefined} onSend={sendPrompt} onStop={stopRun} onTrash={() => trashSession(summary.id)} onDeleteFromDisk={() => deleteFromDisk(summary.id)} onRestoreSession={() => restoreSession(summary.id)} onHide={hideMessages} onRestoreMessages={restoreMessages}
            sidebarHidden={compact && !sideShown} onShowSidebar={toggleSide} inspectorOpen={inspOpen} onToggleInspector={toggleInsp}
            quick={quick(summary)} menu={menuFor(summary)} canContinue={!!agentOf(summary)?.canContinue} />
        ) : (
          <main className="content">
            <header className="toolbar">{sidebarButton}</header>
            <Overview agents={agents} sessions={sessions} current={agent} onAgent={setAgent} onPick={select} loading={!loaded && !error} error={!selected ? error : undefined} missing={!!selected && !!error}
              onProject={(s) => { showProject(s); select(s.id) }} />
          </main>
        )}
      </div>
      {hasInsp && !narrow && <div className="split split-insp" onPointerDown={startResize('insp')} onDoubleClick={resetSize('insp')} role="separator" aria-orientation="vertical" aria-label={t('Resize project context')} title={t('Drag to resize · double-click to reset')} />}
      {hasInsp && (
        <aside className={`inspector ${inspOpen ? 'open' : ''}`} aria-label={t('Project context')} aria-hidden={!inspOpen}>
          <div className="inspector-inner"><Inspector summary={summary!} edits={currentEdits} ctx={currentCtx} onOpenChange={openChange} quick={quick(summary!)} /></div>
        </aside>
      )}

      {settings && <SettingsMenu at={settings} onClose={() => setSettings(undefined)} theme={theme} onTheme={setTheme} density={density} onDensity={setDensity}
        lang={lang} onLang={setLang} trashCount={trashCount} onOpenTrash={openTrash} onRefresh={refresh} refreshing={refreshing} lastScan={lastScan} indexed={total} onHelp={() => setHelp(true)} />}
      {toast && <Toast msg={toast} onDone={() => setToast(undefined)} />}
      {confirm && <Confirm spec={confirm} onClose={() => setConfirm(undefined)} />}
      {palette && <Palette sessions={sessions} recent={recent} onPick={select} onClose={() => setPalette(false)}
        onPickHit={(id, q, m) => { location.hash = `${routeHash(id, 'chat')}?q=${encodeURIComponent(q)}&m=${m}`; setOverlay(null) }}
        commands={[
          ...agents.filter((a) => a.sessionCount).map((a, i) => ({ id: 'agent:' + a.id, label: t('Switch to {agent}', { agent: a.label }), icon: <AgentIcon agent={a.id} size={16} />, hint: String(i + 1), run: () => setAgent(a.id) })),
          { id: 'all', label: t('Sessions from all agents'), icon: 'layers', hint: '0', run: () => setAgent('all') },
          { id: 'overview', label: t('Overview'), icon: 'layers', run: overview },
          ...(summary && !route.trash ? menuFor(summary).filter((m): m is MenuItem => m !== '-' && !m.disabled && !m.danger && m.label !== t('Open'))
            .map((m) => ({ id: 'session:' + m.label, label: m.label, icon: m.icon ?? 'other', hint: m.hint, run: m.onSelect })) : []),
          { id: 'side', label: sideOpen ? t('Collapse sidebar') : t('Expand sidebar'), icon: 'sidebar', hint: '[', run: toggleSide },
          ...(hasInsp ? [{ id: 'insp', label: inspOpen ? t('Hide project context') : t('Show project context'), icon: 'panel', hint: ']', run: toggleInsp }] : []),
          { id: 'density', label: density === 'compact' ? t('Comfortable session list') : t('Compact session list'), icon: density === 'compact' ? 'expand' : 'collapse', run: () => setDensity(density === 'compact' ? 'comfortable' : 'compact') },
          { id: 'trash', label: t('Open Trash'), icon: 'trash', run: openTrash },
          { id: 'rescan', label: t('Rescan sources'), icon: 'refresh', run: refresh },
          ...(['paper', 'ember', 'graphite', 'system'] as const).filter((th) => th !== theme).map((th) => ({ id: 'theme:' + th, label: t('Theme: {name}', { name: t({ paper: 'Light', ember: 'Dark', graphite: 'Graphite', system: 'System' }[th]) }), icon: th === 'paper' ? 'sun' : th === 'system' ? 'monitor' : 'moon', run: () => setTheme(th) })),
          ...LANGS.filter((l) => l.id !== lang).map((l) => ({ id: 'lang:' + l.id, label: `${t('Language')}: ${l.label}`, icon: 'languages', run: () => setLang(l.id) })),
          { id: 'keys', label: t('Keyboard shortcuts'), icon: 'keyboard', hint: '?', run: () => setHelp(true) },
        ]} />}
      {help && (
        <div className="overlay fade-in" onMouseDown={() => setHelp(false)}>
          <div className="sheet pop-in" role="dialog" aria-label={t('Keyboard shortcuts')} onMouseDown={(e) => e.stopPropagation()}>
            <h2>{t('Keyboard')}</h2>
            <dl className="keys">{SHORTCUTS.map(([k, d]) => <div key={k}><dt>{k.split(' ').map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{t(d)}</dd></div>)}</dl>
          </div>
        </div>
      )}
    </div>
    </LangProvider>
  )
}

/**
 * The start page doubles as the agent picker: one card per source with enough context (volume, recency, where
 * the work happened, what it was about) to choose where to look, instead of only the sidebar pop-up.
 */
function Overview({ agents, sessions, current, onAgent, onPick, loading, error, missing, onProject }: {
  agents: Agent[]; sessions: SessionSummary[]; current: string; onAgent: (id: string) => void; onPick: (id: string) => void
  loading: boolean; error?: string; missing: boolean; onProject: (s: SessionSummary) => void
}) {
  const stats = useMemo(() => agents.map((a) => {
    const own = sessions.filter((s) => s.agent === a.id)
    const projects = new Map<string, SessionSummary[]>()
    for (const s of own) if (!s.project.generic) projects.set(s.project.key, [...(projects.get(s.project.key) ?? []), s])
    return {
      agent: a,
      own,
      last: own[0]?.updatedAt,
      projects: projects.size,
      top: [...projects.values()].sort((x, y) => y.length - x.length).slice(0, 3).map((l) => l[0]!),
      active: own.filter((s) => s.active).length,
      pinned: own.filter((s) => s.pinned),
    }
  }), [agents, sessions])

  useT()
  const open = (id: string, sessionId?: string) => { onAgent(id); if (sessionId) onPick(sessionId) }
  return (
    <div className="page">
      <div className="page-inner enter">
        <h1>{error ? t('Could not reach the index') : missing ? t('Session not found') : t('All agents')}</h1>
        <p className="page-lede">{error ?? (missing ? t('It may have been deleted from disk since the last scan.') : t('Each agent keeps its own history. Pick one to browse its sessions, or search everything with Ctrl K.'))}</p>
        {loading ? <div className="sk-line" /> : (
          <div className="agent-grid">
            {stats.map(({ agent: a, own, last, projects, top, active, pinned }, i) => (
              <section key={a.id} className={`agent-card ${a.id === current ? 'current' : ''} ${own.length ? '' : 'empty'}`}>
                <button className="agent-card-head" onClick={() => open(a.id, own[0]?.id)} disabled={!own.length} title={own.length ? t("Open {agent}'s latest session", { agent: a.label }) : undefined}>
                  <span className={`app-tile at-${a.id}`}><AgentIcon agent={a.id} size={26} /></span>
                  <span className="agent-card-title">
                    <span className="agent-name">{a.label}</span>
                    <span className="agent-sub">{active ? <><span className="live-dot" />{t('{n} active now', { n: active })}</> : a.id === current ? t('Current') : last ? t('active {when}', { when: relAgo(last) }) : ''}</span>
                  </span>
                  <kbd>{i + 1}</kbd>
                </button>
                {!a.available || a.error ? (
                  <div className="agent-missing">
                    <b>{a.error ? t('Could not read {agent}', { agent: a.label }) : t('{agent} has no history on this machine', { agent: a.label })}</b>
                    <span>{a.error ?? t('Sessionary looked in {path}. Sessions appear here as soon as the agent writes one.', { path: a.storage })}</span>
                  </div>
                ) : (
                  <>
                    <div className="agent-nums">
                      <div><b>{own.length}</b><span>{t('Sessions')}</span></div>
                      <div><b>{projects}</b><span>{t('Projects')}</span></div>
                      <div><b>{last ? relTime(last) : '—'}</b><span>{t('Last active')}</span></div>
                    </div>
                    {own.length > 0 && (
                      <div className="agent-recent">
                        {[...pinned, ...own.filter((s) => !s.pinned)].slice(0, 4).map((s) => (
                          <button key={s.id} className="recent-row" onClick={() => open(a.id, s.id)} title={s.title}>
                            {s.pinned && <Icon name="pin" size={12} />}
                            <span className="r-title">{cleanTitle(s.title)}</span>
                            {s.active && <span className="live-dot" />}
                            <span className="r-meta">{relTime(s.updatedAt)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {top.length > 0 && <div className="agent-top">{top.map((s) => <button key={s.project.key} className="chip link" onClick={() => onProject(s)} title={t('Show only this project')}><Icon name="folder" size={12} />{s.project.name}</button>)}</div>}
                  </>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
