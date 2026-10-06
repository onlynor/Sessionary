import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-nodes-'))
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
process.env.CODEX_HOME = path.join(tmp, 'codex-none')
process.env.WORKBUDDY_HOME = path.join(tmp, 'workbuddy-none')
process.env.WORKBUDDY_AI_HOME = path.join(tmp, 'workbuddy-ai-none')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi')
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg')
process.env.SESSIONARY_NODE_TIMEOUT_MS = '1500'

const { serve } = await import('@hono/node-server')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')
const { parseNode, NodeError } = await import('../src/core/nodes.ts')
const { sshArgs } = await import('../src/core/sync.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

/** a second Sessionary standing in for a remote node, with one session in its own storage */
async function remoteNode() {
  const dir = path.join(tmp, 'claude', 'projects', '-remote')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'r1.jsonl'), jl(
    { type: 'user', uuid: 'u', sessionId: 'r1', cwd: tmp, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello from the node' } },
    { type: 'assistant', uuid: 'a', timestamp: new Date().toISOString(), message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ))
  const { app, rescan } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'))
  await rescan()
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise((r) => server.once('listening', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

async function controller() {
  const { app, rescan, stopRuns } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'))
  await rescan()
  const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
  const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  return { req, stopRuns }
}

test('node input is validated before it can reach ssh', () => {
  assert.throws(() => parseNode({ name: 'x', kind: 'ssh', host: '-oProxyCommand=evil' }), NodeError)
  assert.throws(() => parseNode({ name: 'x', kind: 'ssh', host: 'a b' }), NodeError)
  assert.throws(() => parseNode({ name: 'x', kind: 'ssh', host: 'h', user: '-l' }), NodeError)
  assert.throws(() => parseNode({ name: 'x', kind: 'ssh', host: 'h', port: 70000 }), NodeError)
  assert.throws(() => parseNode({ name: 'x', kind: 'ssh', host: 'h', identity: '-oFoo' }), NodeError)
  assert.throws(() => parseNode({ name: '', kind: 'ssh', host: 'h' }), NodeError)
  assert.throws(() => parseNode({ name: 'x', kind: 'url', url: 'file:///etc/passwd' }), NodeError)
  const n = parseNode({ name: 'vps', kind: 'ssh', host: 'vps.example.com', user: 'root', port: '2222', identity: '/k/id' })
  const args = sshArgs(n as any, ['true'])
  // the destination can only ever be read as a destination: it follows `--`, and the options come before it
  assert.deepEqual(args.slice(-5), ['-i', '/k/id', '--', 'root@vps.example.com', 'true'])
  assert.ok(args.includes('BatchMode=yes') && args.includes('-p') && args[args.indexOf('-p') + 1] === '2222')
})

test('a node is stored, reached through the proxy and removed', async () => {
  const remote = await remoteNode()
  const { req, stopRuns } = await controller()
  try {
    const added = await (await req('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'test node', kind: 'url', url: remote.url }) })).json() as any
    assert.equal(added.state, 'offline')
    assert.equal((await (await req('/api/nodes')).json() as any[]).length, 1)

    // the proxied list is the node's own session list
    const list = await (await req(`/api/nodes/${added.id}/proxy/api/sessions`)).json() as any[]
    assert.deepEqual(list.map((s) => s.id), ['claude-code:r1'])
    assert.equal((await (await req('/api/nodes')).json() as any[])[0].state, 'online')

    // state-changing calls go through with the node's token, and still need ours
    const pin = await req(`/api/nodes/${added.id}/proxy/api/sessions/claude-code:r1/pin`, { method: 'POST' })
    assert.deepEqual(await pin.json(), { ok: true })
    assert.equal((await req(`/api/nodes/${added.id}/proxy/api/sessions/claude-code:r1/pin`, { method: 'POST', headers: { 'x-sessionary-token': 'bad' } })).status, 403)

    // only the node's API is reachable, and never its token
    assert.equal((await req(`/api/nodes/${added.id}/proxy/api/token`)).status, 400)
    assert.equal((await req(`/api/nodes/${added.id}/proxy/index.html`)).status, 400)
    assert.equal((await req(`/api/nodes/${added.id}/proxy/api/../index.html`)).status, 400)

    await req(`/api/nodes/${added.id}`, { method: 'DELETE' })
    assert.deepEqual(await (await req('/api/nodes')).json(), [])
    assert.equal((await req(`/api/nodes/${added.id}/proxy/api/sessions`)).status, 404)
  } finally { stopRuns(); remote.close() }
})

test('an unreachable node is reported, not hung', async () => {
  const { req, stopRuns } = await controller()
  try {
    const added = await (await req('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'down', kind: 'url', url: 'http://127.0.0.1:1' }) })).json() as any
    const t = Date.now()
    const r = await req(`/api/nodes/${added.id}/connect`, { method: 'POST' })
    assert.equal(r.status, 504)
    assert.ok(Date.now() - t < 5_000)
    assert.equal((await (await req('/api/nodes')).json() as any[])[0].state, 'error')
  } finally { stopRuns() }
})
