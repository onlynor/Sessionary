import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-'))
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'pi')
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg') // no opencode db there → adapter must degrade to empty

const { claude } = await import('../src/adapters/claude.ts')
const { pi } = await import('../src/adapters/pi.ts')
const { opencode } = await import('../src/adapters/opencode.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { scan, loadSession } = await import('../src/core/scanner.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const cdir = path.join(tmp, 'claude', 'projects', '-tmp-proj')
const cfile = path.join(cdir, 'abc.jsonl')
fs.mkdirSync(cdir, { recursive: true })
fs.writeFileSync(cfile, jl(
  { type: 'user', uuid: 'u1', sessionId: 'abc', cwd: '/tmp/proj', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'list files' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', model: 'x', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: '2026-01-01T00:00:02Z', message: { id: 'm1', model: 'x', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } },
  { type: 'assistant', uuid: 'a3', timestamp: '2026-01-01T00:00:04Z', message: { id: 'm2', model: 'x', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'ai-title', aiTitle: 'Listing', sessionId: 'abc' },
))
// a bare /exit session must be ignored
fs.writeFileSync(path.join(cdir, 'exit.jsonl'), jl(
  { type: 'user', uuid: 'e1', sessionId: 'exit', message: { role: 'user', content: '<command-name>/exit</command-name>' } },
))

test('claude: merges split assistant records and attaches tool results', async () => {
  const [src] = (await claude.listSources()).filter((s) => s.key === cfile)
  const s = await claude.load(src!)
  assert.ok(s)
  assert.equal(s.title, 'Listing')
  assert.equal(s.cwd, '/tmp/proj')
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'assistant'])
  const tool = s.messages[1]!.blocks.find((b) => b.type === 'tool')
  assert.ok(tool && tool.type === 'tool')
  assert.equal(tool.output, 'a\nb')
  assert.equal(tool.status, 'ok')
  assert.equal(s.messages[1]!.blocks[0]!.type, 'thinking')
  assert.equal(await claude.summarize({ key: 'x', ref: path.join(cdir, 'exit.jsonl'), fingerprint: '' }), null)
})

test('pi: follows the active branch and pairs toolResult messages', async () => {
  const dir = path.join(tmp, 'pi', 'sessions', '--tmp--')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 's.jsonl'), jl(
    { type: 'session', id: 'p1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp' },
    { type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', id: 'dead', parentId: 'a', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] } },
    { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'message', id: 'c', parentId: 'b', timestamp: '2026-01-01T00:00:04Z', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } },
  ))
  const [src] = await pi.listSources()
  const s = await pi.load(src!)
  assert.ok(s)
  assert.deepEqual(s.messages.map((m) => m.id), ['a', 'b'])
  const t = s.messages[1]!.blocks[0]!
  assert.ok(t.type === 'tool' && t.output === 'ok')
})

test('opencode: missing database degrades to no sessions', async () => {
  assert.deepEqual(await opencode.listSources(), [])
})

test('scan is incremental and drops vanished sources', async () => {
  const store = new IndexStore(':memory:')
  const adapters = [claude, pi, opencode]
  let r = await scan(adapters, store)
  assert.equal(r.find((x) => x.agent === 'claude-code')!.updated, 2)
  r = await scan(adapters, store)
  assert.equal(r.reduce((n, x) => n + x.updated, 0), 0)
  assert.equal(store.list().length, 2) // claude "abc" + pi "p1"
  assert.equal((await loadSession(adapters, store, 'claude-code:abc'))?.messageCount, 3)
  fs.rmSync(cfile)
  r = await scan(adapters, store)
  assert.equal(r.find((x) => x.agent === 'claude-code')!.removed, 1)
  assert.equal(store.list({ agent: 'claude-code' }).length, 0)
})

test('tool kinds are normalised across agents', async () => {
  const { toolKind } = await import('../src/core/derive.ts')
  for (const n of ['Bash', 'bash']) assert.equal(toolKind(n), 'shell')
  for (const n of ['Read', 'read']) assert.equal(toolKind(n), 'read')
  assert.equal(toolKind('mcp__x__y'), 'other')
})

