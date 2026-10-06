import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from './sqlite.ts'

/**
 * Reads another machine's agent history over plain ssh, with nothing installed there: `find` lists the history
 * files, `tar` streams the ones that changed into a local mirror laid out like a home directory, and the usual
 * adapters read the mirror. Only `ssh`, GNU `find` and `tar` are needed on the node. Nothing is ever written to it.
 */
export interface SshTarget { host: string; user?: string; port?: number; identity?: string }

export interface SyncInfo {
  phase: 'idle' | 'listing' | 'fetching'
  lastSync?: number
  /** files on the node that Sessionary mirrors, and their total size */
  files: number
  bytes: number
  /** files still to fetch in the running sync */
  pending: number
  /** which part of the running sync: the transcripts (small, so the node is usable at once) or the databases (large, in the background) */
  stage?: 'transcripts' | 'databases'
  /** of what the running sync has to fetch: how much is in, and how much there is */
  bytesDone: number
  bytesTotal: number
  /** bytes that really crossed the network in the last sync (a delta is far less than the files it updated) */
  wire?: number
  error?: string
}

export class SyncError extends Error {}

const controlDir = () => path.join(os.tmpdir(), `sessionary-ssh-${os.userInfo().uid}`)

/** Arguments for one non-interactive ssh call. The destination follows `--`, so it can never be read as an option. */
export function sshArgs(t: SshTarget, command: string[]): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes', // a password prompt nobody can answer would hang
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    // one connection serves every call for a while; Windows' OpenSSH has no multiplexing
    ...(process.platform === 'win32' ? [] : ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir()}/%C`, '-o', 'ControlPersist=120']),
    ...(t.port ? ['-p', String(t.port)] : []),
    ...(t.identity ? ['-i', t.identity] : []),
    '--', `${t.user ? `${t.user}@` : ''}${t.host}`,
    ...command,
  ]
}

/** What ssh said, with the usual causes spelled out. */
export function explainSsh(stderr: string): string {
  const e = stderr.trim().split('\n').slice(-3).join(' ').trim()
  if (/Permission denied/i.test(e)) return `${e} — key-based login is required; check that ssh to this host works without a password.`
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(e)) return `${e} — run ssh to this host once in a terminal so its host key is trusted.`
  if (/Could not resolve hostname|Connection (timed out|refused)|No route to host/i.test(e)) return `${e} — the node is not reachable.`
  return e || 'ssh failed without an error message.'
}

interface Out { stdout: Buffer; stderr: string; code: number | null }

export function runSsh(bin: string, t: SshTarget, command: string, opts: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Out> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, sshArgs(t, [command]), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal })
    const out: Buffer[] = []
    let err = ''
    const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    p.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new SyncError(e.code === 'ENOENT' ? `The ssh command was not found (${bin}). Install an OpenSSH client.` : e.message)) })
    p.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: err, code }) })
    p.stdin.on('error', () => {})
    p.stdin.end(opts.input ?? '')
  })
}

/** Closes the shared connection of a node, if one is open. Failure just means there was none. */
export async function closeSsh(bin: string, t: SshTarget) {
  if (process.platform === 'win32') return
  await new Promise<void>((resolve) => {
    const p = spawn(bin, ['-O', 'exit', ...sshArgs(t, []).filter((a) => a !== '-T')], { stdio: 'ignore', windowsHide: true })
    p.on('error', () => resolve()); p.on('close', () => resolve())
  })
}

const LIST = `cd "$HOME" 2>/dev/null || { echo "The node has no home directory." >&2; exit 3; }
find . -maxdepth 0 -printf '' 2>/dev/null || { echo "GNU find is required on the node (find -printf)." >&2; exit 4; }
command -v rsync >/dev/null 2>&1 && echo "#rsync"
for d in .claude/projects .pi/agent/sessions .codex/sessions .workbuddy/projects .workbuddy-ai/projects; do
  [ -d "$d" ] && find "$d" -type f \\( -name '*.jsonl' -o -name '*.meta.json' \\) -printf '%p\\t%s\\t%T@\\n'
done
for d in .local/share/opencode .hermes .codex; do
  [ -d "$d" ] && find "$d" -maxdepth 1 -type f \\( -name 'opencode.db' -o -name 'opencode.db-wal' -o -name 'state.db' -o -name 'state.db-wal' -o -name 'state_[0-9]*.sqlite' -o -name 'state_[0-9]*.sqlite-wal' -o -name 'session_index.jsonl' \\) -printf '%p\\t%s\\t%T@\\n'
