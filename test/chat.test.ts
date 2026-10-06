import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  assert.equal(ch.state, 'idle')
  assert.deepEqual(ch.info.models?.map((m) => m.id), ['default', 'haiku'])
  assert.equal(ch.info.commands?.[0]?.name, 'compact')
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
  await assert.rejects(chats.open({ agent: 'claude-code', machine: 'local', cwd: tmpdir() }))
  await chats.stopAll()
})

test('textDiff shows only what changed, with context', () => {
  assert.equal(textDiff('f', '', 'a'), '@@ f\n+a')
  const d = textDiff('f', 'a\nb\nc', 'a\nB\nc')
  assert.ok(d.includes('-b') && d.includes('+B') && d.includes(' a'))
})
