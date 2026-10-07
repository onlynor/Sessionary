import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatApi } from './api'
import type { ApprovalOption, ChatEvent, ChatInfo, ChatQuestion, ChatState, ChatSummary, ChatUsage, ToolBlock } from './types'

/** What the page shows of a chat: the events folded into a list of things, in the order they happened. */
export type LiveItem =
  | { k: 'user'; id: string; text: string; queued?: boolean; at: number }
  | { k: 'text'; id: string; text: string; done: boolean }
  | { k: 'thinking'; id: string; text: string; done: boolean }
  | { k: 'tool'; id: string; block: ToolBlock }
  | { k: 'approval'; id: string; tool: string; title: string; detail?: string; input?: unknown; diff?: string; options: ApprovalOption[]; outcome?: string }
  | { k: 'question'; id: string; questions: ChatQuestion[]; done: boolean }
  | { k: 'note'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { k: 'end'; id: string; stop: 'done' | 'interrupted' | 'error'; error?: string; at: number }

export interface ChatView {
  items: LiveItem[]
  state: ChatState
  info: ChatInfo
  usage?: ChatUsage
  seq: number
  /** when the running turn began */
  since?: number
}
export const emptyView = (agent = ''): ChatView => ({ items: [], state: 'starting', info: { agent }, seq: 0 })

/** the tool kind the existing step rows know, from whatever each agent calls its tools */
export function toolKind(name: string): string {
  const n = name.toLowerCase()
  if (/^(bash|shell|exec|run|command)/.test(n)) return 'shell'
  if (/^(read|view|cat)/.test(n)) return 'read'
  if (/^(multiedit|edit|patch|apply|str_replace)/.test(n)) return 'edit'
  if (/^(write|create)/.test(n)) return 'write'
  if (/^(grep|glob|find|ls|list|search)/.test(n) && !/web/.test(n)) return 'search'
  if (/web|fetch|http/.test(n)) return 'web'
  if (/^(task|agent|delegate)/.test(n)) return 'task'
  if (/todo|plan/.test(n)) return 'todo'
  return 'other'
}

const upsert = (items: LiveItem[], item: LiveItem): LiveItem[] => {
  const i = items.findIndex((x) => x.k === item.k && x.id === item.id)
  if (i < 0) return [...items, item]
  const next = items.slice()
  next[i] = item
  return next
}

/** Folds one event into the view. Applying the same event again, or an older one, changes nothing. */
export function applyEvent(v: ChatView, e: ChatEvent): ChatView {
  if (e.t === 'status') return v.state === e.state ? v : { ...v, state: e.state }
  const seq = Math.max(v.seq, e.seq)
  const at = (items: LiveItem[]) => ({ ...v, seq, items })
  switch (e.t) {
    case 'info': return { ...v, seq, info: { ...v.info, ...Object.fromEntries(Object.entries(e.info).filter(([, x]) => x !== undefined)) } as ChatInfo }
    case 'usage': return { ...v, seq, usage: { ...v.usage, ...e.usage } }
    case 'turn': return e.state === 'start'
      ? { ...v, seq, since: v.since ?? e.at }
      : { ...v, seq, since: undefined, usage: e.usage ? { ...v.usage, ...e.usage } : v.usage, items: [...v.items.map((x) => (x.k === 'text' || x.k === 'thinking') && !x.done ? { ...x, done: true } : x), { k: 'end', id: `end${e.seq}`, stop: e.stop, error: e.error, at: e.at }] }
    case 'user': return v.items.some((x) => x.k === 'user' && x.id === e.id) ? at(v.items) : at([...v.items, { k: 'user', id: e.id, text: e.text, queued: e.queued, at: e.at }])
    case 'text': {
      const cur = v.items.find((x) => x.k === 'text' && x.id === e.id) as Extract<LiveItem, { k: 'text' }> | undefined
      return at(upsert(v.items, { k: 'text', id: e.id, text: (cur?.text ?? '') + e.delta, done: false }))
    }
    case 'text.end': return at(upsert(v.items, { k: 'text', id: e.id, text: e.text, done: true }))
    case 'thinking': {
      const cur = v.items.find((x) => x.k === 'thinking' && x.id === e.id) as Extract<LiveItem, { k: 'thinking' }> | undefined
      return at(upsert(v.items, { k: 'thinking', id: e.id, text: (cur?.text ?? '') + e.delta, done: false }))
    }
    case 'thinking.end': return at(upsert(v.items, { k: 'thinking', id: e.id, text: e.text, done: true }))
    case 'tool': {
      const block: ToolBlock = { type: 'tool', id: e.id, name: e.name, kind: toolKind(e.name), input: (e.input as any) ?? {}, status: e.status === 'running' ? 'pending' : e.status, ...(e.output !== undefined && { output: e.output }), ...(e.diff && { diff: e.diff }) }
      return at(upsert(v.items, { k: 'tool', id: e.id, block }))
    }
    case 'approval': return at(upsert(v.items, { k: 'approval', id: e.id, tool: e.tool, title: e.title, detail: e.detail, input: e.input, diff: e.diff, options: e.options }))
    case 'approval.done': return at(v.items.map((x) => (x.k === 'approval' && x.id === e.id ? { ...x, outcome: e.outcome } : x)))
    case 'question': return at(upsert(v.items, { k: 'question', id: e.id, questions: e.questions, done: false }))
    case 'question.done': return at(v.items.map((x) => (x.k === 'question' && x.id === e.id ? { ...x, done: true } : x)))
    case 'note': return at([...v.items, { k: 'note', id: `n${e.seq}`, level: e.level, text: e.text }])
  }
}

/**
 * Follows one chat: the server replays what it has (from the last event this page saw) and then streams. The browser
 * reconnects by itself and says where it was, so a dropped connection loses nothing.
 */
export function useChatStream(chat: Pick<ChatSummary, 'id' | 'agent' | 'info'> | undefined) {
  const [view, setView] = useState<ChatView>(() => emptyView(chat?.agent))
  const id = chat?.id
  useEffect(() => {
    setView({ ...emptyView(chat?.agent), info: chat?.info ?? { agent: chat?.agent ?? '' } })
    if (!id) return
    let es: EventSource | undefined
    let live = true
    let queue: ChatEvent[] = []
    let raf = 0
    // a burst of deltas is one render, not one per delta
    const flush = () => { raf = 0; const q = queue; queue = []; if (q.length && live) setView((v) => q.reduce(applyEvent, v)) }
    chatApi.events(id).then((s) => {
      if (!live) return s.close()
      es = s
      s.addEventListener('chat', (m) => { queue.push(JSON.parse((m as MessageEvent).data)); if (!raf) raf = requestAnimationFrame(flush) })
      // the stream broke: a blip reconnects by itself (and replays from the last event); a chat the server no longer
      // has (it was restarted) has ended, which lets a session page start its agent again
      s.addEventListener('error', () => {
        chatApi.get(id).catch((e) => { if (live && (e as { status?: number }).status === 404) { s.close(); setView((v) => ({ ...v, state: 'closed' })) } })
      })
    }).catch(() => {})
    return () => { live = false; es?.close(); if (raf) cancelAnimationFrame(raf) }
  }, [id])
  return view
}

/** the verbs on a chat; each one reports a failure to the caller */
export function useChatActions(id: string | undefined) {
  return useMemo(() => ({
    send: (text: string, images?: { mimeType: string; data: string }[]) => chatApi.send(id!, text, images),
    interrupt: () => chatApi.interrupt(id!),
    respond: (approval: string, option: string) => chatApi.respond(id!, approval, option),
    answer: (question: string, answers: Record<string, string[]>) => chatApi.answer(id!, question, answers),
    setModel: (model: string) => chatApi.setModel(id!, model),
    setMode: (mode: string) => chatApi.setMode(id!, mode),
    setEffort: (effort: string) => chatApi.setEffort(id!, effort),
    close: () => chatApi.close(id!),
  }), [id])
}

/** the live chat that continues a session, if the server holds one; refreshed on demand */
export function useChatFor(machine: string, agent: string, session: string) {
  const [chat, setChat] = useState<ChatSummary | null | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    const c = await chatApi.forSession(machine, agent, session).catch(() => null)
    if (alive.current) setChat(c)
    return c
  }, [machine, agent, session])
  useEffect(() => { setChat(undefined); refresh() }, [refresh])
  return { chat, setChat, refresh }
}

