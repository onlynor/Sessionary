import { Hono, type Context } from 'hono'
import { randomBytes } from 'node:crypto'
import { type ControlStore, type Protocol, type Provider, resolveKey } from './store.ts'

/**
 * The gateway: one local endpoint agents are pointed at. It speaks three protocols and relays each request, as is,
 * to a member of the routing group (or the one model) the agent asked for — only to members whose provider speaks
 * that same protocol; nothing is translated.
 *
 * Failover happens only before anything of the reply has been sent: an agent never gets half an answer from one
 * upstream and the rest from another. A member that failed rests for a while (longer for a bad key than for a rate
 * limit) and is tried last, never dropped. A request the upstream refused as malformed (400, 413, 422) is the
 * agent's problem, not the member's, and is passed back without trying the next one.
 */

export const PATHS: Record<string, Protocol> = { '/v1/messages': 'anthropic', '/v1/messages/count_tokens': 'anthropic', '/v1/chat/completions': 'chat', '/v1/responses': 'responses' }
/** what the gateway appends to a provider's base URL for each protocol */
const SUFFIX: Record<string, string> = { '/v1/messages': '/v1/messages', '/v1/messages/count_tokens': '/v1/messages/count_tokens', '/v1/chat/completions': '/chat/completions', '/v1/responses': '/responses' }

export interface Candidate { member: string; provider: Provider; model: string; base: string; key: string }
export interface Plan { target: string; candidates: Candidate[]; skipped: { member: string; why: 'off' | 'protocol' | 'missing' | 'nokey' }[] }

/** what the Routing and Gateway pages are told as it happens */
export interface RouteEvent {
  id: string; at: number; agent: string; target: string; protocol: Protocol
  phase: 'trying' | 'answering' | 'failed' | 'done' | 'refused'
  member?: string; status?: number; ms?: number; why?: string; input?: number; output?: number
}

interface Rest { until: number; why: string; fails: number }
const REST_MAX = 10 * 60_000

/** which upstream answers decide that a member should rest, and for how long */
export function restFor(status: number, fails: number, retryAfter?: string | null): { ms: number; why: string } | null {
  if (status === 400 || status === 413 || status === 422) return null // the request itself
  const backoff = Math.min(REST_MAX, 30_000 * 2 ** Math.max(0, fails - 1))
  if (status === 429) {
    const s = Number(retryAfter)
    return { ms: Number.isFinite(s) && s > 0 ? Math.min(REST_MAX, s * 1000) : Math.max(60_000, backoff), why: 'rate-limited' }
  }
  if (status === 401 || status === 403) return { ms: REST_MAX, why: 'key-refused' }
  if (status === 402) return { ms: REST_MAX, why: 'out-of-credit' }
  if (status === 404) return { ms: backoff, why: 'not-found' }
  if (status === 0) return { ms: backoff, why: 'unreachable' }
  if (status >= 500 || status === 408) return { ms: backoff, why: 'upstream-error' }
  return null
}

/** Decides who answers. Kept in memory: rests and rotation start over when Sessionary restarts. */
export class Router {
  private rests = new Map<string, Rest>()
  private turn = new Map<string, number>()
  private last = new Map<string, { ok?: number; fail?: number; status?: number }>()
  private busy = new Map<string, number>()
  constructor(private store: ControlStore) {}

  /** the members a target names, in the order to try them, before looking at protocol or health */
  members(target: string): string[] {
    if (target.startsWith('group/')) {
      const g = this.store.group(target.slice(6))
      return g && g.on ? g.members : []
    }
    return [target]
  }

  plan(target: string, protocol: Protocol): Plan {
    const providers = new Map(this.store.providers().map((p) => [p.id, p]))
    const out: Plan = { target, candidates: [], skipped: [] }
    let members = this.members(target)
    const g = target.startsWith('group/') ? this.store.group(target.slice(6)) : undefined
    if (g?.mode === 'rotate' && members.length > 1) {
      const n = this.turn.get(g.id) ?? 0
      this.turn.set(g.id, n + 1)
      members = [...members.slice(n % members.length), ...members.slice(0, n % members.length)]
    }
    for (const member of members) {
      const slash = member.indexOf('/')
      const p = providers.get(member.slice(0, slash))
      const model = member.slice(slash + 1)
      if (!p || slash < 1 || !model) { out.skipped.push({ member, why: 'missing' }); continue }
      if (!p.on || p.models.find((m) => m.id === model)?.on === false) { out.skipped.push({ member, why: 'off' }); continue }
      const base = p.endpoints[protocol]
      if (!base) { out.skipped.push({ member, why: 'protocol' }); continue }
      const key = resolveKey(p.key)
      if (!key && p.key) { out.skipped.push({ member, why: 'nokey' }); continue }
      out.candidates.push({ member, provider: p, model, base: base.replace(/\/+$/, ''), key })
    }
    // a resting member is tried last, never left out: when everyone rests, someone still has to answer
    const now = Date.now()
    const resting = (c: Candidate) => (this.rests.get(c.member)?.until ?? 0) > now
    out.candidates = [...out.candidates.filter((c) => !resting(c)), ...out.candidates.filter(resting)]
    return out
  }

