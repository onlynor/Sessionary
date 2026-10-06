import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-machines-'))
const remoteHome = path.join(tmp, 'remote-home')
fs.mkdirSync(remoteHome, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'local-claude')
process.env.CODEX_HOME = path.join(tmp, 'codex-none')
process.env.WORKBUDDY_HOME = path.join(tmp, 'workbuddy-none')
process.env.WORKBUDDY_AI_HOME = path.join(tmp, 'workbuddy-ai-none')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'local-pi')
process.env.XDG_DATA_HOME = path.join(tmp, 'local-xdg')
process.env.HERMES_HOME = path.join(tmp, 'local-hermes')
process.env.SESSIONARY_HOME = path.join(tmp, 'sessionary')
process.env.SHELL = '/bin/sh'

const fakeSsh = path.join(tmp, 'ssh')
fs.writeFileSync(fakeSsh, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -o|-p|-i|-O|-l|-F) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "${remoteHome}"
HOME="${remoteHome}" exec sh -c "$*"
`, { mode: 0o755 })
process.env.SESSIONARY_SSH_BIN = fakeSsh

const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')
const { parseSystem, parseAgents, localSystem, localAgents, SYSTEM_SCRIPT } = await import('../src/core/system.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const seed = (home: string) => {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), jl(
    { type: 'user', uuid: 'u1', sessionId: 'c1', cwd: '/srv/app', timestamp: new Date().toISOString(), message: { role: 'user', content: 'deploy it' } },
    { type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ))
}

async function controller() {
  const overlay = new OverlayStore(':memory:')
  const { app, rescan, stopRuns } = createApp(new IndexStore(':memory:'), undefined, overlay)
  const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
  const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  const json = async (url: string, init?: RequestInit) => (await req(url, init)).json() as Promise<any>
  return { app, rescan, req, json, token, stopRuns }
}
const until = async (what: string, f: () => Promise<boolean>, ms = 15_000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)) }
  assert.fail(`timed out waiting for ${what}`)
}

/** reads a terminal's stream until `text` shows up in what it printed */
async function seeInTerminal(c: Awaited<ReturnType<typeof controller>>, id: string, text: string, ms = 10_000) {
  const res = await c.req(`/api/terminals/${id}/stream?token=${c.token}`)
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = '', out = ''
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline && !out.includes(text)) {
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 300))])
      if (!r) continue
      if (r.done) break
      buf += dec.decode(r.value, { stream: true })
      for (const ev of buf.split('\n\n').slice(0, -1)) {
        const m = /event: out\ndata: (.*)/.exec(ev)
        if (m) out += Buffer.from(m[1]!, 'base64').toString()
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return out
}

test('the system report is read from /proc and ps, and this machine can run the same script', async () => {
  const sample = `noise before
