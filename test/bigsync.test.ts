import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-bigsync-'))
const remoteHome = path.join(tmp, 'remote-home')
const fakeSsh = path.join(tmp, 'ssh')
fs.writeFileSync(fakeSsh, `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -o|-p|-i|-O|-l|-F) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "${remoteHome}"
HOME="${remoteHome}" exec sh -c "$*"
`, { mode: 0o755 })

const { Mirror } = await import('../src/core/sync.ts')

const transcript = path.join(remoteHome, '.claude', 'projects', '-srv-app', 'c1.jsonl')
const bigDb = path.join(remoteHome, '.local', 'share', 'opencode', 'opencode.db')
const MB = 1024 * 1024
fs.mkdirSync(path.dirname(transcript), { recursive: true })
fs.mkdirSync(path.dirname(bigDb), { recursive: true })
fs.writeFileSync(transcript, '{"type":"user"}\n')
const content = randomBytes(6 * MB)
fs.writeFileSync(bigDb, content)

const mirror = (name: string, rsyncBin?: string) => new Mirror(path.join(tmp, name), { host: 'h.example.com' }, fakeSsh, 'tar', rsyncBin)
const exists = (p: string) => fs.existsSync(p)

test('the small transcripts arrive first and the node is usable while the big database is still coming', async () => {
  const m = mirror('a')
  const plan = await m.plan()
  assert.equal(plan.rsync, true)
  let atTranscripts: { transcript: boolean; db: boolean; stage?: string } | undefined
  const r = await m.apply(plan, () => {
    atTranscripts = { transcript: exists(path.join(m.home, '.claude/projects/-srv-app/c1.jsonl')), db: exists(path.join(m.home, '.local/share/opencode/opencode.db')), stage: m.info.stage }
  })
  assert.deepEqual(atTranscripts, { transcript: true, db: false, stage: 'databases' }) // at that moment only the transcript is here
  assert.deepEqual(r, { transcripts: true, databases: true })
  assert.ok(exists(path.join(m.home, '.local/share/opencode/opencode.db')))
  assert.equal(m.info.bytesTotal, 6 * MB + 16)
  assert.equal(m.info.bytesDone, m.info.bytesTotal)
  assert.equal(m.info.pending, 0)
})

test('a changed database costs the changed blocks, not the file (rsync), and the copy is exact', async () => {
  const m = mirror('b')
  await m.apply(await m.plan())
  assert.ok(m.info.wire! > 5 * MB, 'the first copy moves the whole file') // random data does not compress
  // change a few kilobytes in the middle, and say so with a newer timestamp
  const edited = Buffer.from(content)
  randomBytes(4096).copy(edited, 3 * MB)
  fs.writeFileSync(bigDb, edited)
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(bigDb, t, t)
  const plan = await m.plan()
  assert.deepEqual(plan.fetch, ['.local/share/opencode/opencode.db'])
  await m.apply(plan)
  assert.ok(m.info.wire! < 300 * 1024, `moved ${m.info.wire} bytes for a 4 KB change`)
  assert.ok(fs.readFileSync(path.join(m.home, '.local/share/opencode/opencode.db')).equals(edited))
  // nothing changed: nothing to do
  assert.deepEqual((await m.plan()).fetch, [])
})

test('without rsync the same files arrive through tar', async () => {
  const m = mirror('c', '/nonexistent/rsync')
  const plan = await m.plan()
  assert.equal(plan.rsync, false)
  await m.apply(plan)
  assert.ok(fs.readFileSync(path.join(m.home, '.local/share/opencode/opencode.db')).equals(fs.readFileSync(bigDb)))
  assert.ok(m.info.wire! >= 6 * MB)
  assert.equal(m.info.bytesDone, m.info.bytesTotal)
})