test('projects collapse onto the git root, worktrees onto the main repo, home is generic', async () => {
  const { resolveProject } = await import('../src/core/project.ts')
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'pkg', 'a'), { recursive: true })
  const wt = path.join(tmp, 'wt')
  fs.mkdirSync(wt)
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`)
  const a = await resolveProject(path.join(repo, 'pkg', 'a'))
  assert.equal(a.key, repo)
  assert.equal(a.name, 'repo')
  assert.equal(a.sub, 'pkg/a')
  assert.equal((await resolveProject(wt)).key, repo)
  assert.equal((await resolveProject(os.homedir())).generic, true)
  const gone = await resolveProject(path.join(tmp, 'gone'))
  assert.equal(gone.exists, false)
})

test('git changes: tracked diff, untracked as added, paths cannot escape the repo', async () => {
  const { execFileSync } = await import('node:child_process')
  const { gitChanges, gitFileDiff } = await import('../src/core/context.ts')
  const repo = path.join(tmp, 'grepo')
  fs.mkdirSync(repo)
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  g('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  g('add', '.'); g('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n')
  const c = await gitChanges(repo)
  assert.ok(c)
  assert.deepEqual(c.files.map((f) => f.path).sort(), ['a.txt', 'new.txt'])
  assert.equal(c.files.find((f) => f.path === 'a.txt')!.add, 1)
  assert.match((await gitFileDiff(repo, 'a.txt'))!.patch, /\+TWO/)
  assert.match((await gitFileDiff(repo, 'new.txt'))!.patch, /\+x/)
  assert.equal(await gitFileDiff(repo, '../outside'), null)
  assert.equal(await gitChanges(path.join(tmp, 'missing')), null)
})

test('titles: placeholders and wrapper tags are repaired', async () => {
  const { cleanPrompt, pickTitle } = await import('../src/core/derive.ts')
  assert.equal(cleanPrompt('/exit'), undefined)
  assert.equal(cleanPrompt('<command-name>/model</command-name>'), undefined)
  assert.equal(cleanPrompt('<skill name="x">fix the build</skill>'), 'fix the build')
  assert.equal(pickTitle(['New session - 2026-09-04T09:44:51.570Z'], 'Add a parser', 'fallback'), 'Add a parser')
  assert.equal(pickTitle(['416d30e6-6474-4f59-9bcf-5f10fd38f787'], undefined, 'fallback'), 'fallback')
  assert.equal(pickTitle(['Real title'], 'prompt', 'fallback'), 'Real title')
})

test('paging never splits a turn and walks the whole transcript', async () => {
  const { pageMessages } = await import('../src/core/paging.ts')
  type M = import('../src/core/model.ts').Message
  const user = (id: string): M => ({ id, role: 'user', blocks: [{ type: 'text', text: id }] })
  const tool = (id: string): M => ({ id, role: 'user', blocks: [{ type: 'tool', id, name: 'Bash', input: {}, status: 'ok' }] })
  const asst = (id: string): M => ({ id, role: 'assistant', blocks: [{ type: 'text', text: id }] })
  const msgs = [user('u1'), asst('a1'), tool('t1'), asst('a2'), user('u2'), asst('a3'), user('u3')]
  const p1 = pageMessages(msgs, 0, 2)
  assert.deepEqual([p1.start, p1.end, p1.next], [0, 4, 4]) // a tool-result user message is not a turn start
  const p2 = pageMessages(msgs, p1.next!, 2)
  assert.deepEqual([p2.start, p2.end, p2.next], [4, 6, 6])
  const p3 = pageMessages(msgs, p2.next!, 2)
  assert.deepEqual([p3.end, p3.next], [7, null])
  assert.equal(pageMessages(msgs, 0, Infinity).next, null)
})

test('full-text search: CJK substrings, short terms, per-session find in order', async () => {
  const store = new IndexStore(':memory:')
  type M = import('../src/core/model.ts').Message
  const msgs: M[] = [
    { id: '1', role: 'user', blocks: [{ type: 'text', text: '我现在在那里说话总是超时 Connection refused' }] },
    { id: '2', role: 'assistant', blocks: [{ type: 'tool', id: 't', name: 'Bash', input: { command: 'pnpm install' }, output: 'secret output', status: 'ok' }] },
    { id: '3', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed the 超时 by removing the proxy' }] },
  ]
  const summary = { id: 'x:1', agent: 'x', nativeId: '1', title: 't', createdAt: 0, updatedAt: 1, messageCount: 3 }
  store.upsert('x', 'k', 'f', summary, msgs)
  assert.equal(store.search('超时')[0]?.hits, 2)
  assert.equal(store.search('pnpm install').length, 1) // tool targets are searchable
  assert.equal(store.search('secret output').length, 0) // tool output is not
  assert.equal(store.search('ui').length, 0)
  assert.deepEqual(store.find('x:1', '超时').map((f) => f.msgIndex), [0, 2])
  assert.ok(store.find('x:1', 'proxy')[0]!.marks.length > 0)
  store.remove('x', 'k')
  assert.equal(store.search('超时').length, 0)
})

test('trash overlay hides sessions and messages without touching the index or files', async () => {
  const { OverlayStore } = await import('../src/core/overlay.ts')
  const { createApp } = await import('../src/server/app.ts')
  const store = new IndexStore(':memory:')
  const overlay = new OverlayStore(':memory:')
  type M = import('../src/core/model.ts').Message
  const msgs: M[] = [{ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'alpha bravo charlie' }] }, { id: 'm2', role: 'assistant', blocks: [{ type: 'text', text: 'delta echo foxtrot' }] }]
  store.upsert('pi', 'k1', 'f', { id: 'pi:1', agent: 'pi', nativeId: '1', title: 'one', createdAt: 0, updatedAt: 2, messageCount: 2 }, msgs)
  store.upsert('pi', 'k2', 'f', { id: 'pi:2', agent: 'pi', nativeId: '2', title: 'two', createdAt: 0, updatedAt: 1, messageCount: 0 }, [])
  const { app } = createApp(store, undefined, overlay)
  const { token } = (await (await app.request('/api/token', { headers: { host: 'localhost' } })).json()) as { token: string }
  const req = (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { host: 'localhost', 'content-type': 'application/json', 'x-sessionary-token': token } })
  // state-changing calls without the token, or from another origin, are refused
  assert.equal((await app.request('/api/sessions/pi:2/hide', { method: 'POST', headers: { host: 'localhost' } })).status, 403)
  assert.equal((await app.request('/api/sessions/pi:2/hide', { method: 'POST', headers: { host: 'localhost', origin: 'https://evil.example', 'x-sessionary-token': token } })).status, 403)
  const ids = async () => ((await (await req('/api/sessions')).json()) as { id: string }[]).map((s) => s.id)

  assert.deepEqual(await ids(), ['pi:1', 'pi:2'])
  await req('/api/sessions/pi:2/hide', { method: 'POST' })
  assert.deepEqual(await ids(), ['pi:1'])
  const agents = (await (await req('/api/agents')).json()) as { id: string; sessionCount: number }[]
  assert.equal(agents.find((a) => a.id === 'pi')!.sessionCount, 1)
  assert.equal(((await (await req('/api/trash')).json()) as any).sessions.length, 1)

  await req('/api/sessions/pi:1/messages/hide', { method: 'POST', body: JSON.stringify({ ids: ['m2'] }) })
  assert.equal(((await (await req('/api/search?q=foxtrot')).json()) as unknown[]).length, 0) // hidden message no longer searchable
  assert.equal(((await (await req('/api/search?q=bravo')).json()) as unknown[]).length, 1)
  assert.equal(((await (await req('/api/trash')).json()) as any).partial[0].hiddenMessages, 1)

  await req('/api/sessions/pi:2/restore', { method: 'POST' })
  await req('/api/sessions/pi:1/messages/restore', { method: 'POST', body: '{}' })
  assert.deepEqual(await ids(), ['pi:1', 'pi:2'])
  assert.equal(((await (await req('/api/search?q=foxtrot')).json()) as unknown[]).length, 1)
  assert.equal(store.list().length, 2) // the index itself never changed
})

test('delete from disk moves Claude/Pi files into a backup and restores them; OpenCode goes through its CLI', async () => {
  const { OverlayStore } = await import('../src/core/overlay.ts')
  const { removeFromDisk, restoreFromBackup, purgeBackup } = await import('../src/core/removal.ts')
  process.env.SESSIONARY_HOME = path.join(tmp, 'sessionary-home')
  const old = new Date(Date.now() - 3_600_000)

  // Claude: transcript + per-session folders
  const cdir2 = path.join(tmp, 'claude', 'projects', '-tmp-del')
  fs.mkdirSync(path.join(cdir2, 'sid', 'subagents'), { recursive: true })
  const cfile2 = path.join(cdir2, 'sid.jsonl')
  fs.writeFileSync(cfile2, jl({ type: 'user', uuid: 'u', sessionId: 'sid', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'remove me' } }))
  fs.mkdirSync(path.join(tmp, 'claude', 'session-env', 'sid'), { recursive: true })
  fs.utimesSync(cfile2, old, old)

  const store = new IndexStore(':memory:')
  const overlay = new OverlayStore(':memory:')
  const adapters = [claude, pi, opencode]
  await scan(adapters, store)
  assert.ok(store.get('claude-code:sid'))
  const { backupDir } = await removeFromDisk(adapters, store, overlay, 'claude-code:sid')
  assert.equal(fs.existsSync(cfile2), false)
  assert.equal(fs.existsSync(path.join(cdir2, 'sid')), false)
  assert.equal(fs.existsSync(path.join(tmp, 'claude', 'session-env', 'sid')), false)
  assert.equal(fs.readdirSync(backupDir).length, 3)
  await scan(adapters, store)
  assert.equal(store.get('claude-code:sid'), null)
  await restoreFromBackup(adapters, overlay, 'claude-code:sid')
  assert.ok(fs.existsSync(cfile2) && fs.existsSync(path.join(tmp, 'claude', 'session-env', 'sid')))
  assert.equal(overlay.removed().length, 0)

  // a session written to moments ago is refused
  fs.utimesSync(cfile2, new Date(), new Date())
  await scan(adapters, store)
  await assert.rejects(removeFromDisk(adapters, store, overlay, 'claude-code:sid'), /may still be running/)

  // Pi: one file, purge deletes the backup for good
  const pfile = path.join(tmp, 'pi', 'sessions', '--tmp--', 's.jsonl')
  fs.utimesSync(pfile, old, old)
  await scan(adapters, store)
  const pi1 = await removeFromDisk(adapters, store, overlay, 'pi:p1')
  assert.equal(fs.existsSync(pfile), false)
  await purgeBackup(overlay, 'pi:p1')
  assert.equal(fs.existsSync(pi1.backupDir), false)

  // OpenCode: export → backup file → `session delete`; restore → `import`
  const log = path.join(tmp, 'oc.log')
  const fake = path.join(tmp, 'fake-opencode')
  fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n')
if (a[0] === 'export') process.stdout.write(JSON.stringify({ info: { id: a[1] }, messages: [] }))`)
  fs.chmodSync(fake, 0o755)
  process.env.SESSIONARY_OPENCODE_BIN = fake
  const m = await opencode.remove!({ key: 'ses_x', ref: 'ses_x', fingerprint: '' }, path.join(tmp, 'ocb'))
  assert.equal(JSON.parse(fs.readFileSync((m.files as string[])[0]!, 'utf8')).info.id, 'ses_x')
  await opencode.restore!(m, path.join(tmp, 'ocb'))
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0] + (l.includes('delete') ? ' delete' : '')), ['export', 'session delete', 'import'])
})

