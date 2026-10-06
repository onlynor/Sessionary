import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-sync-'))
const remoteHome = path.join(tmp, 'remote-home')
// the local machine has no agents of its own in this test
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'local-claude')
process.env.CODEX_HOME = path.join(tmp, 'codex-none')
process.env.WORKBUDDY_HOME = path.join(tmp, 'workbuddy-none')
process.env.WORKBUDDY_AI_HOME = path.join(tmp, 'workbuddy-ai-none')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'local-pi')
process.env.XDG_DATA_HOME = path.join(tmp, 'local-xdg')
process.env.HERMES_HOME = path.join(tmp, 'local-hermes')
process.env.SESSIONARY_HOME = path.join(tmp, 'sessionary')

// A stand-in for ssh: skips the options, then runs the command in a shell whose HOME is the "remote" home.
const fakeSsh = path.join(tmp, 'ssh')
fs.writeFileSync(fakeSsh, `#!/bin/sh
echo "$@" >> "${tmp}/ssh.log"
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -o|-p|-i|-O|-l|-F) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "${remoteHome}"
HOME="${remoteHome}" exec sh -c "$*"
`, { mode: 0o755 })
process.env.SESSIONARY_SSH_BIN = fakeSsh

const { DatabaseSync } = await import('../src/core/sqlite.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')
const { makeHermes } = await import('../src/adapters/hermes.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const claudeFile = path.join(remoteHome, '.claude', 'projects', '-srv-app', 'c1.jsonl')
const piFile = path.join(remoteHome, '.pi', 'agent', 'sessions', '--srv-app--', '2026-01-01T00-00-00_p1.jsonl')
const hermesDb = path.join(remoteHome, '.hermes', 'state.db')

const claudeSession = (text: string) => jl(
  { type: 'user', uuid: 'u1', sessionId: 'c1', cwd: '/srv/app', gitBranch: 'main', timestamp: new Date().toISOString(), message: { role: 'user', content: text } },
  { type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
)

function seedHermes(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    create table sessions (id text primary key, source text not null, title text, model text, started_at real not null, ended_at real, last_activity_at real,
      cwd text, git_branch text, input_tokens integer default 0, output_tokens integer default 0, cache_read_tokens integer default 0, reasoning_tokens integer default 0,
      actual_cost_usd real, estimated_cost_usd real);
    create table messages (id integer primary key autoincrement, session_id text not null, role text not null, content text, tool_call_id text, tool_calls text,
      tool_name text, timestamp real not null, reasoning text, reasoning_content text, active integer not null default 1);
    insert into sessions (id, source, title, model, started_at, last_activity_at, cwd, input_tokens, output_tokens) values ('h1', 'cli', 'Fix the cron job', 'hermes-4', 1700000000, 1700000100, '/srv/app', 120, 80);
    insert into messages (session_id, role, content, timestamp) values ('h1', 'user', 'why does the cron job fail?', 1700000001);
    insert into messages (session_id, role, content, tool_calls, timestamp) values ('h1', 'assistant', 'Let me look.', '[{"id":"t1","type":"function","function":{"name":"terminal","arguments":"{\\"command\\":\\"crontab -l\\"}"}}]', 1700000002);
    insert into messages (session_id, role, content, tool_call_id, tool_name, timestamp) values ('h1', 'tool', '0 * * * * backup.sh', 't1', 'terminal', 1700000003);
    insert into messages (session_id, role, content, timestamp, active) values ('h1', 'assistant', 'a rewound reply', 1700000004, 0);
    insert into messages (session_id, role, content, timestamp) values ('h1', 'assistant', 'The path in the crontab is wrong.', 1700000005);
  `)
  db.close()
}

async function controller() {
  const { app, stopRuns } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'))
  const { token } = await (await app.request('/api/token', { headers: { host: 'localhost' } })).json() as { token: string }
  const req = (url: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token, ...(init.headers ?? {}) } })
  const json = async (url: string, init?: RequestInit) => (await req(url, init)).json() as Promise<any>
  return { req, json, stopRuns }
}
const until = async (what: string, f: () => Promise<boolean>, ms = 15_000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)) }
  assert.fail(`timed out waiting for ${what}`)
}

test('the Hermes adapter reads sessions, tool calls and skips rewound messages', async () => {
  const root = path.join(tmp, 'h-only')
  seedHermes(path.join(root, 'state.db'))
  const a = makeHermes(() => ({ claude: '', pi: '', xdgData: '', hermes: root, codex: '', workbuddy: '', workbuddyAi: '' }))
  const [src] = await a.listSources()
  assert.equal(src!.key, 'h1')
  const s = (await a.load(src!))!
  assert.equal(s.id, 'hermes:h1')
  assert.equal(s.title, 'Fix the cron job')
  assert.equal(s.cwd, '/srv/app')
  assert.equal(s.messageCount, 3) // user, assistant with a tool call, final reply; the tool row folds into its call
  const tool = s.messages[1]!.blocks.find((b) => b.type === 'tool') as any
  assert.equal(tool.name, 'terminal')
  assert.deepEqual(tool.input, { command: 'crontab -l' })
  assert.equal(tool.output, '0 * * * * backup.sh')
  assert.equal(tool.status, 'ok')
  assert.ok(!JSON.stringify(s.messages).includes('rewound'))
  assert.equal(s.tokens?.input, 120)
})

test('an ssh node is mirrored over ssh and read in place, with nothing installed on it', async () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true })
  fs.writeFileSync(claudeFile, claudeSession('deploy the app'))
  fs.mkdirSync(path.dirname(piFile), { recursive: true })
  fs.writeFileSync(piFile, jl(
    { type: 'session', id: 'p1', cwd: '/srv/app', timestamp: new Date().toISOString() },
    { id: 'e1', parentId: null, type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: 'check the logs' } },
    { id: 'e2', parentId: 'e1', type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'nothing unusual' }] } },
  ))
  seedHermes(hermesDb)

  const { req, json, stopRuns } = await controller()
  try {
    const node = await json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'vps', kind: 'ssh', host: 'vps.example.com', user: 'root' }) })
    const r = await req(`/api/nodes/${node.id}/connect`, { method: 'POST' })
    assert.equal(r.status, 200)
    await until('the first copy', async () => (await json('/api/nodes')).find((n: any) => n.id === node.id)?.state === 'online')

    const list = await json(`/api/nodes/${node.id}/proxy/api/sessions`) as any[]
    assert.deepEqual(list.map((s) => s.id).sort(), ['claude-code:c1', 'hermes:h1', 'pi:p1'])
    const status = (await json('/api/nodes')).find((n: any) => n.id === node.id)
    assert.equal(status.sync.files, 3) // one Claude transcript, one Pi transcript, the Hermes database
    assert.equal(status.sync.pending, 0)
    // a project name comes from the node's path, not from anything on this machine
    assert.equal(list.find((s) => s.id === 'claude-code:c1').project.name, 'app')

    // the transcript is served by the same API as a local session
    const one = await json(`/api/nodes/${node.id}/proxy/api/sessions/${encodeURIComponent('claude-code:c1')}`)
    assert.equal(one.messages[0].blocks[0].text, 'deploy the app')
    const hits = await json(`/api/nodes/${node.id}/proxy/api/search?q=${encodeURIComponent('crontab')}`) as any[]
    assert.deepEqual(hits.map((h) => h.sessionId), ['hermes:h1'])

    // nothing that would change the node, or lead to this machine's disk, is allowed
    for (const p of ['delete-from-disk', 'continue', 'open'])
      assert.equal((await req(`/api/nodes/${node.id}/proxy/api/sessions/claude-code:c1/${p}`, { method: 'POST' })).status, 405, p)
    for (const p of ['context', 'tree', 'changes'])
      assert.equal((await req(`/api/nodes/${node.id}/proxy/api/sessions/claude-code:c1/${p}`)).status, 404, p)
    // resuming is the agent's own command, run on the node through ssh in a terminal
    const resume = await json(`/api/nodes/${node.id}/resume-command?session=${encodeURIComponent('claude-code:c1')}`)
    assert.match(resume.line, /^ssh -t -- root@vps\.example\.com 'exec "\$\{SHELL:-\/bin\/sh\}" -lic .*cd \/srv\/app && claude --resume c1/)
    // the local list does not mix them in
    assert.deepEqual(await json('/api/sessions'), [])

    // changes on the node come across on the next sync; vanished files leave the mirror
    await new Promise((r) => setTimeout(r, 1100)) // mtimes have one-second resolution
    fs.writeFileSync(claudeFile, claudeSession('deploy the app, then restart it'))
    fs.rmSync(piFile)
    assert.equal((await req(`/api/nodes/${node.id}/sync`, { method: 'POST' })).status, 200)
    const after = await json(`/api/nodes/${node.id}/proxy/api/sessions`) as any[]
    assert.deepEqual(after.map((s) => s.id).sort(), ['claude-code:c1', 'hermes:h1'])
    const changed = await json(`/api/nodes/${node.id}/proxy/api/sessions/${encodeURIComponent('claude-code:c1')}`)
    assert.equal(changed.messages[0].blocks[0].text, 'deploy the app, then restart it')

    // ssh was only ever asked to list and to tar
    const log = fs.readFileSync(path.join(tmp, 'ssh.log'), 'utf8')
    assert.match(log, /BatchMode=yes/)
    assert.match(log, /root@vps\.example\.com/)
  } finally { stopRuns() }
})

test('editing a node reconnects with the new settings and drops the copy of a different machine', async () => {
  const { req, json, stopRuns } = await controller()
  try {
    const node = await json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'old name', kind: 'ssh', host: 'one.example.com' }) })
    await req(`/api/nodes/${node.id}/connect`, { method: 'POST' })
    await until('the first copy', async () => (await json('/api/nodes'))[0].state === 'online')
    const mirror = path.join(process.env.SESSIONARY_HOME!, 'nodes', node.id, 'home')
    assert.ok(fs.existsSync(mirror))

    // a rename or a new key keeps the copy; the connection is dropped so it reopens with the new settings
    const renamed = await json(`/api/nodes/${node.id}`, { method: 'PUT', body: JSON.stringify({ name: 'new name', kind: 'ssh', host: 'one.example.com', identity: '/k/id' }) })
    assert.equal(renamed.id, node.id)
    assert.equal(renamed.name, 'new name')
    assert.equal(renamed.state, 'offline')
    assert.ok(fs.existsSync(mirror))
    assert.equal((await json('/api/nodes'))[0].identity, '/k/id')

    // another host is another machine: its history must not linger under this node
    await json(`/api/nodes/${node.id}`, { method: 'PUT', body: JSON.stringify({ name: 'new name', kind: 'ssh', host: 'two.example.com' }) })
    assert.ok(!fs.existsSync(mirror))
    assert.equal((await req(`/api/nodes/${node.id}/connect`, { method: 'POST' })).status, 200)
    await until('the copy from the new host', async () => (await json('/api/nodes'))[0].state === 'online')
    assert.ok(fs.existsSync(mirror))

    // bad input is refused and changes nothing
    assert.equal((await req(`/api/nodes/${node.id}`, { method: 'PUT', body: JSON.stringify({ name: 'x', kind: 'ssh', host: '-oProxyCommand=evil' }) })).status, 400)
    assert.equal((await json('/api/nodes'))[0].host, 'two.example.com')
    assert.equal((await req('/api/nodes/nope', { method: 'PUT', body: JSON.stringify({ name: 'x', kind: 'ssh', host: 'h' }) })).status, 404)
  } finally { stopRuns() }
})

test('a failing ssh login is reported with its reason', async () => {
  const failing = path.join(tmp, 'ssh-fail')
  fs.writeFileSync(failing, '#!/bin/sh\necho "root@nope: Permission denied (publickey)." >&2\nexit 255\n', { mode: 0o755 })
  const before = process.env.SESSIONARY_SSH_BIN
  process.env.SESSIONARY_SSH_BIN = failing
  const { req, json, stopRuns } = await controller()
  try {
    const node = await json('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'locked', kind: 'ssh', host: 'locked.example.com' }) })
    const r = await req(`/api/nodes/${node.id}/connect`, { method: 'POST' })
    assert.equal(r.status, 502)
    assert.match(((await r.json()) as any).error, /Permission denied.*key-based login/s)
    assert.equal((await json('/api/nodes'))[0].state, 'error')
  } finally { process.env.SESSIONARY_SSH_BIN = before; stopRuns() }
})

test('ssh config hosts are offered by alias, without wildcard defaults', async () => {
  const { parseSshConfig } = await import('../src/core/sshconfig.ts')
  const hosts = parseSshConfig(`
Host *
  ServerAliveInterval 30
Host vps us-vps   # two names
  HostName 203.0.113.9
  User root
  Port 2200
  IdentityFile ~/.ssh/id_vps
Host build-*
  User ci
Match host foo
  User nobody
`)
  assert.deepEqual(hosts, [
    { alias: 'vps', hostName: '203.0.113.9', user: 'root', port: 2200, identity: '~/.ssh/id_vps' },
    { alias: 'us-vps', hostName: '203.0.113.9', user: 'root', port: 2200, identity: '~/.ssh/id_vps' },
  ])
})