/** the agents whose own protocol Sessionary speaks, and where (this computer, or a node reached over ssh) */
export const CHAT_AGENTS = ['claude-code', 'codex', 'opencode', 'pi', 'hermes']
export const canChat = (agent: string, machineKind: 'local' | 'ssh' | 'url') => machineKind !== 'url' && CHAT_AGENTS.includes(agent)

/**
 * Start a session's agent ahead of time (a pointer resting on it in a list): opening it then finds the agent up. The
 * server keeps such chats few and lets unused ones go after a few minutes; starting costs no model tokens.
 */
const warmed = new Map<string, number>()
export function prewarmSession(machine: string, sessionId: string) {
  const key = `${machine}\u0000${sessionId}`
  if (Date.now() - (warmed.get(key) ?? 0) < 60_000) return
  warmed.set(key, Date.now())
  chatApi.open({ machine, sessionId, warm: true }).catch(() => warmed.delete(key))
}
/**
 * One live chat on the page: found if the server already holds it, and otherwise started as soon as the page opens
 * (in the background — the history is already on screen, and anything typed meanwhile waits for the agent).
 * `chatId` is for a chat that has no session yet (a new one); `sessionId` for continuing a session.
 */
export function useLiveChat(o: { machine: string; agent: string; sessionId?: string; chatId?: string; enabled: boolean; say: (s: string) => void }) {
  const { machine, agent, sessionId, chatId, enabled, say } = o
  const found = useChatFor(machine, agent, sessionId ?? '')
  const [byId, setById] = useState<ChatSummary | null | undefined>(undefined)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string>()
  const opened = useRef<Promise<ChatSummary> | undefined>(undefined)
  const chat = (chatId ? byId : found.chat) ?? undefined
  const view = useChatStream(chat)
  const actions = useChatActions(chat?.id)

  useEffect(() => {
    if (!chatId) return
    setById(undefined)
    chatApi.get(chatId).then(setById, () => setById(null))
  }, [chatId])
  useEffect(() => { opened.current = undefined; setError(undefined) }, [sessionId, chatId, machine])

  /** the chat for this session, started if it is not running yet (the server answers at once either way) */
  const ensure = useCallback(async (warm = false): Promise<ChatSummary> => {
    if (chat && view.state !== 'closed') return chat
    if (chatId) throw new Error('This chat has ended.')
    if (!opened.current || view.state === 'closed') {
      setOpening(true); setError(undefined)
      opened.current = chatApi.open({ machine, sessionId, warm }).then((c) => { found.setChat(c); return c })
      opened.current.catch((e) => setError((e as Error).message)).finally(() => setOpening(false))
    }
    return opened.current
  }, [chat, view.state, chatId, machine, sessionId])

  // the box was focused: bring the agent up if it is not (never started, or ended since); the server keeps it to one
  const warm = useCallback(() => { if (enabled && !chatId && (chat ? view.state === 'closed' : !opened.current)) ensure().catch(() => {}) }, [enabled, chat, chatId, view.state, ensure])
  // the page is open on this session: bring its agent up now, not when the box is first clicked
  useEffect(() => { if (enabled && sessionId && !chatId && found.chat === null && !opened.current) ensure(true).catch(() => {}) }, [enabled, sessionId, chatId, found.chat])
  const guard = (f: () => Promise<unknown>) => f().then(() => true, (e) => { say((e as Error).message); return false })
  const send = useCallback(async (text: string, images?: { mimeType: string; data: string }[]) => {
    try {
      const c = await ensure()
      await chatApi.send(c.id, text, images)
      return true
    } catch (e) { say((e as Error).message); return false }
  }, [ensure, say])
  return {
    chat, view, opening, error, warm, send, ensure, refresh: found.refresh, loading: chatId ? byId === undefined : found.chat === undefined,
    interrupt: () => guard(actions.interrupt),
    respond: async (a: string, opt: string) => { await actions.respond(a, opt) },
    answer: async (q: string, a: Record<string, string[]>) => { await actions.answer(q, a) },
    setModel: async (m: string) => { await guard(() => actions.setModel(m)) },
    setMode: async (m: string) => { await guard(() => actions.setMode(m)) },
    setEffort: async (m: string) => { await guard(() => actions.setEffort(m)) },
    close: () => actions.close(),
  }
}
