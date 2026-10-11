import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'

const { PRESETS, presetOf } = await import('../src/core/control/presets.ts')
const { joinUrl } = await import('../src/core/control/store.ts')
const { listModels, mergeModels } = await import('../src/core/control/catalog.ts')

// ---- fake upstreams: record what was asked for, answer as told ----
type Reply = (req: http.IncomingMessage, res: http.ServerResponse) => void
const servers: http.Server[] = []
async function upstream(reply: Reply): Promise<{ url: string; seen: { path: string; headers: http.IncomingHttpHeaders }[] }> {
  const seen: { path: string; headers: http.IncomingHttpHeaders }[] = []
  const s = http.createServer((req, res) => { seen.push({ path: req.url ?? '', headers: req.headers }); reply(req, res) })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  servers.push(s)
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen }
}
after(() => { for (const s of servers) s.close() })

const json = (body: unknown): Reply => (_r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

/** a stored provider; `preset` can be one that no longer exists */
const provider = (endpoints: Record<string, string>, over: Record<string, unknown> = {}) =>
  ({ id: 'p', name: 'P', preset: 'minimax', endpoints, key: 'sk-test', models: [], on: true, at: 0, ...over }) as any

const CLOUD = ['anthropic', 'openai', 'deepseek', 'moonshot', 'zhipu', 'gemini', 'xai', 'openrouter']

test('the cloud presets are exactly the eight kept, and the rest are local, gateway and compatible', () => {
  assert.deepEqual(PRESETS.filter((p) => p.kind === 'vendor').map((p) => p.id), CLOUD)
  assert.deepEqual(PRESETS.filter((p) => p.kind === 'local').map((p) => p.id).sort(), ['lmstudio', 'ollama'])
  assert.deepEqual(PRESETS.filter((p) => p.kind === 'gateway').map((p) => p.id), ['magpie'])
  assert.deepEqual(PRESETS.filter((p) => p.kind === 'custom').map((p) => p.id), ['custom-openai', 'custom-anthropic'])
})

test('the removed vendors are gone, but connect through the compatible endpoints', () => {
  for (const id of ['minimax', 'zai', 'qwen', 'mistral', 'groq', 'siliconflow']) assert.equal(presetOf(id), undefined, id)
  assert.equal(presetOf('custom-openai')!.endpoints.chat, '')
  assert.equal(presetOf('custom-anthropic')!.endpoints.anthropic, '')
})

test('a preset offers exactly the protocols its endpoints name', () => {
  const protocols = (id: string) => Object.keys(presetOf(id)!.endpoints).sort()
  assert.deepEqual(protocols('anthropic'), ['anthropic'])
  assert.deepEqual(protocols('openai'), ['chat', 'responses'])
  assert.deepEqual(protocols('gemini'), ['chat']) // only its OpenAI-compatible endpoint, never generateContent
  assert.deepEqual(protocols('openrouter'), ['anthropic', 'chat', 'responses'])
  assert.deepEqual(protocols('ollama'), ['anthropic', 'chat'])
})

test('every vendor and local preset ships a real icon file', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'providers')
  for (const p of PRESETS.filter((x) => x.kind === 'vendor' || x.kind === 'local')) {
    assert.ok(p.icon, `${p.id} has no icon`)
    const file = fs.readFileSync(path.join(dir, p.icon + '.svg'), 'utf8')
    assert.match(file, /^<svg[\s>]/, `${p.icon}.svg is not an SVG`)
  }
})

test('endpoint joining never doubles a suffix', () => {
  assert.equal(joinUrl('https://api.openai.com/v1', '/chat/completions'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(joinUrl('https://api.openai.com/v1/', '/models'), 'https://api.openai.com/v1/models')
  assert.equal(joinUrl('https://api.anthropic.com', '/v1/messages'), 'https://api.anthropic.com/v1/messages')
  // a pasted full path is not doubled
  assert.equal(joinUrl('https://api.openai.com/v1/chat/completions', '/chat/completions'), 'https://api.openai.com/v1/chat/completions')
})

test('model discovery reads the OpenAI list from a chat endpoint', async () => {
  const listing = await upstream(json({ data: [{ id: 'alpha', context_length: 8000 }, { id: 'beta' }] }))
  const models = await listModels(provider({ chat: listing.url + '/v1' }))
  assert.deepEqual(models.map((m) => m.id), ['alpha', 'beta'])
  assert.equal(listing.seen[0]!.path, '/v1/models')
  assert.equal(listing.seen[0]!.headers.authorization, 'Bearer sk-test')
})

test('model discovery reads the Anthropic list from an Anthropic endpoint', async () => {
  const listing = await upstream(json({ data: [{ id: 'claude', display_name: 'Claude' }] }))
  const models = await listModels(provider({ anthropic: listing.url }, { key: 'sk-ant' }))
  assert.deepEqual(models.map((m) => m.id), ['claude'])
  assert.equal(listing.seen[0]!.path, '/v1/models?limit=1000')
  assert.equal(listing.seen[0]!.headers['x-api-key'], 'sk-ant')
})

test('a provider whose list cannot be read fails, and hand-added models survive a refresh', async () => {
  const bad = await upstream((_r, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'no list here' } })) })
  await assert.rejects(() => listModels(provider({ chat: bad.url + '/v1' })), /no list here/)

  // nothing listed and hand-added models kept
  assert.deepEqual(mergeModels([], [{ id: 'kept', on: true, manual: true }]).map((m) => m.id), ['kept'])
  // a switch the user turned off stays off; a hand-added model the provider now lists is not duplicated
  assert.deepEqual(
    mergeModels([{ id: 'a', on: true }, { id: 'b', on: true }], [{ id: 'a', on: false }, { id: 'gone', on: true, manual: true }]),
    [{ id: 'a', on: false }, { id: 'b', on: true }, { id: 'gone', on: true, manual: true }],
  )
})

test('a saved provider whose preset was removed still works from its own endpoints', async () => {
  // `minimax` is no longer a preset; the provider keeps its endpoints and key, so discovery and the gateway still work
  const listing = await upstream(json({ data: [{ id: 'm1' }] }))
  const p = provider({ chat: listing.url + '/v1' }, { preset: 'minimax' })
  assert.equal(presetOf(p.preset), undefined)
  const models = await listModels(p)
  assert.deepEqual(models.map((m) => m.id), ['m1'])
})