  answered(member: string) {
    this.rests.delete(member)
    this.last.set(member, { ...this.last.get(member), ok: Date.now() })
  }
  failed(member: string, status: number, retryAfter?: string | null): Rest | undefined {
    const fails = (this.rests.get(member)?.fails ?? 0) + 1
    this.last.set(member, { ...this.last.get(member), fail: Date.now(), status })
    const r = restFor(status, fails, retryAfter)
    if (!r) return undefined
    const rest = { until: Date.now() + r.ms, why: r.why, fails }
    this.rests.set(member, rest)
    return rest
  }
  start(member: string) { this.busy.set(member, (this.busy.get(member) ?? 0) + 1) }
  end(member: string) { const n = (this.busy.get(member) ?? 1) - 1; if (n > 0) this.busy.set(member, n); else this.busy.delete(member) }
  /** lets a member be tried first again */
  wake(member: string) { this.rests.delete(member) }

  /** every member anything names, with what is known of it */
  health() {
    const now = Date.now()
    const names = new Set<string>([...this.rests.keys(), ...this.last.keys(), ...this.busy.keys()])
    for (const g of this.store.groups()) for (const m of g.members) names.add(m)
    return [...names].map((member) => {
      const r = this.rests.get(member)
      const l = this.last.get(member)
      return {
        member, answering: this.busy.get(member) ?? 0,
        ...(r && r.until > now && { restingUntil: r.until, why: r.why }),
        ...(l?.ok && { lastOk: l.ok }), ...(l?.fail && { lastFail: l.fail, lastStatus: l.status }),
      }
    })
  }
}

// ---------- usage ----------
export interface Tokens { input: number; output: number; cacheRead: number }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** the token counts in one reply object or stream event, whichever of the three protocols it is */
export function usageOf(o: any, into: Tokens = { input: 0, output: 0, cacheRead: 0 }): Tokens {
  const u = o?.usage ?? o?.message?.usage ?? o?.response?.usage
  if (!u || typeof u !== 'object') return into
  const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) || num(u.prompt_tokens)
  const cache = num(u.cache_read_input_tokens) || num(u.prompt_tokens_details?.cached_tokens) || num(u.input_tokens_details?.cached_tokens)
  const output = num(u.output_tokens) || num(u.completion_tokens)
  into.input = Math.max(into.input, input)
  into.output = Math.max(into.output, output)
  into.cacheRead = Math.max(into.cacheRead, cache)
  return into
}

/** passes a reply through untouched while reading the usage out of it */
function tap(body: ReadableStream<Uint8Array>, sse: boolean, done: (t: Tokens, error?: string) => void): ReadableStream<Uint8Array> {
  const dec = new TextDecoder()
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0 }
  let buf = ''
  let whole = ''
  let finished = false
  const finish = (error?: string) => { if (finished) return; finished = true; done(tokens, error) }
  const line = (l: string) => {
    if (!l.startsWith('data:') || !l.includes('usage')) return
    try { usageOf(JSON.parse(l.slice(5).trim()), tokens) } catch { /* not JSON */ }
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      ctl.enqueue(chunk)
      const s = dec.decode(chunk, { stream: true })
      if (sse) {
        buf += s
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1) }
        if (buf.length > 1 << 20) buf = ''
      } else if (whole.length < 4 << 20) whole += s
    },
    flush() {
      if (sse) line(buf.trimEnd())
      else { try { usageOf(JSON.parse(whole), tokens) } catch { /* not JSON */ } }
      finish()
    },
    cancel() { finish('cancelled') },
  } as Transformer<Uint8Array, Uint8Array>))
}

