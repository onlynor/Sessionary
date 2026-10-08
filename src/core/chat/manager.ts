import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { AcpDriver } from './acp.ts'
import { ClaudeDriver } from './claude.ts'
import { CodexDriver } from './codex.ts'
import { PiDriver } from './pi.ts'
import {
  ChatError, type ChatCaps, type ChatDriver, type ChatEvent, type ChatInfo, type ChatSend, type ChatState, type Proc, type SpawnSpec, type Spawner, type StoredEvent,
} from './types.ts'

/** the agents that can be chatted with, and the protocol each one speaks */
export const CHAT_AGENTS = ['claude-code', 'codex', 'opencode', 'pi', 'hermes'] as const
export type ChatAgent = (typeof CHAT_AGENTS)[number]
export const chatSupported = (agent: string): agent is ChatAgent => (CHAT_AGENTS as readonly string[]).includes(agent)

export const PROTOCOL: Record<ChatAgent, string> = { 'claude-code': 'stream-json', codex: 'app-server', opencode: 'ACP', pi: 'rpc', hermes: 'ACP' }

const LOG_MAX = Number(process.env.SESSIONARY_CHAT_LOG_MAX ?? 3000)
const IDLE_MS = Number(process.env.SESSIONARY_CHAT_IDLE_MS ?? 30 * 60_000)
const MAX_CHATS = Number(process.env.SESSIONARY_CHAT_MAX ?? 12)
/** chats started ahead of time (a session page opening, a pointer resting on a session) that nobody has used yet */
const WARM_MAX = Number(process.env.SESSIONARY_CHAT_WARM_MAX ?? 2)
const WARM_MS = Number(process.env.SESSIONARY_CHAT_WARM_MS ?? 3 * 60_000)

export interface OpenRequest {
  agent: ChatAgent
  /** a machine id: 'local' or a node */
  machine: string
  cwd?: string
  /** the agent's own id for the session to continue (what its resume command takes) */
  resume?: string
  /** the Sessionary id of the session this continues, so the page can find the chat again */
  sessionKey?: string
  model?: string
  mode?: string
  effort?: string
  title?: string
}

export interface ChatSummary {
  id: string
  agent: ChatAgent
  machine: string
  cwd?: string
  sessionKey?: string
  sessionId?: string
  title?: string
  state: ChatState
  info: ChatInfo
  startedAt: number
  lastAt: number
  lastSeq: number
  error?: string
  /** how many approvals and questions are waiting for the person */
  pending: number
  /** the last assistant text, for notices and lists */
  preview?: string
  /** how long the last turn took, for deciding whether its end is worth a notice */
  lastTurnMs?: number
}

interface Chat {
  id: string
  req: OpenRequest
  driver: ChatDriver
  state: ChatState
  info: ChatInfo
  log: StoredEvent[]
  seq: number
  subs: Set<(e: StoredEvent) => void>
  startedAt: number
  lastAt: number
  error?: string
  pending: Set<string>
  working: boolean
  preview?: string
  turnAt?: number
  lastTurnMs?: number
  toolIdx: Map<string, StoredEvent>
  listeners: number
  /** started ahead of time and not used yet: the first message or command makes it an ordinary chat; a page open on it
   *  keeps it alive meanwhile, and once nobody looks it goes after WARM_MS */
  warm: boolean
  /** settles when the agent is up (true) or could not start (false); input waits on it */
  ready: Promise<boolean>
}

export interface ChatHooks {
  /** a chat changed in a way the page lists or notifies about (state, title, a request waiting) */
  changed?: (c: ChatSummary, why: 'state' | 'approval' | 'turn-end' | 'closed' | 'info') => void
}

export interface ChatsOptions {
  /** how to start a process for a machine ('local' runs it here, a node's id over ssh) */
  spawnFor: (machine: string) => Spawner
  /** the program that is run for an agent on a machine */
  binFor?: (agent: ChatAgent, machine: string) => string
  /** swap a driver for a test */
  driverFor?: (req: OpenRequest, emit: (e: ChatEvent) => void, spawner: Spawner) => ChatDriver | undefined
  /** what an agent is started with besides what its protocol needs: its model routing (control/agents.ts) */
  launchFor?: (agent: ChatAgent, machine: string, at: { project?: string; session?: string }) => Promise<{ env: Record<string, string>; args: string[]; secret?: { name: string; value: string }; tunnel?: { remotePort: number; localPort: number }; session?: { provider?: string; model: string }; files?: Record<string, string>; release?: () => void } | undefined>
  hooks?: ChatHooks
}

