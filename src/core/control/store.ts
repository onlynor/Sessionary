import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from '../sqlite.ts'
import { dataHome } from '../util.ts'
import type { UsageDayRow } from '../usage.ts'

/**
 * Model Control: the user's providers, models, routing groups and which agent uses which. Like the overlay this is
 * the user's own data — never derived, never rebuilt — but unlike the overlay it holds secrets (API keys and the
 * gateway key), so it is a separate file readable only by its owner.
 *
 * Names: a model is addressed as `<provider id>/<model id>`, a routing group as `group/<group id>`; both are what
 * an agent sends as its model name to the gateway.
 */

/** the wire protocols a provider answers; the gateway relays a request only to a provider that speaks its protocol */
export type Protocol = 'anthropic' | 'chat' | 'responses'
export const PROTOCOLS: Protocol[] = ['anthropic', 'chat', 'responses']

/** `manual`: added by the user, not listed by the provider — kept when the list is read again */
export interface ProviderModel { id: string; name?: string; on: boolean; context?: number; manual?: boolean }
export interface Provider {
  id: string
  name: string
  /** the preset it was made from (for the icon and the help links); '' for a custom one */
  preset: string
  /** base URL per protocol: the gateway appends `/v1/messages`, `/chat/completions` or `/responses` */
  endpoints: Partial<Record<Protocol, string>>
  /** the key as stored: a literal, or `env:NAME` to read it from Sessionary's environment */
  key: string
  models: ProviderModel[]
  on: boolean
  at: number
  /** when the model list was last read from the provider */
  refreshedAt?: number
}

export type RoutingMode = 'order' | 'rotate'
export interface Group { id: string; name: string; mode: RoutingMode; members: string[]; on: boolean; at: number }
/**
 * Where a route applies. Routing belongs to the machine an agent runs on, never to the agent everywhere: `machine` ''
 * is the default for every machine, `agent` '' every agent on that machine, `project` a working directory, `session`
 * one session by its id (`agent:native id`). The most specific route wins (session > project > agent > machine > default).
 */
export interface RouteScope { machine: string; agent?: string; project?: string; session?: string }
export interface Route extends Required<RouteScope> { target: string; at: number }
/** which level a resolved route came from */
export type RouteLevel = 'session' | 'project' | 'agent' | 'machine' | 'default'
export const levelOf = (r: RouteScope): RouteLevel => (r.session ? 'session' : r.project ? 'project' : r.agent ? 'agent' : r.machine ? 'machine' : 'default')

export interface UsageRow {
  at: number; agent: string; target: string
  /** the machine the request came from (`local`, or a node's id) */
  machine?: string
  provider: string; model: string; protocol: Protocol
  status: number; ms: number; input: number; output: number; cacheRead: number; cacheWrite: number; error?: string; tries: number
}

export const MODEL_RE = /^[\w.:@+-][\w.:@+/-]{0,199}$/
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export class ControlError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 502 = 400) { super(message) }
}

/** `deepseek`, `deepseek-2`, … — a readable id that is not taken yet */
export function slug(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'
  let id = base, n = 2
  while (taken(id)) id = `${base}-${n++}`
  return id
}

