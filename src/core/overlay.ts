import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'
import type { SessionSummary } from './model.ts'
import { dataHome } from './util.ts'
import type { NodeConfig } from './nodes.ts'

/**
 * The user's own decisions about sessions — currently "hidden" (Sessionary's trash). Unlike the index this is
 * not derived data: it is never rebuilt or dropped, and it never touches the agents' files. Keys are the stable
 * session id (`agent:nativeId`) and the agent's own message id, so they survive re-indexing and file growth.
 */
export interface TrashEntry { kind: 'session' | 'message'; sessionId: string; messageId: string; at: number }

export interface RemovedEntry { sessionId: string; agent: string; at: number; backupDir: string; manifest: Record<string, unknown>; summary: SessionSummary }

const nodeRow = (r: any): NodeConfig => ({
  id: r.id, name: r.name, kind: r.kind, at: r.at,
  ...(r.host != null && { host: r.host }), ...(r.user != null && { user: r.user }), ...(r.port != null && { port: r.port }),
  ...(r.identity != null && { identity: r.identity }), ...(r.url != null && { url: r.url }),
})

/**
 * The decisions are keyed by session id. A node's sessions are kept in the same database under `node:<id>/`, so
 * one file holds everything and a node's view (`scoped`) sees only its own rows, with the prefix stripped.
 */
export class OverlayStore {
  private db: DatabaseSync
  private prefix: string

  constructor(file = path.join(dataHome(), 'overlay.db'), shared?: { db: DatabaseSync; prefix: string }) {
    if (shared) { this.db = shared.db; this.prefix = shared.prefix; return }
    this.prefix = ''
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
      -- names the user gave sessions; the agents' own files keep theirs
      create table if not exists titles (session_id text primary key, title text not null, at integer not null);
      -- other machines running Sessionary; no secrets (ssh uses the user's own keys)
      create table if not exists nodes (
        id text primary key, name text not null, kind text not null,
        host text, user text, port integer, remote_port integer, identity text, url text,
        at integer not null
      );
    `)
  }

  /** this store's view of one node's sessions */
  scoped(nodeId: string): OverlayStore { return new OverlayStore(':memory:', { db: this.db, prefix: `node:${nodeId}/` }) }

  private k = (id: string) => this.prefix + id
  /** whether a stored session id belongs to this view; the local view owns everything that is not a node's */
  private own = (id: string) => (this.prefix ? id.startsWith(this.prefix) : !id.startsWith('node:'))
  private un = (id: string) => (this.prefix ? id.slice(this.prefix.length) : id)

  /** forget everything recorded about a node's sessions */
  dropNode(nodeId: string) {
    const like = `node:${nodeId}/%`
    this.db.prepare('delete from hidden where session_id like ?').run(like)
    this.db.prepare('delete from pinned where session_id like ?').run(like)
    this.db.prepare('delete from titles where session_id like ?').run(like)
  }

  nodes(): NodeConfig[] {
    return (this.db.prepare('select * from nodes order by at').all() as any[]).map(nodeRow)
  }
  node(id: string): NodeConfig | undefined {
    const r = this.db.prepare('select * from nodes where id = ?').get(id) as any
    return r ? nodeRow(r) : undefined
  }
  addNode(n: NodeConfig) {
    this.db.prepare('insert into nodes (id, name, kind, host, user, port, identity, url, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(n.id, n.name, n.kind, n.host ?? null, n.user ?? null, n.port ?? null, n.identity ?? null, n.url ?? null, n.at)
  }
  updateNode(n: NodeConfig) {
    this.db.prepare('update nodes set name = ?, kind = ?, host = ?, user = ?, port = ?, identity = ?, url = ? where id = ?')
      .run(n.name, n.kind, n.host ?? null, n.user ?? null, n.port ?? null, n.identity ?? null, n.url ?? null, n.id)
  }
  removeNode(id: string) { this.db.prepare('delete from nodes where id = ?').run(id) }

  hideSession(id: string) {
    this.db.prepare("insert or ignore into hidden (kind, session_id, message_id, at) values ('session', ?, '', ?)").run(this.k(id), Date.now())
  }

  restoreSession(id: string) {
    this.db.prepare("delete from hidden where kind = 'session' and session_id = ?").run(this.k(id))
  }

  hideMessages(sessionId: string, ids: string[]) {
    const ins = this.db.prepare("insert or ignore into hidden (kind, session_id, message_id, at) values ('message', ?, ?, ?)")
    const at = Date.now()
    this.db.exec('begin')
    try { for (const id of ids) ins.run(this.k(sessionId), id, at); this.db.exec('commit') } catch (e) { this.db.exec('rollback'); throw e }
  }

  /** `ids` omitted restores every hidden message of the session. */
  restoreMessages(sessionId: string, ids?: string[]) {
    if (!ids) { this.db.prepare("delete from hidden where kind = 'message' and session_id = ?").run(this.k(sessionId)); return }
    const del = this.db.prepare("delete from hidden where kind = 'message' and session_id = ? and message_id = ?")
    for (const id of ids) del.run(this.k(sessionId), id)
  }

  hiddenSessions(): Set<string> {
    return new Set((this.db.prepare("select session_id from hidden where kind = 'session'").all() as any[]).filter((r) => this.own(r.session_id)).map((r) => this.un(r.session_id)))
  }

  hiddenMessages(sessionId: string): Set<string> {
    return new Set((this.db.prepare("select message_id from hidden where kind = 'message' and session_id = ?").all(this.k(sessionId)) as any[]).map((r) => r.message_id))
  }

  /** every hidden (session, message) pair, for filtering search results in one pass */
  allHiddenMessages(): Set<string> {
    return new Set((this.db.prepare("select session_id, message_id from hidden where kind = 'message'").all() as any[]).filter((r) => this.own(r.session_id)).map((r) => `${this.un(r.session_id)}\u0000${r.message_id}`))
  }

  entries(): TrashEntry[] {
    return (this.db.prepare('select kind, session_id, message_id, at from hidden order by at desc').all() as any[])
      .filter((r) => this.own(r.session_id))
      .map((r) => ({ kind: r.kind, sessionId: this.un(r.session_id), messageId: r.message_id, at: r.at }))
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

  pin(id: string) { this.db.prepare('insert or replace into pinned (session_id, at) values (?, ?)').run(this.k(id), Date.now()) }
  unpin(id: string) { this.db.prepare('delete from pinned where session_id = ?').run(this.k(id)) }
  /** session id → when it was pinned */
  pinned(): Map<string, number> {
    return new Map((this.db.prepare('select session_id, at from pinned').all() as any[]).filter((r) => this.own(r.session_id)).map((r) => [this.un(r.session_id), r.at]))
  }

  /** an empty title removes the name again */
  rename(id: string, title: string) {
    const t = title.trim()
    if (!t) this.db.prepare('delete from titles where session_id = ?').run(this.k(id))
    else this.db.prepare('insert or replace into titles (session_id, title, at) values (?, ?, ?)').run(this.k(id), t.slice(0, 200), Date.now())
  }
  /** session id → the name the user gave it */
  titles(): Map<string, string> {
    return new Map((this.db.prepare('select session_id, title from titles').all() as any[]).filter((r) => this.own(r.session_id)).map((r) => [this.un(r.session_id), r.title]))
  }

  close() { this.db.close() }
}
