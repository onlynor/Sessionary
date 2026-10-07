import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-usage-'))
process.env.SESSIONARY_HOME = path.join(tmp, 'home')
const { usageByDay, totalsOf, dayKey } = await import('../src/core/usage.ts')
const { IndexStore } = await import('../src/core/index-store.ts')
const { OverlayStore } = await import('../src/core/overlay.ts')
const { ControlStore } = await import('../src/core/control/store.ts')
const { createApp } = await import('../src/server/app.ts')

const at = (s: string) => new Date(s).getTime() // local time, as the days are
const e = (time: string, input: number, extra: Partial<{ output: number; cacheRead: number; cacheWrite: number; cost: number; model: string }> = {}) =>
  ({ time: at(time), input, output: 0, cacheRead: 0, cacheWrite: 0, ...extra })

test('a session that runs past midnight counts on both days, split by model', () => {
  const rows = usageByDay({ updatedAt: at('2026-03-02T01:00:00'), model: 'm1' }, [
    e('2026-03-01T23:50:00', 10, { cacheRead: 100, output: 5 }),
    e('2026-03-01T23:55:00', 20, { model: 'm2', cost: 0.5 }),
    e('2026-03-02T00:10:00', 30, { cacheWrite: 7, output: 1, cost: 0.25 }),
    e('2026-03-02T00:20:00', 0), // a call that recorded nothing is not a request
  ])
  assert.deepEqual(rows, [
    { day: '2026-03-01', model: 'm1', input: 10, output: 5, cacheRead: 100, cacheWrite: 0, requests: 1 },
    { day: '2026-03-01', model: 'm2', input: 20, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1, cost: 0.5 },
    { day: '2026-03-02', model: 'm1', input: 30, output: 1, cacheRead: 0, cacheWrite: 7, requests: 1, cost: 0.25 },
  ])
  // the totals the lists show count everything read, cached or not
  assert.deepEqual(totalsOf([e('2026-03-01T10:00:00', 10, { cacheRead: 100, cacheWrite: 7, output: 5 })]), { tokens: { input: 117, output: 5 } })
})

test('an agent that keeps only a session total counts it on the day the session was last active', () => {
  assert.deepEqual(usageByDay({ updatedAt: at('2026-03-05T12:00:00'), model: 'x', tokens: { input: 40, output: 4 }, cost: 1 }, undefined),
    [{ day: '2026-03-05', model: 'x', input: 40, output: 4, cacheRead: 0, cacheWrite: 0, requests: 1, cost: 1 }])
  assert.deepEqual(usageByDay({ updatedAt: 0 }, []), [])
  assert.equal(dayKey(at('2026-12-31T23:59:59')), '2026-12-31')
})

test('the index keeps each session’s days, replaces them when the session changes, and serves them by date', async () => {
  const store = new IndexStore(':memory:')
  const s = { id: 'pi:a', agent: 'pi', nativeId: 'a', title: 't', createdAt: at('2026-03-01T09:00:00'), updatedAt: at('2026-03-02T09:00:00'), messageCount: 2 }
  store.upsert('pi', 'k', '1', s, [], [e('2026-03-01T09:00:00', 5), e('2026-03-02T09:00:00', 7)])
  assert.deepEqual(store.usage().map((r) => [r.day, r.input, r.sessionId, r.agent]), [['2026-03-01', 5, 'pi:a', 'pi'], ['2026-03-02', 7, 'pi:a', 'pi']])
  store.upsert('pi', 'k', '2', s, [], [e('2026-03-02T09:00:00', 9)])
  assert.deepEqual(store.usage().map((r) => [r.day, r.input]), [['2026-03-02', 9]])
  assert.deepEqual(store.usage('2026-03-03'), [])

  const { app } = createApp(store, undefined, new OverlayStore(':memory:'), { port: 4999 })
  const rows = await (await app.request('/api/usage?since=2026-03-01', { headers: { host: 'localhost' } })).json() as any[]
  assert.deepEqual(rows.map((r) => [r.day, r.input, r.requests]), [['2026-03-02', 9, 1]])
  store.remove('pi', 'k')
  assert.deepEqual(store.usage(), [])
})

test('gateway usage: old OpenAI-style rows are corrected once, and requests are summed per day', () => {
  // a control.db from before cache writes were recorded: input then included the cached tokens for chat/responses
  const file = path.join(tmp, 'old-control.db')
  const db = new DatabaseSync(file)
  db.exec(`create table usage (at integer not null, agent text not null, target text not null, provider text not null, model text not null,
    protocol text not null, status integer not null, ms integer not null, input integer not null default 0,
    output integer not null default 0, cache_read integer not null default 0, error text, tries integer not null default 1)`)
  const ins = db.prepare('insert into usage (at, agent, target, provider, model, protocol, status, ms, input, output, cache_read, tries) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  ins.run(at('2026-03-01T10:00:00'), 'codex', 'group/fast', 'p', 'm', 'responses', 200, 10, 100, 5, 60, 1)
  ins.run(at('2026-03-01T11:00:00'), 'claude-code', 'p/m', 'p', 'm', 'anthropic', 200, 10, 40, 5, 60, 2)
  ins.run(at('2026-03-01T12:00:00'), 'claude-code', 'p/m', 'p', 'm', 'anthropic', 529, 10, 0, 0, 0, 1)
  db.close()
  const control = new ControlStore(file)
  assert.deepEqual(control.usage().map((r) => [r.protocol, r.input, r.cacheRead]).sort(), [['anthropic', 0, 0], ['anthropic', 40, 60], ['responses', 40, 60]])
  new ControlStore(file).close() // opening again changes nothing more
  assert.deepEqual(new ControlStore(file).usage().find((r) => r.protocol === 'responses')?.input, 40)
  const days = control.usageDays('2026-03-01')
  assert.deepEqual(days.map((d) => [d.day, d.agent, d.route, d.model, d.requests, d.failed, d.input]).sort(), [
    ['2026-03-01', 'claude-code', 'p/m', 'p/m', 2, 1, 40],
    ['2026-03-01', 'codex', 'group/fast', 'p/m', 1, 0, 40],
  ])
  assert.deepEqual(control.usageDays('2026-03-02'), [])
})
