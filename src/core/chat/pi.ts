import { LineReader, textDiff } from './lines.ts'
import { ChatError, type ChatDriver, type ChatSend, type Emit, type Proc, type Spawner } from './types.ts'

const text = (c: any): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n') : '')

/**
 * Pi's RPC mode (`pi --mode rpc`): one JSON object per line each way. Commands carry an `id` that the `response`
 * echoes; everything else is a stream of session events. Pi has no tool-approval step of its own (extensions may ask
 * through `extension_ui_request`, which is answered here).
 */
export class PiDriver implements ChatDriver {
  sessionId?: string
  private proc!: Proc
  private reader!: LineReader
  private n = 0
  private waiting = new Map<string, { res: (v: any) => void; rej: (e: Error) => void }>()
  private state: any = {}
  private tools = new Map<string, { name: string; args?: unknown }>()
  private streaming = false
  private asked = new Map<string, any>()
  private turnOpen = false
  private ended = false
  onEnd?: (error?: string) => void

  constructor(private o: { spawn: Spawner; bin?: string; cwd?: string; resume?: string; model?: string; effort?: string }, private emit: Emit) {}

  async start() {
    const args = ['--mode', 'rpc']
    if (this.o.resume) args.push('--session', this.o.resume)
    if (this.o.model) args.push('--model', this.o.model)
    if (this.o.effort) args.push('--thinking', this.o.effort)
    this.proc = this.o.spawn({ bin: this.o.bin ?? 'pi', args, cwd: this.o.cwd, env: { NO_COLOR: '1' } })
    this.proc.on('error', (e: NodeJS.ErrnoException) => this.end(e.code === 'ENOENT' ? 'The pi command was not found.' : e.message))
    this.proc.on('close', (code) => this.end(code ? this.reader.stderr.trim().split('\n').slice(-3).join('\n') || `The agent exited with code ${code}.` : undefined))
    this.reader = new LineReader(this.proc, (o) => this.onMessage(o), () => {})
    const fail = (e: Error) => new ChatError(`Pi did not start: ${this.reader.stderr.trim().split('\n').slice(-2).join(' ') || e.message}`, 'unavailable')
    const [st, models, levels, cmds] = await Promise.all([
      this.command({ type: 'get_state' }, 30_000),
      this.command({ type: 'get_available_models' }, 30_000).catch(() => ({ models: [] })),
      this.command({ type: 'get_available_thinking_levels' }, 30_000).catch(() => ({ levels: [] })),
      this.command({ type: 'get_commands' }, 30_000).catch(() => ({ commands: [] })),
    ]).catch((e) => { throw fail(e) })
    this.state = st
    this.sessionId = st.sessionFile ?? st.sessionId
    this.emit({
      t: 'info',
      info: {
        agent: 'pi', sessionId: this.sessionId, nativeId: st.sessionId, cwd: this.o.cwd,
        model: st.model ? `${st.model.provider}/${st.model.id}` : undefined, models: (models.models ?? []).map((m: any) => ({ id: `${m.provider}/${m.id}`, label: `${m.name ?? m.id} · ${m.provider}`, description: m.reasoning ? 'reasoning' : undefined })),
        effort: st.thinkingLevel, efforts: levels.levels,
        commands: (cmds.commands ?? []).map((c: any) => ({ name: c.name, description: c.description })),
        caps: { interrupt: true, steer: true, setModel: true, setMode: false, setEffort: true, images: !!st.model?.input?.includes?.('image') },
      },
    })
  }

