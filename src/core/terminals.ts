import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix, type TermSize } from './sync.ts'

/**
 * Interactive terminals the server runs on behalf of the page: a shell, or an agent, on this machine or (through
 * `ssh -tt`) on a node. The server keeps the process and the recent output, so the page can leave and come back
 * — "reconnect" is just attaching to what is still running.
 */
/** `control`: a fourth pipe the program reads size changes from (the PTY helper below) */
/** `env` is added to the process's environment (an agent's model routing, see control/agents.ts) */
export interface SpawnSpec { bin: string; args: string[]; cwd?: string; control?: boolean; env?: Record<string, string> }

export interface TermMeta {
  machine: string
  title: string
  kind: 'shell' | 'resume' | 'new'
  agent?: string
  sessionId?: string
  cwd?: string
  /** the size it started with: a running terminal cannot be resized, so the page draws exactly this */
  cols?: number
  rows?: number
}

export interface TermInfo extends TermMeta {
  id: string
  pid?: number
  state: 'running' | 'exited'
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  bytes: number
  /** whether the page can change its size after it started */
  resizable: boolean
}

const KEEP = 512 * 1024
/** output more than this far apart is a new burst */
const BURST_GAP_MS = () => Number(process.env.SESSIONARY_NOTIFY_QUIET_MS ?? 8000)

interface Term {
  info: TermInfo
  proc: ChildProcess
  control?: NodeJS.WritableStream
  /** when it last printed, when the current burst of output began, and how much it printed since */
  lastOut: number
  burstStart: number
  burstBytes: number
  announced?: number
  killed?: boolean
  chunks: Buffer[]
  size: number
  subs: Set<{ data: (b: Buffer) => void; exit: (i: TermInfo) => void }>
}

export class TerminalError extends Error {}

export class Terminals {
  private terms = new Map<string, Term>()
  /** told when a terminal's process ends on its own (not when it was stopped from here) */
  onExit?: (info: TermInfo) => void
  constructor(private max = 12) {}

  create(meta: TermMeta, spec: SpawnSpec): TermInfo {
    const running = [...this.terms.values()].filter((t) => t.info.state === 'running').length
    if (running >= this.max) throw new TerminalError(`At most ${this.max} terminals can run at once. Close one first.`)
    const proc = spawn(spec.bin, spec.args, {
      cwd: spec.cwd, stdio: spec.control ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...spec.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const info: TermInfo = { ...meta, id: randomBytes(5).toString('hex'), pid: proc.pid, state: 'running', startedAt: Date.now(), bytes: 0, resizable: !!spec.control }
    const term: Term = { info, proc, control: spec.control ? (proc.stdio[3] as NodeJS.WritableStream) : undefined, lastOut: 0, burstStart: 0, burstBytes: 0, chunks: [], size: 0, subs: new Set() }
    term.control?.on('error', () => {})
    this.terms.set(info.id, term)
    const feed = (b: Buffer) => {
      const now = Date.now()
      if (now - term.lastOut > BURST_GAP_MS()) { term.burstStart = now; term.burstBytes = 0 }
      term.lastOut = now; term.burstBytes += b.length
      term.chunks.push(b); term.size += b.length; info.bytes += b.length
      while (term.size > KEEP && term.chunks.length > 1) term.size -= term.chunks.shift()!.length
      for (const s of term.subs) s.data(b)
    }
    proc.stdout!.on('data', feed)
    proc.stderr!.on('data', feed) // ssh reports its own failures here
    proc.stdin!.on('error', () => {})
    proc.on('error', (e: NodeJS.ErrnoException) => {
      feed(Buffer.from(`\r\n${e.code === 'ENOENT' ? `${spec.bin} was not found.` : e.message}\r\n`))
      finish(null)
    })
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      info.state = 'exited'; info.exitCode = code; info.endedAt = Date.now()
      for (const s of term.subs) s.exit({ ...info })
      if (!term.killed) this.onExit?.({ ...info })
    }
    proc.on('close', (code) => finish(code))
    return { ...info }
  }

  list(machine?: string): TermInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info })).filter((i) => !machine || i.machine === machine).sort((a, b) => a.startedAt - b.startedAt)
  }
  get(id: string): TermInfo | undefined { const t = this.terms.get(id); return t && { ...t.info } }

  write(id: string, data: string) {
    const t = this.terms.get(id)
    if (!t || t.info.state !== 'running') throw new TerminalError('This terminal is not running.')
    t.proc.stdin!.write(data)
  }

  /** Changes the size of a running terminal; the program inside is told and redraws. */
  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id)
    if (!t || t.info.state !== 'running') throw new TerminalError('This terminal is not running.')
    if (!t.control) throw new TerminalError('This terminal cannot be resized.')
    cols = Math.max(20, Math.min(500, Math.round(cols))); rows = Math.max(5, Math.min(200, Math.round(rows)))
    t.control.write(`R ${cols} ${rows}\n`)
    t.info.cols = cols; t.info.rows = rows
  }

  /** Receives the output so far (as one chunk), then everything after it, until `unsubscribe`. */
  subscribe(id: string, data: (b: Buffer) => void, exit: (i: TermInfo) => void): (() => void) | null {
    const t = this.terms.get(id)
    if (!t) return null
    if (t.chunks.length) data(Buffer.concat(t.chunks))
    const sub = { data, exit }
    t.subs.add(sub)
    if (t.info.state === 'exited') exit({ ...t.info })
    return () => { t.subs.delete(sub) }
  }

  /** what each running terminal has been doing, for noticing when an agent in one has gone quiet */
  activity(): { info: TermInfo; lastOut: number; burstStart: number; burstBytes: number; announced?: number; mark: () => void }[] {
    return [...this.terms.values()].filter((t) => t.info.state === 'running').map((t) => ({ info: { ...t.info }, lastOut: t.lastOut, burstStart: t.burstStart, burstBytes: t.burstBytes, announced: t.announced, mark: () => { t.announced = t.burstStart } }))
  }

  kill(id: string) {
    const t = this.terms.get(id)
    if (!t || t.info.state !== 'running') return
    t.killed = true
    t.proc.kill('SIGTERM')
    setTimeout(() => { if (t.info.state === 'running') t.proc.kill('SIGKILL') }, 2500).unref()
  }

  /** Forgets a finished terminal (a running one is stopped first). */
  remove(id: string) {
    const t = this.terms.get(id)
    if (!t) return
    if (t.info.state === 'running') this.kill(id)
    this.terms.delete(id)
  }

  stopAll() { for (const t of this.terms.values()) if (t.info.state === 'running') { t.killed = true; t.proc.kill('SIGKILL') } }
}

