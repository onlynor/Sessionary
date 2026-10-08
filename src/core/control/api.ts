import { type Context, Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { dataHome } from '../util.ts'
import { agentModelState, FILES, LAUNCHABLE, launchProfile, PROTOCOL_OF, ROUTABLE, snippet, type LaunchProfile } from './agents.ts'
import { detectMagpie, listModels, mergeModels } from './catalog.ts'
import { type Caller, createGateway, type RouteEvent, Router, sameSecret } from './gateway.ts'
import { PRESETS, presetOf } from './presets.ts'
import { ControlError, type ControlStore, type Group, maskKey, MODEL_RE, PROTOCOLS, type Protocol, type Provider, type RouteScope, slug, validEndpoint } from './store.ts'

/**
 * Model Control's HTTP side: `/gateway/*` for agents (its own key), `/api/control/*` for the page (the app's token
 * guards every POST). Only the controlling app has it — never a node's read-only view.
 */
export interface ControlOptions {
  store: ControlStore
  /** where agents reach the gateway, e.g. `http://127.0.0.1:4777/gateway` */
  gatewayBase: () => string
  /** a port on a node for one session's tunnel (tests pick their own) */
  pickPort?: () => number
  /** a node reached over ssh: its sessions can get a tunnel back to the gateway */
  sshNode?: (machine: string) => boolean
  /** the machines routes may be set for (`local` and the nodes) */
  machines?: () => string[]
  broadcast: (event: string, data: unknown) => void
}

const publicProvider = (p: Provider) => ({ ...p, key: maskKey(p.key), hasKey: !!p.key })
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** a port for one session's tunnel on a node: random in a range services rarely use, so two sessions do not collide */
export const tunnelPort = () => 20_000 + Math.floor(Math.random() * 30_000)

/** where in a machine a session is: its project (working directory) and its session id (`agent:native id`) */
export interface LaunchAt { project?: string; session?: string }

/** how a routed agent is started: its profile, and on a node the tunnel and the door it leads to */
export interface Launch extends LaunchProfile {
  tunnel?: { remotePort: number; localPort: number }
  /** closes the session's door; call it when the session's process has ended (safe to call more than once) */
  release?: () => void
}

/** A session's own way into the gateway: a listener on this computer's loopback that only that session's token opens. */
export interface Door { port: number; token: string; close: () => void }

export function registerControl(app: Hono, o: ControlOptions) {
  const { store } = o
  const router = new Router(store)
  // the last few decisions, so a page that opens now can show what just happened
  const recent: RouteEvent[] = []
  const emit = (e: RouteEvent) => {
    recent.push(e); if (recent.length > 200) recent.shift()
    o.broadcast('route', e)
  }
  app.route('/gateway', createGateway({ store, router, emit }))
  store.pruneUsage()

  /**
   * A door for one session on a node. Its tunnel leads here and nowhere else: not to the app (whose page token would
   * give whatever runs on the node everything the page can do) and not to the gateway key, which never leaves this
   * computer. The token is the session's own and dies with the door, so one read on the node (a process listing, a
   * node whose sshd publishes forwarded ports) is worth at most this session, for as long as it runs.
   */
  const doors = new Set<Door>()
  const openDoor = async (caller: Caller): Promise<Door> => {
    const token = `sk-sessionary-session-${randomBytes(24).toString('base64url')}`
    const app = new Hono()
    app.route('/gateway', createGateway({ store, router, emit, authorize: (key) => (sameSecret(key, token) ? caller : null) }))
    app.all('*', (c) => c.json({ error: { message: 'Only the gateway answers here.' } }, 404))
    const server = http.createServer(getRequestListener(app.fetch))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    let open = true
    const door: Door = {
      port: (server.address() as { port: number }).port, token,
      close: () => {
        if (!open) return
        open = false
        doors.delete(door)
        server.close()
        server.closeAllConnections() // a reply still streaming ends with the session
      },
    }
    doors.add(door)
    return door
  }

  const fail = (c: Context, e: unknown) => (e instanceof ControlError ? c.json({ error: e.message }, e.status) : c.json({ error: (e as Error).message }, 500))
  const body = async (c: Context): Promise<any> => (await c.req.json().catch(() => ({}))) ?? {}
  const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new ControlError(`No such ${what}.`, 404); return v }

  /** a model or group an agent may be bound to, or a group may hold */
  const checkTarget = (target: string, inGroup = false) => {
    if (target.startsWith('group/')) {
      if (inGroup && target === 'group/') throw new ControlError('Which group?')
      need(store.group(target.slice(6)), 'routing group')
      return
    }
    const i = target.indexOf('/')
    if (i < 1 || !MODEL_RE.test(target)) throw new ControlError(`“${target}” is not a model (provider/model) or a group (group/name).`)
    need(store.provider(target.slice(0, i)), 'provider')
  }

  const endpointsFrom = (e: any): Partial<Record<Protocol, string>> => {
    const out: Partial<Record<Protocol, string>> = {}
    for (const p of PROTOCOLS) {
      const v = typeof e?.[p] === 'string' ? e[p].trim() : ''
      if (!v) continue
      if (!validEndpoint(v)) throw new ControlError(`“${v}” is not an http(s) address.`)
      out[p] = v.replace(/\/+$/, '')
    }
    if (!Object.keys(out).length) throw new ControlError('Give the provider at least one endpoint.')
    return out
  }

  /** a target this agent can be sent to: some member speaks its protocol */
  const serves = (agent: string) => (target: string) => router.plan(target, PROTOCOL_OF[agent] ?? 'chat').candidates.length > 0
  const machines = () => o.machines?.() ?? ['local']

  /** each routable agent on one machine: the route it starts on and where that came from (what it runs on by itself is known only here) */
  const agents = (machine: string) => ROUTABLE.map((a) => {
    const own = store.resolve(machine, a, {})
    const r = store.resolve(machine, a, {}, serves(a))
    const plan = r ? router.plan(r.target, PROTOCOL_OF[a]!) : undefined
    return {
      ...(machine === 'local' ? agentModelState(a, undefined, o.gatewayBase()) : { agent: a, via: 'default' as const, launch: LAUNCHABLE.has(a) ? 'env' as const : 'manual' as const }),
      target: r?.target, level: r?.level, protocol: PROTOCOL_OF[a],
      // a broader route this agent cannot use (no member speaks its protocol) is passed over, and said so
      ...(own && own.target !== r?.target && { skipped: own.target }),
      // how many members could answer this agent: the gateway does not translate between protocols
      ...(plan && { reachable: plan.candidates.length, members: router.members(r!.target).length }),
    }
  })
  const machineOf = (c: Context) => { const m = c.req.query('machine') ?? 'local'; return machines().includes(m) ? m : 'local' }

  app.get('/api/control/agents', (c) => c.json(agents(machineOf(c))))
  app.get('/api/control/state', (c) => c.json({
    providers: store.providers().map(publicProvider),
    groups: store.groups(),
    routes: store.routes(),
    agents: agents('local'),
    presets: PRESETS,
    gateway: { base: o.gatewayBase(), key: maskKey(store.gatewayKey()), protocols: { anthropic: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' } },
    health: router.health(),
    recent,
  }))
  app.get('/api/control/magpie', async (c) => c.json(await detectMagpie()))

  // ---- providers ----
  app.post('/api/control/providers', async (c) => {
    try {
      const b = await body(c)
      const preset = presetOf(String(b.preset ?? '')) ?? presetOf('custom-openai')!
      const name = String(b.name ?? '').trim() || preset.name
      const id = slug(preset.kind === 'custom' ? name : preset.id === 'moonshot' ? 'kimi' : preset.id, (x) => !!store.provider(x) || x === 'group')
      const key = String(b.key ?? '').trim() || preset.key || ''
      if (!key && !preset.keyless) throw new ControlError('Paste the API key.')
      const p: Provider = { id, name, preset: preset.id, endpoints: endpointsFrom({ ...preset.endpoints, ...b.endpoints }), key, models: [], on: true, at: Date.now() }
      // the list is read at once; a provider that cannot be reached is still added, with a reason to show
      let warning: string | undefined
      try { p.models = await listModels(p); p.refreshedAt = Date.now() } catch (e) { warning = (e as Error).message }
      store.saveProvider(p)
      return c.json({ provider: publicProvider(p), warning })
    } catch (e) { return fail(c, e) }
  })
  app.put('/api/control/providers/:id', async (c) => {
    try {
      const p = need(store.provider(c.req.param('id')), 'provider')
      const b = await body(c)
      const next: Provider = { ...p }
      if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 80)
      if (typeof b.key === 'string') next.key = b.key.trim() // omitted = unchanged; the page never has the key
      if (b.endpoints) next.endpoints = endpointsFrom(b.endpoints)
      if (typeof b.on === 'boolean') next.on = b.on
      if (Array.isArray(b.models)) {
        // only switches and hand-added models: ids are checked, nothing else from the page is trusted
        const had = new Map(p.models.map((m) => [m.id, m]))
        next.models = b.models.filter((m: any) => typeof m?.id === 'string' && MODEL_RE.test(m.id)).map((m: any) => ({ ...(had.get(m.id) ?? { id: m.id, manual: true }), on: m.on !== false }))
      }
      store.saveProvider(next)
      return c.json(publicProvider(next))
    } catch (e) { return fail(c, e) }
  })
  app.delete('/api/control/providers/:id', (c) => { store.removeProvider(c.req.param('id')); return c.json({ ok: true }) })
  app.post('/api/control/providers/:id/refresh', async (c) => {
    try {
      const p = need(store.provider(c.req.param('id')), 'provider')
      const models = mergeModels(await listModels(p), p.models)
      const next = { ...p, models, refreshedAt: Date.now() }
      store.saveProvider(next)
      return c.json(publicProvider(next))
    } catch (e) { return fail(c, e) }
  })

  // ---- routing groups ----
  const groupFrom = (b: any, had?: Group): Group => {
    const name = String(b.name ?? had?.name ?? '').trim().slice(0, 60)
    if (!name) throw new ControlError('Name the group.')
    const members: string[] = Array.isArray(b.members) ? [...new Set<string>(b.members.map(String))] : had?.members ?? []
    const self = had ? `group/${had.id}` : undefined
    for (const m of members) {
      if (m === self) throw new ControlError('A group cannot contain itself.')
      if (m.startsWith('group/')) throw new ControlError('A group holds models; nesting groups comes later.')
      checkTarget(m, true)
    }
    return { id: had?.id ?? slug(name, (x) => !!store.group(x)), name, mode: b.mode === 'rotate' ? 'rotate' : b.mode === 'order' ? 'order' : had?.mode ?? 'order', members, on: typeof b.on === 'boolean' ? b.on : had?.on ?? true, at: had?.at ?? Date.now() }
  }
  app.post('/api/control/groups', async (c) => { try { const g = groupFrom(await body(c)); store.saveGroup(g); return c.json(g) } catch (e) { return fail(c, e) } })
  app.put('/api/control/groups/:id', async (c) => {
    try { const g = groupFrom(await body(c), need(store.group(c.req.param('id')), 'routing group')); store.saveGroup(g); return c.json(g) } catch (e) { return fail(c, e) }
  })
  app.delete('/api/control/groups/:id', (c) => { store.removeGroup(c.req.param('id')); return c.json({ ok: true }) })

  // ---- routes ----
  /** a scope from the page: a known machine (or '' for every machine), then optionally an agent, a project or a session */
  const scopeFrom = (b: any): RouteScope => {
    const machine = String(b.machine ?? '')
    if (machine && !machines().includes(machine)) throw new ControlError('No such machine.', 404)
    const agent = String(b.agent ?? '')
    if (agent && !(ROUTABLE as readonly string[]).includes(agent)) throw new ControlError('Sessionary cannot route this agent.')
    const project = typeof b.project === 'string' ? b.project.trim().slice(0, 1024) : ''
    const session = typeof b.session === 'string' ? b.session.trim().slice(0, 256) : ''
    if ((project || session) && (!machine || !agent)) throw new ControlError('A project or session route belongs to one agent on one machine.')
    if (project && session) throw new ControlError('A route is for a project or for a session, not both.')
    return { machine, agent, project, session }
  }
  app.post('/api/control/routes', async (c) => {
    try {
      const b = await body(c)
      const scope = scopeFrom(b)
      const target = String(b.target ?? '')
      if (target) checkTarget(target)
      store.setRoute(scope, target)
      return c.json({ ok: true, routes: store.routes(), agents: agents(scope.machine || 'local') })
    } catch (e) { return fail(c, e) }
  })
  app.post('/api/control/members/wake', async (c) => { router.wake(String((await body(c)).member ?? '')); return c.json({ ok: true }) })

  // ---- gateway ----
  // the key itself and the snippets that contain it: POST, so only the page holding the token gets them
  app.post('/api/control/gateway/key', (c) => c.json({ key: store.gatewayKey() }))
  app.post('/api/control/gateway/rotate', (c) => { store.rotateGatewayKey(); return c.json({ key: maskKey(store.gatewayKey()) }) })
  app.post('/api/control/snippet', async (c) => {
    const b = await body(c)
    const s = snippet(String(b.agent ?? ''), String(b.target || 'group/default'), o.gatewayBase(), store.gatewayKey())
    return s ? c.json(s) : c.json({ error: 'No snippet for this agent.' }, 404)
  })

  // ---- usage ----
  /** per day, agent, route and model: what the Usage page draws (`since` YYYY-MM-DD) */
  app.get('/api/control/usage/days', (c) => c.json(store.usageDays(DAY_RE.test(c.req.query('since') ?? '') ? c.req.query('since') : '')))

  /**
   * What Sessionary adds when it starts this agent itself (a terminal, a chat); nothing when it is not bound. On this
   * computer that is the gateway and its key. On an ssh node the session's own ssh connection carries a tunnel from
   * a port on the node's loopback to a door opened for this session alone; the caller must `release` it when the
   * session's process ends, however it ends.
   */
  const launchFor = async (agent: string, machine: string, at: LaunchAt = {}): Promise<Launch | undefined> => {
    const target = store.resolve(machine, agent, at, serves(agent))?.target
    if (!target) return undefined
    if (machine === 'local') {
      const p = launchProfile(agent, target, o.gatewayBase(), `${store.gatewayKey()}.${agent}`)
      if (!p) return undefined
      // here the key is just part of the environment the process is started with, and the files are written once
      const dir = p.files ? writeFiles(p.files) : ''
      return { ...p, env: { ...p.env, [p.secret.name]: p.secret.value }, args: p.args.map((a) => a.split(FILES).join(dir)) }
    }
    if (!o.sshNode?.(machine) || !launchProfile(agent, target, '', '')) return undefined
    const door = await openDoor({ agent, machine, target })
    const tunnel = { remotePort: (o.pickPort ?? tunnelPort)(), localPort: door.port }
    const p = launchProfile(agent, target, `http://127.0.0.1:${tunnel.remotePort}/gateway`, door.token)!
    return { ...p, tunnel, release: door.close }
  }
  return { router, launchFor, doors: () => doors.size, closeDoors: () => { for (const d of [...doors]) d.close() } }
}

/** Sessionary's own helper files for agents it starts here (they hold no secret): written once, read by the agent */
function writeFiles(files: Record<string, string>): string {
  const dir = path.join(dataHome(), 'launch')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(dir, name)
    if (fs.readFileSync(f, { encoding: 'utf8', flag: 'a+' }) !== content) fs.writeFileSync(f, content)
  }
  return dir
}
