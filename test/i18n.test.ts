import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DICT } from '../web/src/locales.ts'

const SRC = join(import.meta.dirname, '../web/src')
const LANGS = ['zh-Hans', 'zh-Hant', 'ja']

/** every literal passed to t()/tx() in the web UI, including both arms of `cond ? 'a' : 'b'` */
function literalKeys(): Set<string> {
  const keys = new Set<string>()
  for (const f of readdirSync(SRC).filter((f) => /\.tsx?$/.test(f) && f !== 'locales.ts')) {
    const s = readFileSync(join(SRC, f), 'utf8')
    for (const m of s.matchAll(/\btx?\(\s*(?:[^()'"`]*\?\s*)?(['"])((?:\\.|(?!\1).)*)\1(?:\s*:\s*(['"])((?:\\.|(?!\3).)*)\3)?/g))
      for (const k of [m[2], m[4]]) if (k) keys.add(k.replace(/\\'/g, "'"))
  }
  return keys
}

test('every UI string has a translation in each language', () => {
  for (const lang of LANGS) {
    const missing = [...literalKeys()].filter((k) => !(k in DICT[lang]!))
    assert.deepEqual(missing, [], `${lang} is missing translations`)
  }
})

test('translations keep their {placeholders}', () => {
  for (const lang of LANGS)
    for (const [k, v] of Object.entries(DICT[lang]!)) {
      const ph = (x: string) => (x.match(/\{\w+\}/g) ?? []).sort().join()
      assert.equal(ph(v), ph(k), `${lang}: "${k}" → "${v}"`)
    }
})
