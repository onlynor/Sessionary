import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-agents-'))
const roots = () => ({ claude: '', pi: '', xdgData: '', hermes: '', codex: path.join(tmp, '.codex'), workbuddy: path.join(tmp, '.workbuddy'), workbuddyAi: path.join(tmp, '.workbuddy-ai') })

const { makeCodex, } = await import('../src/adapters/codex.ts')
const { commandText, patchDiff } = await import('../src/adapters/codex.ts')
const { makeWorkbuddy, makeWorkbuddyAi } = await import('../src/adapters/workbuddy.ts')
const { DatabaseSync } = await import('../src/core/sqlite.ts')
const { adapters, adaptersFor } = await import('../src/adapters/index.ts')

const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

const ID = '0198aaaa-1111-7222-8333-444455556666'
const rollout = path.join(tmp, '.codex', 'sessions', '2026', '08', '01', `rollout-2026-08-01T10-00-00-${ID}.jsonl`)

test('codex: a rollout becomes a conversation with commands, patches, reasoning and token use', async () => {
  write(rollout, jl(
    { timestamp: '2026-08-01T10:00:00.000Z', type: 'session_meta', payload: { id: ID, timestamp: '2026-08-01T10:00:00.000Z', cwd: '/srv/app', originator: 'codex_cli_rs', cli_version: '0.160.1', git: { branch: 'main', commit_hash: 'abc' } } },
    { timestamp: '2026-08-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/srv/app</cwd>\n</environment_context>' }] } },
    { timestamp: '2026-08-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'fix the failing test' } },
    { timestamp: '2026-08-01T10:00:02.500Z', type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/srv/app' } },
    { timestamp: '2026-08-01T10:00:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at the test first' }], encrypted_content: 'zzz' } },
    { timestamp: '2026-08-01T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'], workdir: '/srv/app' }), call_id: 'c1' } },
    { timestamp: '2026-08-01T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '1 failed', metadata: { exit_code: 1, duration_seconds: 2.1 } }) } },
    { timestamp: '2026-08-01T10:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch' } },
    { timestamp: '2026-08-01T10:00:07.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files' } },
    { timestamp: '2026-08-01T10:00:08.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed it.' }] } },
    { timestamp: '2026-08-01T10:00:09.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
  ))
  const a = makeCodex(roots)
  const [src] = await a.listSources()
  assert.equal(src!.ref, rollout)
  const s = (await a.load(src!))!
  assert.equal(s.id, `codex:${ID}`)
  assert.equal(s.title, 'fix the failing test')
  assert.equal(s.cwd, '/srv/app')
  assert.equal(s.gitBranch, 'main')
  assert.equal(s.model, 'gpt-5-codex')
  // Codex counts the cached tokens inside the input and reasoning inside the output (OpenAI's convention): not twice
  assert.deepEqual(s.tokens, { input: 100, output: 20 })
  assert.deepEqual(s.usage?.map(({ input, cacheRead, output }) => ({ input, cacheRead, output })), [{ input: 50, cacheRead: 50, output: 20 }])
  assert.equal(s.filesChanged, 1) // the patch counts once, as one tool call with a path
  assert.equal(s.messages.length, 2) // what was typed, then everything the agent did for it
  assert.ok(!JSON.stringify(s.messages).includes('environment_context'))
  const blocks = s.messages[1]!.blocks
  assert.equal(blocks[0]!.type, 'thinking')
  const sh = blocks.find((b) => b.type === 'tool' && b.name === 'shell') as any
  assert.equal(sh.input.command, 'npm test')
  assert.equal(sh.output, '1 failed')
  assert.equal(sh.status, 'error')
  const patch = blocks.find((b) => b.type === 'tool' && b.name === 'apply_patch') as any
  assert.equal(patch.status, 'ok')
  assert.equal(patch.input.path, 'src/a.ts')
  assert.match(patch.diff, /@@ src\/a\.ts\n@@\n-old\n\+new\n@@ \+ src\/b\.ts\n\+hello/)
  assert.deepEqual(a.resumeCommand!(src!, s), { bin: 'codex', args: ['resume', ID], cwd: '/srv/app' })
  const cont = a.continueCommand!(src!, s, 'go on', { allowWrite: false })
  assert.deepEqual(cont.args.slice(0, 4), ['exec', 'resume', ID, '--json'])
  assert.ok(cont.args.includes('sandbox_mode="read-only"'))
  assert.equal(a.newCommand!('/x').cwd, '/x')
})

