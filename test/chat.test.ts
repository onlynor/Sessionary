import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Chats, localSpawner } from '../src/core/chat/manager.ts'
import { textDiff } from '../src/core/chat/lines.ts'
import type { StoredEvent } from '../src/core/chat/types.ts'

/** a stand-in for `claude -p --input-format stream-json`: answers initialize, then a Write asks permission first */
function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let waiting = null
rl.on('line', (l) => {
  const o = JSON.parse(l)
  if (o.type === 'control_request' && o.request.subtype === 'initialize') return out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { commands: [{ name: 'compact' }], models: [{ value: 'default', displayName: 'Default' }, { value: 'haiku', displayName: 'Haiku' }], current_permission_mode: 'default' } } })
  if (o.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } })
  if (o.type === 'control_response') { if (waiting) { const ok = o.response.response.behavior === 'allow'; reply(ok); waiting = null } return }
  if (o.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'x', permissionMode: 'default' })
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } } })
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    if (o.message.content[0].text.includes('write')) { waiting = true; out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x', content: 'hi' }, tool_use_id: 't1' } }) }
    else out({ type: 'result', is_error: false, total_cost_usd: 0.01, usage: {} })
  }
})
function reply(ok) { out({ type: 'result', is_error: !ok, result: ok ? undefined : 'denied', usage: {} }) }
`)
  chmodSync(bin, 0o755)
  return bin
}

const collect = (chats: Chats, id: string) => {
  const got: StoredEvent[] = []
  chats.subscribe(id, 0, (e) => got.push(e))
  return got
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), 'timed out') }

test('a chat streams, asks for approval, and continues in the same process', async () => {
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => fakeClaude() })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  await until(() => chats.get(ch.id)!.state === 'idle')
  const info = chats.get(ch.id)!.info
  assert.deepEqual(info.models?.map((m) => m.id), ['default', 'haiku'])
  assert.equal(info.commands?.[0]?.name, 'compact')
  const got = collect(chats, ch.id)

  await chats.send(ch.id, { text: 'hello' })
  await until(() => chats.get(ch.id)!.state === 'idle' && got.some((e) => e.t === 'turn' && e.state === 'end'))
  const text = got.find((e) => e.t === 'text.end')
  assert.equal(text && text.t === 'text.end' && text.text, 'hello')
  assert.equal(chats.forSession('local', 'claude-code', 'claude-code:sess-1')?.id, ch.id, 'found by the id the agent reported')

  await chats.send(ch.id, { text: 'please write a file' })
  await until(() => chats.get(ch.id)!.state === 'waiting')
  const ap = got.find((e) => e.t === 'approval')
  assert.ok(ap && ap.t === 'approval' && ap.diff?.includes('+hi'))
  await chats.respond(ch.id, ap.id, 'allow')
  await until(() => chats.get(ch.id)!.state === 'idle')
  assert.ok(got.some((e) => e.t === 'approval.done' && e.outcome === 'allow'))
  await chats.stopAll()
})

test('a late reader catches up from the compacted log', async () => {
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => fakeClaude() })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  await chats.send(ch.id, { text: 'hello' })
  await until(() => chats.get(ch.id)!.state === 'idle' && chats.get(ch.id)!.lastSeq > 8)
  const late = collect(chats, ch.id)
  assert.equal(late.filter((e) => e.t === 'text').length, 0, 'deltas are replaced by the finished text')
  assert.equal(late.filter((e) => e.t === 'text.end').length, 1)
  assert.equal(late.filter((e) => e.t === 'user').length, 1)
  await chats.stopAll()
})

test('a process that is not there is reported, not hung', async () => {
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => '/nonexistent/claude' })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  const got = collect(chats, ch.id)
  await until(() => chats.get(ch.id)?.state === 'closed')
  assert.match(chats.get(ch.id)!.error ?? '', /not found|ENOENT|did not start/i)
  assert.ok(got.some((e) => e.t === 'note' && e.level === 'error'), 'the reason is in the chat itself')
  await assert.rejects(chats.send(ch.id, { text: 'hi' }), /not found|ENOENT|did not start|ended/i)
  await chats.stopAll()
})

test('textDiff shows only what changed, with context', () => {
  assert.equal(textDiff('f', '', 'a'), '@@ f\n+a')
  const d = textDiff('f', 'a\nb\nc', 'a\nB\nc')
  assert.ok(d.includes('-b') && d.includes('+B') && d.includes(' a'))
})

/** a chat whose launch hands out a door: how many times the door was released */
const withDoor = () => {
  let released = 0
  return { count: () => released, launchFor: async () => ({ env: {}, args: [], release: () => { released++ } }) }
}

test('a chat releases its door when it is closed', async () => {
  const door = withDoor()
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => fakeClaude(), launchFor: door.launchFor })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  await until(() => chats.get(ch.id)!.state === 'idle')
  assert.equal(door.count(), 0)
  await chats.close(ch.id)
  await until(() => door.count() >= 1)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(door.count(), 1, 'released once, however many ways the process reported its end')
})

test('a chat that cannot start releases its door', async () => {
  const door = withDoor()
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => '/nonexistent/claude', launchFor: door.launchFor })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  await until(() => chats.get(ch.id)?.state === 'closed' && door.count() >= 1)
  await chats.stopAll()
})

test('an agent that dies on its own releases its door', async () => {
  // answers the handshake, then exits on the first message as if it crashed
  const dir = mkdtempSync(join(tmpdir(), 'dying-claude-'))
  const bin = join(dir, 'claude')
  writeFileSync(bin, `#!/usr/bin/env node
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const o = JSON.parse(l)
  if (o.type === 'control_request') return process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }) + '\\n')
  if (o.type === 'user') process.exit(3)
})
`)
  chmodSync(bin, 0o755)
  const door = withDoor()
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => bin, launchFor: door.launchFor })
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() })
  await chats.send(ch.id, { text: 'hello' }).catch(() => {})
  await until(() => chats.get(ch.id)!.state === 'closed' && door.count() === 1)
  await chats.stopAll()
})

test('a node chat whose tunnel port was taken is opened once more on another port, then gives up', async () => {
  let launches = 0, released = 0, starts = 0
  const failTimes = (n: number) => new Chats({
    spawnFor: () => localSpawner,
    launchFor: async () => { launches++; return { env: {}, args: [], tunnel: { remotePort: 20000 + launches, localPort: 1 }, release: () => { released++ } } },
    driverFor: () => ({ start: async () => { if (++starts <= n) throw new Error(`Claude Code did not start: Error: remote port forwarding failed for listen port ${20000 + starts}`) }, close: async () => {} }) as never,
  })
  const ok = failTimes(1)
  const ch = await ok.open({ agent: 'claude-code', machine: 'vps', cwd: '/tmp' })
  await until(() => ok.get(ch.id)!.state === 'idle')
  assert.deepEqual([launches, released], [2, 1], 'a fresh launch (port and door) for the second try; the first door closed')
  await ok.stopAll()

  launches = 0; released = 0; starts = 0
  const no = failTimes(2)
  const gone = await no.open({ agent: 'claude-code', machine: 'vps', cwd: '/tmp' })
  await until(() => no.get(gone.id)!.state === 'closed')
  assert.match(no.get(gone.id)!.error ?? '', /remote port forwarding failed/)
  assert.deepEqual([launches, released], [2, 2], 'tried twice, both doors closed')
  await no.stopAll()
})

// ---------- the lifecycle: open at once, start in the background, never twice ----------

/** a stand-in agent that takes `ms` to come up, counting how many were started */
function slowDriver(ms: number, counter: { started: number; sent: string[] }) {
  return (_req: unknown, emit: (e: any) => void) => ({
    async start() { counter.started++; await new Promise((r) => setTimeout(r, ms)); emit({ t: 'info', info: { models: [{ id: 'm', label: 'M' }] } }) },
    async send(m: { text: string }) { counter.sent.push(m.text); emit({ t: 'turn', state: 'start' }); emit({ t: 'text.end', id: 't', text: 'ok' }); emit({ t: 'turn', state: 'end', stop: 'done' }) },
    async close() {}, async interrupt() {}, async respond() {}, async answer() {}, async setModel() {}, async setMode() {}, async setEffort() {},
  }) as never
}

test('opening a chat returns at once; what is sent while the agent starts is shown, then delivered', async () => {
  const n = { started: 0, sent: [] as string[] }
  const chats = new Chats({ spawnFor: () => localSpawner, driverFor: slowDriver(400, n) })
  const t0 = Date.now()
  const ch = await chats.open({ agent: 'claude-code', machine: 'local', cwd: '/tmp', sessionKey: 'claude-code:s1', resume: 's1' })
  assert.ok(Date.now() - t0 < 100, 'open does not wait for the agent')
  assert.equal(ch.state, 'starting')
  const got = collect(chats, ch.id)
  const sending = chats.send(ch.id, { text: 'first' })
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(got.some((e) => e.t === 'user' && e.text === 'first'), 'the message shows before the agent is up')
  assert.deepEqual(n.sent, [], 'and reaches the agent only once it is up')
  await sending
  assert.deepEqual(n.sent, ['first'])
  await until(() => chats.get(ch.id)!.state === 'idle')
  await chats.stopAll()
})

test('two opens of one session (a prewarm and a click) share one agent', async () => {
  const n = { started: 0, sent: [] as string[] }
  const chats = new Chats({ spawnFor: () => localSpawner, driverFor: slowDriver(200, n) })
  const req = { agent: 'claude-code' as const, machine: 'local', cwd: '/tmp', sessionKey: 'claude-code:s1', resume: 's1' }
  const [a, b] = await Promise.all([chats.open(req, { warm: true }), chats.open(req)])
  assert.equal(a.id, b.id)
  await until(() => chats.get(a.id)!.state === 'idle')
  assert.equal(n.started, 1, 'one agent process')
  await chats.stopAll()
})

test('prewarmed chats nobody uses stay few; a chat someone looks at is never pushed out', async () => {
  const n = { started: 0, sent: [] as string[] }
  const chats = new Chats({ spawnFor: () => localSpawner, driverFor: slowDriver(10, n) })
  const open = (k: string, warm = true) => chats.open({ agent: 'claude-code', machine: 'local', cwd: '/tmp', sessionKey: `claude-code:${k}`, resume: k }, { warm })
  const viewed = await open('viewed')
  const off = chats.subscribe(viewed.id, 0, () => {}) // the page is open on it
  const w1 = await open('w1'), w2 = await open('w2'), w3 = await open('w3')
  await until(() => chats.get(w1.id)!.state === 'closed')
  const live = chats.list().filter((c) => c.state !== 'closed').map((c) => c.id).sort()
  assert.deepEqual(live, [viewed.id, w2.id, w3.id].sort(), 'the oldest unused prewarm went; the viewed one stayed')
  off?.()
  // a person opening a prewarmed chat makes it an ordinary one
  const again = await open('w3', false)
  assert.equal(again.id, w3.id)
  await chats.stopAll()
})

/** a stand-in for `codex app-server` that writes down what each request asked for */
function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
  const bin = join(dir, 'codex')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs')
const rl = require('readline').createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (l) => {
  const o = JSON.parse(l)
  if (o.id === undefined) return
  fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify({ method: o.method, params: o.params }) + '\\n')
  if (o.method === 'initialize') return out({ id: o.id, result: { userAgent: 'codex/0.1.0' } })
  if (o.method === 'model/list') return out({ id: o.id, result: { data: [] } })
  if (o.method === 'thread/resume' || o.method === 'thread/start') return out({ id: o.id, result: { thread: { id: o.params.threadId ?? 'th-new' }, model: o.params.model ?? 'its-own' } })
  out({ id: o.id, result: {} })
})
`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => { try { return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l: string) => JSON.parse(l)) } catch { return [] } } }
}

