import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// Routing belongs to the machine an agent runs on. These run the real server, a real gateway port, a fake ssh that
// runs the command "on the node" (a home of its own, -R honoured) and fake agents that call the gateway with
// whatever model they were started on, so what reaches the provider is what each machine chose.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-routing-'))
for (const [k, d] of [['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex'], ['PI_CODING_AGENT_DIR', 'pi'], ['HERMES_HOME', 'hermes'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'xdg'], ['SESSIONARY_HOME', 'home']] as const) process.env[k] = path.join(tmp, d)
const nodeHome = path.join(tmp, 'node-home')
const log = path.join(tmp, 'agents.log')
fs.mkdirSync(path.join(nodeHome, 'bin'), { recursive: true })
fs.writeFileSync(path.join(nodeHome, '.profile'), `export PATH="${nodeHome}/bin:$PATH"\n`)

// ssh: options skipped, -R served by a forwarder on this machine, the command run by sh in the node's home
const fakeSsh = path.join(tmp, 'ssh')
fs.writeFileSync(fakeSsh, `#!${process.execPath}
const net = require('net'), { spawn } = require('child_process')
const a = process.argv.slice(2); let i = 0; const fwd = []
while (i < a.length && a[i] !== '--') { if (a[i] === '-R') { const m = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(a[i + 1]); fwd.push([+m[1], +m[2]]) } i += ['-o', '-p', '-i', '-R', '-L', '-F', '-l'].includes(a[i]) ? 2 : 1 }
const cmd = a.slice(i + 2).join(' ')
const servers = fwd.map(([r, l]) => net.createServer((s) => { const t = net.connect(l, '127.0.0.1'); s.pipe(t); t.pipe(s); s.on('error', () => t.destroy()); t.on('error', () => s.destroy()) }).listen(r, '127.0.0.1'))
const p = spawn('sh', ['-c', cmd], { cwd: ${JSON.stringify(nodeHome)}, env: { ...process.env, HOME: ${JSON.stringify(nodeHome)}, SHELL: '/bin/sh', ON_NODE: '1' }, stdio: 'inherit' })
p.on('exit', (c) => { for (const s of servers) s.close(); process.exit(c ?? 1) })
process.on('SIGTERM', () => p.kill('SIGTERM'))
`, { mode: 0o755 })
process.env.SESSIONARY_SSH_BIN = fakeSsh

/** what an agent writes down: where it ran, what it was started with, which key and model it used */
const agentLib = `
const fs = require('fs')
const note = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ where: process.env.ON_NODE ? 'node' : 'local', ...o }) + '\\n')
const call = (base, key, model) => fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) }).then((r) => r.status, (e) => String(e))
`
// Pi's rpc mode: the extension it is given must exist where it runs; on a prompt it calls the provider the extension names
const fakePi = `#!${process.execPath}
${agentLib}
const args = process.argv.slice(2), ext = args[args.indexOf('-e') + 1], model = args[args.indexOf('--model') + 1]
note({ agent: 'pi', args, ext: ext && fs.existsSync(ext) ? fs.readFileSync(ext, 'utf8').includes("registerProvider('sessionary'") : false, hasKey: !!process.env.SESSIONARY_GATEWAY_KEY, keyInArgs: args.some((x) => x.includes('sk-')) })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
require('readline').createInterface({ input: process.stdin }).on('line', async (l) => {
  const o = JSON.parse(l)
  if (o.type === 'get_state') return out({ type: 'response', id: o.id, success: true, data: { sessionId: 'p1', model: { provider: model.slice(0, model.indexOf('/')), id: model.slice(model.indexOf('/') + 1) } } })
  if (o.type === 'prompt') {
    out({ type: 'response', id: o.id, success: true })
    out({ type: 'agent_start' })
    note({ agent: 'pi', status: await call(process.env.SESSIONARY_GATEWAY_URL, process.env.SESSIONARY_GATEWAY_KEY, process.env.SESSIONARY_MODEL) })
    return out({ type: 'agent_settled' })
  }
  out({ type: 'response', id: o.id, success: true, data: {} })
})
`
// Hermes over ACP: its own models only (it keeps its configured endpoint); a prompt is answered on the session's model
const fakeHermes = `#!${process.execPath}
${agentLib}
let model = 'custom:its-own'
note({ agent: 'hermes', base: process.env.CUSTOM_BASE_URL ?? null, hasKey: !!process.env.OPENAI_API_KEY })
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n')
const models = { currentModelId: model, availableModels: ['custom:its-own', 'custom:relay:deep-flash', 'openrouter:big'].map((modelId) => ({ modelId, name: modelId })) }
require('readline').createInterface({ input: process.stdin }).on('line', async (l) => {
  const o = JSON.parse(l)
  if (o.id === undefined) return
  if (o.method === 'initialize') return out({ id: o.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  if (o.method === 'session/new') return out({ id: o.id, result: { sessionId: 'h1', models } })
  if (o.method === 'session/set_model') {
    if (!models.availableModels.some((m) => m.modelId === o.params.modelId)) return out({ id: o.id, error: { code: -32602, message: 'unknown model' } })
    model = o.params.modelId; note({ agent: 'hermes', switched: model }); return out({ id: o.id, result: {} })
  }
  if (o.method === 'session/prompt') { note({ agent: 'hermes', status: 200, answeredOn: model }); return out({ id: o.id, result: { stopReason: 'end_turn' } }) }
  out({ id: o.id, result: {} })
})
`
for (const [name, src] of [['pi', fakePi], ['hermes', fakeHermes]] as const) {
  fs.writeFileSync(path.join(nodeHome, 'bin', name), src, { mode: 0o755 })
  fs.writeFileSync(path.join(tmp, name), src, { mode: 0o755 })
}
process.env.SESSIONARY_PI_BIN = path.join(tmp, 'pi')
process.env.SESSIONARY_HERMES_BIN = path.join(tmp, 'hermes')