__SESSIONARY__
host=vps1
os=Debian GNU/Linux 12 (bookworm)
kernel=6.1.0
arch=x86_64
cpus=4
clk=100
uptime=3600.5
load=0.50 0.40 0.30
t1=1700000000000000000
t2=1700000001000000000
mem=MemTotal: 8000000 kB MemAvailable: 6000000 kB SwapTotal: 1000000 kB SwapFree: 1000000 kB
disk=/dev/vda1 50000000 20000000 30000000 40% /
---s1
cpu  100 0 100 700 100 0 0 0
net 1000 500
proc 100 5000 100
proc 200 1000 0
---s2
cpu  150 0 150 800 100 0 0 0
net 3000 1500
proc 100 5000 100
proc 200 1050 40
---ps
  100  9.9  0.3 02:11:00 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js
  200  0.1  2.0       05:00 /usr/local/bin/claude --resume abc
  300  0.1  0.1    1-02:00 hermes acp
  400  0.0  0.1       00:09 sshd: root`
  const s = parseSystem(sample)
  assert.equal(s.host, 'vps1')
  assert.equal(s.cpus, 4)
  assert.equal(s.cpuPercent, 50) // 100 busy of 200 elapsed ticks
  assert.deepEqual(s.net, { rx: 2000, tx: 1000 }) // bytes per second between the two looks
  assert.equal(s.procs[0]!.cpu, 90) // 90 ticks in one second at 100 per second; ps's lifetime figure (0.1) is not used
  assert.deepEqual(s.mem, { total: 8000000 * 1024, used: 2000000 * 1024 })
  assert.deepEqual(s.disk, { total: 50000000 * 1024, used: 20000000 * 1024, mount: '/' })
  assert.deepEqual(s.agents.map((a) => [a.agent, a.pid]), [['claude', 200], ['hermes', 300]]) // a bare "node …/cli.js" is not claimed
  assert.equal(s.procs[0]!.pid, 200) // busiest right now first, not by the lifetime figure ps gives

  const here = await localSystem()
  assert.ok(here.cpus > 0 && here.mem!.total > 0)
  if (process.platform === 'linux') assert.ok(SYSTEM_SCRIPT.includes('/proc/stat') && here.procs.length > 0)

  const names: [string, string][] = [['claude-code', 'claude'], ['pi', 'pi'], ['hermes', 'hermes']]
  const probe = parseAgents('x\n__SESSIONARY__\npath=/usr/bin:/bin\nclaude\t/usr/bin/claude\t111:222\tclaude 1.2.3 (Claude Code)\nhermes\t/bin/hermes\t5:6\tcommand not found\n', names)
  assert.deepEqual(probe.agents.map((a) => [a.id, a.installed, a.version]), [['claude-code', true, '1.2.3'], ['pi', false, undefined], ['hermes', true, undefined]])
  assert.equal(probe.path, '/usr/bin:/bin')
  // a program whose file has not changed is not asked again: the line comes back without a version and the old one is kept
  const again = parseAgents('__SESSIONARY__\nclaude\t/usr/bin/claude\t111:222\t\n', names, probe.known)
  assert.equal(again.agents[0]!.version, '1.2.3')
  const changed = parseAgents('__SESSIONARY__\nclaude\t/usr/bin/claude\t999:222\t\n', names, probe.known)
  assert.equal(changed.agents[0]!.version, undefined) // a new file with no answer is not given the old version
  assert.ok((await localAgents([['sh', 'sh'], ['nope', 'definitely-not-installed-xyz']])).agents[0]!.installed)
})

test('machines: this computer first, then every node, each with a system report', async () => {
  seed(remoteHome)
  const c = await controller()
  try {
    const node = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'vps', kind: 'ssh', host: 'vps.example.com' }) })
    const list = await c.json('/api/machines') as any[]
    assert.deepEqual(list.map((m) => [m.id, m.kind]), [['local', 'local'], [node.id, 'ssh']])
    const here = await c.json('/api/machines/local/system')
    assert.ok(here.cpus > 0)
    assert.equal((await c.req('/api/machines/nope/system')).status, 404)
    // over ssh the same script runs on the node (here, the fake ssh runs it locally)
    if (process.platform === 'linux') {
      const there = await c.json(`/api/machines/${node.id}/system`)
      assert.ok(there.cpus > 0 && Array.isArray(there.procs))
    }
    const agents = (await c.json('/api/machines/local/agents')).agents as any[]
    assert.deepEqual(agents.map((a) => a.id).sort(), ['claude-code', 'codex', 'hermes', 'opencode', 'pi']) // desktop apps have no program to look for
  } finally { c.stopRuns() }
})

test('probes reach a node whose login shell cannot parse quotes: the script goes in on stdin', async () => {
  if (process.platform !== 'linux') return
  // stands in for fish or tcsh: anything with quoting in the command line is refused, as they would
  const strict = path.join(tmp, 'ssh-strict')
  fs.writeFileSync(strict, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -o|-p|-i|-O|-l|-F) shift 2;; -*) shift;; *) break;; esac; done
shift
case "$*" in *"'"*|*'$('*|*'"'*) echo "fish: Unexpected end of string, quotes are not balanced" >&2; exit 127;; esac
cd "${remoteHome}"
HOME="${remoteHome}" exec sh -c "$*"
`, { mode: 0o755 })
  const before = process.env.SESSIONARY_SSH_BIN
  process.env.SESSIONARY_SSH_BIN = strict
  const c = await controller()
  try {
    const node = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'fishy', kind: 'ssh', host: 'fish.example.com' }) })
    const sys = await c.json(`/api/machines/${node.id}/system`)
    assert.ok(sys.cpus > 0 && sys.mem.total > 0 && sys.procs.length > 0)
    assert.ok(typeof sys.cpuPercent === 'number')
    const agents = (await c.json(`/api/machines/${node.id}/agents`)).agents as any[]
    assert.ok(agents.some((a) => a.id === 'claude-code'))
  } finally { process.env.SESSIONARY_SSH_BIN = before; c.stopRuns() }
})

