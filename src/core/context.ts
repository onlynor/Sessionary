import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { toolKind, toolPath } from './derive.ts'
import type { Block, Session } from './model.ts'

const run = promisify(execFile)

export interface ProjectContext {
  /** where the directory came from – always the session's own record, never guessed */
  cwd?: string
  cwdExists: boolean
  git?: {
    root: string
    branch?: string
    head?: string
    dirty: number
    status: { code: string; path: string }[]
    recent: { hash: string; subject: string; date: string }[]
  }
  /** files the agent touched during this session, from its own tool calls */
  touchedFiles: { path: string; count: number; changed: boolean }[]
  toolUsage: { name: string; count: number }[]
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=', ...args], { cwd, timeout: 8000, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    return stdout
  } catch {
    return null
  }
}

function touchedFrom(blocks: Block[], files: Map<string, number>, changed: Set<string>, tools: Map<string, number>) {
  for (const b of blocks) {
    if (b.type !== 'tool') continue
    const kn = toolKind(b.name) === 'other' ? b.name : toolKind(b.name)
    tools.set(kn, (tools.get(kn) ?? 0) + 1)
    const p = toolPath(b.input)
    if (p) {
      files.set(p, (files.get(p) ?? 0) + 1)
      if (['edit', 'write'].includes(toolKind(b.name))) changed.add(p)
    }
  }
}

export async function projectContext(session: Session): Promise<ProjectContext> {
  const files = new Map<string, number>()
  const changed = new Set<string>()
  const tools = new Map<string, number>()
  for (const m of session.messages) touchedFrom(m.blocks, files, changed, tools)

  const ctx: ProjectContext = {
    cwd: session.cwd,
    cwdExists: false,
    touchedFiles: [...files].map(([path, count]) => ({ path, count, changed: changed.has(path) })).sort((a, b) => b.count - a.count),
    toolUsage: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  }
  if (!session.cwd) return ctx
  try { ctx.cwdExists = (await fs.stat(session.cwd)).isDirectory() } catch { return ctx }

  // Git state is *current* state of that directory, not a reconstruction of the session's moment in time.
  const root = (await git(session.cwd, 'rev-parse', '--show-toplevel'))?.trim()
  if (!root) return ctx
  const [branch, head, status, log] = await Promise.all([
    git(root, 'branch', '--show-current'),
    git(root, 'rev-parse', '--short', 'HEAD'),
    git(root, 'status', '--porcelain=v1', '-uall'),
    git(root, 'log', '-8', '--format=%h%x09%aI%x09%s'),
  ])
  const lines = (status ?? '').split('\n').filter(Boolean)
  ctx.git = {
    root: path.normalize(root),
    branch: branch?.trim() || undefined,
    head: head?.trim() || undefined,
    dirty: lines.length,
    status: lines.slice(0, 200).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) })),
    recent: (log ?? '').split('\n').filter(Boolean).map((l) => {
      const [hash = '', date = '', ...subject] = l.split('\t')
      return { hash, date, subject: subject.join('\t') }
    }),
  }
  return ctx
}

export interface ChangedFile { path: string; status: string; add?: number; del?: number }
export interface Changes { root: string; files: ChangedFile[] }

const MAX_PATCH = 300_000

/** Repo root for a session's cwd, or null when it is gone / not a repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try { await fs.stat(cwd) } catch { return null }
  const r = (await git(cwd, 'rev-parse', '--show-toplevel'))?.trim()
  return r ? path.normalize(r) : null
}

/** Working tree vs HEAD. This is the repository's current state, not something tied to the session. */
export async function gitChanges(cwd: string): Promise<Changes | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const [status, numstat] = await Promise.all([
    git(root, 'status', '--porcelain=v1', '-uall', '--no-renames'),
    git(root, 'diff', 'HEAD', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv'),
  ])
  const counts = new Map<string, { add?: number; del?: number }>()
  for (const l of (numstat ?? '').split('\n')) {
    const [a, d, ...p] = l.split('\t')
    if (p.length) counts.set(p.join('\t'), a === '-' ? {} : { add: Number(a), del: Number(d) })
  }
  const files = (status ?? '').split('\n').filter(Boolean).slice(0, 500).map((l): ChangedFile => {
    const p = l.slice(3)
    return { path: p, status: l.slice(0, 2).trim()[0] ?? '?', ...counts.get(p) }
  })
  return { root, files }
}

const addedPatch = (rel: string, text: string) => {
  const lines = text.replace(/\n$/, '').split('\n')
  return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`
}

/** Unified diff of one file against HEAD. Untracked files are shown as fully added. */
export async function gitFileDiff(cwd: string, rel: string): Promise<{ patch: string; truncated: boolean; binary?: boolean } | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const abs = path.resolve(root, rel)
  const inside = path.relative(root, abs)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null // stay inside the repository

  const tracked = (await git(root, 'ls-files', '--error-unmatch', '--', inside)) != null
  let patch: string
  if (tracked) {
    patch = (await git(root, 'diff', 'HEAD', '--no-renames', '--no-ext-diff', '--no-textconv', '-U3', '--', inside)) ?? ''
  } else {
    let buf: Buffer
    try { buf = await fs.readFile(abs) } catch { return { patch: '', truncated: false } }
    if (buf.includes(0)) return { patch: '', truncated: false, binary: true }
    patch = addedPatch(inside.replace(/\\/g, '/'), buf.subarray(0, MAX_PATCH).toString('utf8'))
  }
  if (/^Binary files /m.test(patch)) return { patch: '', truncated: false, binary: true }
  return patch.length > MAX_PATCH ? { patch: patch.slice(0, MAX_PATCH), truncated: true } : { patch, truncated: false }
}
