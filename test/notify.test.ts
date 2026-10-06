import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-notify-'))
for (const [k, v] of Object.entries({ CLAUDE_CONFIG_DIR: 'c', CODEX_HOME: 'x', WORKBUDDY_HOME: 'w', WORKBUDDY_AI_HOME: 'wa', PI_CODING_AGENT_DIR: 'p', XDG_DATA_HOME: 'xdg', HERMES_HOME: 'h', SESSIONARY_HOME: 'sessionary' })) process.env[k] = path.join(tmp, v)
process.env.SHELL = '/bin/sh'
// short thresholds, so the test does not have to wait for real ones
process.env.SESSIONARY_NOTIFY_QUIET_MS = '600'
process.env.SESSIONARY_NOTIFY_BURST_MS = '500'
process.env.SESSIONARY_NOTIFY_MIN_BYTES = '1000'
process.env.SESSIONARY_NOTIFY_DOWN_MS = '400'

// stand-in agents: `claude` works for a second and then waits for input; `codex` works and exits with an error
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
const burst = `i=0; while [ $i -lt 12 ]; do head -c 300 /dev/zero | tr '\\0' x; echo; sleep 0.1; i=$((i+1)); done`
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${burst}\nsleep 30\n`, { mode: 0o755 })
fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n${burst}\nexit 3\n`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`

const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')
const { Notifier, watchNodes } = await import('../src/core/notifier.ts')

async function controller() {
  const { app, stopRuns } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'))
  const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
  const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  const json = async (url: string, init?: RequestInit) => (await req(url, init)).json() as Promise<any>
  // what the page would hear
  const heard: any[] = []
  const res = await req(`/api/notifications?token=${token}`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const pump = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (r.done) return
      buf += dec.decode(r.value, { stream: true })
      for (const ev of buf.split('\n\n').slice(0, -1)) { const m = /event: notice\ndata: (.*)/.exec(ev); if (m) heard.push(JSON.parse(m[1]!)) }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
    }
  })()
  return { app, req, json, token, heard, stop: async () => { await reader.cancel().catch(() => {}); await pump; stopRuns() } }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (what: string, f: () => boolean, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return; await wait(50) } assert.fail(`timed out waiting for ${what}`) }

test('an agent in a terminal that worked and went quiet is announced once; a shell, and a terminal you stop, are not', async () => {
  if (process.platform === 'win32') return
  const c = await controller()
  try {
    assert.equal((await c.app.request('/api/notifications', { headers: { host: 'localhost' } })).status, 403) // events need the token
    // a shell that prints as much is not an agent
    const sh = await c.json('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: 'local', kind: 'shell', cwd: tmp }) })
    await c.json(`/api/terminals/${sh.id}/input`, { method: 'POST', body: JSON.stringify({ data: `${burst}\n` }) })

    const t = await c.json('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: 'local', kind: 'new', agent: 'claude-code', cwd: tmp }) })
    await until('the idle notice', () => c.heard.some((n) => n.code === 'agent.idle'))
    const n = c.heard.find((x) => x.code === 'agent.idle')
    assert.deepEqual([n.type, n.machine, n.params.agent, n.params.term, n.params.machineName], ['agent', 'local', 'Claude Code', t.id, 'Localhost'])
    await wait(2000) // it stays quiet: still one
    assert.equal(c.heard.filter((x) => x.code === 'agent.idle').length, 1)
    assert.ok(!c.heard.some((x) => x.params.term === sh.id))

    // stopping it yourself is not news
    await c.json(`/api/terminals/${t.id}/kill`, { method: 'POST' })
    await wait(800)
    assert.ok(!c.heard.some((x) => x.code === 'agent.exit'))
  } finally { await c.stop() }
})

test('an agent that ends on its own, with its exit code, is announced', async () => {
  if (process.platform === 'win32') return
  const c = await controller()
  try {
    await c.json('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: 'local', kind: 'new', agent: 'codex', cwd: tmp }) })
    await until('the exit notice', () => c.heard.some((n) => n.code === 'agent.exit'))
    const n = c.heard.find((x) => x.code === 'agent.exit')
    assert.deepEqual([n.params.agent, n.params.exit], ['Codex', 3])
  } finally { await c.stop() }
})

test('a node is reported down only when it stays down, and up when it returns; disconnecting it yourself is silent', async () => {
  const notifier = new Notifier()
  const heard: any[] = []
  notifier.subscribe((n) => heard.push(n))
  const node: any = { id: 'n1', name: 'VPS', state: 'online', sync: { phase: 'idle', lastSync: 1, bytesTotal: 0 } }
  const stop = watchNodes({ list: () => [node] } as any, notifier)
  try {
    await wait(300)
    // a blink: failing for less than the wait, then fine again
    node.state = 'error'; await wait(250); node.state = 'online'; await wait(450)
    assert.equal(heard.length, 0)
    // down and staying down
    node.state = 'error'; node.error = 'timeout'
    await until('the down notice', () => heard.some((n) => n.code === 'machine.down'))
    await wait(900)
    assert.equal(heard.filter((n) => n.code === 'machine.down').length, 1) // said once, not every second
    assert.deepEqual(heard[0].params, { machineName: 'VPS', reason: 'timeout' })
    // retrying counts as still down; coming back is announced
    node.state = 'connecting'; await wait(300); node.state = 'online'
    await until('the up notice', () => heard.some((n) => n.code === 'machine.up'))
    // the person disconnecting it is not news
    heard.length = 0
    node.state = 'offline'; await wait(800)
    assert.equal(heard.length, 0)
    // a large copy finishing is worth one notice; a small one is not
    node.state = 'online'; await wait(300)
    node.sync = { phase: 'fetching', lastSync: 1, bytesTotal: 10 * 1024 * 1024 }; await wait(300); node.sync = { phase: 'idle', lastSync: 2, bytesTotal: 10 * 1024 * 1024 }; await wait(400)
    assert.equal(heard.filter((n) => n.code === 'sync.done').length, 0)
    node.sync = { phase: 'fetching', lastSync: 2, bytesTotal: 800 * 1024 * 1024 }; await wait(300); node.sync = { phase: 'idle', lastSync: 3, bytesTotal: 800 * 1024 * 1024 }
    await until('the copy notice', () => heard.some((n) => n.code === 'sync.done'))
  } finally { stop() }
})
