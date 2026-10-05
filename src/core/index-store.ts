import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'
import type { Message, SessionSummary } from './model.ts'
import { searchableText, snippet, terms } from './search.ts'
import { dataHome } from './util.ts'

/**
 * Derived index of session summaries. Safe to delete at any time: bump SCHEMA or remove the file and it is
 * rebuilt from the original agent files, which stay the source of truth.
 */
const SCHEMA = 5

export interface SourceRow { agent: string; key: string; fingerprint: string }
export interface ListFilter { agent?: string; q?: string; includeChildren?: boolean }

export class IndexStore {
  private db: DatabaseSync

  constructor(file = path.join(dataHome(), 'index.db')) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    const v = (this.db.prepare('pragma user_version').get() as any).user_version as number
    if (v !== SCHEMA) {
      this.db.exec('drop table if exists session; drop table if exists source; drop table if exists content;')
      this.db.exec(`pragma user_version = ${SCHEMA}`)
    }
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists source (
        agent text not null, key text not null, fingerprint text not null, session_id text,
        primary key (agent, key)
      );
      create table if not exists session (
        id text primary key, agent text not null, source_key text not null,
        title text not null, cwd text, updated_at integer not null, parent_id text, data text not null
      );
      create index if not exists session_updated on session(updated_at desc);
      -- full-text over what is readable in each message; trigram so CJK and partial words match
      create virtual table if not exists content using fts5(session_id unindexed, msg_index unindexed, msg_id unindexed, role unindexed, txt, tokenize = 'trigram case_sensitive 0');
    `)
  }

  sources(agent: string): Map<string, SourceRow> {
    const rows = this.db.prepare('select agent, key, fingerprint from source where agent = ?').all(agent) as unknown as SourceRow[]
    return new Map(rows.map((r) => [r.key, r]))
  }

  upsert(agent: string, key: string, fingerprint: string, s: SessionSummary | null, messages: Message[] = []) {
    this.db.exec('begin')
    try {
      const old = this.db.prepare('select session_id from source where agent = ? and key = ?').get(agent, key) as any
      if (old?.session_id) this.dropSession(old.session_id)
      if (s) this.dropSession(s.id)
      this.db.prepare('insert or replace into source (agent, key, fingerprint, session_id) values (?, ?, ?, ?)')
        .run(agent, key, fingerprint, s?.id ?? null)
      if (s)
        this.db.prepare('insert or replace into session (id, agent, source_key, title, cwd, updated_at, parent_id, data) values (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(s.id, agent, key, s.title, s.cwd ?? null, s.updatedAt, s.parentId ?? null, JSON.stringify(s))
      if (s) {
        const ins = this.db.prepare('insert into content (session_id, msg_index, msg_id, role, txt) values (?, ?, ?, ?, ?)')
        messages.forEach((m, i) => { const t = searchableText(m); if (t.trim()) ins.run(s.id, i, m.id, m.role, t) })
      }
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  /** returns the id of the session that went away, if the source had one */
  remove(agent: string, key: string): string | undefined {
    const old = this.db.prepare('select session_id from source where agent = ? and key = ?').get(agent, key) as any
    if (old?.session_id) this.dropSession(old.session_id)
    this.db.prepare('delete from source where agent = ? and key = ?').run(agent, key)
    return old?.session_id ?? undefined
  }

  private dropSession(id: string) {
    this.db.prepare('delete from session where id = ?').run(id)
    this.db.prepare('delete from content where session_id = ?').run(id)
  }

  /** Terms of 3+ characters use the trigram index; shorter ones fall back to a substring scan. */
  private matchRows(q: string, sessionId?: string, limit = 2000) {
    const ts = terms(q)
    if (!ts.length) return { ts, rows: [] as { session_id: string; msg_index: number; msg_id: string; role: string; txt: string }[] }
    const long = ts.filter((t) => [...t].length >= 3)
    const short = ts.filter((t) => [...t].length < 3)
    const where: string[] = []
    const args: (string | number)[] = []
    if (long.length) { where.push('content match ?'); args.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')) }
    for (const t of short) { where.push("txt like ? escape '\\'"); args.push('%' + t.replace(/[\\%_]/g, '\\$&') + '%') }
    if (sessionId) { where.push('session_id = ?'); args.push(sessionId) }
    const order = long.length ? 'order by rank' : ''
    const rows = this.db.prepare(`select session_id, msg_index, msg_id, role, txt from content where ${where.join(' and ')} ${order} limit ${limit}`).all(...args) as any[]
    return { ts, rows }
  }

  /** Sessions whose messages match, best first, each with a few excerpts. */
  search(q: string, agent?: string, hidden?: { sessions: Set<string>; messages: Set<string> }) {
    const { ts, rows: all } = this.matchRows(q)
    const rows = hidden ? all.filter((r) => !hidden.sessions.has(r.session_id) && !hidden.messages.has(`${r.session_id}\u0000${r.msg_id}`)) : all
    const by = new Map<string, { sessionId: string; hits: number; snippets: { msgIndex: number; role: string; text: string; marks: [number, number][] }[] }>()
    for (const r of rows) {
      const g = by.get(r.session_id) ?? by.set(r.session_id, { sessionId: r.session_id, hits: 0, snippets: [] }).get(r.session_id)!
      g.hits++
      if (g.snippets.length < 3) g.snippets.push({ msgIndex: Number(r.msg_index), role: r.role, ...snippet(r.txt, ts) })
    }
    const out = []
    for (const g of by.values()) {
      const row = this.get(g.sessionId)
      if (!row || (agent && row.agent !== agent)) continue
      out.push({ ...g, session: row.summary })
      if (out.length >= 40) break
    }
    return out
  }

  /** Every matching message inside one session, in reading order. */
  find(sessionId: string, q: string, hiddenIds?: Set<string>) {
    const { ts, rows } = this.matchRows(q, sessionId, 5000)
    return rows.filter((r) => !hiddenIds?.has(r.msg_id)).map((r) => ({ msgIndex: Number(r.msg_index), role: r.role, ...snippet(r.txt, ts, 40) })).sort((a, b) => a.msgIndex - b.msgIndex)
  }

  list({ agent, q, includeChildren }: ListFilter = {}): SessionSummary[] {
    const where: string[] = []
    const args: string[] = []
    if (agent) { where.push('agent = ?'); args.push(agent) }
    if (!includeChildren) where.push('parent_id is null')
    if (q) {
      where.push("(title like ? escape '\\' or cwd like ? escape '\\')")
      const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
      args.push(like, like)
    }
    const sql = `select data from session ${where.length ? 'where ' + where.join(' and ') : ''} order by updated_at desc`
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => JSON.parse(r.data))
  }

  get(id: string): { summary: SessionSummary; sourceKey: string; agent: string } | null {
    const r = this.db.prepare('select data, source_key, agent from session where id = ?').get(id) as any
    return r ? { summary: JSON.parse(r.data), sourceKey: r.source_key, agent: r.agent } : null
  }

  children(parentId: string): SessionSummary[] {
    return (this.db.prepare('select data from session where parent_id = ? order by updated_at').all(parentId) as any[]).map((r) => JSON.parse(r.data))
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare('select agent, count(*) n from session where parent_id is null group by agent').all() as any[]
    return Object.fromEntries(rows.map((r) => [r.agent, r.n]))
  }

  close() { this.db.close() }
}
