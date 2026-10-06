import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { adapters as localAdapters, adaptersFor } from '../adapters/index.ts'
import { IndexStore } from '../core/index-store.ts'
import { mirrorRoots } from '../core/util.ts'
import { gitChanges, gitFileDiff, projectContext } from '../core/context.ts'
import { cleanPrompt, toolKind } from '../core/derive.ts'
import { resolveProject, resolveRemoteProject } from '../core/project.ts'
import type { AgentAdapter, Block, Message, Session, SessionSummary } from '../core/model.ts'
import { isTurnStart, pageMessages } from '../core/paging.ts'
import { NodeError, Nodes } from '../core/nodes.ts'
import { sshHosts } from '../core/sshconfig.ts'
import { Notifier, watchNodes, watchTerminals } from '../core/notifier.ts'
import { ProbeCache, type ProbeEntry } from '../core/probecache.ts'
import { agentsScript, localAgents, localSystem, parseAgents, parseSystem, SYSTEM_SCRIPT } from '../core/system.ts'
import { localTerminalSpec, ptyWrap, TerminalError, Terminals, type TermMeta } from '../core/terminals.ts'
import { sshTerminalSpec } from '../core/sync.ts'
import { OverlayStore } from '../core/overlay.ts'
import { ControlStore } from '../core/control/store.ts'
import { registerControl } from '../core/control/api.ts'
import { purgeBackup, removeFromDisk, restoreFromBackup } from '../core/removal.ts'
import { RemovalError } from '../core/model.ts'
import { publicRun, RunError, Runs } from '../core/runs.ts'
import { Chats, chatSupported, localSpawner, PROTOCOL } from '../core/chat/manager.ts'
import { sshSpawner } from '../core/chat/ssh.ts'
import { ChatError } from '../core/chat/types.ts'
import { loadSession, scan, type ScanReport } from '../core/scanner.ts'
import { capabilities, commandLine, inside, LaunchError, openFolder, openInEditor, openTerminal } from '../core/launch.ts'
import { watchSources, type WatchState } from '../core/watcher.ts'
import { existsSync } from 'node:fs'

const MAX_OUTPUT = 20_000

const PAGE_SIZE = 160

/**
 * Transport copy of a message: huge tool output clipped, tool kind tagged, inline image bytes swapped
 * for a reference. Copies, because the loaded session is cached and serves the image endpoint.
 */
function prepare(m: Message, msgIndex: number): Message {
  return {
    ...m,
    blocks: m.blocks.map((b, j): Block => {
      if (b.type === 'tool') {
        const big = !!b.output && b.output.length > MAX_OUTPUT
        return { ...b, kind: toolKind(b.name), output: big ? b.output!.slice(0, MAX_OUTPUT) : b.output, truncated: big || undefined }
      }
      if (b.type === 'image' && b.data) return { type: 'image', mime: b.mime, ref: `${msgIndex}-${j}` }
      return b
    }),
  }
}

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'target', 'dist', 'build', '.next', '.cache'])

async function listDir(cwd: string, rel: string) {
  const root = await fs.realpath(cwd)
  const dir = await fs.realpath(path.resolve(root, rel))
  const inside = path.relative(root, dir)
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null // never leave the session's directory
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !(e.isDirectory() && HIDDEN_DIRS.has(e.name)))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, 500)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

export interface AppOptions {
  /** the adapters this app reads with; default is this machine's agents */
  adapters?: AgentAdapter[]
  /**
   * A view of another machine's history (a node's mirror): nothing may change state, and nothing may touch this
   * machine's disk on the strength of a path recorded elsewhere (git state, file tree, opening folders).
   */
  readOnly?: boolean
  /** the port agents reach the gateway on (Model Control); the server's own */
  port?: number
  /** Model Control's store (`control.db`); in memory when not given, as the overlay is */
  control?: ControlStore
}
const LOCAL_ONLY = /\/api\/sessions\/[^/]+\/(context|tree|changes|changes\/file|run)$/
/** decisions kept in Sessionary's own overlay: they change nothing on the other machine, so a view may make them */
const OVERLAY_POST = /^\/api\/sessions\/[^/]+\/(pin|unpin|hide|restore|rename|messages\/hide|messages\/restore)$/

