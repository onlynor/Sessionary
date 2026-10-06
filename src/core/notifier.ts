import { randomBytes } from 'node:crypto'
import type { Nodes } from './nodes.ts'
import type { Terminals } from './terminals.ts'

/**
 * Things worth interrupting someone for, noticed here rather than in the page: a page in a background tab is
 * throttled by the browser, while the server's timers and the event stream are not. The server only reports
 * what happened (as a code and its facts, so the page can say it in the reader's language); the page decides
 * whether to interrupt: whether it is switched on, whether the reader is already looking, how often.
 */
export type NoticeCode = 'agent.idle' | 'agent.exit' | 'chat.approval' | 'chat.done' | 'machine.down' | 'machine.up' | 'sync.done'
export interface Notice {
  id: string
  type: 'agent' | 'machine' | 'sync'
  code: NoticeCode
  /** the same thing happening again has the same key */
  key: string
  machine: string
  params: Record<string, string | number>
  at: number
}

export class Notifier {
  private subs = new Set<(n: Notice) => void>()
  emit(n: Omit<Notice, 'id' | 'at'>) {
    const full: Notice = { ...n, id: randomBytes(5).toString('hex'), at: Date.now() }
    for (const s of this.subs) s(full)
    return full
  }
  subscribe(fn: (n: Notice) => void) { this.subs.add(fn); return () => { this.subs.delete(fn) } }
}

const env = (k: string, d: number) => Number(process.env[k] ?? d)

/**
 * An agent running in an app terminal that printed for a while and then stopped has finished its turn or is asking
 * you something: both mean it is your move. Typing makes output too (the echo), so a burst has to be long and
 * heavy to count. A shell is not an agent and is left alone, as is a process the reader stopped.
 */
export function watchTerminals(terminals: Terminals, notifier: Notifier, describe: (t: { machine: string; agent?: string; title: string; id: string }) => { agent: string; machineName: string }) {
  const quiet = env('SESSIONARY_NOTIFY_QUIET_MS', 8000), burstMs = env('SESSIONARY_NOTIFY_BURST_MS', 6000), minBytes = env('SESSIONARY_NOTIFY_MIN_BYTES', 1500)
  const tick = () => {
    const now = Date.now()
    for (const a of terminals.activity()) {
      const t = a.info
      if (t.kind === 'shell' || !a.lastOut) continue
      if (now - a.lastOut < quiet || a.burstBytes < minBytes || a.lastOut - a.burstStart < burstMs || a.announced === a.burstStart) continue
      a.mark()
      const d = describe(t)
      notifier.emit({ type: 'agent', code: 'agent.idle', key: `term:${t.id}`, machine: t.machine, params: { agent: d.agent, title: t.title, machineName: d.machineName, term: t.id } })
    }
  }
  terminals.onExit = (t) => {
    if (t.kind === 'shell') return
    const d = describe(t)
    notifier.emit({ type: 'agent', code: 'agent.exit', key: `term-exit:${t.id}`, machine: t.machine, params: { agent: d.agent, title: t.title, machineName: d.machineName, term: t.id, exit: t.exitCode ?? -1 } })
  }
  const timer = setInterval(tick, Math.max(200, Math.min(1000, quiet / 4)))
  timer.unref()
  return () => { clearInterval(timer); terminals.onExit = undefined }
}

/**
 * A node that stops answering and stays that way, coming back, and a big copy finishing. A node that blinks
 * (one failed sync, retried a few seconds later) is not worth a word, so "down" waits to be sure.
 */
export function watchNodes(nodes: Pick<Nodes, 'list'>, notifier: Notifier) {
  const downAfter = env('SESSIONARY_NOTIFY_DOWN_MS', 20_000)
  const seen = new Map<string, { state: string; since: number; announced: boolean; copying: boolean }>()
  const tick = () => {
    const now = Date.now()
    for (const n of nodes.list()) {
      const prev = seen.get(n.id)
      const copying = n.sync?.phase === 'fetching' && (n.sync.bytesTotal ?? 0) > 50 * 1024 * 1024
      if (!prev) { seen.set(n.id, { state: n.state, since: now, announced: false, copying }); continue }
      if (prev.copying && !copying && n.state === 'online' && !n.sync?.error) notifier.emit({ type: 'sync', code: 'sync.done', key: `sync:${n.id}`, machine: n.id, params: { machineName: n.name } })
      prev.copying = copying
      if (n.state !== prev.state) {
        // the person disconnecting a node is not news; a node that was up and is now failing is
        if (n.state === 'online' && prev.announced) notifier.emit({ type: 'machine', code: 'machine.up', key: `up:${n.id}`, machine: n.id, params: { machineName: n.name } })
        // having said it is down, keep that through the retries ("connecting") so that coming back is announced too
        const keep = prev.announced && (n.state === 'error' || n.state === 'connecting')
        prev.state = n.state; prev.since = now; prev.announced = keep
        continue
      }
      if (n.state === 'error' && !prev.announced && now - prev.since >= downAfter && n.sync?.lastSync) {
        prev.announced = true
        notifier.emit({ type: 'machine', code: 'machine.down', key: `down:${n.id}`, machine: n.id, params: { machineName: n.name, reason: n.error ?? '' } })
      }
    }
  }
  const timer = setInterval(tick, Math.max(200, Math.min(3000, downAfter / 4)))
  timer.unref()
  return () => clearInterval(timer)
}
