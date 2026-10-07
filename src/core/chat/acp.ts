import { RpcPeer, exitReason } from './lines.ts'
import { ChatError, type ApprovalOption, type ChatDriver, type ChatSend, type Emit, type ModeOption, type Proc, type SlashCommand, type Spawner } from './types.ts'

/** the text of an ACP content block, or what stands in for it */
function blockText(c: any): string {
  if (!c) return ''
  if (c.type === 'text') return c.text ?? ''
  if (c.type === 'resource_link') return c.uri ?? ''
  if (c.type === 'resource') return c.resource?.text ?? c.resource?.uri ?? ''
  if (c.type === 'image') return '[image]'
  return ''
}
const toolText = (content: any[] | undefined): string | undefined => {
  const t = (content ?? []).map((c) => (c?.type === 'content' ? blockText(c.content) : c?.type === 'terminal' ? `[terminal ${c.terminalId}]` : '')).filter(Boolean).join('\n')
  return t || undefined
}
const diffOf = (content: any[] | undefined): string | undefined => {
  const d = (content ?? []).filter((c) => c?.type === 'diff')
  if (!d.length) return
  return d.map((c) => {
    const a = String(c.oldText ?? '').split('\n'), b = String(c.newText ?? '').split('\n')
    return `@@ ${c.path}\n${c.oldText ? a.map((l) => '-' + l).join('\n') + '\n' : ''}${b.map((l) => '+' + l).join('\n')}`
  }).join('\n')
}

/**
 * The Agent Client Protocol (agentclientprotocol.com), which editors such as Zed use to drive an agent: JSON-RPC
 * over stdio. OpenCode (`opencode acp`) and Hermes (`hermes acp`) both speak it. The agent streams
 * `session/update` notifications; `session/request_permission` is how it asks before a tool runs.
 */
export class AcpDriver implements ChatDriver {
  sessionId?: string
  private rpc!: RpcPeer
  private proc!: Proc
  private turn = false
  private msg = { id: '', text: '' }
  private thought = { id: '', text: '' }
  private tools = new Map<string, { name: string; input?: unknown; kind?: string }>()
  private pending = new Map<string, { reply: (r: unknown) => void; options: any[] }>()
  private modeState: { id?: string; list: ModeOption[] } = { list: [] }
  private modelState: { id?: string; list: { id: string; label: string; description?: string }[] } = { list: [] }
  private effortOpt?: { id: string; values: string[]; cur?: string }
  private modeOptId?: string
  private modelOptId?: string
  private commands: SlashCommand[] = []
  private loadedHistory = false
  private ended = false
  /** closed from here: its end is no news */
  private closing = false
  onEnd?: (error?: string) => void

  constructor(private o: { agent: string; spawn: Spawner; bin: string; args: string[]; cwd?: string; resume?: string; model?: string; mode?: string; env?: Record<string, string> }, private emit: Emit) {}