test('codex: thread names come from the state database or the index file; helpers read commands and patches', async () => {
  const home = path.join(tmp, '.codex')
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'))
  db.exec(`create table threads (id text primary key, name text, title text); insert into threads values ('${ID}', 'Fix tests', 'fix the failing test');`)
  db.close()
  const a = makeCodex(roots)
  const [src] = await a.listSources()
  assert.equal((await a.load(src!))!.title, 'Fix tests')
  fs.rmSync(path.join(home, 'state_5.sqlite'))
  write(path.join(home, 'session_index.jsonl'), jl({ id: ID, thread_name: 'From the index', updated_at: '2026-08-01T10:00:00Z' }))
  assert.equal((await a.load(src!))!.title, 'From the index')

  assert.equal(commandText(['bash', '-lc', 'git status && ls']), 'git status && ls')
  assert.equal(commandText(['git', 'log', '--oneline', 'a b']), "git log --oneline 'a b'")
  assert.equal(commandText('echo hi'), 'echo hi')
  assert.deepEqual(patchDiff('*** Begin Patch\n*** Delete File: x.txt\n*** End Patch').files, ['x.txt'])
})

const buddyLines = (cwd: string, extra: unknown[] = []) => jl(
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_info>os: linux</user_info>' }], sessionId: 's1', cwd, timestamp: 1780000000000 },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarise the quarterly report' }], sessionId: 's1', cwd, timestamp: 1780000001000 },
  { type: 'reasoning', content: [{ type: 'text', text: 'the report is in docs' }], timestamp: 1780000002000 },
  { type: 'function_call', name: 'Read', arguments: JSON.stringify({ file_path: '/work/q3.md' }), callId: 'k1', timestamp: 1780000003000 },
  { type: 'function_call_result', callId: 'k1', status: 'completed', output: { type: 'text', text: 'Revenue grew 12%' }, timestamp: 1780000004000 },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Revenue grew 12% this quarter.' }], providerData: { messageId: 'm1', model: 'glm-5.2' }, timestamp: 1780000005000 },
  ...extra,
)

test('workbuddy: both editions are read from their own homes with the same parser', async () => {
  write(path.join(tmp, '.workbuddy', 'projects', 'proj-1', 's1.jsonl'), buddyLines('/work', [{ type: 'ai-title', title: 'Quarterly report summary' }]))
  write(path.join(tmp, '.workbuddy-ai', 'projects', 'proj-2', 's2.jsonl'), buddyLines('/work/intl'))
  // deeper files are tool output, not conversations
  write(path.join(tmp, '.workbuddy', 'projects', 'proj-1', 's1', 'tool-results', 'big.jsonl'), '{"x":1}\n')

  const cn = makeWorkbuddy(roots), ai = makeWorkbuddyAi(roots)
  const cnSrc = await cn.listSources(), aiSrc = await ai.listSources()
  assert.equal(cnSrc.length, 1)
  assert.equal(aiSrc.length, 1)
  const s = (await cn.load(cnSrc[0]!))!
  assert.equal(s.id, 'workbuddy:s1')
  assert.equal(s.title, 'Quarterly report summary')
  assert.equal(s.cwd, '/work')
  assert.equal(s.model, 'glm-5.2')
  assert.equal(s.createdAt, 1780000000000) // the first record, even one that is app context rather than a prompt
  assert.equal(s.messages.length, 2)
  assert.ok(!JSON.stringify(s.messages).includes('user_info'))
  const tool = s.messages[1]!.blocks.find((b) => b.type === 'tool') as any
  assert.deepEqual([tool.name, tool.input.file_path, tool.output, tool.status], ['Read', '/work/q3.md', 'Revenue grew 12%', 'ok'])
  const t = (await ai.load(aiSrc[0]!))!
  assert.equal(t.id, 'workbuddy-ai:s2')
  assert.equal(t.title, 'summarise the quarterly report') // no title record: the first prompt
  assert.equal(cn.label, 'WorkBuddy')
  assert.equal(ai.label, 'WorkBuddy AI')
  assert.equal(cn.bin, '') // desktop apps: nothing to find on PATH
})

test('the registry knows every agent, and a node gets the same set', () => {
  const ids = adapters.map((a) => a.id)
  assert.deepEqual(ids, ['claude-code', 'codex', 'opencode', 'pi', 'hermes', 'workbuddy', 'workbuddy-ai'])
  assert.deepEqual(adaptersFor(roots).map((a) => a.id), ids)
})
