import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-control-'))
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
process.env.CODEX_HOME = path.join(tmp, 'codex')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi')
process.env.HERMES_HOME = path.join(tmp, 'hermes')
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config')
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg')
process.env.SESSIONARY_HOME = path.join(tmp, 'home')
delete process.env.ANTHROPIC_BASE_URL

const { ControlStore, maskKey } = await import('../src/core/control/store.ts')
const { Router, restFor, usageOf, callerOf } = await import('../src/core/control/gateway.ts')
const { agentModelState, launchProfile, stripJsonc, tomlTables } = await import('../src/core/control/agents.ts')
const { mergeModels } = await import('../src/core/control/catalog.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')

// ---- fake upstreams: each records what it was sent and answers as told ----
type Reply = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void
const servers: http.Server[] = []
async function upstream(reply: Reply): Promise<{ url: string; seen: { path: string; body: any; headers: http.IncomingHttpHeaders }[] }> {
  const seen: { path: string; body: any; headers: http.IncomingHttpHeaders }[] = []
  const s = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { const body = raw ? JSON.parse(raw) : undefined; seen.push({ path: req.url ?? '', body, headers: req.headers }); reply(req, body, res) })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  servers.push(s)
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen }
}
after(() => { for (const s of servers) s.close() })

const anthropicStream: Reply = (_req, body, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 120, cache_read_input_tokens: 30 } } })}\n\n`)
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } })}\n\n`)
  res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } })}\n\n`)
}
const status = (code: number, headers: Record<string, string> = {}): Reply => (_r, _b, res) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify({ error: { message: `fake ${code}` } })) }

function makeApp() {
  const control = new ControlStore(':memory:')
  const { app } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'), { control, port: 4999 })
  const page = async () => {
    const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
    return (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  }
  const gw = (url: string, body: unknown, headers: Record<string, string> = {}) => app.request('/gateway' + url, {
    method: 'POST', body: JSON.stringify(body), headers: { host: '127.0.0.1:4999', 'content-type': 'application/json', 'x-api-key': control.gatewayKey() + '.claude-code', ...headers },
  })
  return { app, control, page, gw }
}
const provider = (id: string, endpoints: Record<string, string>, models = ['m1']) => ({ id, name: id, preset: 'custom-openai', endpoints, key: 'sk-test-' + id, models: models.map((m) => ({ id: m, on: true })), on: true, at: Date.now() })

test('removing a provider takes its models out of groups and unbinds agents that used one', () => {
  const s = new ControlStore(':memory:')
  s.saveProvider(provider('a', { chat: 'http://a' }))
  s.saveProvider(provider('b', { chat: 'http://b' }))
  s.saveGroup({ id: 'g', name: 'G', mode: 'order', members: ['a/m1', 'b/m1'], on: true, at: 1 })
  s.bind('codex', 'a/m1')
  s.bind('opencode', 'group/g')
  s.removeProvider('a')
  assert.deepEqual(s.group('g')!.members, ['b/m1'])
  assert.equal(s.binding('codex'), undefined)
  assert.equal(s.binding('opencode')!.target, 'group/g')
  s.removeGroup('g')
  assert.equal(s.binding('opencode'), undefined)
})

test('the gateway key outlives a restart; a page sees keys only masked', () => {
  const file = path.join(tmp, 'control-key.db')
  const a = new ControlStore(file)
  const key = a.gatewayKey()
  a.close()
  assert.equal(new ControlStore(file).gatewayKey(), key)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(maskKey('sk-abcdefghijklmnop'), 'sk-a…mnop')
  assert.equal(maskKey('env:DEEPSEEK_KEY'), 'env:DEEPSEEK_KEY')
})

test('rests: rate limits follow retry-after, a refused key rests long, a malformed request rests nobody', () => {
  assert.equal(restFor(429, 1, '12')!.ms, 12_000)
  assert.equal(restFor(401, 1)!.why, 'key-refused')
  assert.equal(restFor(400, 1), null)
  assert.ok(restFor(503, 3)!.ms > restFor(503, 1)!.ms)
})

test('usage is read from all three protocols', () => {
  assert.deepEqual(usageOf({ usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 2 } }), { input: 10, output: 2, cacheRead: 4 })
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } } }), { input: 9, output: 3, cacheRead: 1 })
  assert.deepEqual(usageOf({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } } } }), { input: 5, output: 6, cacheRead: 2 })
})

test('callers: the key names the agent; a wrong key is nobody', () => {
  assert.equal(callerOf('k.codex', 'k', ''), 'codex')
  assert.equal(callerOf('k', 'k', 'claude-cli/2.0'), 'claude-code')
  assert.equal(callerOf('kx', 'k', ''), null)
})

test('a rotate group starts each request one member further on', () => {
  const s = new ControlStore(':memory:')
  s.saveProvider(provider('a', { chat: 'http://a' }, ['x', 'y', 'z']))
  s.saveGroup({ id: 'r', name: 'R', mode: 'rotate', members: ['a/x', 'a/y', 'a/z'], on: true, at: 1 })
  const r = new Router(s)
  assert.deepEqual([0, 1, 2, 3].map(() => r.plan('group/r', 'chat').candidates[0]!.member), ['a/x', 'a/y', 'a/z', 'a/x'])
})

test('failover: a rate-limited member rests and the next one answers, streamed, with its usage recorded', async () => {
  const limited = await upstream(status(429, { 'retry-after': '30' }))
  const good = await upstream(anthropicStream)
  const { app, control, gw, page } = makeApp()
  control.saveProvider(provider('busy', { anthropic: limited.url }))
  control.saveProvider(provider('fine', { anthropic: good.url }, ['fast']))
  control.saveGroup({ id: 'daily', name: 'Daily', mode: 'order', members: ['busy/m1', 'fine/fast'], on: true, at: 1 })

  const res = await gw('/v1/messages', { model: 'group/daily', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-beta': 'x-beta' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-sessionary-member'), 'fine/fast')
  assert.match(await res.text(), /hello/)
  // each upstream got its own model name and its own key; the agent's key never left
  assert.equal(limited.seen[0]!.body.model, 'm1')
  assert.equal(good.seen[0]!.body.model, 'fast')
  assert.equal(good.seen[0]!.headers['x-api-key'], 'sk-test-fine')
  assert.equal(good.seen[0]!.headers['anthropic-beta'], 'x-beta')
  assert.equal(good.seen[0]!.path, '/v1/messages')

  const [row] = control.usage()
  assert.equal(row!.agent, 'claude-code')
  assert.equal(row!.tries, 2)
  assert.deepEqual([row!.input, row!.output, row!.cacheRead], [120, 7, 30])

  // the resting member goes last next time
  const req = await page()
  const state = await (await req('/api/control/state')).json() as any
  const busy = state.health.find((h: any) => h.member === 'busy/m1')
  assert.equal(busy.why, 'rate-limited')
  assert.ok(busy.restingUntil > Date.now())
  assert.deepEqual(state.recent.map((e: any) => e.phase), ['trying', 'failed', 'trying', 'answering', 'done'])
  await gw('/v1/messages', { model: 'group/daily', messages: [] })
  assert.equal(good.seen.length, 2)
  assert.equal(limited.seen.length, 1)
  void app
})

test('a malformed request is passed back, not retried elsewhere', async () => {
  const bad = await upstream(status(400))
  const other = await upstream(anthropicStream)
  const { control, gw } = makeApp()
  control.saveProvider(provider('a', { anthropic: bad.url }))
  control.saveProvider(provider('b', { anthropic: other.url }))
  control.saveGroup({ id: 'g', name: 'G', mode: 'order', members: ['a/m1', 'b/m1'], on: true, at: 1 })
  const res = await gw('/v1/messages', { model: 'group/g', messages: [] })
  assert.equal(res.status, 400)
  assert.equal(other.seen.length, 0)
})

test('members that cannot speak the protocol are left out, and the agent is told why', async () => {
  const { control, gw } = makeApp()
  control.saveProvider(provider('chatonly', { chat: 'http://127.0.0.1:9' }))
  control.saveGroup({ id: 'g', name: 'G', mode: 'order', members: ['chatonly/m1'], on: true, at: 1 })
  const res = await gw('/v1/messages', { model: 'group/g', messages: [] })
  assert.equal(res.status, 404)
  const body = await res.json() as any
  assert.equal(body.type, 'error') // in the Anthropic shape, since that is what was asked
  assert.match(body.error.message, /speaks this protocol \(anthropic\)/)
})

test('a model the gateway does not know is served by the asking agent\'s binding', async () => {
  const good = await upstream((_r, body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'x', model: body.model, usage: { prompt_tokens: 3, completion_tokens: 1 } })) })
  const { control, gw } = makeApp()
  control.saveProvider(provider('p', { chat: good.url + '/v1' }, ['real']))
  control.bind('opencode', 'p/real')
  const res = await gw('/v1/chat/completions', { model: 'some-helper-model', messages: [] }, { 'x-api-key': '', authorization: `Bearer ${control.gatewayKey()}.opencode` })
  assert.equal(res.status, 200)
  await res.text() // usage is recorded once the reply has been read through
  assert.equal(good.seen[0]!.path, '/v1/chat/completions')
  assert.equal(good.seen[0]!.body.model, 'real')
  assert.equal(good.seen[0]!.headers.authorization, 'Bearer sk-test-p')
  assert.equal(control.usage()[0]!.input, 3)
})

test('the gateway refuses a wrong key and a page on another site', async () => {
  const { gw } = makeApp()
  assert.equal((await gw('/v1/messages', { model: 'x' }, { 'x-api-key': 'nope' })).status, 401)
  assert.equal((await gw('/v1/messages', { model: 'x' }, { origin: 'https://evil.example' })).status, 403)
})

test('the page adds a provider: the model list is read from it, and the key never comes back', async () => {
  const listing = await upstream((_r, _b, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'alpha', context_length: 8000 }, { id: 'beta' }] })) })
  const { page } = makeApp()
  const req = await page()
  const r = await req('/api/control/providers', { method: 'POST', body: JSON.stringify({ preset: 'custom-openai', name: 'My Relay', key: 'sk-secret-123456789', endpoints: { chat: listing.url + '/v1' } }) })
  const { provider: p } = await r.json() as any
  assert.equal(p.id, 'my-relay')
  assert.deepEqual(p.models.map((m: any) => m.id), ['alpha', 'beta'])
  assert.equal(listing.seen[0]!.headers.authorization, 'Bearer sk-secret-123456789')
  const state = await (await req('/api/control/state')).text()
  assert.ok(!state.includes('sk-secret-123456789'))
  // a group with a model that does not exist is refused; binding to a group works
  assert.equal((await req('/api/control/groups', { method: 'POST', body: JSON.stringify({ name: 'Bad', members: ['nobody/x'] }) })).status, 404)
  const g = await (await req('/api/control/groups', { method: 'POST', body: JSON.stringify({ name: 'Daily coding', members: ['my-relay/alpha'] }) })).json() as any
  assert.equal(g.id, 'daily-coding')
  const bound = await (await req('/api/control/bindings', { method: 'POST', body: JSON.stringify({ agent: 'opencode', target: 'group/daily-coding' }) })).json() as any
  const oc = bound.agents.find((a: any) => a.agent === 'opencode')
  assert.equal(oc.target, 'group/daily-coding')
  assert.equal(oc.reachable, 1)
  // writing needs the page's token
  const { app } = makeApp()
  assert.equal((await app.request('/api/control/gateway/key', { method: 'POST', headers: { host: 'localhost' } })).status, 403)
})

test('refreshing keeps what the user switched off and what they added by hand', () => {
  const merged = mergeModels([{ id: 'a', on: true }, { id: 'b', on: true }], [{ id: 'a', on: false }, { id: 'gone', on: true }, { id: 'mine', on: true, manual: true }])
  assert.deepEqual(merged.map((m) => [m.id, m.on]), [['a', false], ['b', true], ['mine', true]])
})

test('what each agent runs on by itself is read from its own configuration', () => {
  fs.mkdirSync(path.join(tmp, 'claude'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://relay.example' } }))
  const claude = agentModelState('claude-code')
  assert.deepEqual([claude.model, claude.via, claude.conflict], ['opus', 'custom', 'env.ANTHROPIC_BASE_URL'])

  fs.mkdirSync(path.join(tmp, 'codex'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'codex', 'config.toml'), 'model_provider = "magpie"\nmodel = "deepseek/flash" # note\n\n[model_providers.magpie]\nbase_url = "http://127.0.0.1:3425/v1"\n')
  const codex = agentModelState('codex')
  assert.deepEqual([codex.model, codex.provider, codex.via], ['deepseek/flash', 'magpie', 'magpie'])

  fs.mkdirSync(path.join(tmp, 'config', 'opencode'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'config', 'opencode', 'opencode.jsonc'), '{\n  // mine\n  "model": "x/y", /* inline */\n  "provider": { "x": { "options": { "baseURL": "http://127.0.0.1:4999/gateway/v1" } } },\n}')
  const oc = agentModelState('opencode', undefined, 'http://127.0.0.1:4999/gateway')
  assert.deepEqual([oc.model, oc.via], ['x/y', 'sessionary'])

  assert.equal(agentModelState('pi').via, 'default')
  assert.deepEqual(JSON.parse(stripJsonc('{"a": "// not, }", /* c */ "b": [1, 2,],\n // x\n}')), { a: '// not, }', b: [1, 2] })
  assert.equal(tomlTables('a = 1\n[t.u]\nb = "c"').get('t.u')!.b, 'c')
})

test('a binding reaches an agent only through how Sessionary starts it', () => {
  const claude = launchProfile('claude-code', 'group/daily', 'http://127.0.0.1:4777/gateway', 'k')!
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4777/gateway')
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'k.claude-code')
  assert.deepEqual(claude.args, ['--model', 'group/daily'])
  const codex = launchProfile('codex', 'p/m', 'http://127.0.0.1:4777/gateway', 'k')!
  assert.ok(codex.args.includes('model_providers.sessionary.base_url="http://127.0.0.1:4777/gateway/v1"'))
  assert.equal(codex.env.SESSIONARY_GATEWAY_KEY, 'k.codex')
  const oc = JSON.parse(launchProfile('opencode', 'p/m', 'http://g', 'k')!.env.OPENCODE_CONFIG_CONTENT!)
  assert.equal(oc.model, 'sessionary/p/m')
  assert.equal(launchProfile('pi', 'p/m', 'http://g', 'k'), undefined)
})
