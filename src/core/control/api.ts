import type { Context, Hono } from 'hono'
import { agentModelState, launchProfile, PROTOCOL_OF, ROUTABLE, snippet, type LaunchProfile } from './agents.ts'
import { detectMagpie, listModels, mergeModels } from './catalog.ts'
import { createGateway, type RouteEvent, Router } from './gateway.ts'
import { PRESETS, presetOf } from './presets.ts'
import { ControlError, type ControlStore, type Group, maskKey, MODEL_RE, PROTOCOLS, type Protocol, type Provider, slug, validEndpoint, type UsageRow } from './store.ts'

/**
 * Model Control's HTTP side: `/gateway/*` for agents (its own key), `/api/control/*` for the page (the app's token
 * guards every POST). Only the controlling app has it — never a node's read-only view.
 */
export interface ControlOptions {
  store: ControlStore
  /** where agents reach the gateway, e.g. `http://127.0.0.1:4777/gateway` */
  gatewayBase: () => string
  broadcast: (event: string, data: unknown) => void
}

const publicProvider = (p: Provider) => ({ ...p, key: maskKey(p.key), hasKey: !!p.key })
const DAY = 86_400_000

/** usage rows summed the ways the Usage page shows them */
export function summarize(rows: UsageRow[]) {
  const totals = { calls: rows.length, failed: 0, input: 0, output: 0, cacheRead: 0, ms: 0, rerouted: 0 }
  const by = <K extends string>(key: (r: UsageRow) => K) => {
    const m = new Map<K, { key: K; calls: number; input: number; output: number; cacheRead: number; failed: number }>()
    for (const r of rows) {
      const k = key(r)
      const e = m.get(k) ?? { key: k, calls: 0, input: 0, output: 0, cacheRead: 0, failed: 0 }
      e.calls++; e.input += r.input; e.output += r.output; e.cacheRead += r.cacheRead; if (r.status >= 400 || r.error) e.failed++
      m.set(k, e)
    }
    return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output) || b.calls - a.calls)
  }
  for (const r of rows) {
    totals.input += r.input; totals.output += r.output; totals.cacheRead += r.cacheRead; totals.ms += r.ms
    if (r.status >= 400 || r.error) totals.failed++
    if (r.tries > 1) totals.rerouted++
  }
  const day = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return String(d.getTime()) }
  return {
    totals,
    byDay: by((r) => day(r.at)).sort((a, b) => Number(a.key) - Number(b.key)),
    byModel: by((r) => `${r.provider}/${r.model}`),
    byAgent: by((r) => r.agent),
    byTarget: by((r) => r.target),
    recent: rows.slice(0, 40),
  }
}

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

  const agents = () => {
    const bindings = new Map(store.bindings().map((b) => [b.agent, b.target]))
    return ROUTABLE.map((a) => {
      const target = bindings.get(a)
      const plan = target ? router.plan(target, PROTOCOL_OF[a]!) : undefined
      return {
        ...agentModelState(a, undefined, o.gatewayBase()), target, protocol: PROTOCOL_OF[a],
        // how many members could answer this agent: the gateway does not translate between protocols
        ...(plan && { reachable: plan.candidates.length, members: router.members(target!).length }),
      }
    })
  }

  app.get('/api/control/state', (c) => c.json({
    providers: store.providers().map(publicProvider),
    groups: store.groups(),
    bindings: store.bindings(),
    agents: agents(),
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

  // ---- agents ----
  app.post('/api/control/bindings', async (c) => {
    try {
      const b = await body(c)
      const agent = String(b.agent ?? '')
      if (!(ROUTABLE as readonly string[]).includes(agent)) throw new ControlError('Sessionary cannot route this agent.')
      const target = String(b.target ?? '')
      if (target) checkTarget(target)
      store.bind(agent, target)
      return c.json({ ok: true, agents: agents() })
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
  app.get('/api/control/usage', (c) => {
    const days = Number(c.req.query('days') ?? 30)
    const since = days > 0 ? Date.now() - days * DAY : 0
    return c.json(summarize(store.usage(since)))
  })

  /** what Sessionary adds when it starts this agent itself (a terminal, a chat); nothing when it is not bound */
  const launchFor = (agent: string, machine: string): LaunchProfile | undefined => {
    if (machine !== 'local') return undefined // the gateway listens on this computer only
    const target = store.binding(agent)?.target
    return target ? launchProfile(agent, target, o.gatewayBase(), store.gatewayKey()) : undefined
  }
  return { router, launchFor }
}
