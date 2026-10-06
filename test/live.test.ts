import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-live-'))
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
process.env.CODEX_HOME = path.join(tmp, 'codex-none')
process.env.WORKBUDDY_HOME = path.join(tmp, 'workbuddy-none')
process.env.WORKBUDDY_AI_HOME = path.join(tmp, 'workbuddy-ai-none')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi')
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg')
process.env.SESSIONARY_CLAUDE_BIN = 'claude'

const { adapters } = await import('../src/adapters/index.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { scan } = await import('../src/core/scanner.ts')
const { watchSources } = await import('../src/core/watcher.ts')
const { createApp } = await import('../src/server/app.ts')
const { commandLine, inside } = await import('../src/core/launch.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const proj = path.join(tmp, 'work')
fs.mkdirSync(proj, { recursive: true })
const dir = path.join(tmp, 'claude', 'projects', '-work')
fs.mkdirSync(dir, { recursive: true })
const write = (id: string, text: string) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), jl(
  { type: 'user', uuid: `${id}-u`, sessionId: id, cwd: proj, timestamp: new Date().toISOString(), message: { role: 'user', content: text } },
  { type: 'assistant', uuid: `${id}-a`, timestamp: new Date().toISOString(), message: { id: `${id}-m`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
))

test('scans report which sessions changed, including removals', async () => {
  const store = new IndexStore(':memory:')
  write('s1', 'first')
  write('s2', 'second')
  const [first] = await scan(adapters, store)
  assert.deepEqual(first!.changed.sort(), ['claude-code:s1', 'claude-code:s2'])
  const [quiet] = await scan(adapters, store)
  assert.deepEqual(quiet!.changed, [])
  await new Promise((r) => setTimeout(r, 15)) // mtime must move
  write('s1', 'first, edited')
  fs.rmSync(path.join(dir, 's2.jsonl'))
  const [next] = await scan(adapters, store)
  assert.deepEqual(next!.changed.sort(), ['claude-code:s1', 'claude-code:s2'])
  assert.equal(store.get('claude-code:s2'), null)
})

test('the watcher turns agent writes into one debounced change', async () => {
  let calls = 0
  const w = watchSources(adapters, () => { calls++ }, 150)
  assert.equal(w.state.mode, 'events')
  assert.ok(w.state.watched.some((p) => p.startsWith(path.join(tmp, 'claude'))))
  write('s3', 'a')
  write('s3', 'b')
  fs.appendFileSync(path.join(dir, 's3.jsonl'), '\n')
  await new Promise((r) => setTimeout(r, 600))
  w.close()
  assert.equal(calls, 1)
})

async function client() {
  const store = new IndexStore(':memory:')
  const { app, rescan } = createApp(store, undefined, new OverlayStore(':memory:'))
  await rescan()
  const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
  const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  return { app, rescan, req, json: async (url: string, init?: RequestInit) => (await req(url, init)).json() as Promise<any> }
}

test('pins and the active flag come back with the session list', async () => {
  write('s4', 'pin me')
  const { json } = await client()
  assert.deepEqual(await json('/api/sessions/claude-code:s4/pin', { method: 'POST' }), { ok: true })
  const list = await json('/api/sessions') as any[]
  const s = list.find((x) => x.id === 'claude-code:s4')
  assert.equal(s.pinned, true)
  assert.equal(s.active, true) // written a moment ago
  await json('/api/sessions/claude-code:s4/unpin', { method: 'POST' })
  assert.equal((await json('/api/sessions') as any[]).find((x) => x.id === 'claude-code:s4').pinned, undefined)
})

test('resume uses the agent’s interactive command in the session directory', async () => {
  write('s5', 'resume me')
  const { json, req } = await client()
  const cmd = await json('/api/sessions/claude-code:s5/resume-command')
  assert.equal(cmd.bin, 'claude')
  assert.deepEqual(cmd.args, ['--resume', 's5'])
  assert.equal(cmd.cwd, proj)
  assert.equal(cmd.line, commandLine(cmd))
  assert.match(cmd.line, /&& claude --resume s5$/)
  // nothing outside the session's directory can be opened, and unknown targets are refused
  assert.equal((await req('/api/sessions/claude-code:s5/open', { method: 'POST', body: JSON.stringify({ target: 'file', path: '../../etc/passwd' }) })).status, 400)
  assert.equal((await req('/api/sessions/claude-code:s5/open', { method: 'POST', body: JSON.stringify({ target: 'nope' }) })).status, 400)
  // state-changing calls need the token
  assert.equal((await req('/api/sessions/claude-code:s5/open', { method: 'POST', headers: { 'x-sessionary-token': 'x' }, body: '{"target":"folder"}' })).status, 403)
  assert.equal(inside(proj, '.'), fs.realpathSync(proj))
  assert.equal(inside(proj, '..'), null)
})

test('open pages are told when the index changes', async () => {
  const { app, rescan } = await client()
  const res = await app.request('/api/events', { headers: { host: 'localhost' } })
  const reader = res.body!.getReader()
  const seen: string[] = []
  const pump = (async () => {
    const dec = new TextDecoder()
    for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); if (seen.join('').includes('event: index')) break }
  })()
  await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 15))
  write('s6', 'new one')
  await rescan()
  await Promise.race([pump, new Promise((r) => setTimeout(r, 2000))])
  await reader.cancel()
  const text = seen.join('')
  assert.match(text, /event: index/)
  assert.match(text, /claude-code:s6/)
})

test('agents report where they look and whether anything is there', async () => {
  const { json } = await client()
  const agents = await json('/api/agents') as any[]
  const pi = agents.find((a) => a.id === 'pi')
  assert.equal(pi.available, false)
  assert.equal(pi.storage, path.join(tmp, 'pi', 'sessions'))
  assert.equal(agents.find((a) => a.id === 'claude-code').available, true)
})

test('unknown API routes answer 404 JSON, never the page', async () => {
  const store = new IndexStore(':memory:')
  const web = fs.mkdtempSync(path.join(tmp, 'web-'))
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html>')
  const { app } = createApp(store, web, new OverlayStore(':memory:'))
  const r = await app.request('/api/does-not-exist', { headers: { host: 'localhost' } })
  assert.equal(r.status, 404)
  assert.match(r.headers.get('content-type') ?? '', /json/)
  assert.equal((await app.request('/s/anything', { headers: { host: 'localhost' } })).headers.get('content-type'), 'text/html; charset=utf-8')
})