const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0

/**
 * Gives a program a real terminal that can be resized later. Node has no pty of its own (and the project has no
 * native modules), so a few lines of Python's `pty` module do it: they run the program on a pty, copy bytes both
 * ways, and read "R <cols> <rows>" lines from a fourth pipe to change the pty's size, which signals the program
 * (and, for `ssh -tt`, makes ssh tell the other machine).
 */
const PTY_HELPER = `
import os, sys, pty, fcntl, termios, struct, select, signal
cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
def size(fd, c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except Exception: pass
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    try: os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write('%s: %s\\n' % (argv[0], e)); os._exit(127)
def stop(*_):
    try: os.kill(pid, signal.SIGHUP)
    except Exception: pass
    os._exit(1)
signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGHUP, stop)
def out(b):
    while b:
        n = os.write(1, b); b = b[n:]
rd, buf = [0, fd, 3], b''
while True:
    try: ready = select.select(rd, [], [])[0]
    except InterruptedError: continue
    if fd in ready:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: break
        out(d)
    if 0 in ready:
        d = os.read(0, 65536)
        if d: os.write(fd, d)
        else: rd.remove(0)
    if 3 in ready:
        d = os.read(3, 4096)
        if not d: rd.remove(3)
        else:
            buf += d
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                p = line.split()
                if len(p) == 3 and p[0] == b'R': size(fd, int(p[1]), int(p[2]))
st = os.waitpid(pid, 0)[1]
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
`

/** Runs `spec` on a resizable pty when Python is there; otherwise as it is (a terminal that keeps its starting size). */
export function ptyWrap(spec: SpawnSpec, size?: Partial<TermSize>): SpawnSpec {
  if (process.platform === 'win32' || !has('python3')) return spec
  const cols = Math.max(20, Math.min(500, Math.round(size?.cols ?? 100))), rows = Math.max(5, Math.min(200, Math.round(size?.rows ?? 30)))
  return { bin: 'python3', args: ['-c', PTY_HELPER, String(cols), String(rows), spec.bin, ...spec.args], cwd: spec.cwd, control: true, env: spec.env }
}

/** A terminal on this computer: the shell, or `run`, in `cwd`. */
export function localTerminalSpec(o: { cwd?: string; run?: { bin: string; args: string[] }; size?: Partial<TermSize>; env?: Record<string, string> }): SpawnSpec {
  if (process.platform === 'win32') throw new TerminalError('Terminals on this computer are not available on Windows yet.')
  const cols = Math.max(20, Math.min(500, Math.round(o.size?.cols ?? 100))), rows = Math.max(5, Math.min(200, Math.round(o.size?.rows ?? 30)))
  const run = o.run ? [o.run.bin, ...o.run.args].map(posix).join(' ') : `${posix(process.env.SHELL || '/bin/sh')} -l`
  const line = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${run}`
  const inner: SpawnSpec = { bin: 'sh', args: ['-c', line], cwd: o.cwd, env: o.env }
  if (has('python3')) return ptyWrap(inner, o.size)
  if (process.platform === 'darwin' && has('script')) return { bin: 'script', args: ['-q', '/dev/null', 'sh', '-c', line], cwd: o.cwd, env: o.env }
  if (has('script')) return { bin: 'script', args: ['-qfc', line, '/dev/null'], cwd: o.cwd, env: o.env }
  throw new TerminalError('A terminal needs Python 3 or the `script` command on this computer.')
}
