import path from 'node:path'
import { DatabaseSync } from '../core/sqlite.ts'
import type { AgentAdapter, Block, Message, Session, Source } from '../core/model.ts'
import { derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import { localRoots, type Roots } from '../core/util.ts'

// ~/.hermes/state.db (SQLite): `sessions` (one row per conversation) and `messages` (OpenAI-style rows:
// role user | assistant | tool, `tool_calls` as a JSON array on assistant rows, results as separate `tool` rows).
// Opened strictly read-only. Rows with active = 0 were rewound or replaced and are not part of the conversation.

const text = (v: unknown): string => {
  if (typeof v !== 'string' || !v) return ''
  // multimodal content may be stored as a JSON array of parts
  if (v.startsWith('[')) {
    try {
      const parts = JSON.parse(v)
      if (Array.isArray(parts)) return parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n')
    } catch { /* plain text that happens to start with "[" */ }
  }
  return v
}

const parseJson = (v: unknown): unknown => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v } }

export const makeHermes = (roots: () => Roots = localRoots): AgentAdapter => {
  const dbPath = () => path.join(roots().hermes, 'state.db')
  const withDb = <T,>(fn: (db: DatabaseSync) => T, fallback: T): T => {
    let db: DatabaseSync
    try { db = new DatabaseSync(dbPath(), { readOnly: true }) } catch { return fallback }
    try { return fn(db) } catch { return fallback } finally { db.close() }
  }

  const self: AgentAdapter = {
    id: 'hermes',
    label: 'Hermes',
    bin: 'hermes',
    newCommand(cwd) {
      return { bin: process.env.SESSIONARY_HERMES_BIN ?? 'hermes', args: [], cwd }
    },

    async listSources() {
      return withDb((db) => {
        const rows = db.prepare(`
          select s.id, coalesce(s.last_activity_at, s.ended_at, s.started_at) t,
                 (select max(m.id) from messages m where m.session_id = s.id) mx
          from sessions s`).all() as any[]
        return rows.map((r): Source => ({ key: r.id, ref: r.id, fingerprint: `${r.t}:${r.mx ?? 0}` }))
      }, [])
    },

    async summarize(source) {
      const s = await self.load(source)
      if (!s) return null
      const { messages, usage, ...summary } = s
      return summary
    },

    async load(source) {
      return withDb<Session | null>((db) => {
        const r = db.prepare('select * from sessions where id = ?').get(source.ref) as any
        if (!r) return null
        const rows = db.prepare('select * from messages where session_id = ? and coalesce(active, 1) = 1 order by timestamp, id').all(source.ref) as any[]

        const messages: Message[] = []
        const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
        let firstPrompt: string | undefined
        for (const m of rows) {
          const time = typeof m.timestamp === 'number' ? Math.round(m.timestamp * 1000) : undefined
          const id = String(m.id)
          if (m.role === 'tool') {
            const tb = tools.get(m.tool_call_id)
            if (tb) { tb.output = text(m.content); tb.status = 'ok' }
            continue
          }
          const blocks: Block[] = []
          const reasoning = text(m.reasoning_content) || text(m.reasoning)
          if (m.role === 'assistant' && reasoning.trim()) blocks.push({ type: 'thinking', text: reasoning })
          const body = text(m.content)
          if (body.trim()) {
            blocks.push({ type: 'text', text: body })
            if (m.role === 'user') firstPrompt ??= body
          }
          if (m.role === 'assistant' && m.tool_calls) {
            const calls = parseJson(m.tool_calls)
            for (const c of Array.isArray(calls) ? calls : []) {
              const fn = c?.function ?? c
              const tb: Extract<Block, { type: 'tool' }> = {
                type: 'tool', id: String(c?.id ?? `${id}:${blocks.length}`), name: String(fn?.name ?? 'tool'),
                input: parseJson(fn?.arguments) ?? {}, status: 'pending',
              }
              tools.set(tb.id, tb)
              blocks.push(tb)
            }
          }
          if (!blocks.length) continue
          messages.push({ id, role: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant', time, model: m.role === 'assistant' ? r.model ?? undefined : undefined, blocks })
        }
        if (!messages.length) return null

        const created = Math.round((r.started_at ?? 0) * 1000)
        const updated = Math.round((r.last_activity_at ?? r.ended_at ?? r.started_at ?? 0) * 1000)
        return {
          id: `hermes:${r.id}`,
          agent: 'hermes',
          nativeId: r.id,
          title: pickTitle([r.title], firstPrompt, fallbackTitle(messages, created)),
          cwd: r.cwd || undefined,
          gitBranch: r.git_branch || undefined,
          model: r.model || undefined,
          createdAt: created,
          updatedAt: Math.max(updated, created),
          messageCount: messages.length,
          tokens: { input: (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0), output: (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0) },
          cost: r.actual_cost_usd ?? r.estimated_cost_usd ?? undefined,
          ...derive(messages),
          messages,
          // Hermes keeps one total per session: it counts on the day the session was last active
          usage: [{ time: Math.max(updated, created), model: r.model || undefined, input: r.input_tokens ?? 0, output: (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0), cacheRead: r.cache_read_tokens ?? 0, cacheWrite: r.cache_write_tokens ?? 0, ...(typeof (r.actual_cost_usd ?? r.estimated_cost_usd) === 'number' && { cost: r.actual_cost_usd ?? r.estimated_cost_usd }) }],
        }
      }, null)
    },

    // the database is rewritten in place (plus its WAL), so watch its directory, not a tree
    storage() { return { path: dbPath(), watch: [{ path: path.dirname(dbPath()), recursive: false }] } },
  }
  return self
}
export const hermes = makeHermes()
