import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t, useT } from './i18n'
import { Conversation, agentName } from './Conversation'
import { Crumbs } from './ui'
import { ChatComposer } from './ChatComposer'
import { canChat, useLiveChat } from './chat'
import { LiveThread, pendingTurns, toTurns } from './LiveThread'
import { Inspector } from './Inspector'
import { useLayout } from './layout'
import { useMachine } from './machines'
import { go, href, type Route } from './route'
import { useSessionActions } from './sessionActions'
import { useUi } from './ui'
import type { ChangeFocus, EditBlock, ProjectContext, Run, Session } from './types'

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable)

/**
 * One session of one machine: the conversation, the project context beside it, and everything that can be done
 * to it. Written once for every machine — a node's session is read through the same API as this computer's.
 */
export function SessionPage({ route }: { route: Extract<Route, { page: 'session' }> }) {
  useT()
  const { machine, api, sessions, agents, reload } = useMachine()
  const ui = useUi()
  const act = useSessionActions()
  const layout = useLayout()
  const selected = route.id
  const local = machine.kind === 'local'

  const [session, setSession] = useState<Session>()
  const [ctx, setCtx] = useState<ProjectContext>()
  const [edits, setEdits] = useState<{ id: string; list: EditBlock[] }>()
  const [error, setError] = useState<string>()
  const [focus, setFocus] = useState<ChangeFocus>()
  const [hiddenRev, setHiddenRev] = useState(0)
  const [run, setRun] = useState<Run>()
  const [pending, setPending] = useState<string>()
  const loadingMore = useRef(false)
  const sessionRef = useRef<Session | undefined>(undefined)
  sessionRef.current = session

  useEffect(() => {
    setSession(undefined); setCtx(undefined); setEdits(undefined); setError(undefined); setFocus(undefined)
    let live = true
    api.session(selected).then((s) => live && setSession(s)).catch((e) => live && setError(String(e.message ?? e)))
    api.context(selected).then((c) => live && setCtx(c)).catch(() => live && setCtx(undefined))
    api.edits(selected).then((l) => live && setEdits({ id: selected, list: l })).catch(() => live && setEdits({ id: selected, list: [] }))
    return () => { live = false }
  }, [selected, api])

  // the list knows the current name and pin; the loaded session may be older than that
  const listed = sessions.find((s) => s.id === selected)
  const summary = listed ?? (session?.id === selected ? session : undefined)
  const current = session?.id === selected ? { ...session, ...(listed ? { pinned: listed.pinned, title: listed.title, renamed: listed.renamed, active: listed.active } : {}) } : undefined
  const currentEdits = edits && edits.id === selected ? edits.list : undefined

  // ---- the live chat: the agent's own protocol, held open by the server ----
  const agentId = selected.slice(0, selected.indexOf(':'))
  const chatOk = canChat(agentId, machine.kind) && !summary?.parentId && !current?.trashed
  const chat = useLiveChat({ machine: machine.id, agent: agentId, sessionId: selected, enabled: chatOk, say: ui.say })
  const chatBusy = chat.view.state === 'working' || chat.view.state === 'waiting'
  const lastEnd = [...chat.view.items].reverse().find((x) => x.k === 'end')?.id

  const loadMore = useCallback(async (all = false) => {
    const s = sessionRef.current
    if (!s || s.page.next == null || loadingMore.current) return
    loadingMore.current = true
    try {
      const next = await api.session(s.id, s.page.next, all ? 'all' : undefined)
      setSession((cur) => (cur && cur.id === next.id && cur.page.end === next.page.start ? { ...cur, messages: [...cur.messages, ...next.messages], page: next.page } : cur))
    } finally { loadingMore.current = false }
  }, [api])

  // ---- hiding messages (Sessionary-only; the agent's file is untouched) ----
  const reloadSession = async (id: string, count?: number) => {
    const s = await api.session(id, 0, count)
    setSession((cur) => (cur?.id === id || !cur ? s : cur))
    api.edits(id).then((l) => setEdits({ id, list: l }), () => {})
    api.context(id).then(setCtx, () => {})
    setHiddenRev((r) => r + 1)
  }
  const hideMessages = async (ids: string[], what: string) => {
    const s = sessionRef.current
    if (!s || !ids.length) return
    await api.hideMessages(s.id, ids)
    const set = new Set(ids)
    setSession((cur) => cur && cur.id === s.id ? { ...cur, messages: cur.messages.map((m) => (set.has(m.id) ? { id: m.id, role: m.role, time: m.time, blocks: [], hidden: true } : m)) } : cur)
    api.edits(s.id).then((l) => setEdits({ id: s.id, list: l }), () => {})
    setHiddenRev((r) => r + 1)
    ui.say(what, async () => { await api.restoreMessages(s.id, ids); await reloadSession(s.id, s.messages.length) })
  }
  const restoreMessages = async (ids: string[]) => {
    const s = sessionRef.current
    if (!s) return
    await api.restoreMessages(s.id, ids)
    await reloadSession(s.id, s.messages.length)
  }
  const restoreSession = async () => {
    await api.restore(selected); await reload()
    setSession((cur) => (cur?.id === selected ? { ...cur, trashed: false } : cur))
    ui.say(t('Restored from Trash'))
  }

  // ---- continue the session through the agent's own CLI (this computer's sessions only) ----
  const isTurn = (m: Session['messages'][number]) => m.role === 'user' && !m.hidden && m.blocks.some((b) => b.type !== 'tool')
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
      setRun(done); setPending(undefined)
      await refreshTail(r.sessionId)
      api.edits(r.sessionId).then((l) => setEdits({ id: r.sessionId, list: l }), () => {})
      api.context(r.sessionId).then(setCtx, () => {})
      setHiddenRev((n) => n + 1)
      reload()
      if (done.status === 'failed') ui.say(done.error ?? t('The agent stopped with an error'))
      else if (done.resultSessionId && done.resultSessionId !== r.sessionId) ui.say(t('The agent continued in a new session'), () => act.open({ id: done.resultSessionId! }))
    })
    es.onerror = () => { /* the browser retries; the run itself is unaffected */ }
  }
  useEffect(() => {
    setRun(undefined); setPending(undefined); events.current?.close()
    if (local) api.activeRun(selected).then((r) => { if (r?.status === 'running') attach(r) }, () => {})
  }, [selected, local])
  useEffect(() => () => events.current?.close(), [])
  const sendPrompt = async (prompt: string, allowWrite: boolean) => {
    try {
      const r = await api.continueSession(selected, prompt, allowWrite)
      setPending(prompt); attach(r)
      return true
    } catch (e) { ui.say(t('Not sent: {error}', { error: (e as Error).message })); return false }
  }
  const stopRun = () => { if (run) api.stopRun(run.id).catch(() => {}) }

  // ---- follow the agent writing to the session on screen ----
  const live = useRef({ running: false })
  live.current = { running: run?.status === 'running' || chatBusy }
  useEffect(() => {
    const es = api.events()
    es.addEventListener('index', (e) => {
      const { changed } = JSON.parse((e as MessageEvent).data) as { changed: string[] }
      if (!changed.includes(selected) || live.current.running) return
      refreshTail(selected).catch(() => {})
      api.edits(selected).then((l) => setEdits({ id: selected, list: l }), () => {})
      api.context(selected).then(setCtx, () => {})
      setHiddenRev((n) => n + 1)
    })
    return () => es.close()
  }, [selected, api])

  // the agent finished a turn: its own history has it now (a node's arrives with the next sync, which the server starts)
  useEffect(() => {
    if (!lastEnd) return
    const later = [setTimeout(() => refreshTail(selected).catch(() => {}), 0), setTimeout(() => refreshTail(selected).catch(() => {}), 2500)]
    api.edits(selected).then((l) => setEdits({ id: selected, list: l }), () => {})
    api.context(selected).then(setCtx, () => {})
    setHiddenRev((n) => n + 1)
    reload()
    return () => later.forEach(clearTimeout)
  }, [lastEnd])

  const turns = useMemo(() => pendingTurns(toTurns(chat.view.items), session?.id === selected ? session.messages : undefined), [chat.view.items, session, selected])
  const liveThread = turns.length ? (
    <LiveThread turns={turns} agent={summary?.agent ?? agentId} cwd={summary?.cwd} onRespond={chat.respond} onAnswer={chat.answer} />
  ) : null
  const fallback = !!chat.error && local && !!act.agentOf(summary ?? { agent: agentId })?.canContinue
  const chatBox = chatOk && !fallback ? ({ onSent }: { onSent: () => void }) => (
    <ChatComposer agentName={agentName(agentId)} view={chat.view} opening={chat.opening} error={chat.error} onWarm={chat.warm}
      hint={summary?.active && !chat.chat ? t('Written to in the last two minutes — probably open elsewhere') : undefined}
      onSend={async (text, images) => { const ok = await chat.send(text, images); if (ok) onSent(); return ok }}
      onInterrupt={() => { chat.interrupt() }} onModel={chat.setModel} onMode={chat.setMode} onEffort={chat.setEffort} />
  ) : undefined

  const goView = (v: 'chat' | 'changes') => go(href.session(machine.id, selected, v === 'changes' ? { v: 'changes' } : undefined))
  const openChange = (f: ChangeFocus) => { setFocus(f); goView('changes'); if (layout.narrow && layout.inspOpen) layout.toggleInsp() }

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (e.key === ']') layout.toggleInsp()
      else if (e.key === 'p' && summary) act.togglePin(summary)
      else if (e.key === 'R' && e.shiftKey && summary) act.resume(summary)
      else if (e.key === 'Delete' && summary && !session?.trashed) { e.preventDefault(); act.trash(summary, () => go(href.machine(machine.id, 'sessions'))) }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  const quick = useMemo(() => {
    if (!summary) return undefined
    const a = act.agentOf(summary)
    return {
      pinned: !!summary.pinned, onPin: () => act.togglePin(summary),
      canResume: !!a?.canResume && (!local || !!summary.cwd), onResume: () => act.resume(summary),
      onFolder: local && summary.cwd && act.caps?.fileManager ? () => act.openIn(summary, 'folder') : undefined,
      onTerminal: local && summary.cwd && act.caps?.terminal ? () => act.openIn(summary, 'terminal') : undefined,
      onEditor: local && summary.cwd ? () => act.openIn(summary, 'editor') : undefined, editor: act.caps?.editor,
      onProject: () => act.showProject(summary),
      onOpenFile: (path: string) => act.openIn(summary, 'file', path),
    }
  }, [summary, act.caps, agents, local])

  if (!summary || !quick) {
    return (
      <main className="content">
        <div className="page"><div className="page-inner"><div className="empty-state">{error ? <><b>{t('Session not found')}</b>{error}</> : <span className="spinner" />}</div></div></div>
      </main>
    )
  }
  const agentLabel = agents.find((a) => a.id === summary.agent)?.label ?? agentName(summary.agent)
  const crumbs = (
    <Crumbs items={[
      { label: machine.name, href: href.machine(machine.id) },
      { label: agentLabel, href: href.agent(machine.id, summary.agent) },
      ...(summary.project.generic ? [] : [{ label: summary.project.name, href: href.agent(machine.id, summary.agent, { p: summary.project.key }) }]),
    ]} />
  )

  return (
    <>
      <Conversation summary={summary} session={current} error={error} view={route.view} onView={goView} focus={focus} onFocus={openChange}
        onOpen={(id) => act.open({ id })} onLoadMore={() => loadMore()} onLoadAll={() => loadMore(true)} edits={currentEdits}
        findInit={route.q ? { q: route.q, m: route.m } : undefined}
        hiddenRev={hiddenRev} run={run?.sessionId === summary.id ? run : undefined} pending={run?.sessionId === summary.id ? pending : undefined}
        live={liveThread} liveTick={chat.view.seq} composer={chatBox}
        onSend={sendPrompt} onStop={stopRun}
        onTrash={() => act.trash(summary, () => go(href.machine(machine.id, 'sessions')))} onDeleteFromDisk={() => act.deleteFromDisk(summary, () => go(href.machine(machine.id, 'sessions')))}
        onRestoreSession={restoreSession} onHide={hideMessages} onRestoreMessages={restoreMessages}
        crumbs={crumbs} onRename={(title) => act.rename({ ...summary, title }, true)}
        inspectorOpen={layout.inspOpen} onToggleInspector={layout.toggleInsp}
        quick={quick} menu={act.menuFor(summary, { page: true, then: () => go(href.machine(machine.id, 'sessions')) })} canContinue={(local && !!act.agentOf(summary)?.canContinue) || (chatOk && !fallback)} />
      {layout.inspRoot && createPortal(<div className="inspector-inner"><Inspector summary={summary} edits={currentEdits} ctx={current ? ctx : undefined} onOpenChange={openChange} quick={quick} /></div>, layout.inspRoot)}
    </>
  )
}
