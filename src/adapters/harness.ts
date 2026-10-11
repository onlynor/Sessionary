import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { cleanPrompt, derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import type { AgentAdapter, Block, Message, Session, Source, UsageEntry } from '../core/model.ts'
import { totalsOf } from '../core/usage.ts'
import { dataHome, home, toMs } from '../core/util.ts'

/**
 * DeepSeek Harness (`dsh`) as a Sessionary agent.
 *
 * One resolver, `resolveHarness()`, is the only thing that decides which installation is used: the installed-agent
 * probe reports it (through `bin`), the chat launches exactly that program, and the session reader reads its data.
 * Discovery needs no configuration: a `dsh` on PATH, an npm/pnpm/bun global installation, or a cached `npx`
 * installation. A source checkout is not required, no path is ever shown to a person, and nothing is downloaded,
 * installed or updated at runtime.
 *
 * The resolver validates more than a version string: the package must really be `@deepseek-ai/dsh`, ship the CLI
 * entry point, and boot its `acp` profile (the automation server Sessionary's chat drives). A candidate that
 * cannot do that is not an installation, however new its version. An unsupported (too old) installation is never
 * preferred over a valid one, and when none is valid the agent simply reads as missing.
 *
 * The installation's own model configuration is never touched: Sessionary's Model Control reaches it through a
 * profile patch the server writes per launch (see core/control/agents.ts), and all of the session data lives in
 * Sessionary's own directory, never the person's `~/.dsh`.
 */

export const MIN_VERSION = '0.1.0-rc.8'

type InstallSource = 'env' | 'path' | 'global' | 'cache'

export interface HarnessInstall {
  /** the CLI entry point, e.g. …/@deepseek-ai/dsh/lib/bin.js */
  entry: string
  /** the package directory */
  dir: string
  version: string
  source: InstallSource
}

/** the `dsh` launcher's name inside Sessionary's data directory */
const LAUNCHER = 'dsh'

/** The installation's data is isolated from the person's own `~/.dsh`, in Sessionary's directory. */
function harnessHome(): string {
  return process.env.DSH_HOME || path.join(dataHome(), 'deepseek-harness')
}
if (!process.env.DSH_HOME) process.env.DSH_HOME = harnessHome()
if (!process.env.DSH_AGENTS_HOME) process.env.DSH_AGENTS_HOME = path.join(harnessHome(), 'agents')
if (!process.env.DSH_TELEMETRY_DISABLED) process.env.DSH_TELEMETRY_DISABLED = '1'

/** Parse a version into numeric core segments and prerelease identifiers (numbers sort before strings, as semver). */
function parseVersion(v: string): { core: number[]; pre: (number | string)[] } {
  const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2)
  return {
    core: core.split('.').map((n) => parseInt(n, 10) || 0),
    pre: pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p)) : [],
  }
}