test('continue runs the agent CLI in the session directory, read-only by default', async () => {
  const { Runs } = await import('../src/core/runs.ts')
  const store = new IndexStore(':memory:')
  const dir = fs.mkdtempSync(path.join(tmp, 'proj-'))
  const fake = path.join(tmp, 'fake-pi')
  const log = path.join(tmp, 'pi-run.log')
  fs.writeFileSync(fake, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }))`)
  fs.chmodSync(fake, 0o755)
  process.env.SESSIONARY_PI_BIN = fake
  const sfile = path.join(tmp, 'pi', 'sessions', '--run--', 'r.jsonl')
  fs.mkdirSync(path.dirname(sfile), { recursive: true })
  fs.writeFileSync(sfile, jl({ type: 'session', id: 'r1', timestamp: '2026-01-01T00:00:00Z', cwd: dir }, { type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }))
  const old = new Date(Date.now() - 3_600_000)
  fs.utimesSync(sfile, old, old)
  await scan([pi], store)
  const ended: string[] = []
  const runs = new Runs([pi], store, (r) => ended.push(r.status))
  const run = await runs.start('pi:r1', '-dash first', false)
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(ended, ['done'])
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'))
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(dir))
  assert.deepEqual(seen.args, ['--session', sfile, '-p', '--tools', 'read,grep,find,ls', ' -dash first'])
  assert.equal(run.status, 'done')
  // a write right after our own run is ours; a fresh writer (e.g. a terminal) is left alone
  fs.utimesSync(sfile, new Date(), new Date())
  await scan([pi], store)
  await assert.rejects(new Runs([pi], store, () => {}).start('pi:r1', 'again', false), /last two minutes/)
})