// ---------- the endpoint ----------
export interface GatewayOptions {
  store: ControlStore
  router: Router
  emit?: (e: RouteEvent) => void
  /** how long to wait for an upstream's headers (a reply that does not stream comes all at once) */
  headersTimeoutMs?: number
}

/** which agent is asking: the key's suffix (`<key>.<agent>`) set when Sessionary starts it, else its user agent */
export function callerOf(key: string, gatewayKey: string, ua: string): string | null {
  if (key !== gatewayKey && !key.startsWith(gatewayKey + '.')) return null
  const named = key.slice(gatewayKey.length + 1)
  if (named) return named
  const u = ua.toLowerCase()
  return u.includes('claude') ? 'claude-code' : u.includes('codex') ? 'codex' : u.includes('opencode') ? 'opencode' : u.includes('hermes') ? 'hermes' : u.includes('pi-coding') ? 'pi' : 'other'
}

const errorBody = (protocol: Protocol, message: string, type = 'api_error') =>
  protocol === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { message, type, code: type } }

export function createGateway(o: GatewayOptions) {
  const { store, router } = o
  const emit = o.emit ?? (() => {})
  const gw = new Hono()

  // Only agents on this machine: a page on another site must not be able to spend the user's keys.
  gw.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return c.json({ error: { message: 'Cross-origin request refused' } }, 403)
    await next()
  })

  const auth = (c: Context) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    const key = (bearer ?? c.req.header('x-api-key') ?? c.req.header('x-goog-api-key') ?? '').trim()
    return key ? callerOf(key, store.gatewayKey(), c.req.header('user-agent') ?? '') : null
  }

  gw.get('/v1/models', (c) => {
    if (!auth(c)) return c.json({ error: { message: 'Missing or wrong gateway key.' } }, 401)
    const data = [
      ...store.groups().filter((g) => g.on).map((g) => ({ id: `group/${g.id}`, object: 'model', type: 'model', owned_by: 'sessionary', display_name: g.name, created_at: new Date(g.at).toISOString() })),
      ...store.providers().filter((p) => p.on).flatMap((p) => p.models.filter((m) => m.on).map((m) => ({
        id: `${p.id}/${m.id}`, object: 'model', type: 'model', owned_by: p.id, display_name: `${m.name ?? m.id} · ${p.name}`, created_at: new Date(p.at).toISOString(), ...(m.context && { context_length: m.context }),
      }))),
    ]
    return c.json({ object: 'list', data, has_more: false })
  })

  gw.post('/v1/*', async (c) => {
    const path = new URL(c.req.url).pathname.replace(/^.*?(\/v1\/)/, '/v1/')
    const protocol = PATHS[path]
    if (!protocol) return c.json({ error: { message: `The gateway does not serve ${path}.` } }, 404)
    const agent = auth(c)
    if (!agent) return c.json(errorBody(protocol, 'Missing or wrong gateway key.', 'authentication_error'), 401)
    if (Number(c.req.header('content-length') ?? 0) > 64 << 20) return c.json(errorBody(protocol, 'Request too large.', 'invalid_request_error'), 413)

    let body: any
    try { body = JSON.parse(await c.req.text()) } catch { return c.json(errorBody(protocol, 'The request body is not JSON.', 'invalid_request_error'), 400) }
    const asked = typeof body?.model === 'string' ? body.model : ''
    // a model the gateway does not know (an agent's built-in helper model, say) is served by the agent's binding
    const known = (t: string) => router.members(t).length > 0 && (t.startsWith('group/') || store.provider(t.slice(0, t.indexOf('/'))))
    const target = asked && known(asked) ? asked : store.binding(agent)?.target ?? asked
    const id = randomBytes(5).toString('hex')
    const t0 = Date.now()
    const plan = router.plan(target, protocol)
    if (!plan.candidates.length) {
      const why = !target ? 'The request names no model.'
        : plan.skipped.some((s) => s.why === 'protocol') ? `None of the models in ${target} speaks this protocol (${protocol}). Add one whose provider has a ${protocol} endpoint.`
        : plan.skipped.length ? `Every model in ${target} is switched off or has no key.` : `Sessionary does not know the model ${target}.`
      emit({ id, at: t0, agent, target, protocol, phase: 'refused', why })
      return c.json(errorBody(protocol, why, 'not_found_error'), 404)
    }

    const stream = body?.stream === true
    let tries = 0
    let lastFail: Response | undefined
    let lastError = ''
    for (const [i, cand] of plan.candidates.entries()) {
      const isLast = i === plan.candidates.length - 1
      tries++
      emit({ id, at: Date.now(), agent, target, protocol, phase: 'trying', member: cand.member })
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: c.req.header('accept') ?? (stream ? 'text/event-stream' : 'application/json') }
      const ua = c.req.header('user-agent'); if (ua) headers['user-agent'] = ua
      if (protocol === 'anthropic') {
        if (cand.key) headers['x-api-key'] = cand.key
        headers['anthropic-version'] = c.req.header('anthropic-version') ?? '2023-06-01'
        const beta = c.req.header('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta
      } else if (cand.key) headers.authorization = `Bearer ${cand.key}`

      const ctl = new AbortController()
      const onAbort = () => ctl.abort()
      c.req.raw.signal?.addEventListener('abort', onAbort)
      const timer = setTimeout(() => ctl.abort(), o.headersTimeoutMs ?? 10 * 60_000)
      let res: Response
      router.start(cand.member)
      try {
        res = await fetch(cand.base + SUFFIX[path], { method: 'POST', headers, body: JSON.stringify({ ...body, model: cand.model }), signal: ctl.signal })
      } catch (e) {
        clearTimeout(timer); router.end(cand.member)
        if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 })
        lastError = (e as Error).message
        const rest = router.failed(cand.member, 0)
        emit({ id, at: Date.now(), agent, target, protocol, phase: 'failed', member: cand.member, status: 0, why: rest?.why ?? 'unreachable' })
        if (isLast) break
        continue
      }
      clearTimeout(timer)

      if (!res.ok) {
        router.end(cand.member)
        const rest = router.failed(cand.member, res.status, res.headers.get('retry-after'))
        emit({ id, at: Date.now(), agent, target, protocol, phase: 'failed', member: cand.member, status: res.status, why: rest?.why ?? 'request-refused' })
        // the agent's own request was refused, or there is no one else: the upstream's answer goes back as it is
        if (!rest || isLast) {
          store.addUsage({ at: t0, agent, target, provider: cand.provider.id, model: cand.model, protocol, status: res.status, ms: Date.now() - t0, input: 0, output: 0, cacheRead: 0, error: rest?.why ?? 'request-refused', tries })
          return passBack(res)
        }
        lastFail = res
        await res.body?.cancel().catch(() => {})
        continue
      }

      router.answered(cand.member)
      emit({ id, at: Date.now(), agent, target, protocol, phase: 'answering', member: cand.member, ms: Date.now() - t0 })
      const sse = (res.headers.get('content-type') ?? '').includes('event-stream')
      const out = res.body ? tap(res.body, sse, (tk, error) => {
        router.end(cand.member)
        c.req.raw.signal?.removeEventListener('abort', onAbort)
        const ms = Date.now() - t0
        if (path !== '/v1/messages/count_tokens') store.addUsage({ at: t0, agent, target, provider: cand.provider.id, model: cand.model, protocol, status: res.status, ms, input: tk.input, output: tk.output, cacheRead: tk.cacheRead, error, tries })
        emit({ id, at: Date.now(), agent, target, protocol, phase: 'done', member: cand.member, status: res.status, ms, input: tk.input, output: tk.output, ...(error && { why: error }) })
      }) : (router.end(cand.member), null)
      const h = new Headers()
      for (const k of ['content-type', 'cache-control', 'request-id', 'x-request-id']) { const v = res.headers.get(k); if (v) h.set(k, v) }
      h.set('x-sessionary-member', cand.member)
      return new Response(out, { status: res.status, headers: h })
    }

    const last = plan.candidates.at(-1)!
    store.addUsage({ at: t0, agent, target, provider: last.provider.id, model: last.model, protocol, status: lastFail?.status ?? 502, ms: Date.now() - t0, input: 0, output: 0, cacheRead: 0, error: lastError || 'unreachable', tries })
    return c.json(errorBody(protocol, `No model in ${target} could answer: ${lastError || 'unreachable'}`, 'api_error'), 502)
  })

  return gw
}

/** an upstream's error as the agent should see it */
function passBack(res: Response): Response {
  const h = new Headers()
  for (const k of ['content-type', 'retry-after']) { const v = res.headers.get(k); if (v) h.set(k, v) }
  return new Response(res.body, { status: res.status, headers: h })
}
