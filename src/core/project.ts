import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A "project" is derived from a session's own cwd: the enclosing git work-tree root if there is one,
 * otherwise the cwd. Linked worktrees collapse onto their main repository. Never stored in the index,
 * because directories appear, move and vanish after the session was recorded.
 */
export interface ProjectRef {
  key: string
  name: string
  /** false when the recorded directory is gone */
  exists: boolean
  /** true for the home directory or filesystem root, which is a scratch space rather than a project */
  generic: boolean
  /** path of the cwd relative to the project root, when deeper */
  sub?: string
}

const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '') || path.sep
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

async function isDir(p: string) {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let dir = start
  for (let i = 0; i < 40; i++) {
    const dotgit = path.join(dir, '.git')
    try {
      const st = await fs.stat(dotgit)
      if (st.isDirectory()) return dir
      // linked worktree: ".git" is a file "gitdir: <repo>/.git/worktrees/<name>"
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotgit, 'utf8'))
      const wt = m && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(m[1]!.trim())
      return wt ? wt[1] : dir
    } catch { /* keep walking */ }
    const up = path.dirname(dir)
    if (up === dir) return
    dir = up
  }
}

const cache = new Map<string, { at: number; ref: ProjectRef }>()

export async function resolveProject(cwd: string | undefined): Promise<ProjectRef> {
  if (!cwd) return { key: 'none', name: 'No directory', exists: false, generic: true }
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.ref
  const dir = norm(cwd)
  const exists = await isDir(dir)
  const home = norm(os.homedir())
  let ref: ProjectRef
  if (dir === home || dir === path.parse(dir).root) {
    ref = { key: 'generic:' + dir, name: dir === home ? 'Home' : dir, exists, generic: true }
  } else {
    const root = exists ? await findGitRoot(dir) : undefined
    const base = root ?? dir
    const sub = root && dir !== root ? path.relative(root, dir).replace(/\\/g, '/') : undefined
    ref = { key: process.platform === 'win32' ? base.toLowerCase() : base, name: baseName(base), exists, generic: false, sub }
  }
  cache.set(cwd, { at: Date.now(), ref })
  return ref
}

/**
 * Project of a session recorded on another machine. Nothing on this machine says whether that directory or its
 * git root exists, so the name comes from the path alone: the last segment, except for home directories.
 */
export async function resolveRemoteProject(cwd: string | undefined): Promise<ProjectRef> {
  if (!cwd) return { key: 'none', name: 'No directory', exists: false, generic: true }
  const dir = cwd.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (dir === '/' || dir === '/root' || /^\/home\/[^/]+$/.test(dir) || /^\/Users\/[^/]+$/.test(dir))
    return { key: 'generic:' + dir, name: dir === '/' ? dir : 'Home', exists: true, generic: true }
  return { key: dir, name: dir.split('/').filter(Boolean).pop() ?? dir, exists: true, generic: false }
}