test('a routed Codex chat names the routing when it opens the thread (a resumed thread keeps its own provider otherwise)', async () => {
  const codex = fakeCodex()
  const launchFor = async () => ({ env: {}, args: ['-c', 'model_provider="sessionary"'], session: { provider: 'sessionary', model: 'group/fast' } })
  const chats = new Chats({ spawnFor: () => localSpawner, binFor: () => codex.bin, launchFor })
  try {
    const c = await chats.open({ agent: 'codex', machine: 'local', resume: 'th-old', sessionKey: 'codex:th-old' })
    await until(() => chats.get(c.id)?.state === 'idle')
    const resume = codex.calls().find((x: any) => x.method === 'thread/resume')
    assert.equal(resume.params.modelProvider, 'sessionary')
    assert.equal(resume.params.model, 'group/fast')
    assert.equal(chats.get(c.id)?.info.model, 'group/fast')

    // unrouted: nothing is forced on the thread
    const plain = fakeCodex()
    const free = new Chats({ spawnFor: () => localSpawner, binFor: () => plain.bin })
    const d = await free.open({ agent: 'codex', machine: 'local', resume: 'th-old', sessionKey: 'codex:th-old' })
    await until(() => free.get(d.id)?.state === 'idle')
    const r2 = plain.calls().find((x: any) => x.method === 'thread/resume')
    assert.equal(r2.params.modelProvider, undefined)
    assert.equal(r2.params.model, undefined)
    await free.stopAll()
  } finally { await chats.stopAll() }
})

