import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-harness-'))
process.env.DSH_HOME = path.join(tmp, 'dsh')
process.env.SESSIONARY_DEEPSEEK_HARNESS_BIN = '/tmp/fake-dsh-launcher'
const { makeHarness } = await import('../src/adapters/harness.ts')

const adapter = makeHarness()

/** one Zstandard frame per commit, exactly as the harness writes them */
const write = (dir: string, name: string, rows: unknown[]) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.concat(rows.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))))
}

const sessionDir = path.join(process.env.DSH_HOME!, 'sessions', '--tmp-ws--', 'harness-1')
write(sessionDir, 'session.v4.jsonl.zstd', [
  { type: 'session', version: 4, id: 'harness-1', createdAt: 1_700_000_000_000, cwd: '/tmp/ws', isSeeded: false, delegationDepth: 0 },
  { type: 'permission/preset', seq: 0, time: 1_700_000_000_010, data: { preset: 'workspace-write' } },
  { type: 'user/message', seq: 1, time: 1_700_000_000_100, data: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'list the markdown files' }], source: { kind: 'user' } } },
  // the harness's own runtime context: not something a person typed, and not a message
  { type: 'user/message', seq: 2, time: 1_700_000_000_110, data: { role: 'user', id: 'u2', content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context', form: 'snapshot' } } },
  { type: 'session/title', seq: 3, time: 1_700_000_000_120, data: { title: 'list the markdown files' } },
  { type: 'assistant/message', seq: 4, time: 1_700_000_001_000, data: { message: { role: 'assistant', id: 'a1', content: [{ type: 'tool-call', id: 'call_1', name: 'glob', arguments: '{"pattern":"*.md"}' }], source: { kind: 'model', provider: 'sessionary', model: 'test-model' } }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } },
  { type: 'tool/call', seq: 5, time: 1_700_000_001_100, data: { callId: 'call_1', name: 'glob', arguments: '{"pattern":"*.md"}' } },
  { type: 'tool/result', seq: 6, time: 1_700_000_001_200, data: { message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.md' }], isError: false } } },
  { type: 'assistant/message', seq: 7, time: 1_700_000_002_000, data: { message: { role: 'assistant', id: 'a2', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'done' }], source: { kind: 'model', provider: 'sessionary', model: 'test-model' } }, usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } } },
])
// a seeded session that never held a conversation must not become a row
write(path.join(process.env.DSH_HOME!, 'sessions', '--tmp-ws--', 'harness-seed'), 'session.v4.jsonl.zstd', [
  { type: 'session', version: 4, id: 'harness-seed', createdAt: 1_700_000_000_000, cwd: '/tmp/ws', isSeeded: true, delegationDepth: 0 },
  { type: 'session/end-seed', seq: 0, time: 1_700_000_000_001, data: {} },
])

test('listSources finds each session file', async () => {
  const sources = (await adapter.listSources()).sort((a, b) => a.key.localeCompare(b.key))
  assert.equal(sources.length, 2)
  assert.ok(sources.every((s) => s.ref.endsWith('.jsonl.zstd') && s.fingerprint.includes(':')))
})

test('summarize reads title, cwd, model, tokens and counts (skipping runtime context)', async () => {
  const [source] = (await adapter.listSources()).filter((s) => s.ref.includes('harness-1'))
  const summary = await adapter.summarize(source!)
  assert.equal(summary?.id, 'deepseek-harness:harness-1')
  assert.equal(summary?.agent, 'deepseek-harness')
  assert.equal(summary?.nativeId, 'harness-1')
  assert.equal(summary?.title, 'list the markdown files')
  assert.equal(summary?.cwd, '/tmp/ws')
  assert.equal(summary?.model, 'test-model')
  assert.equal(summary?.messageCount, 3)
  assert.deepEqual(summary?.tokens, { input: 7, output: 3 })
  assert.equal(summary?.toolCalls, 1)
  assert.equal(summary?.updatedAt, 1_700_000_002_000)
})

test('load renders text, thinking and a correlated tool call', async () => {
  const [source] = (await adapter.listSources()).filter((s) => s.ref.includes('harness-1'))
  const session = (await adapter.load(source!))!
  assert.equal(session.messages.length, 3)
  assert.equal(session.messages[0]!.role, 'user')
  const tool = session.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool') as Extract<import('../src/core/model.ts').Block, { type: 'tool' }>
  assert.equal(tool.name, 'glob')
  assert.deepEqual(tool.input, { pattern: '*.md' })
  assert.equal(tool.output, 'a.md')
  assert.equal(tool.status, 'ok')
  assert.ok(session.messages.some((m) => m.blocks.some((b) => b.type === 'thinking' && b.text === 'thinking')))
  assert.equal(session.usage?.length, 2)
})

test('a seeded session with no conversation is not a row', async () => {
  const [source] = (await adapter.listSources()).filter((s) => s.ref.includes('harness-seed'))
  assert.equal(await adapter.summarize(source!), null)
  assert.equal(await adapter.load(source!), null)
})

test('the adapter never writes to the harness storage', async () => {
  const before = (await adapter.listSources()).map((s) => s.fingerprint).sort()
  await Promise.all((await adapter.listSources()).map((s) => adapter.load(s)))
  const after = (await adapter.listSources()).map((s) => s.fingerprint).sort()
  assert.deepEqual(after, before)
})

test('a mirrored machine lists DeepSeek Harness, reading that node’s own home, with `dsh` as its program', async () => {
  const { mirrorRoots } = await import('../src/core/util.ts')
  const { adaptersFor } = await import('../src/adapters/index.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-harness-node-'))

  const node = adaptersFor(() => mirrorRoots(home)).find((a) => a.id === 'deepseek-harness')
  assert.ok(node, 'a node lists DeepSeek Harness too, so its card is there even when nothing is installed')
  assert.equal(node.bin, 'dsh') // the node's own program on PATH, never this computer's launcher
  assert.equal(node.storage().path, path.join(home, '.dsh', 'sessions'))

  const dir = path.join(home, '.dsh', 'sessions', '--srv-app--', 'node-1')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'session', version: 4, id: 'node-1', createdAt: 1_700_000_000_000, cwd: '/srv/app' },
    { type: 'user/message', seq: 1, time: 1_700_000_000_100, data: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello from the node' }], source: { kind: 'user' } } },
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''))

  const [source] = await node.listSources()
  assert.equal(source!.ref, path.join(dir, 'session.v4.jsonl'))
  const summary = await node.summarize(source!)
  assert.equal(summary?.id, 'deepseek-harness:node-1')
  assert.equal(summary?.cwd, '/srv/app')
  assert.equal(summary?.title, 'hello from the node')
})