/** local processes; the environment is the person's own, with what the protocol needs added */
export const localSpawner: Spawner = (s: SpawnSpec): Proc => spawn(s.bin, s.args, { cwd: s.cwd, env: { ...process.env, ...s.env, ...(s.secret && { [s.secret.name]: s.secret.value }) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as Proc

const DEFAULT_BIN: Record<ChatAgent, string> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi', hermes: 'hermes' }
const ENV_BIN: Record<ChatAgent, string> = { 'claude-code': 'SESSIONARY_CLAUDE_BIN', codex: 'SESSIONARY_CODEX_BIN', opencode: 'SESSIONARY_OPENCODE_BIN', pi: 'SESSIONARY_PI_BIN', hermes: 'SESSIONARY_HERMES_BIN' }
export const localBin = (agent: ChatAgent) => process.env[ENV_BIN[agent]] ?? DEFAULT_BIN[agent]

/**
 * Live conversations. Each chat is a process on the agent's official protocol that the server keeps while the page is
 * closed, with a numbered log of what happened so a page that opens (or reconnects) late catches up from the
 * log instead of from the process. The log is compacted as it goes: finished text replaces its deltas, and a tool
 * keeps one entry holding its latest state.
 */
export class Chats {
  private chats = new Map<string, Chat>()
  private sweeper?: NodeJS.Timeout
  constructor(private o: ChatsOptions) {
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, Math.min(60_000, IDLE_MS / 4)))
    this.sweeper.unref?.()
  }

  list(machine?: string): ChatSummary[] { return [...this.chats.values()].filter((c) => !machine || c.req.machine === machine).map((c) => this.summary(c)) }
  get(id: string): ChatSummary | undefined { const c = this.chats.get(id); return c && this.summary(c) }
  /** the live chat that continues a session, if there is one */
  forSession(machine: string, agent: string, key: string): ChatSummary | undefined {
    const c = [...this.chats.values()].find((x) => x.state !== 'closed' && x.req.machine === machine && x.req.agent === agent && this.keyOf(x) === key)
    return c && this.summary(c)
  }

  /** the Sessionary id of the session this chat is writing (known once the agent has said what it is) */
  private keyOf(c: Chat): string | undefined {
    const n = c.info.nativeId ?? c.info.sessionId
    return c.req.sessionKey ?? (n ? `${c.req.agent}:${n}` : undefined)
  }
  private summary(c: Chat): ChatSummary {
    return {
      id: c.id, agent: c.req.agent, machine: c.req.machine, cwd: c.req.cwd, sessionKey: this.keyOf(c), sessionId: c.info.sessionId, title: c.req.title,
      state: c.state, info: c.info, startedAt: c.startedAt, lastAt: c.lastAt, lastSeq: c.seq, error: c.error, pending: c.pending.size, preview: c.preview, lastTurnMs: c.lastTurnMs,
    }
  }

  /**
   * A chat for this session, at once. The record exists before anything is started, so two opens of one session (a
   * prewarm and a click) find the same chat and never start two agents; the agent itself comes up in the background,
   * and whatever is sent meanwhile waits for it. `warm`: opened ahead of time, before anyone asked for it — such chats
   * are few and short-lived unless someone uses them (starting an agent costs no tokens, only a process).
   */
  async open(req: OpenRequest, opts: { warm?: boolean } = {}): Promise<ChatSummary> {
    if (!chatSupported(req.agent)) throw new ChatError('This agent cannot be chatted with from Sessionary.', 'unsupported')
    const existing = req.sessionKey ? [...this.chats.values()].find((x) => x.state !== 'closed' && x.req.machine === req.machine && x.req.agent === req.agent && this.keyOf(x) === req.sessionKey) : undefined
    if (existing) {
      if (!opts.warm) existing.warm = false
      return this.summary(existing)
    }
    const running = [...this.chats.values()].filter((c) => c.state !== 'closed')
    if (opts.warm) {
      // a prewarm never crowds out real work: it gives way when the server is busy, and pushes out older prewarms
      if (running.length >= MAX_CHATS - 1) throw new ChatError('Too many chats are running to start one ahead of time.', 'busy')
      const idleWarm = running.filter((c) => c.warm && c.listeners === 0).sort((x, y) => x.lastAt - y.lastAt)
      for (const c of idleWarm.slice(0, Math.max(0, idleWarm.length - WARM_MAX + 1))) this.close(c.id).catch(() => {})
    } else if (running.length >= MAX_CHATS) throw new ChatError(`At most ${MAX_CHATS} chats can run at once; close one first.`, 'busy')

    const id = randomUUID().slice(0, 12)
    const chat: Chat = {
      id, req, state: 'starting', info: { agent: req.agent, cwd: req.cwd }, log: [], seq: 0, subs: new Set(), startedAt: Date.now(), lastAt: Date.now(),
      pending: new Set(), working: false, toolIdx: new Map(), listeners: 0, driver: undefined as unknown as ChatDriver, warm: !!opts.warm, ready: Promise.resolve(false),
    }
    this.chats.set(id, chat)
    chat.ready = this.boot(chat)
    return this.summary(chat)
  }

  /** starts the agent for a chat; never throws: a chat that cannot start ends, saying why */
  private async boot(chat: Chat, attempt = 0): Promise<boolean> {
    const { req } = chat
    const emit = (e: ChatEvent) => this.record(chat, e)
    // read fresh each time: the chat can be closed while its agent is still starting
    const isClosed = () => chat.state === 'closed'
    let extra: Awaited<ReturnType<NonNullable<ChatsOptions['launchFor']>>>
    // the route of this session on this machine: its own, else its project's, its agent's, its machine's, the default
    try { extra = await this.o.launchFor?.(req.agent, req.machine, { project: req.cwd, session: req.sessionKey }) } catch (e) { return this.failed(chat, (e as Error).message) }
    if (isClosed()) { extra?.release?.(); return false } // closed while it was being prepared
    const base = this.o.spawnFor(req.machine)
    // the routing's arguments go first, so a model picked in the chat itself still has the last word; a node's door
    // closes when the process does, however it ends
    const spawner: Spawner = extra ? (s) => {
      const p = base({ ...s, args: [...extra!.args, ...s.args], env: { ...s.env, ...extra!.env }, ...(extra!.secret && { secret: extra!.secret }), ...(extra!.tunnel && { tunnel: extra!.tunnel }), ...(extra!.files && { files: extra!.files }) })
      if (extra!.release) { p.on('close', extra!.release); p.on('error', extra!.release) }
      return p
    } : base
    const bin = this.o.binFor?.(req.agent, req.machine) ?? (req.machine === 'local' ? localBin(req.agent) : DEFAULT_BIN[req.agent])
    const driver = this.o.driverFor?.(req, emit, spawner) ?? this.makeDriver(req, bin, emit, spawner, extra?.session)
    chat.driver = driver
    let started = false
    ;(driver as { onEnd?: (e?: string) => void }).onEnd = (error) => {
      if (!started) return // a failed start is reported once, below
      chat.error = error ?? chat.error
      if (error) this.noteOnce(chat, error)
      this.setState(chat, 'closed')
      this.o.hooks?.changed?.(this.summary(chat), 'closed')
    }
    try { await driver.start() } catch (e) {
      extra?.release?.() // nothing may have been started to close it
      try { await driver.close() } catch { /* already gone */ }
      // the port picked on the node for the tunnel was in use: another launch picks another port (and a new door)
      if (extra?.tunnel && attempt === 0 && !isClosed() && /remote port forwarding failed/i.test((e as Error).message)) return this.boot(chat, 1)
      return this.failed(chat, (e as Error).message)
    }
    started = true
    if (isClosed()) { driver.close().catch(() => {}); return false }
    if (chat.state === 'starting') this.setState(chat, 'idle')
    return true
  }

  private failed(chat: Chat, why: string): false {
    chat.error = why
    this.noteOnce(chat, why)
    this.setState(chat, 'closed')
    this.o.hooks?.changed?.(this.summary(chat), 'closed')
    setTimeout(() => this.chats.delete(chat.id), 60_000).unref?.()
    return false
  }

  /** an error, said once: a driver reports its own end, and the manager says why only if it has not */
  private noteOnce(chat: Chat, text: string) {
    if (!chat.log.some((e) => e.t === 'note' && (e as { text: string }).text === text)) this.record(chat, { t: 'note', level: 'error', text })
  }

  private makeDriver(req: OpenRequest, bin: string, emit: (e: ChatEvent) => void, spawner: Spawner, routed?: { provider?: string; model: string }): ChatDriver {
    const common = { spawn: spawner, bin, cwd: req.cwd, resume: req.resume, model: req.model ?? routed?.model }
    switch (req.agent) {
      case 'claude-code': return new ClaudeDriver({ ...common, mode: req.mode }, emit)
      case 'codex': return new CodexDriver({ ...common, mode: req.mode, effort: req.effort, provider: routed?.provider }, emit)
      case 'opencode': return new AcpDriver({ ...common, agent: 'opencode', args: ['acp'], mode: req.mode }, emit)
      case 'hermes': return new AcpDriver({ ...common, agent: 'hermes', args: ['acp'], mode: req.mode }, emit)
      case 'pi': return new PiDriver({ ...common, effort: req.effort }, emit)
    }
  }

  // ---- the log ----
  private record(c: Chat, e: ChatEvent) {
    c.lastAt = Date.now()
    if (e.t === 'info') {
      c.info = { ...c.info, ...Object.fromEntries(Object.entries(e.info).filter(([, v]) => v !== undefined)) } as ChatInfo
      if (e.info.caps) c.info.caps = { ...c.info.caps, ...e.info.caps } as Partial<ChatCaps>
      if (e.info.sessionId && e.info.sessionId !== c.req.resume) this.o.hooks?.changed?.(this.summary(c), 'info')
    }
    if (e.t === 'turn' && e.state === 'start') { c.turnAt ??= Date.now(); c.working = true; if (c.pending.size === 0) this.setState(c, 'working') }
    if (e.t === 'turn' && e.state === 'end') { c.lastTurnMs = c.turnAt ? Date.now() - c.turnAt : undefined; c.turnAt = undefined; c.working = false; c.pending.clear(); this.setState(c, 'idle') }
    if (e.t === 'approval' || e.t === 'question') { c.pending.add(e.id); this.setState(c, 'waiting'); this.o.hooks?.changed?.(this.summary(c), 'approval') }
    if ((e.t === 'approval.done' || e.t === 'question.done') && c.pending.delete(e.id) && c.pending.size === 0) this.setState(c, c.working ? 'working' : 'idle')
    if (e.t === 'text.end' && e.text.trim()) c.preview = e.text.trim().slice(0, 240)

    const se = { ...e, seq: ++c.seq, at: Date.now() } as StoredEvent
    // compaction: a finished block replaces its deltas, a tool keeps one entry
    if (e.t === 'text.end' || e.t === 'thinking.end') {
      const delta = e.t === 'text.end' ? 'text' : 'thinking'
      c.log = c.log.filter((x) => !(x.t === delta && (x as { id: string }).id === e.id))
    }
    if (e.t === 'tool') {
      const prev = c.toolIdx.get(e.id)
      if (prev) {
        const i = c.log.indexOf(prev)
        if (i >= 0) { c.log[i] = se; c.toolIdx.set(e.id, se); this.fan(c, se); return }
      }
      c.toolIdx.set(e.id, se)
    }
    if (e.t === 'info') {
      // only the newest `info` matters to a late reader
      const i = c.log.findIndex((x) => x.t === 'info')
      if (i >= 0) { c.log[i] = { ...se, info: c.info } as StoredEvent; this.fan(c, se); return }
    }
    c.log.push(se)
    if (c.log.length > LOG_MAX) {
      const drop = c.log.length - Math.floor(LOG_MAX * 0.8)
      const kept = c.log.slice(drop)
      for (const x of c.log.slice(0, drop)) if (x.t === 'tool') c.toolIdx.delete(x.id)
      // an `info` entry survives however old it is
      const info = c.log.slice(0, drop).find((x) => x.t === 'info')
      c.log = info ? [info, ...kept] : kept
    }
    this.fan(c, se)
  }
  private fan(c: Chat, e: StoredEvent) { for (const f of c.subs) { try { f(e) } catch { /* a dead reader */ } } }

  private setState(c: Chat, s: ChatState) {
    if (c.state === s || (c.state === 'closed' && s !== 'closed')) return
    c.state = s
    this.fan(c, { t: 'status', state: s, seq: ++c.seq, at: Date.now() })
    if (s === 'idle' && c.working === false) this.o.hooks?.changed?.(this.summary(c), 'turn-end')
    else this.o.hooks?.changed?.(this.summary(c), 'state')
  }

  /** events after `after` (0 for everything), then each new one until the returned function is called */
  subscribe(id: string, after: number, fn: (e: StoredEvent) => void): (() => void) | undefined {
    const c = this.chats.get(id)
    if (!c) return
    // a page open on it keeps it alive (see sweep); only using it makes a prewarmed chat an ordinary one
    for (const e of c.log.filter((x) => x.seq > after)) fn(e)
    fn({ t: 'status', state: c.state, seq: c.seq, at: Date.now() })
    c.subs.add(fn)
    c.listeners++
    return () => { c.subs.delete(fn); c.listeners-- ; c.lastAt = Date.now() }
  }

  private need(id: string): Chat {
    const c = this.chats.get(id)
    if (!c) throw new ChatError('No such chat.', 'unavailable')
    if (c.state === 'closed') throw new ChatError(c.error ?? 'This chat has ended.', 'unavailable')
    return c
  }
  /** the chat once its agent is up: what was asked of it while it was starting is done now, in order */
  private async ready(id: string): Promise<Chat> {
    const c = this.need(id)
    c.warm = false // used, not just looked at
    if (!(await c.ready)) throw new ChatError(c.error ?? 'The agent could not start.', 'unavailable')
    return this.need(id)
  }

  async send(id: string, m: ChatSend) {
    const first = this.need(id)
    if (!m.text.trim() && !m.images?.length) throw new ChatError('The message is empty.', 'failed')
    if (first.working && first.info.caps?.steer === false) throw new ChatError('The agent is still working; wait for it to finish or interrupt it.', 'busy')
    first.warm = false
    // the message shows at once; if the agent is still starting it is delivered as soon as it is up
    this.record(first, { t: 'user', id: randomUUID().slice(0, 8), text: m.text, ...((first.working || first.state === 'starting') && { queued: true }) })
    const c = await this.ready(id)
    if (!c.working) { c.working = true; this.setState(c, 'working') }
    try { await c.driver.send(m) } catch (e) {
      // the message did not reach the agent
      c.working = c.state === 'working' && c.pending.size > 0
      if (!c.working) this.setState(c, 'idle')
      throw e instanceof ChatError ? e : new ChatError((e as Error).message, 'failed')
    }
  }
  async interrupt(id: string) { await (await this.ready(id)).driver.interrupt() }
  async respond(id: string, approval: string, option: string) { await (await this.ready(id)).driver.respond(approval, option) }
  async answer(id: string, question: string, answers: Record<string, string[]>) { await (await this.ready(id)).driver.answer(question, answers) }
  async setModel(id: string, model: string) { await (await this.ready(id)).driver.setModel(model) }
  async setMode(id: string, mode: string) { await (await this.ready(id)).driver.setMode(mode) }
  async setEffort(id: string, effort: string) { await (await this.ready(id)).driver.setEffort(effort) }

  async close(id: string) {
    const c = this.chats.get(id)
    if (!c) return
    if (c.state !== 'closed') { this.setState(c, 'closed'); await c.driver?.close().catch(() => {}) }
    // keep a finished chat's log for a minute so a page that is still open can show how it ended
    setTimeout(() => this.chats.delete(id), 60_000).unref?.()
  }

  /** chats nobody is watching and nothing is happening in go away; a person's work is never cut off */
  private sweep() {
    const now = Date.now()
    for (const c of this.chats.values()) {
      if (c.state === 'idle' && c.listeners === 0 && now - c.lastAt > IDLE_MS) this.close(c.id).catch(() => {})
      // started ahead of time and never used: it goes soon, so prewarming leaves no crowd of idle agents behind
      else if (c.warm && c.listeners === 0 && (c.state === 'idle' || c.state === 'starting') && now - c.startedAt > WARM_MS) this.close(c.id).catch(() => {})
    }
  }

  async stopAll() {
    if (this.sweeper) clearInterval(this.sweeper)
    await Promise.all([...this.chats.keys()].map((id) => this.close(id)))
  }
}
