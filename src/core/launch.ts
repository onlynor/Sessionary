import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { LaunchCommand } from './model.ts'

/**
 * Opening things on the user's desktop: a folder in the file manager, a terminal in a directory (optionally
 * running an agent's interactive resume), a file or folder in an editor. Everything is spawned detached; the
 * UI only learns whether the launch itself worked.
 */

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

export function findBin(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try { if (fs.statSync(p).isFile()) { if (!isWin) fs.accessSync(p, fs.constants.X_OK); return p } } catch { /* not here */ }
    }
  }
  return null
}

// how each terminal is told "start in this directory and run this"; `run` is a full argv
type Term = { name: string; bin: string; args: (cwd: string, run?: string[]) => string[] }
const LINUX_TERMS: Term[] = [
  { name: 'kitty', bin: 'kitty', args: (cwd, run) => ['--directory', cwd, ...(run ?? [])] },
  { name: 'alacritty', bin: 'alacritty', args: (cwd, run) => ['--working-directory', cwd, ...(run ? ['-e', ...run] : [])] },
  { name: 'wezterm', bin: 'wezterm', args: (cwd, run) => ['start', '--cwd', cwd, ...(run ? ['--', ...run] : [])] },
  { name: 'ghostty', bin: 'ghostty', args: (cwd, run) => [`--working-directory=${cwd}`, ...(run ? ['-e', ...run] : [])] },
  { name: 'foot', bin: 'foot', args: (cwd, run) => [`--working-directory=${cwd}`, ...(run ?? [])] },
  { name: 'GNOME Terminal', bin: 'gnome-terminal', args: (cwd, run) => [`--working-directory=${cwd}`, ...(run ? ['--', ...run] : [])] },
  { name: 'Ptyxis', bin: 'ptyxis', args: (cwd, run) => ['--new-window', `--working-directory=${cwd}`, ...(run ? ['--', ...run] : [])] },
  { name: 'Konsole', bin: 'konsole', args: (cwd, run) => ['--workdir', cwd, ...(run ? ['-e', ...run] : [])] },
  { name: 'Xfce Terminal', bin: 'xfce4-terminal', args: (cwd, run) => [`--working-directory=${cwd}`, ...(run ? ['-x', ...run] : [])] },
  { name: 'Terminal', bin: 'x-terminal-emulator', args: (_cwd, run) => (run ? ['-e', ...run] : []) },
  { name: 'xterm', bin: 'xterm', args: (_cwd, run) => (run ? ['-e', ...run] : []) },
]

function linuxTerminal(): (Term & { path: string }) | null {
  const pref = process.env.SESSIONARY_TERMINAL ?? process.env.TERMINAL
  if (pref) {
    const known = LINUX_TERMS.find((t) => t.bin === path.basename(pref))
    const p = findBin(pref)
    if (p) return { ...(known ?? { name: path.basename(pref), bin: pref, args: (_c: string, run?: string[]) => (run ? ['-e', ...run] : []) }), path: p }
  }
  for (const t of LINUX_TERMS) { const p = findBin(t.bin); if (p) return { ...t, path: p } }
  return null
}

const GUI_EDITORS = [['code', 'VS Code'], ['cursor', 'Cursor'], ['zed', 'Zed'], ['windsurf', 'Windsurf'], ['subl', 'Sublime Text'], ['codium', 'VSCodium']] as const

function editor(): { name: string; bin: string; kind: 'gui' | 'terminal' } | null {
  const pref = process.env.SESSIONARY_EDITOR
  if (pref) { const p = findBin(pref.split(' ')[0]!); if (p) return { name: path.basename(pref), bin: p, kind: 'gui' } }
  for (const [bin, name] of GUI_EDITORS) { const p = findBin(bin); if (p) return { name, bin: p, kind: 'gui' } }
  // a terminal editor ($VISUAL / $EDITOR, e.g. nvim) opens inside a terminal window
  const term = process.env.VISUAL ?? process.env.EDITOR
  if (term && findBin(term.split(' ')[0]!) && (isMac || isWin || linuxTerminal())) return { name: path.basename(term.split(' ')[0]!), bin: term, kind: 'terminal' }
  return null
}

