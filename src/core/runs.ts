import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { IndexStore } from './index-store.ts'
import type { AgentAdapter } from './model.ts'

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'
export interface Run {
  id: string
  sessionId: string
  /** set when the agent reports a different session id (it forked instead of appending) */
  resultSessionId?: string
  allowWrite: boolean
  status: RunStatus
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  /** last lines of stderr, for explaining failures */
  error?: string
  proc?: ChildProcess
}

const QUIET_MS = 120_000

/**
 * Continues existing sessions through each agent's own non-interactive CLI. One run per session; a session
 * the agent wrote to recently (outside our own runs) is assumed to be open in a terminal and is left alone.
 */
export class Runs {
  private runs = new Map<string, Run>()
  private lastEnd = new Map<string, number>() // sessionId → when our last run finished
  constructor(private adapters: AgentAdapter[], private store: IndexStore, private onEnd: (r: Run) => void) {}

  get(id: string) { return this.runs.get(id) }
  active(sessionId: string) { return [...this.runs.values()].find((r) => r.sessionId === sessionId && r.status === 'running') }

  async start(sessionId: string, prompt: string, allowWrite: boolean): Promise<Run> {
    const row = this.store.get(sessionId)
    if (!row) throw new RunError('Session not found.')
    if (row.summary.parentId) throw new RunError('Sub-agent sessions cannot be continued directly; continue the parent session.')
    const adapter = this.adapters.find((a) => a.id === row.agent)
    if (!adapter?.continueCommand) throw new RunError(`${adapter?.label ?? row.agent} sessions cannot be continued from Sessionary.`)
    if (this.active(sessionId)) throw new RunError('This session is already running.')
    if (!prompt.trim()) throw new RunError('The prompt is empty.')

    const source = { key: row.sourceKey, ref: row.sourceKey, fingerprint: '' }
    const cmd = adapter.continueCommand(source, row.summary, prompt, { allowWrite })
    if (!cmd.cwd || !fs.existsSync(cmd.cwd)) throw new RunError('The session’s working directory no longer exists, so the agent cannot resume it.')

    // written recently by someone other than us → probably open in a terminal
    const fp = (await adapter.listSources()).find((s) => s.key === row.sourceKey)
    const touched = fp ? lastWrite(fp.fingerprint, row.sourceKey) : 0
    const ours = this.lastEnd.get(sessionId) ?? 0
    if (touched && Date.now() - touched < QUIET_MS && touched > ours + 5_000)
      throw new RunError('This session was updated in the last two minutes, probably in a terminal. Close it there first so two writers don’t collide.')

    const run: Run = { id: Math.random().toString(36).slice(2, 10), sessionId, allowWrite, status: 'running', startedAt: Date.now() }
    const proc = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' }, windowsHide: true })
    run.proc = proc
    let buf = ''
    let errTail = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const sid = cmd.sessionIdFrom?.(l)
        if (sid && sid !== sessionId) run.resultSessionId = sid
      }
    })
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000) })
    const finish = (status: RunStatus, code: number | null, error?: string) => {
      if (run.status !== 'running') return
      run.status = status
      run.exitCode = code
      run.endedAt = Date.now()
      run.error = error
      run.proc = undefined
      this.lastEnd.set(sessionId, run.endedAt)
      this.onEnd(run)
    }
    proc.on('error', (e: NodeJS.ErrnoException) => finish('failed', null, e.code === 'ENOENT' ? `The ${cmd.bin} command was not found on PATH.` : e.message))
    proc.on('exit', (code, signal) => {
      if (signal || run.status === 'stopped') return finish('stopped', code)
      finish(code === 0 ? 'done' : 'failed', code, code === 0 ? undefined : errTail.trim().split('\n').slice(-3).join('\n') || `exited with code ${code}`)
    })
    this.runs.set(run.id, run)
    return run
  }

  stop(id: string) {
    const r = this.runs.get(id)
    if (!r?.proc || r.status !== 'running') return
    r.status = 'stopped'
    r.endedAt = Date.now()
    this.lastEnd.set(r.sessionId, r.endedAt)
    r.proc.kill('SIGINT')
    const p = r.proc
    setTimeout(() => { if (p.exitCode == null) p.kill('SIGTERM') }, 3000).unref()
    r.proc = undefined
    this.onEnd(r)
  }

  stopAll() { for (const r of this.runs.values()) this.stop(r.id) }
}

export class RunError extends Error {}

/** fingerprints are `size:mtime` for files and `time_updated` for OpenCode; both end in a millisecond time */
function lastWrite(fingerprint: string, key: string): number {
  const t = Number(fingerprint.split(':').pop())
  if (t > 1e12) return t
  try { return fs.statSync(key).mtimeMs } catch { return 0 }
}

export const publicRun = (r: Run) => ({ id: r.id, sessionId: r.sessionId, resultSessionId: r.resultSessionId, allowWrite: r.allowWrite, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, error: r.error })
