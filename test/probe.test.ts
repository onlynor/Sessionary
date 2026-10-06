import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-probe-'))
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'c')
process.env.CODEX_HOME = path.join(tmp, 'x')
process.env.WORKBUDDY_HOME = path.join(tmp, 'w')
process.env.WORKBUDDY_AI_HOME = path.join(tmp, 'wa')
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'p')
process.env.XDG_DATA_HOME = path.join(tmp, 'xdg')
process.env.HERMES_HOME = path.join(tmp, 'h')
process.env.SESSIONARY_HOME = path.join(tmp, 'sessionary')
process.env.SESSIONARY_PROBE_FRESH_MS = '60000'

// stand-in programs: each start is logged, and takes a moment, like a Node-based CLI on a small server
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
const log = path.join(tmp, 'runs.log')
for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> "${log}"\nsleep 0.4\necho "${name} 1.0.0"\n`, { mode: 0o755 })
}
process.env.PATH = `${bin}:${process.env.PATH}`

const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { createApp } = await import('../src/server/app.ts')

const runs = (name: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === name).length : 0)
async function controller() {
  const { app, stopRuns } = createApp(new IndexStore(':memory:'), undefined, new OverlayStore(':memory:'))
  const get = async (url: string) => { const t = Date.now(); const r = await app.request(url, { headers: { host: 'localhost' } }); return { body: (await r.json()) as any, ms: Date.now() - t } }
  return { get, stopRuns }
}

test('agent detection is remembered: a repeat is instant, an unchanged program is not run again, a rescan sees changes', async () => {
  const c = await controller()
  try {
    const first = await c.get('/api/machines/local/agents')
    assert.equal(first.body.agents.find((a: any) => a.id === 'claude-code').version, '1.0.0')
    assert.equal(first.body.agents.find((a: any) => a.id === 'codex').version, '1.0.0')
    assert.ok(first.ms >= 350, 'the first look has to ask the programs')
    // the programs that had to be asked were asked at the same time, not one after the other
    assert.ok(first.ms < 1500, `took ${first.ms}ms`)
    assert.equal(runs('claude'), 1)

    // the next look is the remembered answer, and it survives a restart because it is on disk
    const second = await c.get('/api/machines/local/agents')
    assert.ok(second.ms < 150, `took ${second.ms}ms`)
    assert.equal(second.body.agents.find((a: any) => a.id === 'claude-code').version, '1.0.0')
    assert.ok(fs.existsSync(path.join(tmp, 'sessionary', 'probe-cache.json')))

    // a forced look finds out again, but the program file is unchanged so nobody is asked for a version
    const forced = await c.get('/api/machines/local/agents?refresh=1')
    assert.equal(runs('claude'), 1)
    assert.ok(forced.ms < 400, `took ${forced.ms}ms`)
    assert.equal(forced.body.agents.find((a: any) => a.id === 'claude-code').version, '1.0.0')

    // a program that was updated is asked again
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho claude >> "${log}"\necho "claude 2.0.0"\n`, { mode: 0o755 })
    const updated = await c.get('/api/machines/local/agents?refresh=1')
    assert.equal(updated.body.agents.find((a: any) => a.id === 'claude-code').version, '2.0.0')
    assert.equal(runs('claude'), 2)
    assert.equal(runs('codex'), 1)
  } finally { c.stopRuns() }
})

test('an old answer is given at once and refreshed behind the scenes', async () => {
  process.env.SESSIONARY_PROBE_FRESH_MS = '0'
  const c = await controller() // reads the setting when it is created
  try {
    await c.get('/api/machines/local/agents?refresh=1')
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho codex >> "${log}"\necho "codex 3.0.0"\n`, { mode: 0o755 })
    const stale = await c.get('/api/machines/local/agents')
    assert.ok(stale.ms < 150, `took ${stale.ms}ms`)
    assert.equal(stale.body.refreshing, true)
    assert.equal(stale.body.agents.find((a: any) => a.id === 'codex').version, '1.0.0') // the old answer
    await new Promise((r) => setTimeout(r, 900))
    const fresh = await c.get('/api/machines/local/agents')
    assert.equal(fresh.body.agents.find((a: any) => a.id === 'codex').version, '3.0.0') // what the background look found
  } finally { process.env.SESSIONARY_PROBE_FRESH_MS = '60000'; c.stopRuns() }
})