/** Semantic version order, prereleases before their release and numeric identifiers numerically. */
export function compareVersions(a: string, b: string): number {
  const A = parseVersion(a), B = parseVersion(b)
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const d = (A.core[i] ?? 0) - (B.core[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (!A.pre.length || !B.pre.length) return A.pre.length === B.pre.length ? 0 : A.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

/** Read one candidate as an installation, or nothing when it is not `@deepseek-ai/dsh`. */
function readInstall(candidate: string, source: InstallSource): HarnessInstall | null {
  let p = candidate
  try { p = fs.realpathSync(p) } catch { return null }
  let entry: string | undefined
  let dir: string | undefined
  const stat = fs.statSync(p, { throwIfNoEntry: false })
  if (stat?.isFile()) {
    if (!p.endsWith('.js')) return null
    entry = p
    dir = path.dirname(path.dirname(p))
  } else if (stat?.isDirectory()) {
    for (const c of [path.join(p, 'lib', 'bin.js'), path.join(p, 'apps', 'cli', 'lib', 'bin.js')]) {
      if (fs.existsSync(c)) { entry = c; dir = path.dirname(path.dirname(c)); break }
    }
  }
  if (!entry || !dir) return null
  let pkg: { name?: string; version?: string }
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
  if (pkg.name !== '@deepseek-ai/dsh' || typeof pkg.version !== 'string') return null
  return { entry, dir, version: pkg.version, source }
}

/** Whether this entry point really boots the ACP profile Sessionary's chat drives. */
function bootsAcp(entry: string): boolean {
  try {
    const r = spawnSync(process.execPath, [entry, '--profile', 'acp', '--help'], {
      timeout: 20_000, encoding: 'utf8', env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    })
    // the entry point, the `acp` profile, and its own words: not just an exit code
    return r.status === 0 && /Agent Client Protocol/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  } catch { return false }
}

/** A `dsh` executable on PATH, if there is one. */
function fromPath(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* keep looking */ }
  }
}

/** The node_modules directories global package managers install into. */
function globalRoots(): string[] {
  const roots = [
    process.env.NPM_CONFIG_PREFIX && path.join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'),
    process.env.PNPM_HOME && path.join(process.env.PNPM_HOME, 'global', '5', 'node_modules'),
    process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'install', 'global', 'node_modules'),
    path.join(home(), '.bun', 'install', 'global', 'node_modules'),
    path.join(home(), '.npm-global', 'lib', 'node_modules'),
    path.join(home(), '.local', 'lib', 'node_modules'),
    path.join(home(), '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ]
  for (const g of [path.join(home(), '.local', 'share', 'pnpm', 'global')]) {
    try { for (const v of fs.readdirSync(g)) roots.push(path.join(g, v, 'node_modules')) } catch { /* none */ }
  }
  return roots.filter((r): r is string => !!r)
}

/** Installations npx left in its cache. */
function cacheRoots(): string[] {
  const cache = process.env.npm_config_cache || path.join(home(), '.npm')
  try { return fs.readdirSync(path.join(cache, '_npx')).map((d) => path.join(cache, '_npx', d, 'node_modules')) } catch { return [] }
}

let resolved: HarnessInstall | null | undefined

/**
 * The one installation Sessionary uses, or null when there is none that can serve ACP. SESSIONARY_DSH (a
 * development override) always wins; otherwise the newest supported installation wins, and a stale cached one can
 * never hide a valid one.
 */
export function resolveHarness(force = false): HarnessInstall | null {
  if (!force && resolved !== undefined) return resolved
  const candidates: [string | undefined, InstallSource][] = [
    [process.env.SESSIONARY_DSH, 'env'],
    [fromPath(), 'path'],
    ...globalRoots().map((r) => [path.join(r, '@deepseek-ai', 'dsh'), 'global'] as [string, InstallSource]),
    ...cacheRoots().map((r) => [path.join(r, '@deepseek-ai', 'dsh'), 'cache'] as [string, InstallSource]),
  ]
  const rank: Record<InstallSource, number> = { env: 0, path: 1, global: 2, cache: 3 }
  const found: HarnessInstall[] = []
  for (const [candidate, source] of candidates) {
    if (!candidate) continue
    const install = readInstall(candidate, source)
    if (install && compareVersions(install.version, MIN_VERSION) >= 0) found.push(install)
  }
  found.sort((a, b) => compareVersions(b.version, a.version) || rank[a.source] - rank[b.source])
  const chosen = found.find((i) => bootsAcp(i.entry))
  resolved = chosen ?? null
  return resolved
}

/**
 * The program Sessionary runs Harness with: a small launcher beside Sessionary's data that runs the resolved
 * entry point with the very Node.js this server runs on (the app's bundled runtime in a packaged build). The chat
 * and the installed-agent probe both use it, so they cannot disagree about which installation is in use.
 */
export function harnessBin(): string {
  const install = resolveHarness()
  if (!install) return LAUNCHER
  const dir = path.join(dataHome(), 'harness', 'bin')
  const file = path.join(dir, process.platform === 'win32' ? `${LAUNCHER}.cmd` : LAUNCHER)
  const body = process.platform === 'win32'
    ? `@echo off\r\nrem Sessionary: DeepSeek Harness ${install.version}\r\n"${process.execPath}" "${install.entry}" %*\r\n`
    : `#!/bin/sh\n# Sessionary: DeepSeek Harness ${install.version} — the installation resolveHarness() chose, run with the Node.js this server runs on.\nexec "${process.execPath}" "${install.entry}" "$@"\n`
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body)
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755)
  } catch { return install.entry }
  return file
}

// ---- reading the installation's own sessions (never written, never copied) ----

/** Zstandard's frame magic: the harness appends one frame per commit, so a log may hold many. */
const FRAME = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decompress every frame of a harness log, or read it as plain UTF-8 when it is not compressed. */
export function decodeLog(buf: Buffer): string {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(FRAME)) return buf.toString('utf8')
  const starts: number[] = []
  for (let i = 0; (i = buf.indexOf(FRAME, i)) >= 0; i += 4) starts.push(i)
  const parts: Buffer[] = []
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]! : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end))) } catch { /* skip a damaged frame */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')

function blocksOf(content: unknown): Block[] {
  const out: Block[] = []
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ type: 'text', text: c.text })
    else if (c?.type === 'reasoning' && typeof c.text === 'string' && c.text.trim()) out.push({ type: 'thinking', text: c.text })
  }
  return out
}

const jsonOf = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