/** what a page may see of a key: enough to recognise it, never enough to use it */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.startsWith('env:')) return key
  return key.length <= 10 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`
}
export const resolveKey = (key: string) => (key.startsWith('env:') ? process.env[key.slice(4)] ?? '' : key)

const json = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d } catch { return d } }
const providerRow = (r: any): Provider => ({
  id: r.id, name: r.name, preset: r.preset, endpoints: json(r.endpoints, {}), key: r.key, models: json(r.models, []), on: !!r.on, at: r.at,
  ...(r.refreshed_at != null && { refreshedAt: r.refreshed_at }),
})
const groupRow = (r: any): Group => ({ id: r.id, name: r.name, mode: r.mode === 'rotate' ? 'rotate' : 'order', members: json(r.members, []), on: !!r.on, at: r.at })

export class ControlStore {
  private db: DatabaseSync

  constructor(file = path.join(dataHome(), 'control.db')) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // created owner-only before SQLite opens it: it holds API keys
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600))
      try { fs.chmodSync(file, 0o600) } catch { /* not ours to change */ }
    }
    this.db = new DatabaseSync(file)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists providers (
        id text primary key, name text not null, preset text not null default '', endpoints text not null,
        key text not null default '', models text not null default '[]', on_ integer not null default 1,
        refreshed_at integer, at integer not null, ord integer not null default 0
      );
      create table if not exists groups_ (
        id text primary key, name text not null, mode text not null default 'order', members text not null default '[]',
        on_ integer not null default 1, at integer not null
      );
      -- where an agent is sent when Sessionary starts it, per machine (see RouteScope; '' = any)
      create table if not exists routes (
        machine text not null, agent text not null default '', project text not null default '', session text not null default '',
        target text not null, at integer not null, primary key (machine, agent, project, session)
      );
      create table if not exists settings (k text primary key, v text not null);
      create table if not exists usage (
        at integer not null, agent text not null, target text not null, provider text not null, model text not null,
        protocol text not null, status integer not null, ms integer not null, input integer not null default 0,
        output integer not null default 0, cache_read integer not null default 0, error text, tries integer not null default 1
      );
      create index if not exists usage_at on usage(at);
    `)
    // rows written before cache writes were counted kept OpenAI-style input (cached tokens included): those are
    // corrected once, when the column arrives (Anthropic rows then counted cache writes as input: left as they are)
    const cols = (this.db.prepare('pragma table_info(usage)').all() as any[]).map((c) => c.name)
    if (!cols.includes('cache_write')) {
      this.db.exec(`alter table usage add column cache_write integer not null default 0;
        update usage set input = max(0, input - cache_read) where protocol in ('chat', 'responses');`)
    }
    // before nodes could be routed, every request came from this computer
    if (!cols.includes('machine')) this.db.exec(`alter table usage add column machine text not null default 'local'`)
    // bindings were per agent on every machine; they become this computer's, where they were made and applied
    if (this.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'bindings'").get()) {
      this.db.exec(`insert or ignore into routes (machine, agent, project, session, target, at) select 'local', agent, '', '', target, at from bindings;
        drop table bindings;`)
    }
  }

  // ---- providers ----
  providers(): Provider[] {
    return (this.db.prepare('select *, on_ as "on" from providers order by ord, at').all() as any[]).map(providerRow)
  }
  provider(id: string): Provider | undefined {
    const r = this.db.prepare('select *, on_ as "on" from providers where id = ?').get(id) as any
    return r ? providerRow(r) : undefined
  }
  saveProvider(p: Provider) {
    this.db.prepare(`insert into providers (id, name, preset, endpoints, key, models, on_, refreshed_at, at, ord) values (?, ?, ?, ?, ?, ?, ?, ?, ?, (select coalesce(max(ord), 0) + 1 from providers))
      on conflict(id) do update set name = excluded.name, preset = excluded.preset, endpoints = excluded.endpoints, key = excluded.key,
      models = excluded.models, on_ = excluded.on_, refreshed_at = excluded.refreshed_at`)
      .run(p.id, p.name, p.preset, JSON.stringify(p.endpoints), p.key, JSON.stringify(p.models), p.on ? 1 : 0, p.refreshedAt ?? null, p.at)
  }
  /** a provider goes with its models: groups forget them and agents bound to one of them go back to their default */
  removeProvider(id: string) {
    this.db.exec('begin')
    try {
      this.db.prepare('delete from providers where id = ?').run(id)
      for (const g of this.groups()) {
        const members = g.members.filter((m) => !m.startsWith(id + '/'))
        if (members.length !== g.members.length) this.saveGroup({ ...g, members })
      }
      this.db.prepare("delete from routes where target like ? escape '\\'").run(id.replace(/[%_\\]/g, '\\$&') + '/%')
      this.db.exec('commit')
    } catch (e) { this.db.exec('rollback'); throw e }
  }

  // ---- routing groups ----
  groups(): Group[] { return (this.db.prepare('select *, on_ as "on" from groups_ order by at').all() as any[]).map(groupRow) }
  group(id: string): Group | undefined {
    const r = this.db.prepare('select *, on_ as "on" from groups_ where id = ?').get(id) as any
    return r ? groupRow(r) : undefined
  }
  saveGroup(g: Group) {
    this.db.prepare(`insert into groups_ (id, name, mode, members, on_, at) values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set name = excluded.name, mode = excluded.mode, members = excluded.members, on_ = excluded.on_`)
      .run(g.id, g.name, g.mode, JSON.stringify(g.members), g.on ? 1 : 0, g.at)
  }
  removeGroup(id: string) {
    this.db.prepare('delete from groups_ where id = ?').run(id)
    this.db.prepare('delete from routes where target = ?').run(`group/${id}`)
  }

  // ---- routes ----
  /** every route, or one machine's (its own, not the default it inherits) */
  routes(machine?: string): Route[] {
    const rows = (machine === undefined ? this.db.prepare('select * from routes order by machine, agent, project, session').all() : this.db.prepare('select * from routes where machine = ? order by agent, project, session').all(machine)) as any[]
    return rows.map((r) => ({ machine: r.machine, agent: r.agent, project: r.project, session: r.session, target: r.target, at: r.at }))
  }
  /** an empty target removes the route: that scope inherits again */
  setRoute(scope: RouteScope, target: string) {
    const k = [scope.machine, scope.agent ?? '', scope.project ?? '', scope.session ?? '']
    if (!target) this.db.prepare('delete from routes where machine = ? and agent = ? and project = ? and session = ?').run(...k)
    else this.db.prepare('insert or replace into routes (machine, agent, project, session, target, at) values (?, ?, ?, ?, ?, ?)').run(...k, target, Date.now())
  }
  /**
   * The route for one agent on one machine, from the most specific scope down. `usable` skips a level whose target
   * cannot serve this agent (no member speaks its protocol), so a broad default never breaks an agent it does not fit.
   */
  resolve(machine: string, agent: string, at: { project?: string; session?: string } = {}, usable: (target: string) => boolean = () => true): (Route & { level: RouteLevel }) | undefined {
    const tries: RouteScope[] = [
      ...(at.session ? [{ machine, agent, session: at.session }] : []),
      ...(at.project ? [{ machine, agent, project: at.project }] : []),
      { machine, agent }, { machine }, { machine: '' },
    ]
    for (const s of tries) {
      const r = this.db.prepare('select * from routes where machine = ? and agent = ? and project = ? and session = ?').get(s.machine, s.agent ?? '', s.project ?? '', s.session ?? '') as any
      if (r && usable(r.target)) return { machine: r.machine, agent: r.agent, project: r.project, session: r.session, target: r.target, at: r.at, level: levelOf(s) }
    }
    return undefined
  }
  /** a machine that is removed takes its routes with it */
  dropMachine(machine: string) { if (machine) this.db.prepare('delete from routes where machine = ?').run(machine) }

  // ---- gateway ----
  private setting(k: string): string | undefined { return (this.db.prepare('select v from settings where k = ?').get(k) as any)?.v }
  private setSetting(k: string, v: string) { this.db.prepare('insert or replace into settings (k, v) values (?, ?)').run(k, v) }
  /** the gateway's own key; it outlives restarts because agents keep it in their environment or configuration */
  gatewayKey(): string {
    let k = this.setting('gateway.key')
    if (!k) { k = newGatewayKey(); this.setSetting('gateway.key', k) }
    return k
  }
  rotateGatewayKey(): string { const k = newGatewayKey(); this.setSetting('gateway.key', k); return k }

  // ---- usage ----
  addUsage(u: UsageRow) {
    this.db.prepare('insert into usage (at, machine, agent, target, provider, model, protocol, status, ms, input, output, cache_read, cache_write, error, tries) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.at, u.machine ?? 'local', u.agent, u.target, u.provider, u.model, u.protocol, u.status, u.ms, u.input, u.output, u.cacheRead, u.cacheWrite, u.error ?? null, u.tries)
  }
  usage(since = 0, limit = 5000): UsageRow[] {
    return (this.db.prepare('select * from usage where at >= ? order by at desc limit ?').all(since, limit) as any[]).map((r) => ({
      at: r.at, machine: r.machine, agent: r.agent, target: r.target, provider: r.provider, model: r.model, protocol: r.protocol, status: r.status, ms: r.ms,
      input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, tries: r.tries, ...(r.error != null && { error: r.error }),
    }))
  }
  /** requests per day (this computer's time zone), agent, route and model since a day (YYYY-MM-DD) */
  usageDays(since = ''): UsageDayRow[] {
    const from = since ? new Date(`${since}T00:00:00`).getTime() : 0
    return (this.db.prepare(`
      select strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') as day, machine, agent, target, provider, model,
        count(*) as requests, sum(status >= 400 or error is not null) as failed, sum(input) as input, sum(output) as output,
        sum(cache_read) as cache_read, sum(cache_write) as cache_write
      from usage where at >= ? group by day, machine, agent, target, provider, model order by day`).all(from) as any[]).map((r) => ({
      day: r.day, machine: r.machine, agent: r.agent, route: r.target, model: `${r.provider}/${r.model}`, requests: r.requests, failed: r.failed,
      input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
    }))
  }
  /** keeps the table from growing without end: what is older than `keepMs` goes (a year and a bit: the Usage page shows a year) */
  pruneUsage(keepMs = 400 * 86_400_000) { this.db.prepare('delete from usage where at < ?').run(Date.now() - keepMs) }

  close() { this.db.close() }
}

const newGatewayKey = () => `sk-sessionary-${randomBytes(18).toString('base64url')}`

/** checks what a page sent before it reaches the store */
export function validProviderId(id: string) { return ID_RE.test(id) }
export function validEndpoint(url: string) {
  try { const u = new URL(url); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password } catch { return false }
}
