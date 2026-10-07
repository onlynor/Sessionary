import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from '../core/sqlite.ts'
import type { AgentAdapter, Block, Message, Session, Source, UsageEntry } from '../core/model.ts'
import { totalsOf } from '../core/usage.ts'
import { cleanPrompt, derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import { argSafe, jsonlLines, localRoots, toMs, type Roots } from '../core/util.ts'

// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl — the append-only log of one thread. Every line is
// {timestamp, type, payload}: `session_meta` (id, cwd, git…), `response_item` (what the model saw and said: messages,
// reasoning, function calls and their outputs), `event_msg` (what the UI showed: user_message, token_count…),
// `turn_context` (model, sandbox), `compacted`. Newer versions also index threads in ~/.codex/state_N.sqlite, which
// is only read for the names people gave their threads; the JSONL stays the source of truth.

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** things Codex puts in the model's input that the person did not type */
const INJECTED = /^\s*(<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions|<collaboration_mode>|<user_shell_command>|# AGENTS\.md instructions|<turn_aborted>|<ide_context>|<user_action>)/

async function walk(dir: string, depth = 0): Promise<string[]> {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth < 5) out.push(...(await walk(p, depth + 1)))
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const parseJson = (v: unknown): any => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return undefined } }

/** `["bash","-lc","git status"]` is what the model asked for; `git status` is what a person wants to read */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd
  if (!Array.isArray(cmd)) return ''
  const a = cmd.map(String)
  if (a.length >= 3 && /^(ba|z|da|fi)?sh$/.test(path.basename(a[0]!)) && /^-\w*c$/.test(a[1]!)) return a[2]!
  return a.map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/** Codex's `apply_patch` envelope as the line diff the UI draws: "@@ file" before each file's lines */
export function patchDiff(patch: string): { diff: string; files: string[] } {
  const out: string[] = []
  const files: string[] = []
  for (const line of patch.split('\n')) {
    const f = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
    if (f) { files.push(f[2]!); out.push(`@@ ${f[1] === 'Add' ? '+ ' : f[1] === 'Delete' ? '- ' : ''}${f[2]}`); continue }
    if (/^\*\*\* (Begin Patch|End Patch|End of File|Move to:)/.test(line)) continue
    if (line.startsWith('@@')) { out.push('@@'); continue }
    if (line[0] === '+' || line[0] === '-' || line[0] === ' ') out.push(line)
  }
  return { diff: out.join('\n'), files }
}

/** a tool's output the way a person reads it, and whether it failed */
function toolOutput(raw: unknown): { text: string; ok: boolean } {
  let body = raw
  if (typeof body === 'string' && body.startsWith('{')) { const j = parseJson(body); if (j && typeof j === 'object') body = j }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as { output?: unknown; metadata?: { exit_code?: number }; content?: unknown; success?: boolean }
    const text = typeof o.output === 'string' ? o.output : typeof o.content === 'string' ? o.content : JSON.stringify(o)
    return { text, ok: o.metadata?.exit_code != null ? o.metadata.exit_code === 0 : o.success !== false }
  }
  if (Array.isArray(body)) return { text: body.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n'), ok: true }
  const text = String(body ?? '')
  const code = /^Exit code: (-?\d+)/m.exec(text)
  return { text, ok: code ? Number(code[1]) === 0 : true }
}

