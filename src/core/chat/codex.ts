import { RpcPeer } from './lines.ts'
import { ChatError, type ApprovalOption, type ChatDriver, type ChatSend, type Emit, type ModeOption, type Proc, type Question, type Spawner } from './types.ts'

/**
 * Codex's modes are an approval policy plus a sandbox, chosen together. `ask` is Codex's `untrusted`: anything that
 * is not known to be safe waits for the person.
 */
const MODES: (ModeOption & { policy: string; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' })[] = [
  { id: 'ask', label: 'Ask before commands', policy: 'untrusted', sandbox: 'workspace-write' },
  { id: 'auto', label: 'Ask when needed', policy: 'on-request', sandbox: 'workspace-write' },
  { id: 'readonly', label: 'Read only', policy: 'on-request', sandbox: 'read-only' },
  { id: 'full', label: 'Full access, never ask', policy: 'never', sandbox: 'danger-full-access' },
]
const POLICY_TYPE = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' } as const

/** `/usr/bin/zsh -lc 'echo hi'` → `echo hi`: the shell wrapper is Codex's, not the command's */
export function bareCommand(c: string | null | undefined): string {
  const m = /^(?:\S*\/)?(?:ba|z|da|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec((c ?? '').trim())
  return m ? m[2]!.replace(/'\\''/g, "'") : (c ?? '')
}

const status = (s: string | undefined): 'running' | 'ok' | 'error' => (s === 'completed' ? 'ok' : s === 'failed' || s === 'declined' ? 'error' : 'running')

/** the model's name for a file change's diff: the diffs of every file, one after the other */
function changesDiff(changes: any[] | undefined): string | undefined {
  if (!changes?.length) return
  return changes.map((c) => {
    const d = typeof c.diff === 'string' ? c.diff : ''
    return /^(---|@@|diff )/m.test(d) ? d : `@@ ${c.path}\n${d.replace(/\n$/, '').split('\n').map((l: string) => (c.kind?.type === 'delete' ? '-' : '+') + l).join('\n')}`
  }).join('\n')
}

/**
 * Codex's app-server: JSON-RPC over stdio, the same interface its own VS Code extension uses. A thread holds the
 * conversation; `turn/start` runs the agent; approvals arrive as requests *from* the server that we answer.
 */
export class CodexDriver implements ChatDriver {
  sessionId?: string
  private rpc!: RpcPeer
  private proc!: Proc
  private turnId?: string
  private model?: string
  private effort?: string
  private mode = 'ask'
  private reasoningOpen = new Set<string>()
  private text = new Map<string, string>()
  private output = new Map<string, string>()
  private items = new Map<string, any>()
  private pending = new Map<string, { reply: (r: unknown) => void; kind: 'command' | 'file' | 'perm' | 'input' | 'elicit'; params: any; decisions?: Record<string, unknown> }>()
  private ended = false
  onEnd?: (error?: string) => void

  constructor(private o: { spawn: Spawner; bin?: string; cwd?: string; resume?: string; model?: string; mode?: string; effort?: string }, private emit: Emit) {
    if (o.mode && MODES.some((m) => m.id === o.mode)) this.mode = o.mode
    this.model = o.model
    this.effort = o.effort
  }

  async start() {
    this.proc = this.o.spawn({ bin: this.o.bin ?? 'codex', args: ['app-server'], cwd: this.o.cwd, env: { NO_COLOR: '1' } })
    this.proc.on('error', (e: NodeJS.ErrnoException) => this.end(e.code === 'ENOENT' ? 'The codex command was not found.' : e.message))
    this.proc.on('close', (code) => this.end(code ? this.rpc.reader.stderr.trim().split('\n').slice(-3).join('\n') || `The agent exited with code ${code}.` : undefined))
    this.rpc = new RpcPeer(this.proc, { notification: (m, p) => this.onNotification(m, p), request: (m, p, reply, fail, id) => this.onRequest(m, p, reply, fail, id) })
    const fail = (e: Error) => new ChatError(`Codex did not start: ${this.rpc.reader.stderr.trim().split('\n').slice(-2).join(' ') || e.message}`, 'unavailable')
    const init = await this.rpc.request('initialize', { clientInfo: { name: 'sessionary', title: 'Sessionary', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 30_000).catch((e) => { throw fail(e) })
    this.rpc.notify('initialized', {})
    const list = await this.rpc.request('model/list', {}, 30_000).catch(() => ({ data: [] }))
    const m = MODES.find((x) => x.id === this.mode)!
    const base = { cwd: this.o.cwd, approvalPolicy: m.policy, sandbox: m.sandbox, ...(this.model && { model: this.model }) }
    const th = this.o.resume
      ? await this.rpc.request('thread/resume', { threadId: this.o.resume, excludeTurns: true, ...base }, 60_000).catch((e) => { throw new ChatError(e.message, 'failed') })
      : await this.rpc.request('thread/start', base, 60_000).catch((e) => { throw new ChatError(e.message, 'failed') })
    this.sessionId = th.thread?.id ?? this.o.resume
    this.model = th.model ?? this.model
    this.effort = this.effort ?? th.reasoningEffort ?? undefined
    const models = (list.data ?? []).filter((x: any) => !x.hidden)
    const cur = models.find((x: any) => x.id === this.model || x.model === this.model)
    this.emit({
      t: 'info',
      info: {
        agent: 'codex', sessionId: this.sessionId, model: this.model, cwd: th.cwd ?? this.o.cwd, version: /\/(\d[\w.]*)/.exec(init.userAgent ?? '')?.[1],
        models: models.map((x: any) => ({ id: x.id, label: x.displayName ?? x.id, description: x.description })),
        mode: this.mode, modes: MODES.map(({ id, label }) => ({ id, label })),
        effort: this.effort ?? undefined, efforts: cur?.supportedReasoningEfforts?.map((e: any) => (typeof e === 'string' ? e : e.reasoningEffort)).filter(Boolean),
        commands: [],
        caps: { interrupt: true, steer: true, setModel: true, setMode: true, setEffort: true, images: true },
      },
    })
  }

  private end(error?: string) {
    if (this.ended) return
    this.ended = true
    if (error) this.emit({ t: 'note', level: 'error', text: error })
    this.onEnd?.(error)
  }

  private policyParams() {
    const m = MODES.find((x) => x.id === this.mode)!
    return { approvalPolicy: m.policy, sandboxPolicy: { type: POLICY_TYPE[m.sandbox] } }
  }

  async send(m: ChatSend) {
    if (!this.sessionId) throw new ChatError('The session is not ready.', 'failed')
    const input = [...(m.images ?? []).map((i) => ({ type: 'image', url: `data:${i.mimeType};base64,${i.data}` })), { type: 'text', text: m.text, text_elements: [] }]
    if (this.turnId) {
      // a turn is running: this message goes into it
      try { await this.rpc.request('turn/steer', { threadId: this.sessionId, expectedTurnId: this.turnId, input }); return } catch { /* the turn just ended: start a new one */ }
    }
    const r = await this.rpc.request('turn/start', { threadId: this.sessionId, input, ...this.policyParams(), ...(this.model && { model: this.model }), ...(this.effort && { effort: this.effort }) })
    this.turnId = r.turn?.id
  }
  async interrupt() { if (this.turnId && this.sessionId) await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch(() => {}) }
  async setModel(id: string) { this.model = id; this.emit({ t: 'info', info: { agent: 'codex', model: id } }) }
  async setEffort(level: string) { this.effort = level; this.emit({ t: 'info', info: { agent: 'codex', effort: level } }) }
  async setMode(id: string) {
    if (!MODES.some((m) => m.id === id)) throw new ChatError('Unknown mode.', 'failed')
    this.mode = id
    this.emit({ t: 'info', info: { agent: 'codex', mode: id } })
  }
  async close() {
    if (this.ended) return
    try { this.proc.stdin.end() } catch { /* ignore */ }
    const p = this.proc
    setTimeout(() => p.kill('SIGTERM'), 1500).unref?.()
  }

  async respond(id: string, optionId: string) {
    const p = this.pending.get(id)
    if (!p) throw new ChatError('That request is no longer pending.', 'failed')
    this.pending.delete(id)
    if (p.kind === 'perm') {
      const allow = optionId !== 'decline' && optionId !== 'cancel'
      p.reply({ permissions: allow ? p.params.permissions : {}, scope: optionId === 'acceptForSession' ? 'session' : 'turn' })
    } else if (p.kind === 'elicit') p.reply({ action: optionId === 'accept' ? 'accept' : optionId === 'cancel' ? 'cancel' : 'decline', ...(optionId === 'accept' && { content: {} }) })
    else p.reply({ decision: p.decisions?.[optionId] ?? optionId })
    this.emit({ t: 'approval.done', id, outcome: optionId })
  }

  async answer(id: string, answers: Record<string, string[]>) {
    const p = this.pending.get(id)
    if (!p || p.kind !== 'input') throw new ChatError('That question is no longer pending.', 'failed')
    this.pending.delete(id)
    p.reply({ answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answers: v }])) })
    this.emit({ t: 'question.done', id })
  }

  // ---- what the server asks of us ----
  private onRequest(method: string, p: any, reply: (r: unknown) => void, fail: (c: number, m: string) => void, rid: number | string) {
    const id = String(rid)
    const opt = (idv: string, label: string, kind: ApprovalOption['kind']): ApprovalOption => ({ id: idv, label, kind })
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const decisions: Record<string, unknown> = {}
        const options: ApprovalOption[] = []
        for (const d of p.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel']) {
          if (d === 'accept') { decisions.accept = 'accept'; options.push(opt('accept', 'Allow', 'allow')) }
          else if (d === 'acceptForSession') { decisions.acceptForSession = 'acceptForSession'; options.push(opt('acceptForSession', 'Allow for this session', 'allow_always')) }
          else if (d === 'decline') { decisions.decline = 'decline'; options.push(opt('decline', 'Deny', 'deny')) }
          else if (d === 'cancel') { decisions.cancel = 'cancel'; options.push(opt('cancel', 'Deny and stop', 'abort')) }
          else if (d?.acceptWithExecpolicyAmendment) { decisions.amend = d; options.push(opt('amend', `Always allow “${(d.acceptWithExecpolicyAmendment.execpolicy_amendment ?? []).join(' ')}”`, 'allow_always')) }
        }
        if (!options.some((o) => o.kind === 'deny')) { decisions.decline = 'decline'; options.push(opt('decline', 'Deny', 'deny')) }
        this.pending.set(id, { reply, kind: 'command', params: p, decisions })
        this.emit({ t: 'approval', id, tool: 'Bash', title: 'Run a command', detail: bareCommand(p.command), input: { command: bareCommand(p.command), cwd: p.cwd, reason: p.reason }, options })
        return
      }
      case 'item/fileChange/requestApproval': {
        const item = this.items.get(p.itemId)
        this.pending.set(id, { reply, kind: 'file', params: p })
        this.emit({
          t: 'approval', id, tool: 'Edit', title: 'Change files', detail: p.reason ?? (item?.changes ?? []).map((c: any) => c.path).join('\n') ?? undefined,
          input: { changes: item?.changes }, diff: changesDiff(item?.changes),
          options: [opt('accept', 'Allow', 'allow'), opt('acceptForSession', 'Allow for this session', 'allow_always'), opt('decline', 'Deny', 'deny'), opt('cancel', 'Deny and stop', 'abort')],
        })
        return
      }
      case 'item/permissions/requestApproval':
        this.pending.set(id, { reply, kind: 'perm', params: p })
        this.emit({ t: 'approval', id, tool: 'Permissions', title: 'Extra permissions', detail: p.reason ?? undefined, input: p.permissions, options: [opt('accept', 'Allow', 'allow'), opt('acceptForSession', 'Allow for this session', 'allow_always'), opt('decline', 'Deny', 'deny')] })
        return
      case 'item/tool/requestUserInput': {
        this.pending.set(id, { reply, kind: 'input', params: p })
        const questions: Question[] = (p.questions ?? []).map((q: any) => ({ id: q.id, header: q.header, question: q.question, other: !!q.isOther, secret: !!q.isSecret, options: q.options?.map((o: any) => ({ label: o.label, description: o.description })) }))
        this.emit({ t: 'question', id, questions })
        return
      }
      case 'mcpServer/elicitation/request':
        this.pending.set(id, { reply, kind: 'elicit', params: p })
        this.emit({ t: 'approval', id, tool: p.serverName ?? 'MCP', title: `${p.serverName ?? 'An MCP server'} asks for input`, detail: p.message ?? undefined, options: [opt('accept', 'Continue', 'allow'), opt('decline', 'Decline', 'deny')] })
        return
      case 'item/tool/call': reply({ success: false, contentItems: [{ type: 'inputText', text: 'Sessionary does not provide client-side tools.' }] }); return
      default: fail(-32601, `Sessionary does not handle ${method}`)
    }
  }

  // ---- what the server tells us ----
  private onNotification(method: string, p: any) {
    switch (method) {
      case 'turn/started': this.turnId = p.turn?.id; this.emit({ t: 'turn', state: 'start' }); return
      case 'turn/completed': {
        const t = p.turn
        this.turnId = undefined
        for (const id of [...this.pending.keys()]) { this.pending.delete(id); this.emit({ t: 'approval.done', id, outcome: 'cancel' }) }
        this.emit({ t: 'turn', state: 'end', stop: t?.status === 'interrupted' ? 'interrupted' : t?.status === 'failed' ? 'error' : 'done', ...(t?.error?.message && { error: t.error.message }) })
        return
      }
      case 'error': if (!p.willRetry) this.emit({ t: 'note', level: 'error', text: p.error?.message ?? 'Codex reported an error.' }); return
      case 'warning': case 'configWarning': case 'deprecationNotice': this.emit({ t: 'note', level: 'warn', text: p.message ?? p.summary ?? method }); return
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        this.emit({ t: 'usage', usage: { input: u?.total?.inputTokens, output: u?.total?.outputTokens, context: u?.last?.totalTokens, window: u?.modelContextWindow ?? undefined } })
        return
      }
      case 'item/started': return this.onItem(p.item, false)
      case 'item/completed': return this.onItem(p.item, true)
      case 'item/agentMessage/delta': this.text.set(p.itemId, (this.text.get(p.itemId) ?? '') + p.delta); this.emit({ t: 'text', id: p.itemId, delta: p.delta }); return
      case 'item/reasoning/summaryTextDelta': case 'item/reasoning/textDelta': this.reasoningOpen.add(p.itemId); this.emit({ t: 'thinking', id: p.itemId, delta: p.delta }); return
      case 'item/reasoning/summaryPartAdded': if (this.reasoningOpen.has(p.itemId)) this.emit({ t: 'thinking', id: p.itemId, delta: '\n\n' }); return
      case 'item/commandExecution/outputDelta': {
        const o = (this.output.get(p.itemId) ?? '') + (p.delta ?? '')
        this.output.set(p.itemId, o)
        const it = this.items.get(p.itemId)
        if (it) this.tool(it, 'running', o)
        return
      }
      case 'item/fileChange/patchUpdated': {
        const it = this.items.get(p.itemId)
        if (it) { it.changes = p.changes ?? it.changes; this.tool(it, 'running') }
        return
      }
      case 'thread/name/updated': return
    }
  }

  private onItem(item: any, done: boolean) {
    if (!item?.id) return
    this.items.set(item.id, item)
    switch (item.type) {
      case 'agentMessage':
        if (done) this.emit({ t: 'text.end', id: item.id, text: item.text ?? this.text.get(item.id) ?? '' })
        return
      case 'plan': if (done && item.text) this.emit({ t: 'text.end', id: item.id, text: item.text }); return
      case 'reasoning':
        if (done) { const txt = [...(item.summary ?? []), ...(this.reasoningOpen.has(item.id) ? [] : item.content ?? [])].join('\n\n'); if (txt.trim()) this.emit({ t: 'thinking.end', id: item.id, text: txt }) }
        return
      case 'userMessage': case 'hookPrompt': case 'functionCallOutput': case 'contextCompaction': case 'sleep': return
      default: this.tool(item, done ? status(item.status) : 'running')
    }
  }

  private tool(item: any, st: 'running' | 'ok' | 'error', liveOutput?: string) {
    let name = item.type as string, input: unknown, output: string | undefined, diff: string | undefined
    switch (item.type) {
      case 'commandExecution': {
        name = 'Bash'
        input = { command: bareCommand(item.command), cwd: item.cwd }
        output = item.aggregatedOutput ?? liveOutput ?? this.output.get(item.id)
        if (st !== 'running' && item.exitCode != null && item.exitCode !== 0) st = 'error'
        break
      }
      case 'fileChange': name = 'Edit'; input = { changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) }; diff = changesDiff(item.changes); break
      case 'mcpToolCall': name = `${item.server}.${item.tool}`; input = item.arguments; output = item.error?.message ?? (item.result ? JSON.stringify(item.result.content ?? item.result).slice(0, 4000) : undefined); if (item.error) st = 'error'; break
      case 'dynamicToolCall': name = item.tool; input = item.arguments; output = item.contentItems?.map((c: any) => c.text ?? '').join('\n'); break
      case 'webSearch': name = 'WebSearch'; input = { query: item.query }; break
      case 'imageView': name = 'View'; input = { path: item.path }; break
      case 'imageGeneration': name = 'Image'; input = { prompt: item.revisedPrompt }; output = item.savedPath ?? undefined; break
      case 'collabAgentToolCall': name = 'Task'; input = { prompt: item.prompt, tool: item.tool }; break
      case 'enteredReviewMode': case 'exitedReviewMode': name = 'Review'; input = { review: item.review }; break
      default: return
    }
    this.emit({ t: 'tool', id: item.id, name, ...(input !== undefined && { input }), status: st, ...(output !== undefined && { output }), ...(diff && { diff }) })
  }
}
