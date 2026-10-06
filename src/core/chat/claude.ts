import { LineReader, textDiff } from './lines.ts'
import { ChatError, type ChatDriver, type ChatSend, type Emit, type ModeOption, type Proc, type Question, type SpawnSpec, type Spawner } from './types.ts'

const MODES: ModeOption[] = [
  { id: 'default', label: 'Ask before changes' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan mode' },
  { id: 'auto', label: 'Auto mode', description: 'A classifier approves the safe actions' },
]

/** the text of a tool_result's content (a string, or blocks of text and images) */
function resultText(c: any): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
  return ''
}

/** a diff for the tools that change a file, from what the tool was asked to do */
export function claudeDiff(name: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return
  if (name === 'Edit' && typeof input.old_string === 'string') return textDiff(input.file_path, input.old_string, input.new_string ?? '')
  if (name === 'Write' && typeof input.content === 'string') return textDiff(input.file_path, '', input.content)
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.map((e: any) => textDiff(input.file_path, e.old_string ?? '', e.new_string ?? '')).join('\n')
}

/**
 * Claude Code's own bidirectional protocol: `claude -p --input-format stream-json --output-format stream-json`.
 * Messages go in as JSON lines; what comes back is the raw API stream (with `--include-partial-messages`) plus
 * control requests, among them `can_use_tool` — Claude asking whether it may run a tool — answered in kind.
 */
export class ClaudeDriver implements ChatDriver {
  sessionId?: string
  private proc!: Proc
  private reader!: LineReader
  private n = 0
  private waiting = new Map<string, { res: (v: any) => void; rej: (e: Error) => void }>()
  private blocks = new Map<number, { kind: 'text' | 'thinking' | 'tool'; id: string; text: string; name?: string }>()
  private msgId = ''
  private tools = new Map<string, { name: string; input?: unknown }>()
  private approvals = new Map<string, { request: any }>()
  private ended = false
  private resolved = new Map<string, string>()

  constructor(private o: { spawn: Spawner; bin?: string; cwd?: string; resume?: string; model?: string; mode?: string; extraArgs?: string[]; wrap?: (s: SpawnSpec) => SpawnSpec }, private emit: Emit) {}