test('a node that answers with nothing useful says what it answered', async () => {
  const junk = path.join(tmp, 'ssh-junk')
  fs.writeFileSync(junk, '#!/bin/sh\necho "Welcome to a router, no /proc here"\n', { mode: 0o755 })
  const before = process.env.SESSIONARY_SSH_BIN
  process.env.SESSIONARY_SSH_BIN = junk
  const c = await controller()
  try {
    const node = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'router', kind: 'ssh', host: 'r.example.com' }) })
    const r = await c.req(`/api/machines/${node.id}/system`)
    assert.equal(r.status, 502)
    assert.match(((await r.json()) as any).error, /It answered: Welcome to a router/)
  } finally { process.env.SESSIONARY_SSH_BIN = before; c.stopRuns() }
})

test('a terminal on this computer: type into it, see the output, reattach, stop it', async () => {
  if (process.platform === 'win32') return
  const c = await controller()
  try {
    const t = await c.json('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: 'local', kind: 'shell', cwd: tmp, cols: 90, rows: 20 }) })
    assert.equal(t.state, 'running')
    assert.equal((await c.req('/api/terminals')).status, 200)
    assert.equal((await c.app.request('/api/terminals', { headers: { host: 'localhost' } })).status, 403) // output needs the token
    await c.json(`/api/terminals/${t.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'echo size-$(stty size)-$((6*7))\n' }) })
    const out = await seeInTerminal(c, t.id, 'size-20 90-42')
    assert.match(out, /size-20 90-42/) // it is a real terminal of the size the page asked for
    // the page can resize it while it runs: the shell is told, so full-screen programs redraw to fit
    assert.equal(t.resizable, true)
    assert.equal((await c.req(`/api/terminals/${t.id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 132, rows: 41 }) })).status, 200)
    await c.json(`/api/terminals/${t.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'echo now-$(stty size)\n' }) })
    assert.match(await seeInTerminal(c, t.id, 'now-41 132'), /now-41 132/)
    assert.equal((await c.json('/api/terminals'))[0].cols, 132)
    // leaving and coming back finds the same terminal with what it already printed
    const again = await seeInTerminal(c, t.id, 'size-20 90-42')
    assert.match(again, /size-20 90-42/)
    assert.equal((await c.json('/api/terminals?machine=local')).length, 1)
    await c.json(`/api/terminals/${t.id}/kill`, { method: 'POST' })
    await until('the shell to stop', async () => (await c.json('/api/terminals'))[0].state === 'exited')
    assert.equal((await c.req(`/api/terminals/${t.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'x' }) })).status, 409)
    // restart: the same kind of terminal, fresh
    const r = await c.json(`/api/terminals/${t.id}/restart`, { method: 'POST' })
    assert.notEqual(r.id, t.id)
    assert.equal(r.state, 'running')
    assert.equal((await c.json('/api/terminals')).length, 1)
  } finally { c.stopRuns() }
})