done
exit 0`

const FETCH = 'cd "$HOME" && tar -cf - -T -'

const isDb = (p: string) => /(^|\/)((opencode|state)\.db|state_\d+\.sqlite)(-wal)?$/.test(p)
const BATCH = 400

export interface Plan { fetch: string[]; gone: string[]; remote: Map<string, { size: number; sig: string }>; /** both ends have rsync, so only changed blocks need to travel */ rsync: boolean }

/** One node's mirror: `<dir>/home` holds the copied files, `<dir>/manifest.json` what was copied from where. */
export class Mirror {
  readonly home: string
  private manifestFile: string
  info: SyncInfo = { phase: 'idle', files: 0, bytes: 0, pending: 0, bytesDone: 0, bytesTotal: 0 }
  private running = false

  constructor(readonly dir: string, private target: SshTarget, private sshBin = process.env.SESSIONARY_SSH_BIN ?? 'ssh', private tarBin = process.env.SESSIONARY_TAR_BIN ?? 'tar', private rsyncBin = process.env.SESSIONARY_RSYNC_BIN ?? 'rsync') {
    this.home = path.join(dir, 'home')
    this.manifestFile = path.join(dir, 'manifest.json')
  }

  get busy() { return this.running }

  private async manifest(): Promise<Record<string, string>> {
    try { return JSON.parse(await fs.readFile(this.manifestFile, 'utf8')) } catch { return {} }
  }

  /** Asks the node what it has and works out what differs from the mirror. Also proves that ssh works. */
  async plan(): Promise<Plan> {
    await fs.mkdir(this.home, { recursive: true })
    if (process.platform !== 'win32') await fs.mkdir(controlDir(), { recursive: true, mode: 0o700 })
    this.info = { ...this.info, phase: 'listing', error: undefined }
    const r = await runSsh(this.sshBin, this.target, LIST, { timeoutMs: 60_000 })
    if (r.code !== 0) { this.info = { ...this.info, phase: 'idle' }; throw new SyncError(explainSsh(r.stderr)) }
    const remote = new Map<string, { size: number; sig: string }>()
    let nodeHasRsync = false
    for (const line of r.stdout.toString('utf8').split('\n')) {
      if (line === '#rsync') { nodeHasRsync = true; continue }
      const [p, size, mtime] = line.split('\t')
      if (!p || !size || !mtime || p.includes('\0')) continue
      const rel = p.replace(/^\.\//, '')
      // the node's file names are data, not instructions: nothing may point outside the mirror
      if (path.isAbsolute(rel) || rel.split('/').includes('..')) continue
      remote.set(rel, { size: Number(size), sig: `${size}:${Math.floor(Number(mtime))}` })
    }
    const have = await this.manifest()
    const fetch: string[] = []
    for (const [p, v] of remote) {
      // a -wal that is missing locally was folded into its database by the checkpoint
      if (have[p] === v.sig && (p.endsWith('-wal') || (await fs.stat(path.join(this.home, p)).then(() => true, () => false)))) continue
      fetch.push(p)
    }
    const gone = Object.keys(have).filter((p) => !remote.has(p))
    let bytes = 0
    for (const v of remote.values()) bytes += v.size
    this.info = { ...this.info, phase: fetch.length ? 'fetching' : 'idle', files: remote.size, bytes, pending: fetch.length }
    return { fetch, gone, remote, rsync: nodeHasRsync && this.rsyncUsable() }
  }

  private rsyncOk: boolean | undefined
  /** rsync here, and a way to hand it ssh's options (they travel as one word, so they cannot contain spaces) */
  private rsyncUsable() {
    if (process.platform === 'win32') return false
    this.rsyncOk ??= spawnSync(this.rsyncBin, ['--version'], { stdio: 'ignore' }).status === 0
    return this.rsyncOk && !this.rshWords().some((w) => /\s/.test(w))
  }
  private rshWords() { const a = sshArgs(this.target, []); return [this.sshBin, ...a.slice(0, a.indexOf('--'))] }

  /**
   * Copies what the plan says changed, in two stages. The transcripts are small and make the node usable, so they
   * go first and `afterTranscripts` is told as soon as they are in; the databases (OpenCode's can be a gigabyte)
   * follow, and the node is already being used while they arrive.
   */
  async apply(plan: Plan, afterTranscripts?: (changed: boolean) => Promise<void> | void): Promise<{ transcripts: boolean; databases: boolean }> {
    this.running = true
    const have = await this.manifest()
    const save = () => fs.writeFile(this.manifestFile, JSON.stringify(have))
    const sizeOf = (files: string[]) => files.reduce((n, f) => n + (plan.remote.get(f)?.size ?? 0), 0)
    const light = plan.fetch.filter((p) => !isDb(p)), heavy = plan.fetch.filter(isDb)
    let done = 0, left = plan.fetch.length, wire = 0
    this.info = { ...this.info, phase: 'fetching', stage: 'transcripts', bytesDone: 0, bytesTotal: sizeOf(plan.fetch), pending: left, wire: undefined, error: undefined }
    const fetch = async (files: string[]) => {
      wire += await this.fetchBatch(files, plan, (n) => { this.info = { ...this.info, bytesDone: Math.min(done + n, this.info.bytesTotal) } })
      for (const f of files) have[f] = plan.remote.get(f)!.sig
      await save()
      done += sizeOf(files); left -= files.length
      this.info = { ...this.info, bytesDone: done, pending: left, wire }
    }
    try {
      let lightChanged = false, heavyChanged = false
      for (const p of plan.gone) { await fs.rm(path.join(this.home, p), { force: true }); delete have[p]; lightChanged = true }
      if (plan.gone.length) await save()
      for (let i = 0; i < light.length; i += BATCH) { await fetch(light.slice(i, i + BATCH)); lightChanged = true }
      this.info = { ...this.info, stage: 'databases' }
      await afterTranscripts?.(lightChanged)
      // db and wal must come from the same moment, so they travel together
      if (heavy.length) { await fetch(heavy); heavyChanged = true; await this.checkpoint(heavy) }
      this.info = { ...this.info, phase: 'idle', stage: undefined, pending: 0, lastSync: Date.now(), error: undefined }
      return { transcripts: lightChanged, databases: heavyChanged }
    } catch (e) {
      this.info = { ...this.info, phase: 'idle', stage: undefined, error: (e as Error).message }
      throw e
    } finally { this.running = false }
  }

  async sync(): Promise<boolean> { const r = await this.apply(await this.plan()); return r.transcripts || r.databases }

  /** Fetches files into the mirror; returns the bytes that crossed the network. */
  private fetchBatch(files: string[], plan: Plan, onBytes: (n: number) => void): Promise<number> {
    return plan.rsync && this.rsyncUsable() ? this.fetchRsync(files, onBytes) : this.fetchTar(files, onBytes)
  }

  /**
   * rsync updates each file from the copy already here, so an appended transcript or a database that changed in a few
   * pages costs a few kilobytes, not the file. Files are replaced atomically (written aside, then renamed).
   */
  private fetchRsync(files: string[], onBytes: (n: number) => void): Promise<number> {
    const [bin, ...rsh] = this.rshWords()
    const dest = `${this.target.user ? `${this.target.user}@` : ''}${this.target.host}:`
    return new Promise<number>((resolve, reject) => {
      const p = spawn(this.rsyncBin, ['-t', '-z', '--no-motd', '--files-from=-', '--info=progress2', '--stats', '-e', [bin, ...rsh].join(' '), '--', dest, this.home + '/'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let out = '', err = ''
      p.stdout.on('data', (d) => {
        out = (out + d).slice(-6000)
        const m = [...String(d).matchAll(/([\d,]+)\s+\d+%/g)].pop()
        if (m) onBytes(Number(m[1]!.replace(/,/g, '')))
      })
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
      p.on('error', (e) => reject(new SyncError(e.message)))
      p.on('close', (code) => {
        // 24: a file vanished while it was being read, which is normal for a session being deleted
        if (code !== 0 && code !== 24) return reject(new SyncError(explainSsh(err) || `rsync failed (${code}).`))
        resolve(Number(/Total bytes received: ([\d,]+)/.exec(out)?.[1]?.replace(/,/g, '') ?? 0))
      })
      p.stdin.on('error', () => {})
      p.stdin.end(files.join('\n') + '\n')
    })
  }

  private async fetchTar(files: string[], onBytes: (n: number) => void): Promise<number> {
    const stage = path.join(this.dir, '.stage')
    await fs.rm(stage, { recursive: true, force: true })
    await fs.mkdir(stage, { recursive: true })
    let bytes = 0
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn(this.sshBin, sshArgs(this.target, [FETCH]), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const tar = spawn(this.tarBin, ['-xf', '-', '-C', stage, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
      let sshErr = '', tarErr = ''
      let sshCode: number | null | undefined, tarCode: number | null | undefined
      const done = () => {
        if (sshCode === undefined || tarCode === undefined) return
        // tar exits 1 when a file grew while it was read, which is normal for a transcript being written
        if ((sshCode ?? 1) > 1) reject(new SyncError(explainSsh(sshErr) || 'The node could not send its files.'))
        else if (tarCode !== 0) reject(new SyncError(`tar could not unpack the files: ${tarErr.trim().split('\n').pop() ?? ''}`))
        else resolve()
      }
      ssh.stderr.on('data', (d) => { sshErr = (sshErr + d).slice(-2000) })
      tar.stderr.on('data', (d) => { tarErr = (tarErr + d).slice(-2000) })
      ssh.stdout.on('data', (d: Buffer) => { bytes += d.length; onBytes(bytes) })
      ssh.on('error', (e) => reject(new SyncError(e.message)))
      tar.on('error', (e: NodeJS.ErrnoException) => { ssh.kill(); reject(new SyncError(e.code === 'ENOENT' ? 'The tar command was not found on this computer.' : e.message)) })
      ssh.on('close', (c) => { sshCode = c; done() })
      tar.on('close', (c) => { tarCode = c; done() })
      ssh.stdout.pipe(tar.stdin)
      tar.stdin.on('error', () => {})
      ssh.stdin.on('error', () => {})
      ssh.stdin.end(files.join('\n') + '\n')
    })
    // only now does anything touch the mirror, so an interrupted transfer never leaves half a file in it
    for (const f of files) {
      const from = path.join(stage, f)
      if (!(await fs.stat(from).then(() => true, () => false))) continue // vanished on the node meanwhile
      const to = path.join(this.home, f)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)
    }
    await fs.rm(stage, { recursive: true, force: true })
    return bytes
  }

  /** Folds a copied WAL into its database so the adapters can open the copy read-only without the node's -shm. */
  private async checkpoint(files: string[]) {
    for (const f of new Set(files.map((x) => x.replace(/-wal$/, '')))) {
      const file = path.join(this.home, f)
      try {
        const db = new DatabaseSync(file)
        try { db.exec('pragma wal_checkpoint(truncate)') } finally { db.close() }
      } catch { /* a copy caught mid-write; the next sync replaces it */ }
    }
  }

  async close() { await closeSsh(this.sshBin, this.target) }
}

export const posix = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * The command that opens an interactive session on the node: ssh with a terminal, then the agent's own resume
 * command in the session's directory, run by a login shell so the node's PATH (npm / ~/.local/bin) applies.
 */
export function sshTerminalCommand(t: SshTarget, cmd: { bin: string; args: string[]; cwd: string }): { bin: string; args: string[]; line: string } {
  const remote = `${cmd.cwd ? `cd ${posix(cmd.cwd)} && ` : ''}${[cmd.bin, ...cmd.args].map(posix).join(' ')}`
  const wrapped = `exec "\${SHELL:-/bin/sh}" -lic ${posix(remote)}`
  const args = ['-t', ...(t.port ? ['-p', String(t.port)] : []), ...(t.identity ? ['-i', t.identity] : []), '--', `${t.user ? `${t.user}@` : ''}${t.host}`, wrapped]
  return { bin: 'ssh', args, line: ['ssh', ...args].map(posix).join(' ') }
}

export interface TermSize { cols: number; rows: number }
const size = (z?: Partial<TermSize>) => ({ cols: Math.max(20, Math.min(500, Math.round(z?.cols ?? 100))), rows: Math.max(5, Math.min(200, Math.round(z?.rows ?? 30))) })

/**
 * A terminal on a node: `ssh -tt` gives the node's side a terminal even though ours is a pipe, and the page's
 * size is set before the shell starts (a later resize is not forwarded). With `run`, the agent's command runs in
 * a login shell so the node's PATH applies, in `cwd`; without it the person gets that shell.
 */
export function sshTerminalSpec(t: SshTarget, o: { cwd?: string; run?: { bin: string; args: string[] }; size?: Partial<TermSize> }): { bin: string; args: string[] } {
  const { cols, rows } = size(o.size)
  const shell = '"${SHELL:-/bin/sh}"'
  const inner = o.run
    ? `${o.cwd ? `cd ${posix(o.cwd)} && ` : ''}${[o.run.bin, ...o.run.args].map(posix).join(' ')}`
    : undefined
  const start = inner ? `exec ${shell} -lic ${posix(inner)}` : `${o.cwd ? `cd ${posix(o.cwd)} 2>/dev/null; ` : ''}exec ${shell} -l`
  const remote = `stty cols ${cols} rows ${rows} 2>/dev/null; ${start}`
  return { bin: process.env.SESSIONARY_SSH_BIN ?? 'ssh', args: sshArgs(t, [remote]).map((a) => (a === '-T' ? '-tt' : a)) }
}
