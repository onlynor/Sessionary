import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionary-harness-resolver-'))

/** a package laid out as npm installs `@deepseek-ai/dsh`; `acp` decides whether the profile boots */
function fakeInstall(name: string, version: string, acp = true): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), acp
    ? "// stand-in for the real CLI: only the ACP profile probe matters here\nif (process.argv.includes('--help')) console.log('Serve automation clients over Agent Client Protocol stdio.')\nprocess.exit(0)\n"
    : 'process.exit(1)\n')
  return dir
}

const supported = fakeInstall('supported', '0.2.1-alpha.2')
const old = fakeInstall('old', '0.1.0-rc.6')
const broken = fakeInstall('broken', '0.3.0', false)

const { resolveHarness, compareVersions } = await import('../src/adapters/harness.ts')

test('semantic version order handles prereleases and numeric identifiers', () => {
  assert.equal(compareVersions('0.1.0-rc.10', '0.1.0-rc.8'), 1)
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.0-rc.2'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1)
  assert.equal(compareVersions('0.1.0-rc.8', '0.1.0-rc.8'), 0)
})

test('a named, supported installation resolves and passes the ACP launch check', () => {
  process.env.SESSIONARY_DSH = supported
  const r = resolveHarness(true)
  assert.equal(r?.version, '0.2.1-alpha.2')
  assert.equal(r?.source, 'env')
  assert.equal(r?.entry, path.join(supported, 'lib', 'bin.js'))
})

test('an unsupported (too old) installation is never used', () => {
  process.env.SESSIONARY_DSH = old
  assert.equal(resolveHarness(true), null)
})

test('an installation whose ACP profile does not boot is refused, whatever its version', () => {
  process.env.SESSIONARY_DSH = broken
  assert.equal(resolveHarness(true), null)
})

test('nothing named and nothing installed resolves to no installation', () => {
  delete process.env.SESSIONARY_DSH
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX }
  process.env.PATH = path.join(tmp, 'empty-path')
  process.env.HOME = path.join(tmp, 'empty-home')
  process.env.NPM_CONFIG_PREFIX = path.join(tmp, 'empty-prefix')
  try { assert.equal(resolveHarness(true), null) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