test('a terminal on a node runs through ssh -tt', async () => {
  if (process.platform === 'win32') return
  const c = await controller()
  try {
    const node = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'vps', kind: 'ssh', host: 'vps.example.com' }) })
    const t = await c.json('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: node.id, kind: 'shell', cwd: '/', cols: 80, rows: 24 }) })
    assert.equal(t.machine, node.id)
    await c.json(`/api/terminals/${t.id}/input`, { method: 'POST', body: JSON.stringify({ data: 'echo home-is-$HOME\nexit\n' }) })
    const out = await seeInTerminal(c, t.id, `home-is-${remoteHome}`)
    assert.ok(out.includes(`home-is-${remoteHome}`))
    // url nodes have no terminal
    const url = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'u', kind: 'url', url: 'http://127.0.0.1:1' }) })
    assert.equal((await c.req('/api/terminals', { method: 'POST', body: JSON.stringify({ machine: url.id, kind: 'shell' }) })).status, 400)
  } finally { c.stopRuns() }
})

test('names, pins and trash are kept per machine and never leak into another machine’s list', async () => {
  seed(path.join(tmp, 'local-home-unused'))
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'local-home-unused', '.claude')
  seed(remoteHome)
  const c = await controller()
  try {
    await c.rescan()
    const node = await c.json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'vps', kind: 'ssh', host: 'vps.example.com' }) })
    await c.req(`/api/nodes/${node.id}/connect`, { method: 'POST' })
    await until('the first copy', async () => (await c.json('/api/nodes'))[0].state === 'online')
    const base = `/api/nodes/${node.id}/proxy/api`
    const id = 'claude-code:c1'

    // the same session id exists on both machines; each keeps its own decisions
    assert.equal((await c.json('/api/sessions')).length, 1)
    assert.equal((await c.json(`${base}/sessions`)).length, 1)
    assert.equal((await c.req(`${base}/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: 'Node deploy' }) })).status, 200)
    assert.equal((await c.req(`${base}/sessions/${id}/pin`, { method: 'POST' })).status, 200)
    assert.equal((await c.json(`${base}/sessions`))[0].title, 'Node deploy')
    assert.equal((await c.json(`${base}/sessions`))[0].pinned, true)
    const local = (await c.json('/api/sessions'))[0]
    assert.notEqual(local.title, 'Node deploy')
    assert.equal(local.pinned, undefined)

    await c.json(`/api/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: 'Local deploy' }) })
    assert.equal((await c.json('/api/sessions'))[0].title, 'Local deploy')
    assert.equal((await c.json(`${base}/sessions`))[0].title, 'Node deploy')
    // an empty name takes the custom one away
    await c.json(`/api/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: '' }) })
    assert.notEqual((await c.json('/api/sessions'))[0].title, 'Local deploy')

    // hiding on the node hides only there, and the node's trash lists it
    await c.req(`${base}/sessions/${id}/hide`, { method: 'POST' })
    assert.equal((await c.json(`${base}/sessions`)).length, 0)
    assert.equal((await c.json('/api/sessions')).length, 1)
    assert.equal((await c.json(`${base}/trash`)).sessions.length, 1)
    assert.equal((await c.json('/api/trash')).sessions.length, 0)
    // but nothing that would change the node, or touch this disk, is allowed
    assert.equal((await c.req(`${base}/sessions/${id}/delete-from-disk`, { method: 'POST' })).status, 405)
    assert.equal((await c.req(`${base}/sessions/${id}/continue`, { method: 'POST', body: '{"prompt":"x"}' })).status, 405)
    assert.equal((await c.json(`${base}/agents`)).find((a: any) => a.id === 'claude-code').canContinue, false)

    // removing the node forgets its decisions
    await c.req(`/api/nodes/${node.id}`, { method: 'DELETE' })
    const summary = await c.json('/api/summary')
    assert.equal(summary.sessions, 1)
    assert.equal(summary.agents.find((a: any) => a.id === 'claude-code').sessions, 1)
    assert.equal(summary.recent[0].id, id)
  } finally { c.stopRuns() }
})