  private command(c: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    const id = `sy-${++this.n}`
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(new Error(`${c.type} timed out`)) }, timeoutMs)
      t.unref?.()
      this.waiting.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      this.write({ id, ...c })
    })
  }
  private write(o: unknown) { try { this.proc.stdin.write(JSON.stringify(o) + '\n') } catch { /* gone: close reports it */ } }

  private end(error?: string) {
    if (this.ended) return
    this.ended = true
    const e = new Error(error ?? 'The agent process ended.')
    for (const w of this.waiting.values()) w.rej(e)
    this.waiting.clear()
    if (error) this.emit({ t: 'note', level: 'error', text: error })
    this.onEnd?.(error)
  }

  async send(m: ChatSend) {
    const images = (m.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
    await this.command({ type: 'prompt', message: m.text, ...(images.length && { images }), ...(this.streaming && { streamingBehavior: 'steer' }) })
  }
  async interrupt() { await this.command({ type: 'abort' }, 15_000).catch(() => {}) }
  async setModel(id: string) {
    const i = id.indexOf('/')
    const m = await this.command({ type: 'set_model', provider: id.slice(0, i), modelId: id.slice(i + 1) })
    this.emit({ t: 'info', info: { agent: 'pi', model: m?.provider ? `${m.provider}/${m.id}` : id } })
  }
  async setMode(): Promise<void> { throw new ChatError('Pi has no modes.', 'unsupported') }
  async setEffort(level: string) { await this.command({ type: 'set_thinking_level', level }); this.emit({ t: 'info', info: { agent: 'pi', effort: level } }) }
  async answer(): Promise<void> { throw new ChatError('Use respond for this request.', 'unsupported') }
  async close() {
    if (this.ended) return
    try { this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => p.kill('SIGTERM'), 2000).unref?.()
  }

  async respond(id: string, optionId: string) {
    const q = this.asked.get(id)
    if (!q) throw new ChatError('That request is no longer pending.', 'failed')
    this.asked.delete(id)
    const cancelled = optionId === 'cancel'
    if (q.method === 'confirm') this.write({ type: 'extension_ui_response', id, ...(cancelled ? { cancelled: true } : { confirmed: optionId === 'yes' }) })
    else this.write({ type: 'extension_ui_response', id, ...(cancelled ? { cancelled: true } : { value: optionId }) })
    this.emit({ t: 'approval.done', id, outcome: optionId })
  }

  private onMessage(o: any) {
    switch (o.type) {
      case 'response': {
        const w = this.waiting.get(o.id)
        if (!w) return
        this.waiting.delete(o.id)
        o.success ? w.res(o.data ?? {}) : w.rej(new ChatError(o.error ?? 'The command failed.'))
        return
      }
      case 'agent_start': this.streaming = true; this.turnOpen = true; this.emit({ t: 'turn', state: 'start' }); return
      case 'agent_settled': {
        this.streaming = false
        if (this.turnOpen) { this.turnOpen = false; this.emit({ t: 'turn', state: 'end', stop: this.lastError ? 'error' : this.aborted ? 'interrupted' : 'done', ...(this.lastError && { error: this.lastError }) }) }
        this.lastError = undefined; this.aborted = false
        return
      }
      case 'message_start': case 'message_end': return this.onMessageEvent(o)
      case 'message_update': return this.onUpdate(o)
      case 'tool_execution_start': this.tools.set(o.toolCallId, { name: o.toolName, args: o.args }); this.toolEvent(o.toolCallId, o.toolName, o.args, 'running'); return
      case 'tool_execution_update': this.toolEvent(o.toolCallId, o.toolName, o.args, 'running', text(o.partialResult?.content)); return
      case 'tool_execution_end': this.toolEvent(o.toolCallId, o.toolName, this.tools.get(o.toolCallId)?.args, o.isError ? 'error' : 'ok', text(o.result?.content)); return
      case 'auto_retry_start': this.emit({ t: 'note', level: 'warn', text: `Retrying (${o.attempt}/${o.maxAttempts}): ${String(o.errorMessage ?? '').slice(0, 200)}` }); this.lastError = undefined; return
      case 'auto_retry_end': if (o.success === false) this.lastError = o.finalError ?? this.lastError; return
      case 'compaction_start': this.emit({ t: 'note', level: 'info', text: 'Compacting the conversation…' }); return
      case 'extension_error': this.emit({ t: 'note', level: 'warn', text: `Extension error: ${o.error}` }); return
      case 'extension_ui_request': return this.onUi(o)
    }
  }
  private lastError?: string
  private aborted = false

  private onMessageEvent(o: any) {
    const m = o.message
    if (m?.role === 'assistant' && o.type === 'message_start') { this.seq++; this.block.clear() }
    if (m?.role === 'assistant' && o.type === 'message_end') {
      if (m.stopReason === 'error') this.lastError = m.errorMessage ?? 'The model returned an error.'
      else if (m.stopReason === 'aborted') this.aborted = true
      const u = m.usage
      if (u) this.emit({ t: 'usage', usage: { input: u.input, output: u.output, cost: u.cost?.total, context: u.totalTokens } })
    }
  }

  private block = new Map<number, { kind: 'text' | 'thinking'; id: string }>()
  private onUpdate(o: any) {
    const e = o.assistantMessageEvent
    if (!e) return
    const id = `${this.msgKey()}:${e.contentIndex}`
    switch (e.type) {
      case 'text_start': this.block.set(e.contentIndex, { kind: 'text', id: `${this.msgKey()}:${e.contentIndex}` }); return
      case 'thinking_start': this.block.set(e.contentIndex, { kind: 'thinking', id: `${this.msgKey()}:${e.contentIndex}` }); return
      case 'text_delta': { const b = this.block.get(e.contentIndex) ?? { kind: 'text' as const, id }; this.block.set(e.contentIndex, b); this.emit({ t: 'text', id: b.id, delta: e.delta }); return }
      case 'thinking_delta': { const b = this.block.get(e.contentIndex) ?? { kind: 'thinking' as const, id }; this.block.set(e.contentIndex, b); this.emit({ t: 'thinking', id: b.id, delta: e.delta }); return }
      case 'text_end': { const b = this.block.get(e.contentIndex); if (b) this.emit({ t: 'text.end', id: b.id, text: e.content ?? '' }); this.block.delete(e.contentIndex); return }
      case 'thinking_end': { const b = this.block.get(e.contentIndex); if (b && e.content) this.emit({ t: 'thinking.end', id: b.id, text: e.content }); this.block.delete(e.contentIndex); return }
      case 'toolcall_end': { const c = e.toolCall; if (c?.id) { this.tools.set(c.id, { name: c.name, args: c.arguments }); this.toolEvent(c.id, c.name, c.arguments, 'running') } return }
    }
  }
  private seq = 0
  private msgKey() { return `pi${this.epoch}-${this.seq}` }
  private epoch = Date.now().toString(36)

  private toolEvent(id: string, name: string, args: any, status: 'running' | 'ok' | 'error', output?: string) {
    let diff: string | undefined
    if (name === 'edit' && args) {
      const edits: any[] = Array.isArray(args.edits) ? args.edits : args.oldText != null ? [{ oldText: args.oldText, newText: args.newText }] : []
      if (edits.length) diff = edits.map((x) => textDiff(args.path ?? args.file_path ?? '', String(x.oldText ?? ''), String(x.newText ?? ''))).join('\n')
    } else if (name === 'write' && typeof args?.content === 'string') diff = textDiff(args.path ?? args.file_path ?? '', '', args.content)
    this.emit({ t: 'tool', id, name, ...(args !== undefined && { input: args }), status, ...(output !== undefined && { output }), ...(diff && { diff }) })
  }

  private onUi(o: any) {
    if (o.method === 'notify') { this.emit({ t: 'note', level: o.notifyType === 'error' ? 'error' : o.notifyType === 'warning' ? 'warn' : 'info', text: o.message }); return }
    if (o.method === 'select') {
      this.asked.set(o.id, o)
      this.emit({ t: 'approval', id: o.id, tool: 'extension', title: o.title ?? 'Choose', options: [...(o.options ?? []).map((x: string) => ({ id: x, label: x, kind: /^(deny|block|no|reject)/i.test(x) ? 'deny' as const : 'allow' as const })), { id: 'cancel', label: 'Cancel', kind: 'abort' as const }] })
    } else if (o.method === 'confirm') {
      this.asked.set(o.id, o)
      this.emit({ t: 'approval', id: o.id, tool: 'extension', title: o.title ?? 'Confirm', detail: o.message, options: [{ id: 'yes', label: 'Yes', kind: 'allow' }, { id: 'no', label: 'No', kind: 'deny' }] })
    } else if (o.method === 'input' || o.method === 'editor') {
      // free text has no card; decline so the extension is not left waiting
      this.write({ type: 'extension_ui_response', id: o.id, cancelled: true })
      this.emit({ t: 'note', level: 'warn', text: `An extension asked for text (${o.title ?? o.method}); Sessionary cannot answer that here.` })
    }
  }
}