async function parse(source: Source): Promise<Session | null> {
  let raw: string
  try { raw = decodeLog(await fs.promises.readFile(source.ref)) } catch { return null }

  let header: any
  const messages: Message[] = []
  const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
  const usage: UsageEntry[] = []
  let title: string | undefined
  let model: string | undefined
  let firstPrompt: string | undefined
  let last = 0

  for (const line of raw.split('\n')) {
    if (!line) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'session') { header = e; last = toMs(e.createdAt) ?? last; continue }
    const t = toMs(e.time) ?? last
    const d = e.data ?? {}
    switch (e.type) {
      case 'user/message': {
        // the harness's own runtime context is not something a person typed
        if (d.source?.kind !== 'user') break
        const blocks = blocksOf(d.content)
        if (!blocks.length) break
        firstPrompt ??= (Array.isArray(d.content) ? d.content : []).map((c: any) => cleanPrompt(c?.text)).find(Boolean)
        messages.push({ id: d.id ?? `u${e.seq}`, role: 'user', time: t, blocks })
        break
      }
      case 'assistant/message': {
        const m = d.message ?? {}
        const blocks: Block[] = []
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) blocks.push({ type: 'text', text: c.text })
          else if (c?.type === 'reasoning' && typeof c.text === 'string' && c.text.trim()) blocks.push({ type: 'thinking', text: c.text })
          else if (c?.type === 'tool-call') {
            const tb: Extract<Block, { type: 'tool' }> = { type: 'tool', id: c.id, name: c.name, input: jsonOf(c.arguments), status: 'pending' }
            tools.set(c.id, tb)
            blocks.push(tb)
          }
        }
        // the model id is the pi-ai route target a Sessionary route chose (`provider/model` or `group/id`)
        if (typeof m.source?.model === 'string') model = m.source.model
        if (blocks.length) messages.push({ id: m.id ?? `a${e.seq}`, role: 'assistant', time: t, model, blocks })
        if (d.usage) {
          const u = d.usage
          usage.push({ time: t, model, input: Number(u.inputTokens) || 0, output: Number(u.outputTokens) || 0, cacheRead: Number(u.cachedInputTokens) || 0, cacheWrite: 0 })
        }
        break
      }
      case 'tool/result': {
        const m = d.message ?? {}
        const tb = m.toolCallId ? tools.get(m.toolCallId) : undefined
        if (tb) { tb.output = textOf(m.content); tb.status = m.isError ? 'error' : 'ok' }
        break
      }
      case 'session/title': if (typeof d.title === 'string' && d.title.trim()) title = d.title; break
    }
    if (t > last) last = t
  }

  if (!header?.id) return null
  if (!firstPrompt && !messages.some((m) => m.role === 'assistant')) return null
  const created = toMs(header.createdAt) ?? 0
  return {
    id: `deepseek-harness:${header.id}`,
    agent: 'deepseek-harness',
    nativeId: header.id,
    title: pickTitle([title], firstPrompt, fallbackTitle(messages, created)),
    cwd: header.cwd,
    model,
    createdAt: created,
    updatedAt: last || created,
    messageCount: messages.length,
    ...totalsOf(usage),
    ...derive(messages),
    messages,
    usage,
  }
}

export const makeHarness = (): AgentAdapter => {
  const root = () => path.join(harnessHome(), 'sessions')
  return {
    id: 'deepseek-harness',
    label: 'DeepSeek Harness',
    // the resolved launcher's absolute path, or `dsh` so the ordinary probe reports the ordinary missing state
    bin: harnessBin(),

    async listSources() {
      const out: Source[] = []
      let projects
      try { projects = await fs.promises.readdir(root(), { withFileTypes: true }) } catch { return out }
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const dir = path.join(root(), project.name)
        let sessions
        try { sessions = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
        for (const session of sessions) {
          if (!session.isDirectory()) continue
          let files
          try { files = await fs.promises.readdir(path.join(dir, session.name)) } catch { continue }
          const file = files.find((f) => /^session\.v\d+\.jsonl(\.zst|\.zstd)?$/.test(f))
          if (!file) continue
          const ref = path.join(dir, session.name, file)
          const st = await fs.promises.stat(ref).catch(() => null)
          if (st) out.push({ key: ref, ref, fingerprint: `${st.size}:${Math.floor(st.mtimeMs)}` })
        }
      }
      return out
    },
    async summarize(source) {
      const s = await parse(source)
      if (!s) return null
      const { messages, usage, ...summary } = s
      return summary
    },
    load: (source) => parse(source),

    storage() { return { path: root(), watch: [{ path: root(), recursive: true }] } },
    newCommand(cwd) { return { bin: harnessBin(), args: ['--profile', 'tui'], cwd } },
    resumeCommand(_source, session) { return { bin: harnessBin(), args: ['--profile', 'tui', '--resume', session.nativeId], cwd: session.cwd ?? '' } },
  }
}

export const harness = makeHarness()