export interface Capabilities { terminal: string | null; editor: string | null; fileManager: boolean }
export function capabilities(): Capabilities {
  return {
    terminal: isMac ? 'Terminal' : isWin ? (findBin('wt') ? 'Windows Terminal' : 'Command Prompt') : linuxTerminal()?.name ?? null,
    editor: editor()?.name ?? null,
    fileManager: isMac || isWin || !!findBin('xdg-open') || !!findBin('gio'),
  }
}

export class LaunchError extends Error {}

/** POSIX single-quote; Windows double-quote */
export const quote = (s: string) => (isWin ? `"${s.replace(/"/g, '""')}"` : /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
/** the one line a user would type to do the same thing themselves */
export const commandLine = (c: LaunchCommand) => `cd ${isWin ? '/d ' : ''}${quote(c.cwd)} && ${[path.basename(c.bin), ...c.args].map(quote).join(' ')}`

function detached(bin: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: 'ignore', detached: true, windowsHide: false, env: process.env })
    p.once('error', (e: NodeJS.ErrnoException) => reject(new LaunchError(e.code === 'ENOENT' ? `${path.basename(bin)} was not found.` : e.message)))
    p.once('spawn', () => { p.unref(); resolve() })
  })
}

const ensureDir = (dir: string) => {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new LaunchError('The session’s working directory no longer exists.')
}

export async function openFolder(dir: string) {
  ensureDir(dir)
  if (isMac) return detached('open', [dir])
  if (isWin) return detached('explorer', [dir])
  if (findBin('xdg-open')) return detached('xdg-open', [dir])
  if (findBin('gio')) return detached('gio', ['open', dir])
  throw new LaunchError('No file manager opener (xdg-open) was found.')
}

/** A terminal window in `cwd`; with `run`, the command runs there and the shell stays open afterwards. */
export async function openTerminal(cwd: string, run?: LaunchCommand) {
  ensureDir(cwd)
  if (run && !findBin(run.bin)) throw new LaunchError(`The ${path.basename(run.bin)} command was not found on PATH.`)
  const line = run ? [run.bin, ...run.args].map(quote).join(' ') : ''
  if (isMac) {
    const script = `cd ${quote(cwd)}${line ? `; ${line}` : ''}`
    return detached('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'])
  }
  if (isWin) {
    if (findBin('wt')) return detached('wt', ['-d', cwd, ...(run ? ['cmd', '/k', line] : [])])
    return detached('cmd', ['/c', 'start', 'Sessionary', '/D', cwd, 'cmd', '/k', ...(run ? [line] : [])], cwd)
  }
  const term = linuxTerminal()
  if (!term) throw new LaunchError('No terminal emulator was found. Set $TERMINAL to the one you use.')
  // through the user's login shell, so their PATH and aliases apply; the shell stays open when the agent exits
  const shell = process.env.SHELL ?? '/bin/sh'
  const argv = run ? [shell, '-lc', `${line}; exec ${quote(shell)} -l`] : undefined
  return detached(term.path, term.args(cwd, argv), cwd)
}

/** `target` is a directory or a file inside it; `cwd` is where a terminal editor starts. */
export async function openInEditor(target: string, cwd: string) {
  if (!fs.existsSync(target)) throw new LaunchError('That path no longer exists.')
  const ed = editor()
  if (!ed) return fs.statSync(target).isDirectory() ? openFolder(target) : openFile(target)
  if (ed.kind === 'gui') return detached(ed.bin, [target], cwd)
  const [bin, ...pre] = ed.bin.split(' ')
  return openTerminal(cwd, { bin: bin!, args: [...pre, target], cwd })
}

/** the system's default application for a file */
export async function openFile(file: string) {
  if (isMac) return detached('open', [file])
  if (isWin) return detached('cmd', ['/c', 'start', '', file])
  if (findBin('xdg-open')) return detached('xdg-open', [file])
  throw new LaunchError('No opener (xdg-open) was found.')
}

/** `rel` resolved inside `root`, or null when it would leave it (symlinks included) */
export function inside(root: string, rel: string): string | null {
  try {
    const r = fs.realpathSync(root)
    const p = fs.realpathSync(path.resolve(r, rel))
    const back = path.relative(r, p)
    return back.startsWith('..') || path.isAbsolute(back) ? null : p
  } catch { return null }
}