const { getRequestListener } = await import('@hono/node-server')
const { ControlStore } = await import('../src/core/control/store.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')

// one provider that answers every request and remembers the model and who it was for
const seen: { model: string }[] = []
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const b = JSON.parse(raw || '{}')
    seen.push({ model: b.model })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'x', model: b.model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } }))
  })
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`

// the app on a real port: agents started here reach its gateway over HTTP
let listener: http.RequestListener = () => {}
const server = http.createServer((q, s) => listener(q, s))
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const control = new ControlStore(':memory:')
control.saveProvider({ id: 'p', name: 'P', preset: 'custom-openai', endpoints: { chat: upstreamUrl }, key: 'sk-upstream', models: [{ id: 'model-a', on: true }, { id: 'model-b', on: true }], on: true, at: 1 })
const { app, stopRuns } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'), { control, port })
listener = getRequestListener(app.fetch)
after(async () => { await stopRuns?.(); server.closeAllConnections(); server.close(); upstream.close() })

const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
const json = async (url: string, init?: RequestInit) => (await req(url, init)).json() as Promise<any>
const post = (url: string, body: unknown) => json(url, { method: 'POST', body: JSON.stringify(body) })
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)) }
  assert.fail(`timed out waiting for ${what}`)
}
const notes = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const routes = () => control.routes()

// two ssh nodes besides this computer
const shanghai = (await post('/api/nodes', { name: 'shanghai', kind: 'ssh', host: 'shanghai.example' })).id as string
const sfo = (await post('/api/nodes', { name: 'sfo', kind: 'ssh', host: 'sfo.example' })).id as string

/** a chat with one message, until the agent has made its call */
async function talk(machine: string, agent: string, o: { model?: string; switchTo?: string } = {}) {
  const before = notes().filter((n) => n.status !== undefined).length
  const c = await post('/api/chats', { machine, agent, cwd: '/tmp', ...(o.model && { model: o.model }) })
  assert.ok(c.id, JSON.stringify(c))
  await until(`${agent} on ${machine} to start`, async () => (await json(`/api/chats/${c.id}`)).state === 'idle')
  if (o.switchTo) assert.deepEqual(await post(`/api/chats/${c.id}/model`, { model: o.switchTo }), { ok: true })
  await post(`/api/chats/${c.id}/send`, { text: 'hi' })
  await until(`${agent} on ${machine} to call`, () => notes().filter((n) => n.status !== undefined).length > before)
  await req(`/api/chats/${c.id}`, { method: 'DELETE' })
  return notes().filter((n) => n.status !== undefined).at(-1)
}

test('scopes inherit session > project > agent > machine > default, and never across machines', () => {
  const s = new ControlStore(':memory:')
  s.setRoute({ machine: '' }, 'p/default')
  s.setRoute({ machine: 'shanghai' }, 'p/node')
  s.setRoute({ machine: 'shanghai', agent: 'pi' }, 'p/agent')
  s.setRoute({ machine: 'shanghai', agent: 'pi', project: '/srv/app' }, 'p/project')
  s.setRoute({ machine: 'shanghai', agent: 'pi', session: 'pi:s1' }, 'p/session')
  const at = (m: string, a: string, o = {}) => { const r = s.resolve(m, a, o); return r && `${r.level}:${r.target}` }
  assert.equal(at('shanghai', 'pi', { project: '/srv/app', session: 'pi:s1' }), 'session:p/session')
  assert.equal(at('shanghai', 'pi', { project: '/srv/app', session: 'pi:other' }), 'project:p/project')
  assert.equal(at('shanghai', 'pi', { project: '/srv/else' }), 'agent:p/agent')
  assert.equal(at('shanghai', 'hermes'), 'machine:p/node')
  // nothing chosen for shanghai reaches another machine
  assert.equal(at('local', 'pi', { project: '/srv/app', session: 'pi:s1' }), 'default:p/default')
  assert.equal(at('sfo', 'pi'), 'default:p/default')
  // a level whose target cannot serve the agent is passed over
  assert.equal(s.resolve('shanghai', 'pi', {}, (t) => t !== 'p/agent')?.target, 'p/node')
  // a removed machine takes its routes with it
  s.dropMachine('shanghai')
  assert.equal(at('shanghai', 'pi', { session: 'pi:s1' }), 'default:p/default')
})

test('bindings from before become this computer\'s routes, not every machine\'s', async () => {
  const { DatabaseSync } = await import('../src/core/sqlite.ts')
  const file = path.join(tmp, 'old-control.db')
  const db = new DatabaseSync(file)
  db.exec(`create table bindings (agent text primary key, target text not null, at integer not null);
    create table usage (at integer not null, agent text not null, target text not null, provider text not null, model text not null, protocol text not null, status integer not null, ms integer not null, input integer not null default 0, output integer not null default 0, cache_read integer not null default 0, error text, tries integer not null default 1);
    insert into bindings values ('pi', 'p/model-a', 5);
    insert into usage (at, agent, target, provider, model, protocol, status, ms) values (1, 'pi', 'p/model-a', 'p', 'model-a', 'chat', 200, 1);`)
  db.close()
  const s = new ControlStore(file)
  assert.deepEqual(s.routes().map((r) => [r.machine, r.agent, r.target]), [['local', 'pi', 'p/model-a']])
  assert.equal(s.resolve('shanghai', 'pi'), undefined)
  assert.equal(s.usage()[0]!.machine, 'local')
  s.close()
  // opening it again changes nothing
  const again = new ControlStore(file)
  assert.equal(again.routes().length, 1)
  again.close()
})

test('localhost/Pi uses model A while shanghai/Pi uses model B, each through the gateway, Pi\'s own files untouched', async () => {
  await post('/api/control/routes', { machine: 'local', agent: 'pi', target: 'p/model-a' })
  await post('/api/control/routes', { machine: shanghai, agent: 'pi', target: 'p/model-b' })

  const here = (await json('/api/control/agents?machine=local')).find((a: any) => a.agent === 'pi')
  const there = (await json(`/api/control/agents?machine=${shanghai}`)).find((a: any) => a.agent === 'pi')
  assert.deepEqual([here.target, here.level], ['p/model-a', 'agent'])
  assert.deepEqual([there.target, there.level], ['p/model-b', 'agent'])

  seen.length = 0
  const l = await talk('local', 'pi')
  assert.equal(l.status, 200)
  const n = await talk(shanghai, 'pi')
  assert.equal(n.status, 200)
  assert.deepEqual(seen.map((x) => x.model), ['model-a', 'model-b'])

  const started = notes().filter((x) => x.agent === 'pi' && x.args)
  const local = started.find((x) => x.where === 'local')!, node = started.find((x) => x.where === 'node')!
  assert.ok(local.args.includes('sessionary/p/model-a') && node.args.includes('sessionary/p/model-b'))
  // the extension was where Pi ran (written on the node by the command that started it), the key never an argument
  assert.equal(local.ext, true); assert.equal(node.ext, true)
  assert.ok(local.hasKey && node.hasKey && !local.keyInArgs && !node.keyInArgs)
  assert.ok(fs.existsSync(path.join(nodeHome, '.cache', 'sessionary', 'launch', 'pi-sessionary.mjs')))
  assert.ok(!fs.existsSync(path.join(nodeHome, '.pi')))
})

test('changing one node\'s route does not modify another node or this computer', async () => {
  await post('/api/control/routes', { machine: sfo, agent: 'pi', target: 'p/model-a' })
  const snapshot = (m: string) => JSON.stringify(routes().filter((r) => r.machine === m))
  const before = { local: snapshot('local'), sfo: snapshot(sfo) }
  const agentsBefore = { local: await json('/api/control/agents?machine=local'), sfo: await json(`/api/control/agents?machine=${sfo}`) }

  // shanghai: Pi moves, then the whole node gets a route, then Pi's own is removed (it inherits the node's)
  await post('/api/control/routes', { machine: shanghai, agent: 'pi', target: 'p/model-a' })
  await post('/api/control/routes', { machine: shanghai, target: 'p/model-b' })
  await post('/api/control/routes', { machine: shanghai, agent: 'pi', target: '' })
  const pi = (await json(`/api/control/agents?machine=${shanghai}`)).find((a: any) => a.agent === 'pi')
  assert.deepEqual([pi.target, pi.level], ['p/model-b', 'machine'])

  assert.equal(snapshot('local'), before.local)
  assert.equal(snapshot(sfo), before.sfo)
  assert.deepEqual(await json('/api/control/agents?machine=local'), agentsBefore.local)
  assert.deepEqual(await json(`/api/control/agents?machine=${sfo}`), agentsBefore.sfo)

  // a project or session route needs its machine and agent; an unknown machine is refused
  assert.equal((await req('/api/control/routes', { method: 'POST', body: JSON.stringify({ machine: shanghai, project: '/srv', target: 'p/model-a' }) })).status, 400)
  assert.equal((await req('/api/control/routes', { method: 'POST', body: JSON.stringify({ machine: 'nowhere', agent: 'pi', target: 'p/model-a' }) })).status, 404)
  await post('/api/control/routes', { machine: shanghai, target: '' })
})

test('gateway usage is recorded as the node\'s where the request came from', async () => {
  const mine = control.usage().filter((u) => u.agent === 'pi')
  assert.deepEqual(mine.map((u) => [u.machine, u.model]).sort(), [['local', 'model-a'], [shanghai, 'model-b']].sort())
  const days = await json('/api/control/usage/days')
  assert.deepEqual(days.filter((d: any) => d.agent === 'pi').map((d: any) => [d.machine, d.model]).sort(), [['local', 'p/model-a'], [shanghai, 'p/model-b']].sort())
})

test('remote Hermes receives the selected model for its session and answers on it; a route never reaches it', async () => {
  // a route for Hermes on shanghai is kept, but Hermes is not started with it (its own endpoint would win)
  await post('/api/control/routes', { machine: shanghai, agent: 'hermes', target: 'p/model-b' })
  const h = (await json(`/api/control/agents?machine=${shanghai}`)).find((a: any) => a.agent === 'hermes')
  assert.equal(h.launch, 'manual')

  // chosen with the session: applied on the node before anything is said
  const first = await talk(shanghai, 'hermes', { model: 'custom:relay:deep-flash' })
  assert.deepEqual([first.where, first.answeredOn], ['node', 'custom:relay:deep-flash'])
  // chosen mid-chat: the next answer is on it
  const second = await talk(shanghai, 'hermes', { switchTo: 'openrouter:big' })
  assert.deepEqual([second.where, second.answeredOn], ['node', 'openrouter:big'])
  const started = notes().filter((x) => x.agent === 'hermes' && 'base' in x)
  assert.ok(started.length >= 2 && started.every((x) => x.base === null && !x.hasKey))
  // nothing of Hermes's own was written on the node
  assert.ok(!fs.existsSync(path.join(nodeHome, '.hermes')))
  await post('/api/control/routes', { machine: shanghai, agent: 'hermes', target: '' })
})

test('a chat that cannot be switched to the model it was opened with does not start on another one', async () => {
  const c = await post('/api/chats', { machine: shanghai, agent: 'hermes', cwd: '/tmp', model: 'custom:not-offered' })
  await until('the chat to end', async () => (await json(`/api/chats/${c.id}`)).state === 'closed')
  const ch = await json(`/api/chats/${c.id}`)
  assert.match(ch.error ?? '', /could not switch this session to custom:not-offered: unknown model/)
})

test('history usage is each machine\'s own; the Master adds it up, every row marked with its machine', async () => {
  const r = await json('/api/usage/machines')
  assert.ok(Array.isArray(r.rows))
  // shanghai came online for its chats and answers for itself; sfo never connected and is not woken for this
  const states = Object.fromEntries((await json('/api/machines')).map((m: any) => [m.id, m.state]))
  assert.equal(states[shanghai], 'online')
  assert.notEqual(states[sfo], 'online')
  assert.deepEqual(r.missing, [sfo])
  assert.ok(r.rows.every((x: any) => x.machine === 'local' || x.machine === shanghai))
})