  async start() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio']
    if (this.o.resume) args.push('--resume', this.o.resume)
    if (this.o.model) args.push('--model', this.o.model)
    if (this.o.mode && this.o.mode !== 'default') args.push('--permission-mode', this.o.mode)
    args.push(...(this.o.extraArgs ?? []))
    this.proc = this.o.spawn({ bin: this.o.bin ?? 'claude', args, cwd: this.o.cwd, env: { NO_COLOR: '1' } })
    this.proc.on('error', (e: NodeJS.ErrnoException) => this.end(e.code === 'ENOENT' ? 'The claude command was not found.' : e.message))
    this.proc.on('close', (code) => this.end(code ? this.reader.stderr.trim().split('\n').slice(-3).join('\n') || `The agent exited with code ${code}.` : undefined))
    this.reader = new LineReader(this.proc, (o) => this.onMessage(o), () => {})
    const init = await this.control({ subtype: 'initialize' }, 30_000).catch((e) => { throw new ChatError(`Claude Code did not start: ${this.reader.stderr.trim().split('\n').slice(-2).join(' ') || e.message}`, 'unavailable') })
    for (const m of init.models ?? []) if (m.resolvedModel) this.resolved.set(m.resolvedModel, m.value)
    this.emit({
      t: 'info',
      info: {
        agent: 'claude-code',
        mode: init.current_permission_mode ?? this.o.mode ?? 'default', modes: MODES,
        models: (init.models ?? []).map((m: any) => ({ id: m.value, label: m.displayName ?? m.value, description: m.description })),
        commands: (init.commands ?? []).map((c: any) => ({ name: c.name, description: c.description, hint: c.argumentHint })),
        caps: { interrupt: true, steer: true, setModel: true, setMode: true, setEffort: false, images: true },
        ...(this.o.resume && { sessionId: this.o.resume }),
        model: this.o.model ?? 'default',
      },
    })
  }

  private control(request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
    const id = `sy-${++this.n}`
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiting.delete(id); rej(new Error(`${request.subtype} timed out`)) }, timeoutMs)
      t.unref?.()
      this.waiting.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      this.write({ type: 'control_request', request_id: id, request })
    })
  }
  private write(o: unknown) { try { this.proc.stdin.write(JSON.stringify(o) + '\n') } catch { /* gone: close reports it */ } }

  private end(error?: string) {
    if (this.ended) return
    this.ended = true
    const e = new Error(error ?? 'The agent process ended.')
    for (const w of this.waiting.values()) w.rej(e)
    this.waiting.clear()
    this.emit({ t: 'info', info: { agent: 'claude-code' } })
    if (error) this.emit({ t: 'note', level: 'error', text: error })
    this.onEnd?.(error)
  }
  onEnd?: (error?: string) => void

  /** built-in commands that finish without saying anything: the page is told they ran */
  private slash?: 'compact' | 'clear'
  async send(m: ChatSend) {
    const c = /^\/(compact|clear)(\s|$)/.exec(m.text.trim())
    this.slash = c ? (c[1] as 'compact' | 'clear') : undefined
    const content: unknown[] = [...(m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })), { type: 'text', text: m.text }]
    this.write({ type: 'user', message: { role: 'user', content } })
  }
  async interrupt() { await this.control({ subtype: 'interrupt' }).catch(() => {}) }
  async setModel(id: string) { await this.control({ subtype: 'set_model', model: id }); this.emit({ t: 'info', info: { agent: 'claude-code', model: id } }) }
  async setMode(id: string) { await this.control({ subtype: 'set_permission_mode', mode: id }); this.emit({ t: 'info', info: { agent: 'claude-code', mode: id } }) }
  async setEffort(): Promise<void> { throw new ChatError('This agent cannot change its effort during a chat.', 'unsupported') }
  async close() {
    if (this.ended) return
    try { this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => p.kill('SIGTERM'), 1500).unref?.()
  }

  async respond(id: string, optionId: string) {
    const a = this.approvals.get(id)
    if (!a) throw new ChatError('That request is no longer pending.', 'failed')
    this.approvals.delete(id)
    const r = a.request
    const reply = optionId === 'deny' || optionId === 'abort'
      ? { behavior: 'deny', message: optionId === 'abort' ? 'The user stopped this.' : 'The user denied this action.', ...(optionId === 'abort' && { interrupt: true }) }
      : { behavior: 'allow', updatedInput: r.input, ...(optionId === 'allow_always' && r.permission_suggestions?.length && { updatedPermissions: r.permission_suggestions }) }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: reply } })
    this.emit({ t: 'approval.done', id, outcome: optionId })
  }

  async answer(id: string, answers: Record<string, string[]>) {
    const a = this.approvals.get(id)
    if (!a) throw new ChatError('That question is no longer pending.', 'failed')
    this.approvals.delete(id)
    const questions: any[] = a.request.input?.questions ?? []
    // Claude's AskUserQuestion takes the answers by question text
    const byText: Record<string, string> = {}
    for (const q of questions) byText[q.question] = (answers[q.question] ?? answers[q.header] ?? []).join(', ')
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: { ...a.request.input, answers: byText } } } })
    this.emit({ t: 'question.done', id })
  }

  private onMessage(o: any) {
    switch (o.type) {
      case 'control_response': {
        const r = o.response
        const w = this.waiting.get(r?.request_id)
        if (!w) return
        this.waiting.delete(r.request_id)
        if (r.subtype === 'error') w.rej(new Error(r.error ?? 'request failed'))
        else w.res(r.response ?? {})
        return
      }
      case 'control_request': return this.onRequest(o)
      case 'system':
        if (o.subtype === 'init') {
          this.sessionId = o.session_id
          this.emit({ t: 'info', info: { agent: 'claude-code', sessionId: o.session_id, ...(this.resolved.has(o.model) && { model: this.resolved.get(o.model) }), mode: o.permissionMode, version: o.claude_code_version, cwd: o.cwd } })
        }
        return
      case 'stream_event': return o.parent_tool_use_id ? undefined : this.onStream(o.event)
      case 'assistant': {
        if (o.parent_tool_use_id) return
        // the complete message: tool inputs are only certain here
        for (const b of o.message?.content ?? []) if (b.type === 'tool_use') this.toolUpdate(b.id, b.name, b.input, 'running')
        return
      }
      case 'user': {
        const c = o.message?.content
        if (!Array.isArray(c)) return
        for (const b of c) if (b?.type === 'tool_result') {
          const t = this.tools.get(b.tool_use_id)
          this.toolUpdate(b.tool_use_id, t?.name ?? 'tool', t?.input, b.is_error ? 'error' : 'ok', resultText(b.content))
        }
        return
      }
      case 'result': {
        const aborted = typeof o.terminal_reason === 'string' && o.terminal_reason.startsWith('aborted')
        this.blocks.clear()
        if (this.slash && !o.is_error && !aborted) this.emit({ t: 'note', level: 'info', text: this.slash === 'compact' ? 'Context compacted' : 'Context cleared' })
        this.slash = undefined
        const usage = { input: o.usage?.input_tokens, output: o.usage?.output_tokens, cost: o.total_cost_usd }
        this.emit({ t: 'turn', state: 'end', stop: aborted ? 'interrupted' : o.is_error ? 'error' : 'done', ...(o.is_error && !aborted && { error: typeof o.result === 'string' ? o.result : (o.errors ?? []).join('\n') || o.subtype }), usage })
        return
      }
    }
  }

  private onStream(e: any) {
    switch (e?.type) {
      case 'message_start': this.msgId = e.message?.id ?? String(++this.n); this.blocks.clear(); this.emit({ t: 'turn', state: 'start' }); return
      case 'content_block_start': {
        const b = e.content_block
        if (b.type === 'text') this.blocks.set(e.index, { kind: 'text', id: `${this.msgId}:${e.index}`, text: '' })
        else if (b.type === 'thinking') this.blocks.set(e.index, { kind: 'thinking', id: `${this.msgId}:${e.index}`, text: '' })
        else if (b.type === 'tool_use') { this.blocks.set(e.index, { kind: 'tool', id: b.id, text: '', name: b.name }); this.toolUpdate(b.id, b.name, undefined, 'running') }
        return
      }
      case 'content_block_delta': {
        const blk = this.blocks.get(e.index)
        if (!blk) return
        const d = e.delta
        if (d.type === 'text_delta' && blk.kind === 'text') { blk.text += d.text; this.emit({ t: 'text', id: blk.id, delta: d.text }) }
        else if (d.type === 'thinking_delta' && blk.kind === 'thinking' && d.thinking) { blk.text += d.thinking; this.emit({ t: 'thinking', id: blk.id, delta: d.thinking }) }
        else if (d.type === 'input_json_delta' && blk.kind === 'tool') blk.text += d.partial_json
        return
      }
      case 'content_block_stop': {
        const blk = this.blocks.get(e.index)
        if (!blk) return
        if (blk.kind === 'text') this.emit({ t: 'text.end', id: blk.id, text: blk.text })
        else if (blk.kind === 'thinking') { if (blk.text) this.emit({ t: 'thinking.end', id: blk.id, text: blk.text }) }
        else { let input: unknown; try { input = JSON.parse(blk.text || '{}') } catch { /* the full message follows */ } if (input !== undefined) this.toolUpdate(blk.id, blk.name!, input, 'running') }
        this.blocks.delete(e.index)
      }
    }
  }

  private toolUpdate(id: string, name: string, input: unknown, status: 'running' | 'ok' | 'error', output?: string) {
    const prev = this.tools.get(id)
    const inp = input ?? prev?.input
    this.tools.set(id, { name, input: inp })
    const diff = claudeDiff(name, inp)
    this.emit({ t: 'tool', id, name, ...(inp !== undefined && { input: inp }), status, ...(output !== undefined && { output }), ...(diff && { diff }) })
  }

  private onRequest(o: any) {
    const r = o.request
    if (r?.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: `Unsupported request: ${r?.subtype}` } })
      return
    }
    this.approvals.set(o.request_id, { request: r })
    if (r.tool_name === 'AskUserQuestion' && Array.isArray(r.input?.questions)) {
      const questions: Question[] = r.input.questions.map((q: any) => ({ id: q.question, header: q.header, question: q.question, multi: !!q.multiSelect, options: (q.options ?? []).map((x: any) => ({ label: x.label, description: x.description })), other: true }))
      this.emit({ t: 'question', id: o.request_id, questions })
      return
    }
    const diff = claudeDiff(r.tool_name, r.input)
    const detail = r.tool_name === 'Bash' ? r.input?.command : r.tool_name === 'ExitPlanMode' ? r.input?.plan : r.description
    this.emit({
      t: 'approval', id: o.request_id, tool: r.tool_name, title: r.display_name ?? r.tool_name, detail, input: r.input, ...(diff && { diff }),
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow' },
        ...(r.permission_suggestions?.length ? [{ id: 'allow_always', label: 'Allow for this session', kind: 'allow_always' as const }] : []),
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    })
  }
}