export function createApp(store: IndexStore, webRoot?: string, overlay: OverlayStore = new OverlayStore(':memory:'), opts: AppOptions = {}) {
  const adapters = opts.adapters ?? localAdapters
  let stopTerminals = () => {}
  let stopChats = async () => {}
  let stopNotices = () => {}
  const projectOf = opts.readOnly ? resolveRemoteProject : resolveProject
  const app = new Hono()
  // DNS-rebinding guard: session history is private, so only answer requests addressed to a loopback name
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !process.env.SESSIONARY_ALLOW_HOST) return c.text('Forbidden host', 403)
    await next()
  })

  if (opts.readOnly) app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !OVERLAY_POST.test(c.req.path)) return c.json({ error: 'This view is read-only.' }, 405)
    if (LOCAL_ONLY.test(c.req.path)) return c.json({ error: 'Not available for another machine’s sessions.' }, 404)
    await next()
  })

  // Anything that changes state (and continuing a session runs an agent on this machine) needs a per-launch
  // token. Other sites can't read it: no CORS, and the Host guard above stops DNS rebinding.
  const token = randomBytes(24).toString('hex')
  app.get('/api/token', (c) => c.json({ token }))
  app.use('/api/*', async (c, next) => {
    // a node's view is only reachable through the controller's own authenticated proxy
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || opts.readOnly) return next()
    const origin = c.req.header('origin')
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return c.json({ error: 'Cross-origin request refused' }, 403)
    if (c.req.header('x-sessionary-token') !== token) return c.json({ error: 'Missing or wrong session token; reload the page.' }, 403)
    await next()
  })
  // ---- live updates: every scan that changed something is pushed to open pages as an `index` event ----
  const listeners = new Set<(event: string, data: unknown) => void>()
  const broadcast = (event: string, data: unknown) => { for (const l of listeners) l(event, data) }
  let lastScan: { at: number; reports: ScanReport[] } | undefined
  let watch: WatchState = { mode: 'polling', watched: [] }
  let scanning: Promise<ScanReport[]> | null = null
  let again = false // a change arrived while scanning: scan once more when this one ends
  const rescan = (): Promise<ScanReport[]> => {
    if (scanning) { again = true; return scanning }
    broadcast('scan', { scanning: true })
    scanning = scan(adapters, store).then((reports) => {
      const changed = reports.flatMap((r) => r.changed)
      for (const id of changed) cache.delete(id)
      lastScan = { at: Date.now(), reports }
      broadcast('index', { changed, at: lastScan.at })
      return reports
    }).finally(() => {
      scanning = null
      broadcast('scan', { scanning: false })
      if (again) { again = false; rescan().catch(() => {}) }
    })
    return scanning
  }

  // Paging, images and context all re-read the same session in quick succession; parse it once.
  const cache = new Map<string, { at: number; s: Promise<Session | null> }>()
  const loadRaw = (id: string) => {
    const hit = cache.get(id)
    if (hit && Date.now() - hit.at < 20_000) return hit.s
    const s = loadSession(adapters, store, id)
    cache.set(id, { at: Date.now(), s })
    while (cache.size > 4) cache.delete(cache.keys().next().value!)
    s.then((v) => { if (!v) cache.delete(id) }, () => cache.delete(id))
    return s
  }
  /**
   * The session as the reader chose to see it: hidden messages keep their slot (so indices used by paging,
   * images and search stay valid) but lose their content, so nothing downstream counts or shows them.
   */
  const load = async (id: string): Promise<Session | null> => {
    const s = await loadRaw(id)
    if (!s) return null
    const hidden = overlay.hiddenMessages(id)
    if (!hidden.size) return s
    return { ...s, messages: s.messages.map((m) => (hidden.has(m.id) ? ({ id: m.id, role: m.role, time: m.time, blocks: [], hidden: true } as Message) : m)) }
  }
  const visible = (list: SessionSummary[]) => { const h = overlay.hiddenSessions(); return h.size ? list.filter((s) => !h.has(s.id)) : list }
  /** written in the last two minutes, or one of our runs is writing it: probably open in an agent right now */
  const ACTIVE_MS = 120_000
  const decorate = async (list: SessionSummary[]) => {
    const pins = overlay.pinned()
    const names = overlay.titles()
    const now = Date.now()
    return Promise.all(list.map(async (s) => ({
      ...s,
      ...(names.has(s.id) && { title: names.get(s.id)!, renamed: true }),
      project: await projectOf(s.cwd),
      pinned: pins.has(s.id) || undefined,
      active: now - s.updatedAt < ACTIVE_MS || !!runs.active(s.id) || undefined,
    })))
  }

  app.get('/api/agents', (c) => {
    const counts: Record<string, number> = {}
    for (const s of visible(store.list())) counts[s.agent] = (counts[s.agent] ?? 0) + 1
    return c.json(adapters.map((a) => {
      const st = a.storage()
      const report = lastScan?.reports.find((r) => r.agent === a.id)
      return { id: a.id, label: a.label, sessionCount: counts[a.id] ?? 0, storage: st.path, available: existsSync(st.path), error: report?.error, canResume: !!a.resumeCommand, canContinue: !opts.readOnly && !!a.continueCommand, canCreate: !!a.newCommand, bin: a.bin }
    }))
  })

  app.get('/api/sessions', async (c) => {
    const agent = c.req.query('agent')
    const q = c.req.query('q')
    return c.json(await decorate(visible(store.list({ agent, q }))))
  })

  /** what this machine can open, and whether updates arrive live */
  app.get('/api/status', (c) => c.json({ scanning: !!scanning, lastScan: lastScan?.at, watch, capabilities: capabilities(), platform: process.platform }))
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => { stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}) }
    listeners.add(send)
    send('hello', { lastScan: lastScan?.at, scanning: !!scanning })
    // held open until the page goes away; a ping keeps proxies and sleeping laptops from dropping it silently
    await new Promise<void>((resolve) => {
      const ping = setInterval(() => { stream.writeSSE({ event: 'ping', data: '' }).catch(() => { clearInterval(ping); resolve() }) }, 25_000)
      stream.onAbort(() => { clearInterval(ping); resolve() })
    })
    listeners.delete(send)
  }))

  // ---- pins (Sessionary's own state) ----
  app.post('/api/sessions/:id/pin', (c) => { overlay.pin(c.req.param('id')); broadcast('index', { changed: [c.req.param('id')], at: Date.now() }); return c.json({ ok: true }) })
  app.post('/api/sessions/:id/unpin', (c) => { overlay.unpin(c.req.param('id')); broadcast('index', { changed: [c.req.param('id')], at: Date.now() }); return c.json({ ok: true }) })

  // ---- open things on the desktop: folder, terminal, editor, and the agent's own interactive resume ----
  const resumeOf = (id: string) => {
    const row = store.get(id)
    const a = row && adapters.find((x) => x.id === row.agent)
    if (!row || !a?.resumeCommand) return null
    // a sub-agent transcript is resumed through its parent
    const target = row.summary.parentId ? store.get(row.summary.parentId) ?? row : row
    return a.resumeCommand({ key: target.sourceKey, ref: target.sourceKey, fingerprint: '' }, target.summary)
  }
  app.get('/api/sessions/:id/resume-command', (c) => {
    const cmd = resumeOf(c.req.param('id'))
    return cmd ? c.json({ ...cmd, line: commandLine(cmd) }) : c.json({ error: 'This agent has no resume command.' }, 404)
  })
  app.post('/api/sessions/:id/open', async (c) => {
    const row = store.get(c.req.param('id'))
    if (!row) return c.json({ error: 'Session not found.' }, 404)
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    const cwd = row.summary.cwd ?? ''
    try {
      switch (body?.target) {
        case 'folder': await openFolder(cwd); break
        case 'terminal': await openTerminal(cwd); break
        case 'editor': await openInEditor(cwd, cwd); break
        case 'file': {
          const p = typeof body.path === 'string' && cwd ? inside(cwd, body.path) : null
          if (!p) return c.json({ error: 'That file is outside the session’s directory.' }, 400)
          await openInEditor(p, cwd)
          break
        }
        case 'resume': {
          const cmd = resumeOf(row.summary.id)
          if (!cmd) return c.json({ error: 'This agent cannot be resumed from Sessionary.' }, 400)
          if (runs.active(row.summary.id)) return c.json({ error: 'Sessionary is still running a prompt in this session. Wait for it or stop it first.' }, 409)
          await openTerminal(cmd.cwd, cmd)
          break
        }
        default: return c.json({ error: 'Unknown target.' }, 400)
      }
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof LaunchError ? 422 : 500)
    }
  })

  app.get('/api/search', (c) => {
    const names = overlay.titles()
    const hits = store.search(c.req.query('q') ?? '', c.req.query('agent'), { sessions: overlay.hiddenSessions(), messages: overlay.allHiddenMessages() })
    return c.json(names.size ? hits.map((h) => (names.has(h.sessionId) ? { ...h, session: { ...h.session, title: names.get(h.sessionId)! } } : h)) : hits)
  })

  /** counts and the latest activity, for overviews that must not load every session */
  app.get('/api/summary', async (c) => {
    const list = await decorate(visible(store.list()))
    const projects = new Set(list.filter((s) => !s.project.generic).map((s) => s.project.key))
    const agents = adapters.map((a) => {
      const own = list.filter((s) => s.agent === a.id)
      return { id: a.id, label: a.label, sessions: own.length, last: own[0]?.updatedAt }
    })
    return c.json({ sessions: list.length, projects: projects.size, active: list.filter((s) => s.active).length, last: list[0]?.updatedAt, agents, recent: list.slice(0, 8) })
  })

  app.get('/api/sessions/:id/find', (c) => c.json(store.find(c.req.param('id'), c.req.query('q') ?? '', overlay.hiddenMessages(c.req.param('id')))))

  // ---- trash: Sessionary-only hiding; agents' files are never touched ----
  app.get('/api/trash', async (c) => {
    const sessions: unknown[] = []
    const messages = new Map<string, { count: number; at: number }>()
    for (const e of overlay.entries()) {
      if (e.kind === 'session') {
        const row = store.get(e.sessionId)
        if (row) sessions.push({ ...row.summary, hiddenAt: e.at })
      } else {
        const m = messages.get(e.sessionId) ?? { count: 0, at: e.at }
        m.count++
        messages.set(e.sessionId, m)
      }
    }
    const hiddenSessions = overlay.hiddenSessions()
    const partial = [...messages].filter(([id]) => !hiddenSessions.has(id)).flatMap(([id, m]) => {
      const row = store.get(id)
      return row ? [{ ...row.summary, hiddenMessages: m.count, hiddenAt: m.at }] : []
    })
    const withProject = <T extends SessionSummary>(l: T[]) => Promise.all(l.map(async (x) => ({ ...x, project: await projectOf(x.cwd) })))
    const removed = overlay.removed().map((r) => ({ ...r.summary, removedAt: r.at, backupDir: r.backupDir }))
    return c.json({ sessions: await withProject(sessions as SessionSummary[]), partial: await withProject(partial), removed: await withProject(removed) })
  })
  const ids = async (c: { req: { json: () => Promise<any> } }) => { try { const b = await c.req.json(); return Array.isArray(b?.ids) ? (b.ids as unknown[]).filter((x): x is string => typeof x === 'string') : undefined } catch { return undefined } }
  // ---- continue an existing session through the agent's own CLI ----
  const runs = new Runs(adapters, store, (r) => { cache.delete(r.sessionId); if (r.resultSessionId) cache.delete(r.resultSessionId); rescan().catch(() => {}) })
  app.post('/api/sessions/:id/continue', async (c) => {
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    try {
      const run = await runs.start(c.req.param('id'), String(body?.prompt ?? ''), body?.allowWrite === true)
      broadcast('index', { changed: [run.sessionId], at: Date.now() }) // it is active now
      return c.json(publicRun(run))
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof RunError ? 409 : 500)
    }
  })
  app.get('/api/sessions/:id/run', (c) => { const r = runs.active(c.req.param('id')); return c.json(r ? publicRun(r) : null) })
  app.post('/api/runs/:id/stop', (c) => { runs.stop(c.req.param('id')); const r = runs.get(c.req.param('id')); return c.json(r ? publicRun(r) : null) })
  /** Server-sent events while a run is going: `update` whenever the agent wrote to the session, then `end`. */
  app.get('/api/runs/:id/events', (c) => {
    const run = runs.get(c.req.param('id'))
    if (!run) return c.json({ error: 'not found' }, 404)
    return streamSSE(c, async (stream) => {
      const row = store.get(run.sessionId)
      const adapter = adapters.find((a) => a.id === row?.agent)
      let last = ''
      while (!stream.aborted) {
        const watchId = run.resultSessionId ?? run.sessionId
        const key = store.get(watchId)?.sourceKey ?? row?.sourceKey
        const fp = key ? (await adapter?.listSources())?.find((x) => x.key === key)?.fingerprint ?? '' : ''
        if (fp && fp !== last) {
          if (last) { cache.delete(run.sessionId); await stream.writeSSE({ event: 'update', data: JSON.stringify(publicRun(run)) }) }
          last = fp
        }
        if (run.status !== 'running') { await stream.writeSSE({ event: 'end', data: JSON.stringify(publicRun(run)) }); break }
        await stream.sleep(700)
      }
    })
  })

  // ---- delete from disk (phase 2): agent-native and reversible through a backup ----
  const guarded = async (c: { json: (b: unknown, s?: any) => Response }, fn: () => Promise<unknown>) => {
    try {
      const r = await fn()
      cache.clear()
      await rescan()
      return c.json({ ok: true, ...(r as object) })
    } catch (e) {
      if (e instanceof RemovalError) return c.json({ error: e.message, code: e.code }, e.code === 'busy' || e.code === 'conflict' ? 409 : 422)
      return c.json({ error: (e as Error).message }, 500)
    }
  }
  app.post('/api/sessions/:id/delete-from-disk', (c) => guarded(c, () => removeFromDisk(adapters, store, overlay, c.req.param('id'))))
  app.post('/api/removed/:id/restore', (c) => guarded(c, () => restoreFromBackup(adapters, overlay, c.req.param('id'))))
  app.post('/api/removed/:id/purge', (c) => guarded(c, () => purgeBackup(overlay, c.req.param('id'))))

  app.post('/api/sessions/:id/rename', async (c) => {
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    overlay.rename(c.req.param('id'), String(body?.title ?? ''))
    broadcast('index', { changed: [c.req.param('id')], at: Date.now() })
    return c.json({ ok: true })
  })
  app.post('/api/sessions/:id/hide', (c) => { overlay.hideSession(c.req.param('id')); return c.json({ ok: true }) })
  app.post('/api/sessions/:id/restore', (c) => { overlay.restoreSession(c.req.param('id')); return c.json({ ok: true }) })
  app.post('/api/sessions/:id/messages/hide', async (c) => {
    const list = await ids(c)
    if (!list?.length) return c.json({ error: 'ids required' }, 400)
    overlay.hideMessages(c.req.param('id'), list)
    return c.json({ ok: true })
  })
  app.post('/api/sessions/:id/messages/restore', async (c) => { overlay.restoreMessages(c.req.param('id'), await ids(c)); return c.json({ ok: true }) })

  app.post('/api/scan', async (c) => c.json(await rescan()))


  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const s = await load(id)
    if (!s) return c.json({ error: 'not found' }, 404)
    const all = c.req.query('limit') === 'all'
    const page = pageMessages(s.messages, Number(c.req.query('cursor') ?? 0) || 0, all ? Infinity : Number(c.req.query('limit')) || PAGE_SIZE)
    const messages = s.messages.slice(page.start, page.end).map((m, i) => prepare(m, page.start + i))
    const { messages: _, ...summary } = s
    const [deco] = await decorate([summary as SessionSummary])
    return c.json({ ...deco, messages, page, children: page.start === 0 ? visible(store.children(id)) : [], trashed: overlay.hiddenSessions().has(id) })
  })

  // the reader's prompts, for the jump-to index beside the conversation (covers pages not loaded yet)
  app.get('/api/sessions/:id/outline', async (c) => {
    const s = await load(c.req.param('id'))
    if (!s) return c.json({ error: 'not found' }, 404)
    const out: { msgIndex: number; text: string; time?: number }[] = []
    s.messages.forEach((m, i) => {
      if (!isTurnStart(m)) return
      const raw = m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
      // machine-generated user turns (background task results, interruptions) are not prompts
      if (/^\s*(<task-notification|<system-reminder|\[Request interrupted)/.test(raw)) return
      const pasted = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content/.exec(raw)?.[1]
      const own = cleanPrompt(raw.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' '))
      // a prompt that is only a paste is recognised by the paste's opening words
      const text = own ?? (pasted ? `Pasted · ${cleanPrompt(pasted) ?? ''}` : m.blocks.some((b) => b.type === 'image') ? 'Image' : undefined)
      if (text) out.push({ msgIndex: i, text: text.slice(0, 160), time: m.time })
    })
    return c.json(out)
  })

  // every edit/write call of the session, for the change review and the inspector, without the transcript
  app.get('/api/sessions/:id/edits', async (c) => {
    const s = await load(c.req.param('id'))
    if (!s) return c.json({ error: 'not found' }, 404)
    const edits = s.messages.flatMap((m, i) => prepare(m, i).blocks.filter((b) => b.type === 'tool' && (b.kind === 'edit' || b.kind === 'write')).map((b) => ({ ...b, output: undefined, time: m.time })))
    return c.json(edits)
  })

  app.get('/api/sessions/:id/images/:ref', async (c) => {
    const s = await load(c.req.param('id'))
    const [i, j] = c.req.param('ref').split('-').map(Number)
    const b = s?.messages[i ?? -1]?.blocks[j ?? -1]
    if (!b || b.type !== 'image' || !b.data) return c.json({ error: 'not found' }, 404)
    return new Response(Buffer.from(b.data, 'base64'), { headers: { 'content-type': b.mime, 'cache-control': 'private, max-age=86400' } })
  })

  app.get('/api/sessions/:id/changes', async (c) => {
    const cwd = store.get(c.req.param('id'))?.summary.cwd
    return c.json((cwd && (await gitChanges(cwd))) || { root: null, files: [] })
  })

  app.get('/api/sessions/:id/changes/file', async (c) => {
    const cwd = store.get(c.req.param('id'))?.summary.cwd
    const rel = c.req.query('path')
    const d = cwd && rel ? await gitFileDiff(cwd, rel) : null
    return d ? c.json(d) : c.json({ error: 'unavailable' }, 404)
  })

  app.get('/api/sessions/:id/tree', async (c) => {
    const row = store.get(c.req.param('id'))
    if (!row?.summary.cwd) return c.json({ error: 'no directory' }, 404)
    try {
      const entries = await listDir(row.summary.cwd, c.req.query('path') ?? '')
      return entries ? c.json(entries) : c.json({ error: 'outside project' }, 400)
    } catch {
      return c.json({ error: 'unreadable' }, 404)
    }
  })

  app.get('/api/sessions/:id/context', async (c) => {
    const s = await load(c.req.param('id'))
    if (!s) return c.json({ error: 'not found' }, 404)
    return c.json(await projectContext(s))
  })

  // ---- nodes: other machines running Sessionary, reached through a tunnel we manage ----
  let warmUp = (_id: string) => {}
  const nodes = new Nodes(overlay, (dir, mirrorHome) => {
    const sub = createApp(new IndexStore(path.join(dir, 'index.db')), undefined, new OverlayStore(':memory:'), { adapters: adaptersFor(() => mirrorRoots(mirrorHome)), readOnly: true })
    return { request: (p, init) => sub.app.request(p, init), rescan: sub.rescan }
  }, { online: (id) => warmUp(id) })
  const nodeErr = (c: Context, e: unknown) => {
    if (e instanceof NodeError) return c.json({ error: e.message }, e.status as 400)
    throw e
  }
  app.get('/api/nodes', (c) => c.json(nodes.list()))
  app.post('/api/nodes', async (c) => {
    try { return c.json(nodes.add(await c.req.json().catch(() => ({})))) } catch (e) { return nodeErr(c, e) }
  })
  app.put('/api/nodes/:id', async (c) => {
    try { const n = await nodes.update(c.req.param('id'), await c.req.json().catch(() => ({}))); probeCache.drop(c.req.param('id')); return c.json(n) } catch (e) { return nodeErr(c, e) }
  })
  app.delete('/api/nodes/:id', (c) => { nodes.remove(c.req.param('id')); probeCache.drop(c.req.param('id')); return c.json({ ok: true }) })
  app.post('/api/nodes/:id/connect', async (c) => {
    try { await nodes.connect(c.req.param('id')) } catch (e) { return nodeErr(c, e) }
    return c.json(nodes.list().find((n) => n.id === c.req.param('id')))
  })
  app.post('/api/nodes/:id/sync', async (c) => {
    try { await nodes.syncNow(c.req.param('id')) } catch (e) { return nodeErr(c, e) }
    return c.json(nodes.list().find((n) => n.id === c.req.param('id')))
  })
  app.get('/api/ssh-hosts', (c) => c.json(sshHosts()))
  // resume a session of an ssh node: a terminal here running ssh -t, then the agent's own resume command there
  app.get('/api/nodes/:id/resume-command', async (c) => {
    try { return c.json({ line: (await nodes.resumeCommand(c.req.param('id'), c.req.query('session') ?? '')).line }) } catch (e) { return nodeErr(c, e) }
  })
  app.post('/api/nodes/:id/resume', async (c) => {
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    try {
      const cmd = await nodes.resumeCommand(c.req.param('id'), String(body?.sessionId ?? ''))
      await openTerminal(os.homedir(), { bin: cmd.bin, args: cmd.args, cwd: os.homedir() })
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof LaunchError) return c.json({ error: e.message }, 422)
      return nodeErr(c, e)
    }
  })
  app.post('/api/nodes/:id/disconnect', (c) => { nodes.disconnect(c.req.param('id')); return c.json({ ok: true }) })
  // the node's own API, verbatim: `/api/nodes/:id/proxy/api/sessions` is `/api/sessions` on that node
  app.all('/api/nodes/:id/proxy/*', async (c) => {
    const id = c.req.param('id')
    const rest = new URL(c.req.url).pathname.slice(`/api/nodes/${id}/proxy`.length)
    try {
      const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.arrayBuffer()
      const res = await nodes.forward(id, c.req.method, rest, new URL(c.req.url).search, { contentType: c.req.header('content-type'), accept: c.req.header('accept') }, body)
      const headers = new Headers()
      for (const h of ['content-type', 'cache-control']) { const v = res.headers.get(h); if (v) headers.set(h, v) }
      return new Response(res.body, { status: res.status, headers })
    } catch (e) { return nodeErr(c, e) }
  })

  // ---- machines: this computer and every node, one list, one way to ask each what it is doing ----
  const AGENT_NAMES = (): [string, string][] => localAdapters.filter((a) => a.bin).map((a) => [a.id, a.bin])
  const cached = <T,>(ttl: number) => { const m = new Map<string, { at: number; v: Promise<T> }>(); return (k: string, f: () => Promise<T>) => { const h = m.get(k); if (h && Date.now() - h.at < ttl) return h.v; const v = f(); m.set(k, { at: Date.now(), v }); v.catch(() => m.delete(k)); return v } }
  // What is installed on a machine rarely changes, but finding out costs a login shell and a few program starts, so
  // the answer is remembered on disk: asking returns the last answer at once and, when it is getting old, looks
  // again in the background. The login shell's PATH is remembered longer still, and a program whose file has not
  // changed is not asked for its version again.
  const probeCache = new ProbeCache()
  const PROBE_FRESH_MS = Number(process.env.SESSIONARY_PROBE_FRESH_MS ?? 60_000)
  const PATH_FRESH_MS = 6 * 3_600_000
  const probing = new Map<string, Promise<ProbeEntry>>()
  const probeAgents = (id: string, force = false): Promise<ProbeEntry> => {
    const running = probing.get(id)
    if (running) return running
    const prev = probeCache.get(id)
    const run = (async (): Promise<ProbeEntry> => {
      const names = AGENT_NAMES()
      let entry: ProbeEntry
      if (id === 'local') {
        const r = await localAgents(names, prev?.known)
        entry = { at: Date.now(), agents: r.agents, known: r.known }
      } else {
        const cfg = nodes.list().find((n) => n.id === id)
        if (!cfg) throw new NodeError('No such machine.', 404)
        if (cfg.kind !== 'ssh') {
          const r = (await remoteJson(id, '/api/machines/local/agents')) as { agents: ProbeEntry['agents'] }
          entry = { at: Date.now(), agents: r.agents, known: {} }
        } else {
          const path = !force && prev?.path && prev.pathAt && Date.now() - prev.pathAt < PATH_FRESH_MS ? prev.path : undefined
          const out = (await nodes.exec(id, agentsScript(names.map(([, b]) => b), { loginPath: !path, path, known: prev?.known }))).stdout
          const r = parseAgents(out, names, prev?.known)
          entry = { at: Date.now(), agents: r.agents, known: r.known, path: r.path ?? prev?.path, pathAt: path ? prev!.pathAt : Date.now() }
        }
      }
      probeCache.set(id, entry)
      return entry
    })()
    probing.set(id, run)
    run.then(() => probing.delete(id), () => probing.delete(id))
    return run
  }
  warmUp = (id) => { probeAgents(id).catch(() => {}) }
  const remoteJson = async (id: string, path: string) => {
    const r = await nodes.forward(id, 'GET', path, '', {})
    if (!r.ok) throw new NodeError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? 'The machine did not answer.', 502)
    return r.json()
  }
  if (!opts.readOnly) {
    // ---- Model Control: providers, routing groups, which agent uses what, and the gateway agents are pointed at ----
    const control = registerControl(app, { store: opts.control ?? new ControlStore(':memory:'), gatewayBase: () => `http://127.0.0.1:${opts.port ?? 4777}/gateway`, broadcast, sshNode: (id) => nodes.list().some((n) => n.id === id && n.kind === 'ssh') })
    app.get('/api/machines', (c) => c.json([
      { id: 'local', name: 'Localhost', kind: 'local', state: 'online', host: os.hostname(), platform: process.platform, at: 0 },
      ...nodes.list(),
    ]))
    app.get('/api/machines/:id/system', async (c) => {
      const id = c.req.param('id')
      try {
        if (id === 'local') return c.json(await localSystem())
        const cfg = nodes.list().find((n) => n.id === id)
        if (!cfg) return c.json({ error: 'No such machine.' }, 404)
        if (cfg.kind !== 'ssh') return c.json(await remoteJson(id, '/api/machines/local/system'))
        const raw = await nodes.exec(id, SYSTEM_SCRIPT)
        const report = parseSystem(raw.stdout)
        // the script only knows Linux; say what came back instead of guessing why
        if (!report.mem && !report.load && report.uptime == null && !report.procs.length) {
          const said = (raw.stderr.trim() || raw.stdout.trim()).slice(0, 300)
          throw new NodeError(`The node did not report its state. System monitoring needs a Linux node (it reads /proc). It answered: ${said || 'nothing'}`, 502)
        }
        return c.json(report)
      } catch (e) { return nodeErr(c, e) }
    })
    app.get('/api/machines/:id/agents', async (c) => {
      const id = c.req.param('id')
      const force = c.req.query('refresh') === '1'
      try {
        const have = probeCache.get(id)
        if (have && !force) {
          const old = Date.now() - have.at >= PROBE_FRESH_MS
          if (old) probeAgents(id).catch(() => {})
          return c.json({ agents: have.agents, at: have.at, refreshing: old || probing.has(id) })
        }
        const e = await probeAgents(id, force)
        return c.json({ agents: e.agents, at: e.at, refreshing: false })
      } catch (e) { return nodeErr(c, e) }
    })

    // ---- terminals: a shell or an agent running here or on a node; the server keeps it while the page is away ----
    const terminals = new Terminals()
    const authed = (c: Context) => (c.req.header('x-sessionary-token') ?? c.req.query('token')) === token
    const termErr = (c: Context, e: unknown) => {
      if (e instanceof TerminalError) return c.json({ error: e.message }, 409)
      if (e instanceof LaunchError) return c.json({ error: e.message }, 422)
      return nodeErr(c, e)
    }
    const startTerminal = async (body: any) => {
      const machine = String(body?.machine ?? 'local')
      const kind = body?.kind === 'resume' || body?.kind === 'new' ? body.kind : 'shell'
      const size = { cols: Number(body?.cols) || 100, rows: Number(body?.rows) || 30 }
      const cwdIn = typeof body?.cwd === 'string' && body.cwd && !body.cwd.startsWith('generic:') ? body.cwd : undefined
      const agent = typeof body?.agent === 'string' ? body.agent : undefined
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
      const meta: TermMeta = { machine, kind, title: 'Shell', agent, sessionId, cwd: cwdIn, cols: size.cols, rows: size.rows }
      const node = machine === 'local' ? undefined : nodes.list().find((n) => n.id === machine)
      if (machine !== 'local' && !node) throw new NodeError('No such machine.', 404)
      if (node && node.kind !== 'ssh') throw new NodeError('Terminals are available on this computer and on nodes reached over SSH.', 400)

      let run: { bin: string; args: string[] } | undefined
      let cwd = cwdIn
      if (kind === 'resume') {
        if (!sessionId) throw new NodeError('Which session?', 400)
        const cmd = node ? await nodes.resumeRaw(machine, sessionId) : resumeOf(sessionId)
        if (!cmd) throw new NodeError('This agent cannot be resumed from Sessionary.', 400)
        run = cmd; cwd = cmd.cwd || cwd
        const row = node ? undefined : store.get(sessionId)
        meta.title = overlay.titles().get(sessionId) ?? row?.summary.title ?? 'Session'
        // a node's sessions are not in this computer's index; their id still starts with the agent's
        meta.agent ??= row?.agent ?? (sessionId.includes(':') ? sessionId.slice(0, sessionId.indexOf(':')) : undefined); meta.cwd = cwd
      } else if (kind === 'new') {
        const a = localAdapters.find((x) => x.id === agent)
        if (!a?.newCommand) throw new NodeError('This agent cannot be started from Sessionary.', 400)
        const cmd = a.newCommand(cwd ?? '')
        run = { bin: node ? (cmd.bin.split('/').pop() ?? cmd.bin) : cmd.bin, args: cmd.args }
        meta.title = `${a.label} · ${cwd?.split('/').filter(Boolean).pop() ?? 'new session'}`
      }
      // a bound agent started here goes through the gateway: its routing is added to how it is started; on a node
      // that includes a door of its own, which must close when the terminal's process ends (or never starts)
      const extra = run && meta.agent ? await control.launchFor(meta.agent, machine) : undefined
      if (run && extra) run = { bin: run.bin, args: [...extra.args, ...run.args] }
      try {
        if (!node) {
          if (cwd && !existsSync(cwd)) cwd = undefined
          return terminals.create(meta, localTerminalSpec({ cwd: cwd ?? os.homedir(), run, size, env: extra?.env }))
        }
        const spec = sshTerminalSpec(nodes.target(machine), { cwd, run, size, env: extra?.env, secret: extra?.secret, tunnel: extra?.tunnel })
        return terminals.create(meta, ptyWrap(spec, size), extra?.release)
      } catch (e) { extra?.release?.(); throw e }
    }
    app.get('/api/terminals', (c) => (authed(c) ? c.json(terminals.list(c.req.query('machine'))) : c.json({ error: 'Missing token.' }, 403)))
    app.post('/api/terminals', async (c) => {
      try { return c.json(await startTerminal(await c.req.json().catch(() => ({})))) } catch (e) { return termErr(c, e) }
    })
    app.get('/api/terminals/:id/stream', (c) => {
      if (!authed(c)) return c.json({ error: 'Missing token.' }, 403)
      const id = c.req.param('id')
      if (!terminals.get(id)) return c.json({ error: 'No such terminal.' }, 404)
      return streamSSE(c, async (stream) => {
        const off = terminals.subscribe(id,
          (b) => { stream.writeSSE({ event: 'out', data: b.toString('base64') }).catch(() => {}) },
          (info) => { stream.writeSSE({ event: 'exit', data: JSON.stringify(info) }).catch(() => {}) })
        await new Promise<void>((resolve) => {
          const ping = setInterval(() => { stream.writeSSE({ event: 'ping', data: '' }).catch(() => { clearInterval(ping); resolve() }) }, 25_000)
          stream.onAbort(() => { clearInterval(ping); resolve() })
        })
        off?.()
      })
    })
    app.post('/api/terminals/:id/input', async (c) => {
      const body = await c.req.json().catch(() => ({}))
      try { terminals.write(c.req.param('id'), String((body as any)?.data ?? '')); return c.json({ ok: true }) } catch (e) { return termErr(c, e) }
    })
    app.post('/api/terminals/:id/resize', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { cols?: number; rows?: number }
      try { terminals.resize(c.req.param('id'), Number(body.cols), Number(body.rows)); return c.json({ ok: true }) } catch (e) { return termErr(c, e) }
    })
    app.post('/api/terminals/:id/kill', (c) => { terminals.kill(c.req.param('id')); return c.json({ ok: true }) })
    app.post('/api/terminals/:id/restart', async (c) => {
      const old = terminals.get(c.req.param('id'))
      if (!old) return c.json({ error: 'No such terminal.' }, 404)
      const body = await c.req.json().catch(() => ({}))
      try {
        terminals.remove(old.id)
        return c.json(await startTerminal({ machine: old.machine, kind: old.kind, agent: old.agent, sessionId: old.sessionId, cwd: old.cwd, cols: old.cols, rows: old.rows, ...(body as object) }))
      } catch (e) { return termErr(c, e) }
    })
    app.delete('/api/terminals/:id', (c) => { terminals.remove(c.req.param('id')); return c.json({ ok: true }) })
    stopTerminals = () => terminals.stopAll()

    // ---- notices: what is worth interrupting someone for (the page decides whether to) ----
    const notifier = new Notifier()
    const nameOf = (id: string) => (id === 'local' ? 'Localhost' : nodes.list().find((n) => n.id === id)?.name ?? id)
    const stopWatching = [
      watchTerminals(terminals, notifier, (t) => ({ agent: localAdapters.find((a) => a.id === t.agent)?.label ?? t.agent ?? 'Agent', machineName: nameOf(t.machine) })),
      watchNodes(nodes, notifier),
    ]
    stopNotices = () => { for (const s of stopWatching) s() }

    // ---- chats: an agent's own protocol held open, so a message gets an answer, not a new process ----
    const chatLabel = (id: string) => localAdapters.find((a) => a.id === id)?.label ?? id
    const chats = new Chats({
      spawnFor: (machine) => (machine === 'local' ? localSpawner : sshSpawner(nodes.target(machine))),
      launchFor: (agent, machine) => control.launchFor(agent, machine),
      hooks: {
        changed: (ch, why) => {
          if (why === 'approval') notifier.emit({ type: 'agent', code: 'chat.approval', key: `chat-approval:${ch.id}`, machine: ch.machine, params: { agent: chatLabel(ch.agent), title: ch.title ?? ch.preview ?? '', machineName: nameOf(ch.machine), chat: ch.id, session: ch.sessionKey ?? '' } })
          // a quick answer is not worth an interruption: only turns that took a while end with a notice
          else if (why === 'turn-end' && (ch.lastTurnMs ?? 0) >= Number(process.env.SESSIONARY_NOTIFY_CHAT_MIN_MS ?? 15_000)) notifier.emit({ type: 'agent', code: 'chat.done', key: `chat-done:${ch.id}`, machine: ch.machine, params: { agent: chatLabel(ch.agent), title: ch.title ?? '', machineName: nameOf(ch.machine), chat: ch.id, session: ch.sessionKey ?? '', preview: ch.preview ?? '' } })
          if (why === 'turn-end' || why === 'closed') { if (ch.machine === 'local') rescan().catch(() => {}); else nodes.syncNow(ch.machine).catch(() => {}) }
        },
      },
    })
    stopChats = async () => { await chats.stopAll(); control.closeDoors() }
    const chatErr = (c: Context, e: unknown) => {
      if (e instanceof ChatError) return c.json({ error: e.message, code: e.code }, e.code === 'busy' ? 409 : e.code === 'unsupported' ? 400 : e.code === 'unavailable' ? 410 : 502)
      if (e instanceof NodeError) return c.json({ error: e.message }, e.status as 400)
      return c.json({ error: (e as Error).message }, 500)
    }
    /** which agent, directory and agent-side id a Sessionary session continues as */
    const chatTarget = async (machine: string, sessionId: string) => {
      const agent = sessionId.slice(0, sessionId.indexOf(':'))
      const native = sessionId.slice(agent.length + 1)
      if (machine === 'local') {
        const row = store.get(sessionId)
        if (!row) throw new ChatError('Session not found.', 'failed')
        const cmd = resumeOf(sessionId)
        return { agent: row.agent, cwd: row.summary.cwd, resume: cmd?.args.at(-1) ?? native, key: sessionId, title: overlay.titles().get(sessionId) ?? row.summary.title }
      }
      const cmd = await nodes.resumeRaw(machine, sessionId).catch(() => undefined)
      // Pi is resumed by its id there: the path we know is inside our copy
      return { agent, cwd: cmd?.cwd, resume: agent === 'pi' ? native : cmd?.args.at(-1) ?? native, key: sessionId, title: undefined }
    }
    app.get('/api/chats', (c) => (authed(c) ? c.json(chats.list(c.req.query('machine'))) : c.json({ error: 'Missing token.' }, 403)))
    app.get('/api/chats/agents', (c) => c.json(Object.fromEntries(Object.entries(PROTOCOL).map(([k, v]) => [k, v]))))
    app.get('/api/chats/for', (c) => {
      const f = chats.forSession(c.req.query('machine') ?? 'local', c.req.query('agent') ?? '', c.req.query('session') ?? '')
      return c.json(f ?? null)
    })
    app.post('/api/chats', async (c) => {
      try {
        const b = (await c.req.json().catch(() => ({}))) as any
        const machine = String(b.machine ?? 'local')
        if (machine !== 'local') { const n = nodes.list().find((x) => x.id === machine); if (!n) throw new NodeError('No such machine.', 404); if (n.kind !== 'ssh') throw new ChatError('Chats run on this computer and on nodes reached over SSH.', 'unsupported') }
        let agent = String(b.agent ?? ''), cwd: string | undefined = typeof b.cwd === 'string' && b.cwd && !b.cwd.startsWith('generic:') ? b.cwd : undefined
        let resume: string | undefined, key: string | undefined, title: string | undefined
        if (typeof b.sessionId === 'string' && b.sessionId) {
          const t = await chatTarget(machine, b.sessionId)
          agent = t.agent; cwd = t.cwd || cwd; resume = t.resume; key = t.key; title = t.title
        }
        if (!chatSupported(agent)) throw new ChatError(`${chatLabel(agent)} cannot be chatted with from Sessionary.`, 'unsupported')
        if (machine === 'local' && cwd && !existsSync(cwd)) { if (resume) throw new ChatError('The session’s working directory no longer exists, so the agent cannot resume it.', 'failed'); cwd = undefined }
        if (machine === 'local' && !cwd) cwd = os.homedir()
        const ch = await chats.open({ agent, machine, cwd, resume, sessionKey: key, title, model: b.model, mode: b.mode, effort: b.effort })
        return c.json(ch)
      } catch (e) { return chatErr(c, e) }
    })
    app.get('/api/chats/:id', (c) => { const ch = chats.get(c.req.param('id')); return ch ? c.json(ch) : c.json({ error: 'No such chat.' }, 404) })
    app.get('/api/chats/:id/events', (c) => {
      if (!authed(c)) return c.json({ error: 'Missing token.' }, 403)
      const id = c.req.param('id')
      if (!chats.get(id)) return c.json({ error: 'No such chat.' }, 404)
      const after = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0) || 0
      return streamSSE(c, async (stream) => {
        const off = chats.subscribe(id, after, (e) => { stream.writeSSE({ event: 'chat', id: String(e.seq), data: JSON.stringify(e) }).catch(() => {}) })
        await new Promise<void>((resolve) => {
          const ping = setInterval(() => { stream.writeSSE({ event: 'ping', data: '' }).catch(() => { clearInterval(ping); resolve() }) }, 25_000)
          stream.onAbort(() => { clearInterval(ping); resolve() })
        })
        off?.()
      })
    })
    const chatPost = (path: string, fn: (id: string, b: any) => Promise<unknown>) => app.post(`/api/chats/:id/${path}`, async (c) => {
      try { await fn(c.req.param('id'), await c.req.json().catch(() => ({}))); return c.json({ ok: true }) } catch (e) { return chatErr(c, e) }
    })
    chatPost('send', (id, b) => chats.send(id, { text: String(b.text ?? ''), images: Array.isArray(b.images) ? b.images.filter((i: any) => typeof i?.data === 'string' && typeof i?.mimeType === 'string').slice(0, 8) : undefined }))
    chatPost('interrupt', (id) => chats.interrupt(id))
    chatPost('respond', (id, b) => chats.respond(id, String(b.approval ?? ''), String(b.option ?? '')))
    chatPost('answer', (id, b) => chats.answer(id, String(b.question ?? ''), b.answers && typeof b.answers === 'object' ? b.answers : {}))
    chatPost('model', (id, b) => chats.setModel(id, String(b.model ?? '')))
    chatPost('mode', (id, b) => chats.setMode(id, String(b.mode ?? '')))
    chatPost('effort', (id, b) => chats.setEffort(id, String(b.effort ?? '')))
    app.delete('/api/chats/:id', async (c) => { await chats.close(c.req.param('id')); return c.json({ ok: true }) })
    app.get('/api/notifications', (c) => {
      if (!authed(c)) return c.json({ error: 'Missing token.' }, 403)
      return streamSSE(c, async (stream) => {
        // only what happens while this page is open: nothing is replayed, so a page that was closed hears nothing later
        const off = notifier.subscribe((n) => { stream.writeSSE({ event: 'notice', data: JSON.stringify(n) }).catch(() => {}) })
        await stream.writeSSE({ event: 'hello', data: '{}' })
        await new Promise<void>((resolve) => {
          const ping = setInterval(() => { stream.writeSSE({ event: 'ping', data: '' }).catch(() => { clearInterval(ping); resolve() }) }, 25_000)
          stream.onAbort(() => { clearInterval(ping); resolve() })
        })
        off()
      })
    })
  }

  // an unknown API route is an error, not the page: a page from a newer build talking to an older server must
  // be able to tell "this endpoint doesn't exist here" from "the server is down"
  app.all('/api/*', (c) => c.json({ error: 'No such endpoint — the running Sessionary may be older than this page.' }, 404))

  if (webRoot) {
    app.get('*', async (c) => {
      let rel = decodeURIComponent(new URL(c.req.url).pathname)
      if (rel === '/' || rel.includes('..')) rel = '/index.html'
      let file = path.join(webRoot, rel)
      let data = await fs.readFile(file).catch(() => null)
      if (!data) { file = path.join(webRoot, 'index.html'); data = await fs.readFile(file).catch(() => null) } // SPA fallback
      if (!data) return c.text('web assets missing – run `npm run build:web`', 500)
      return new Response(new Uint8Array(data), { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } })
    })
  }
  /** live updates from the agents' storage; polling stays as the fallback (and covers missed events) */
  const startWatching = () => {
    const w = watchSources(adapters, () => { rescan().catch(() => {}) })
    watch = w.state
    return w.close
  }
  /** reconnect every node in the background: a node that is down just stays down and shows why */
  const autoConnect = () => { warmUp('local'); for (const n of nodes.list()) nodes.connect(n.id).catch(() => {}) }
  return { app, rescan, startWatching, autoConnect, stopRuns: () => { stopNotices(); runs.stopAll(); nodes.stopAll(); stopTerminals(); stopChats().catch(() => {}) } }
}
