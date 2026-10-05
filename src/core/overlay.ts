import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'
import type { SessionSummary } from './model.ts'
import { dataHome } from './util.ts'

/**
 * The user's own decisions about sessions — currently "hidden" (Sessionary's trash). Unlike the index this is
 * not derived data: it is never rebuilt or dropped, and it never touches the agents' files. Keys are the stable
 * session id (`agent:nativeId`) and the agent's own message id, so they survive re-indexing and file growth.
 */
export interface TrashEntry { kind: 'session' | 'message'; sessionId: string; messageId: string; at: number }

export interface RemovedEntry { sessionId: string; agent: string; at: number; backupDir: string; manifest: Record<string, unknown>; summary: SessionSummary }

export class OverlayStore {
  private db: DatabaseSync

  constructor(file = path.join(dataHome(), 'overlay.db')) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists hidden (
        kind text not null check (kind in ('session', 'message')),
        session_id text not null,
        message_id text not null default '',
        at integer not null,
        primary key (kind, session_id, message_id)
      );
      -- sessions the user keeps at the top of the list
      create table if not exists pinned (session_id text primary key, at integer not null);
      -- sessions taken out of an agent's own storage; the backup is what makes it reversible
      create table if not exists removed (
        session_id text primary key, agent text not null, at integer not null,
        backup_dir text not null, manifest text not null, summary text not null
      );
    `)
  }

  hideSession(id: string) {
    this.db.prepare("insert or ignore into hidden (kind, session_id, message_id, at) values ('session', ?, '', ?)").run(id, Date.now())
  }

  restoreSession(id: string) {
    this.db.prepare("delete from hidden where kind = 'session' and session_id = ?").run(id)
  }

  hideMessages(sessionId: string, ids: string[]) {
    const ins = this.db.prepare("insert or ignore into hidden (kind, session_id, message_id, at) values ('message', ?, ?, ?)")
    const at = Date.now()
    this.db.exec('begin')
    try { for (const id of ids) ins.run(sessionId, id, at); this.db.exec('commit') } catch (e) { this.db.exec('rollback'); throw e }
  }

  /** `ids` omitted restores every hidden message of the session. */
  restoreMessages(sessionId: string, ids?: string[]) {
    if (!ids) { this.db.prepare("delete from hidden where kind = 'message' and session_id = ?").run(sessionId); return }
    const del = this.db.prepare("delete from hidden where kind = 'message' and session_id = ? and message_id = ?")
    for (const id of ids) del.run(sessionId, id)
  }

  hiddenSessions(): Set<string> {
    return new Set((this.db.prepare("select session_id from hidden where kind = 'session'").all() as any[]).map((r) => r.session_id))
  }

  hiddenMessages(sessionId: string): Set<string> {
    return new Set((this.db.prepare("select message_id from hidden where kind = 'message' and session_id = ?").all(sessionId) as any[]).map((r) => r.message_id))
  }

  /** every hidden (session, message) pair, for filtering search results in one pass */
  allHiddenMessages(): Set<string> {
    return new Set((this.db.prepare("select session_id, message_id from hidden where kind = 'message'").all() as any[]).map((r) => `${r.session_id}\u0000${r.message_id}`))
  }

  entries(): TrashEntry[] {
    return (this.db.prepare('select kind, session_id, message_id, at from hidden order by at desc').all() as any[])
      .map((r) => ({ kind: r.kind, sessionId: r.session_id, messageId: r.message_id, at: r.at }))
  }

  addRemoved(r: RemovedEntry) {
    this.db.prepare('insert or replace into removed (session_id, agent, at, backup_dir, manifest, summary) values (?, ?, ?, ?, ?, ?)')
      .run(r.sessionId, r.agent, r.at, r.backupDir, JSON.stringify(r.manifest), JSON.stringify(r.summary))
  }

  removed(sessionId?: string): RemovedEntry[] {
    const rows = (sessionId
      ? this.db.prepare('select * from removed where session_id = ?').all(sessionId)
      : this.db.prepare('select * from removed order by at desc').all()) as any[]
    return rows.map((r) => ({ sessionId: r.session_id, agent: r.agent, at: r.at, backupDir: r.backup_dir, manifest: JSON.parse(r.manifest), summary: JSON.parse(r.summary) }))
  }

  dropRemoved(sessionId: string) {
    this.db.prepare('delete from removed where session_id = ?').run(sessionId)
  }

  pin(id: string) { this.db.prepare('insert or replace into pinned (session_id, at) values (?, ?)').run(id, Date.now()) }
  unpin(id: string) { this.db.prepare('delete from pinned where session_id = ?').run(id) }
  /** session id → when it was pinned */
  pinned(): Map<string, number> {
    return new Map((this.db.prepare('select session_id, at from pinned').all() as any[]).map((r) => [r.session_id, r.at]))
  }

  close() { this.db.close() }
}