  async start() {
    this.proc = this.o.spawn({ bin: this.o.bin, args: this.o.args, cwd: this.o.cwd, env: { NO_COLOR: '1', ...this.o.env } })
    this.proc.on('error', (e: NodeJS.ErrnoException) => this.end(e.code === 'ENOENT' ? `The ${this.o.bin} command was not found.` : e.message))
    this.proc.on('close', (code, signal) => this.end(exitReason(code, signal, this.rpc.reader.stderr, this.closing)))
    this.rpc = new RpcPeer(this.proc, { notification: (m, p) => this.onNotification(m, p), request: (m, p, reply, fail) => this.onRequest(m, p, reply, fail) })
    const fail = (e: Error) => new ChatError(`${this.o.agent} did not start: ${this.rpc.reader.stderr.trim().split('\n').slice(-2).join(' ') || e.message}`, 'unavailable')
    const init = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'sessionary', title: 'Sessionary', version: '0.1.0' },
    }, 60_000).catch((e) => { throw fail(e) })
    const cwd = this.o.cwd ?? process.cwd()
    let res: any
    if (this.o.resume) {
      // history is already on disk (that is what the page shows), so replay is not wanted: drop what `load` streams
      const caps = init.agentCapabilities ?? {}
      const method = caps.sessionCapabilities?.resume ? 'session/resume' : caps.loadSession ? 'session/load' : undefined
      if (!method) throw new ChatError(`${this.o.agent} cannot resume sessions over ACP.`, 'unsupported')
      this.loadedHistory = method === 'session/load'
      res = await this.rpc.request(method, { sessionId: this.o.resume, cwd, mcpServers: [] }, 120_000).catch((e) => { throw new ChatError(e.message, 'failed') })
      this.loadedHistory = false
      this.sessionId = this.o.resume
      res = res ?? {}
    } else {
      res = await this.rpc.request('session/new', { cwd, mcpServers: [] }, 120_000).catch((e) => { throw new ChatError(e.message, 'failed') })
      this.sessionId = res.sessionId
    }
    this.readOptions(res)
    if (this.o.model && this.o.model !== this.modelState.id) await this.setModel(this.o.model).catch(() => {})
    if (this.o.mode && this.o.mode !== this.modeState.id) await this.setMode(this.o.mode).catch(() => {})
    this.emit({
      t: 'info',
      info: {
        agent: this.o.agent, sessionId: this.sessionId, cwd, version: init.agentInfo?.version,
        model: this.modelState.id, models: this.modelState.list, mode: this.modeState.id, modes: this.modeState.list,
        effort: this.effortOpt?.cur, efforts: this.effortOpt?.values, commands: this.commands,
        caps: { interrupt: true, steer: false, setModel: this.modelState.list.length > 0, setMode: this.modeState.list.length > 0, setEffort: !!this.effortOpt, images: !!init.agentCapabilities?.promptCapabilities?.image },
      },
    })
  }

  /** models and modes come either as configOptions (current) or as the older `models` / `modes` objects */
  private readOptions(res: any) {
    for (const o of res.configOptions ?? []) {
      const vals = (o.options ?? []).flatMap((x: any) => (x.options ? x.options : [x])).map((x: any) => ({ id: x.value, label: x.name ?? x.value, description: x.description ?? undefined }))
      if (o.category === 'model' || o.id === 'model') { this.modelOptId = o.id; this.modelState = { id: o.currentValue, list: vals } }
      else if (o.category === 'mode' || o.id === 'mode') { this.modeOptId = o.id; this.modeState = { id: o.currentValue, list: vals } }
      else if (o.category === 'thought_level' || o.id === 'thought_level' || o.id === 'reasoning_effort') this.effortOpt = { id: o.id, values: vals.map((v: any) => v.id), cur: o.currentValue }
    }
    if (!this.modelState.list.length && res.models) this.modelState = { id: res.models.currentModelId, list: (res.models.availableModels ?? []).map((m: any) => ({ id: m.modelId, label: m.name ?? m.modelId, description: m.description ?? undefined })) }
    if (!this.modeState.list.length && res.modes) this.modeState = { id: res.modes.currentModeId, list: (res.modes.availableModes ?? []).map((m: any) => ({ id: m.id, label: m.name ?? m.id, description: m.description ?? undefined })) }
  }

  private end(error?: string) {
    if (this.ended) return
    this.ended = true
    if (error) this.emit({ t: 'note', level: 'error', text: error })
    this.onEnd?.(error)
  }

  async send(m: ChatSend) {
    if (!this.sessionId) throw new ChatError('The session is not ready.', 'failed')
    if (this.turn) throw new ChatError('The agent is still working on the last message.', 'busy')
    this.turn = true
    this.msg = { id: '', text: '' }
    this.thought = { id: '', text: '' }
    this.emit({ t: 'turn', state: 'start' })
    const prompt = [...(m.images ?? []).map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data })), { type: 'text', text: m.text }]
    // the answer to session/prompt is the turn's end; the stream arrives meanwhile as notifications
    this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt }, 24 * 3600_000).then((r) => {
      this.closeBlocks()
      const stop = r?.stopReason
      this.finish(stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'error' : 'done', stop === 'refusal' ? 'The model refused to continue.' : undefined, r?.usage)
    }, (e) => { this.closeBlocks(); this.finish('error', e.message) })
  }

  private finish(stop: 'done' | 'interrupted' | 'error', error?: string, usage?: any) {
    if (!this.turn) return
    this.turn = false
    for (const id of [...this.pending.keys()]) { this.pending.delete(id); this.emit({ t: 'approval.done', id, outcome: 'cancel' }) }
    this.emit({ t: 'turn', state: 'end', stop, ...(error && { error }), ...(usage && { usage: { input: usage.inputTokens, output: usage.outputTokens } }) })
  }

  private closeBlocks() {
    if (this.thought.id) this.emit({ t: 'thinking.end', id: this.thought.id, text: this.thought.text })
    if (this.msg.id) this.emit({ t: 'text.end', id: this.msg.id, text: this.msg.text })
    this.thought = { id: '', text: '' }
    this.msg = { id: '', text: '' }
  }

  async interrupt() { if (this.turn && this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId }) }

  private async setOption(id: string | undefined, value: string, legacy: string, legacyKey: string) {
    if (!this.sessionId) throw new ChatError('The session is not ready.')
    try {
      if (id) await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value }, 30_000)
      else await this.rpc.request(legacy, { sessionId: this.sessionId, [legacyKey]: value }, 30_000)
    } catch (e) {
      // agents differ on which of the two they implement
      await this.rpc.request(legacy, { sessionId: this.sessionId, [legacyKey]: value }, 30_000).catch(() => { throw e })
    }
  }
  async setModel(id: string) { await this.setOption(this.modelOptId, id, 'session/set_model', 'modelId'); this.modelState.id = id; this.emit({ t: 'info', info: { agent: this.o.agent, model: id } }) }
  async setMode(id: string) { await this.setOption(this.modeOptId, id, 'session/set_mode', 'modeId'); this.modeState.id = id; this.emit({ t: 'info', info: { agent: this.o.agent, mode: id } }) }
  async setEffort(level: string) {
    if (!this.effortOpt) throw new ChatError('This agent has no effort setting.', 'unsupported')
    await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: this.effortOpt.id, value: level }, 30_000)
    this.effortOpt.cur = level
    this.emit({ t: 'info', info: { agent: this.o.agent, effort: level } })
  }
  async answer(): Promise<void> { throw new ChatError('This agent does not ask questions this way.', 'unsupported') }
  async close() {
    if (this.ended) return
    this.closing = true
    try { await Promise.race([this.rpc.request('session/close', { sessionId: this.sessionId }, 2000), new Promise((r) => setTimeout(r, 2000))]) } catch { /* not every agent has it */ }
    try { this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => p.kill('SIGTERM'), 1500).unref?.()
  }

  async respond(id: string, optionId: string) {
    const p = this.pending.get(id)
    if (!p) throw new ChatError('That request is no longer pending.', 'failed')
    this.pending.delete(id)
    p.reply({ outcome: p.options.some((o) => o.optionId === optionId) ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } })
    this.emit({ t: 'approval.done', id, outcome: optionId })
  }

  private onRequest(method: string, p: any, reply: (r: unknown) => void, fail: (c: number, m: string) => void) {
    if (method !== 'session/request_permission') return fail(-32601, `Sessionary does not handle ${method}`)
    const tc = p.toolCall ?? {}
    const id = `perm-${tc.toolCallId ?? Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2, 6)}`
    this.pending.set(id, { reply, options: p.options ?? [] })
    const kind = (k: string): ApprovalOption['kind'] => (k === 'allow_always' ? 'allow_always' : k === 'allow_once' ? 'allow' : 'deny')
    const known = this.tools.get(tc.toolCallId)
    const raw = tc.rawInput ?? known?.input
    this.emit({
      t: 'approval', id, tool: known?.name ?? tc.title ?? 'tool', title: tc.title ?? known?.name ?? 'Tool', detail: typeof raw?.command === 'string' ? raw.command : (tc.locations?.[0]?.path ?? undefined),
      input: raw, diff: diffOf(tc.content),
      options: (p.options ?? []).map((o: any) => ({ id: o.optionId, label: o.name ?? o.optionId, kind: kind(o.kind) })),
    })
  }

  private onNotification(method: string, p: any) {
    if (method !== 'session/update' || p?.sessionId !== this.sessionId) return
    const u = p.update
    // `session/load` replays the whole history; the page already has it
    if (this.loadedHistory) { if (u?.sessionUpdate === 'available_commands_update') this.commandsUpdate(u); return }
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = blockText(u.content)
        if (!t) return
        if (this.thought.id) { this.emit({ t: 'thinking.end', id: this.thought.id, text: this.thought.text }); this.thought = { id: '', text: '' } }
        const id = u.messageId ?? (this.msg.id || `m${Date.now()}`)
        if (this.msg.id && this.msg.id !== id) this.emit({ t: 'text.end', id: this.msg.id, text: this.msg.text }), (this.msg = { id: '', text: '' })
        this.msg = { id, text: this.msg.text + t }
        this.emit({ t: 'text', id, delta: t })
        return
      }
      case 'agent_thought_chunk': {
        const t = blockText(u.content)
        if (!t) return
        const id = u.messageId ?? (this.thought.id || `th${Date.now()}`)
        if (this.thought.id && this.thought.id !== id) this.emit({ t: 'thinking.end', id: this.thought.id, text: this.thought.text }), (this.thought = { id: '', text: '' })
        this.thought = { id, text: this.thought.text + t }
        this.emit({ t: 'thinking', id, delta: t })
        return
      }
      case 'tool_call': case 'tool_call_update': {
        // text before a tool call is complete
        if (this.msg.id) { this.emit({ t: 'text.end', id: this.msg.id, text: this.msg.text }); this.msg = { id: '', text: '' } }
        if (this.thought.id) { this.emit({ t: 'thinking.end', id: this.thought.id, text: this.thought.text }); this.thought = { id: '', text: '' } }
        const prev = this.tools.get(u.toolCallId)
        const name = prev?.name ?? u.title ?? u.kind ?? 'tool'
        const kind = u.kind ?? prev?.kind
        const input = u.rawInput && Object.keys(u.rawInput).length ? u.rawInput : prev?.input
        // the first update carries the tool's name as its title; a later one carries a nicer one (a path)
        this.tools.set(u.toolCallId, { name: prev?.name ?? (u.title ?? kind ?? 'tool'), input, kind })
        const st = u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'error' : 'running'
        const out = toolText(u.content) ?? (u.rawOutput?.output != null ? String(u.rawOutput.output) : undefined)
        const diff = diffOf(u.content)
        this.emit({ t: 'tool', id: u.toolCallId, name, ...(input !== undefined && { input }), status: st, ...(out !== undefined && { output: out }), ...(diff && { diff }) })
        return
      }
      case 'plan': {
        const entries: any[] = u.entries ?? []
        this.emit({ t: 'tool', id: 'plan', name: 'Plan', input: { todos: entries.map((e) => ({ content: e.content, status: e.status })) }, status: entries.every((e) => e.status === 'completed') ? 'ok' : 'running' })
        return
      }
      case 'available_commands_update': this.commandsUpdate(u); return
      case 'current_mode_update': this.modeState.id = u.currentModeId; this.emit({ t: 'info', info: { agent: this.o.agent, mode: u.currentModeId } }); return
      case 'config_option_update': {
        this.readOptions({ configOptions: u.configOptions })
        this.emit({ t: 'info', info: { agent: this.o.agent, model: this.modelState.id, models: this.modelState.list, mode: this.modeState.id, modes: this.modeState.list } })
        return
      }
      case 'usage_update': this.emit({ t: 'usage', usage: { context: u.used, window: u.size, cost: u.cost?.amount } }); return
      case 'session_info_update': return
    }
  }
  private commandsUpdate(u: any) {
    this.commands = (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description, hint: c.input?.hint }))
    this.emit({ t: 'info', info: { agent: this.o.agent, commands: this.commands } })
  }
}