export const makeCodex = (roots: () => Roots = localRoots): AgentAdapter => {
  const home = () => roots().codex
  const root = () => path.join(home(), 'sessions')
  const bin = () => process.env.SESSIONARY_CODEX_BIN ?? 'codex'

  /** names people gave threads: the state database of newer versions, the index file of older ones */
  async function names(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    try {
      const dbs = (await fs.readdir(home())).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
      if (dbs[0]) {
        const db = new DatabaseSync(path.join(home(), dbs[0]), { readOnly: true })
        try { for (const r of db.prepare("select id, coalesce(nullif(name, ''), nullif(title, '')) t from threads").all() as any[]) if (r.t) out.set(r.id, r.t) } finally { db.close() }
      }
    } catch { /* no database, or one this version does not know */ }
    try {
      for (const r of jsonlLines(await fs.readFile(path.join(home(), 'session_index.jsonl'), 'utf8'))) if (r?.id && r.thread_name) out.set(r.id, r.thread_name)
    } catch { /* no index */ }
    return out
  }

  async function parse(source: Source): Promise<Session | null> {
    const file = source.ref
    let text: string
    try { text = await fs.readFile(file, 'utf8') } catch { return null }
    const rows = [...jsonlLines(text)]
    const meta = rows.find((r) => r.type === 'session_meta')?.payload
    const m = meta?.meta ?? meta ?? {}
    const id: string = m.id ?? UUID.exec(file)?.[1] ?? path.basename(file, '.jsonl')
    // current versions record what was typed as an event; older ones only have the model's copy of it
    const hasUserEvents = rows.some((r) => r.type === 'event_msg' && r.payload?.type === 'user_message')

    const messages: Message[] = []
    const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
    let turn: Message | undefined
    let model: string | undefined
    // Codex records running totals (OpenAI's convention: cached tokens are part of the input, reasoning part of the
    // output); each call is the difference from the previous total
    const usage: UsageEntry[] = []
    let seen = { input: 0, cached: 0, write: 0, output: 0 }
    let firstPrompt: string | undefined
    let last = toMs(m.timestamp)
    const startTurn = (rid: string, time?: number) => (turn = { id: rid, role: 'assistant', time, model, blocks: [] })
    const push = (b: Block, rid: string, time?: number) => { (turn ??= startTurn(rid, time)).blocks.push(b); if (!messages.includes(turn)) messages.push(turn) }
    const user = (text: string, rid: string, time?: number) => {
      if (!text.trim()) return
      turn = undefined
      messages.push({ id: rid, role: 'user', time, blocks: [{ type: 'text', text }] })
      if (cleanPrompt(text)) firstPrompt ??= text
    }

    rows.forEach((r, i) => {
      const time = toMs(r.timestamp)
      if (time) last = Math.max(last ?? 0, time)
      const p = r.payload ?? {}
      const rid = `${i}`
      if (r.type === 'turn_context') { model = p.model ?? model; return }
      if (r.type === 'compacted') { turn = undefined; messages.push({ id: rid, role: 'system', time, blocks: [{ type: 'note', kind: 'compaction', text: 'Conversation compacted' }] }); return }
      if (r.type === 'event_msg') {
        if (p.type === 'user_message') user(String(p.message ?? ''), rid, time)
        else if (p.type === 'token_count' && p.info?.total_token_usage) {
          const u = p.info.total_token_usage
          const now = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, write: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0 }
          // a total that went down started over (a new process): all of it is new
          const from = now.input < seen.input || now.output < seen.output ? { input: 0, cached: 0, write: 0, output: 0 } : seen
          const d = { input: now.input - from.input, cached: Math.max(0, now.cached - from.cached), write: Math.max(0, now.write - from.write), output: now.output - from.output }
          if ((d.input || d.output) && time) usage.push({ time, model, input: Math.max(0, d.input - d.cached - d.write), output: d.output, cacheRead: d.cached, cacheWrite: d.write })
          seen = now
        } else if (p.type === 'error' && p.message) push({ type: 'note', kind: 'error', text: String(p.message) }, rid, time)
        return
      }
      if (r.type !== 'response_item') return
      switch (p.type) {
        case 'message': {
          const parts: any[] = Array.isArray(p.content) ? p.content : []
          const body = parts.map((c) => c?.text ?? '').filter(Boolean).join('\n')
          if (p.role === 'assistant') { if (body.trim()) push({ type: 'text', text: body }, rid, time) }
          else if (p.role === 'user' && !hasUserEvents && !INJECTED.test(body)) user(body, rid, time)
          // developer / system messages are instructions Codex gave the model, not part of the conversation
          return
        }
        case 'reasoning': {
          const summary = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => s?.text ?? '').filter(Boolean).join('\n\n')
          push({ type: 'thinking', text: summary, redacted: !summary }, rid, time)
          return
        }
        case 'function_call':
        case 'local_shell_call':
        case 'custom_tool_call': {
          const callId: string = p.call_id ?? p.id ?? rid
          let name: string = p.name ?? 'shell'
          let input: any
          if (p.type === 'local_shell_call') { name = 'shell'; input = { command: commandText(p.action?.command), workdir: p.action?.working_directory } }
          else if (p.type === 'custom_tool_call') {
            const patch = String(p.input ?? '')
            if (name === 'apply_patch') { const d = patchDiff(patch); input = { path: d.files[0], files: d.files, patch }; (input as any).__diff = d.diff } else input = { input: patch }
          } else {
            input = parseJson(p.arguments) ?? { arguments: p.arguments }
            if (input && typeof input === 'object') {
              const cmd = input.command ?? input.cmd
              if (cmd != null) input = { ...input, command: commandText(cmd) }
            }
          }
          const diff: string | undefined = input?.__diff
          if (input && '__diff' in input) delete input.__diff
          const tb: Extract<Block, { type: 'tool' }> = { type: 'tool', id: callId, name, input, status: 'pending', ...(diff ? { diff } : {}) }
          tools.set(callId, tb)
          push(tb, rid, time)
          return
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const tb = tools.get(p.call_id)
          if (!tb) return
          const o = toolOutput(p.output)
          tb.output = o.text; tb.status = o.ok ? 'ok' : 'error'
          return
        }
        case 'web_search_call': {
          const q = p.action?.query ?? p.action?.queries?.join(', ') ?? ''
          push({ type: 'tool', id: p.id ?? rid, name: 'web_search', input: { query: q }, status: p.status === 'failed' ? 'error' : 'ok' }, rid, time)
        }
      }
    })
    if (!messages.length) return null

    const created = toMs(m.timestamp) ?? messages.find((x) => x.time)?.time ?? 0
    const named = (await names()).get(id)
    return {
      id: `codex:${id}`,
      agent: 'codex',
      nativeId: id,
      title: pickTitle([named], firstPrompt, fallbackTitle(messages, created)),
      cwd: m.cwd || undefined,
      gitBranch: m.git?.branch || undefined,
      model,
      createdAt: created,
      updatedAt: last ?? created,
      messageCount: messages.length,
      ...totalsOf(usage),
      ...derive(messages),
      messages,
      usage,
    }
  }

  const self: AgentAdapter = {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',

    async listSources() {
      const out: Source[] = []
      for (const file of await walk(root())) {
        const st = await fs.stat(file).catch(() => null)
        if (st) out.push({ key: file, ref: file, fingerprint: `${st.size}:${Math.floor(st.mtimeMs)}` })
      }
      return out
    },
    async summarize(source) {
      const s = await parse(source)
      if (!s) return null
      const { messages, usage, ...summary } = s
      return summary
    },
    load: parse,

    storage() { return { path: root(), watch: [{ path: root(), recursive: true }] } },
    newCommand(cwd) {
      return { bin: bin(), args: [], cwd }
    },
    resumeCommand(_source, session) {
      return { bin: bin(), args: ['resume', session.nativeId], cwd: session.cwd ?? '' }
    },
    // `codex exec resume` appends to the same thread; the sandbox is chosen with a config override
    continueCommand(_source, session, prompt, { allowWrite }) {
      return {
        bin: bin(),
        args: ['exec', 'resume', session.nativeId, '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${allowWrite ? 'workspace-write' : 'read-only'}"`, argSafe(prompt)],
        cwd: session.cwd ?? '',
        sessionIdFrom: (line) => { try { const j = JSON.parse(line); const t = j?.thread_id ?? j?.msg?.session_id; return typeof t === 'string' ? `codex:${t}` : undefined } catch { return undefined } },
      }
    },
  }
  return self
}
export const codex = makeCodex()
