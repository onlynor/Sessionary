import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { adapters } from '../adapters/index.ts'
import { gitChanges, gitFileDiff, projectContext } from '../core/context.ts'
import { cleanPrompt, toolKind } from '../core/derive.ts'
import { resolveProject } from '../core/project.ts'
import type { IndexStore } from '../core/index-store.ts'
import type { Block, Message, Session, SessionSummary } from '../core/model.ts'
import { isTurnStart, pageMessages } from '../core/paging.ts'
import { OverlayStore } from '../core/overlay.ts'
import { purgeBackup, removeFromDisk, restoreFromBackup } from '../core/removal.ts'
import { RemovalError } from '../core/model.ts'
import { publicRun, RunError, Runs } from '../core/runs.ts'
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

export function createApp(store: IndexStore, webRoot?: string, overlay: OverlayStore = new OverlayStore(':memory:')) {
  const app = new Hono()
  // DNS-rebinding guard: session history is private, so only answer requests addressed to a loopback name
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && !process.env.SESSIONARY_ALLOW_HOST) return c.text('Forbidden host', 403)
    await next()
  })

  // Anything that changes state (and continuing a session runs an agent on this machine) needs a per-launch
  // token. Other sites can't read it: no CORS, and the Host guard above stops DNS rebinding.
  const token = randomBytes(24).toString('hex')
  app.get('/api/token', (c) => c.json({ token }))
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
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
    const now = Date.now()
    return Promise.all(list.map(async (s) => ({
      ...s,
      project: await resolveProject(s.cwd),
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
      return { id: a.id, label: a.label, sessionCount: counts[a.id] ?? 0, storage: st.path, available: existsSync(st.path), error: report?.error, canResume: !!a.resumeCommand, canContinue: !!a.continueCommand }
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

  app.get('/api/search', (c) => c.json(store.search(c.req.query('q') ?? '', c.req.query('agent'), { sessions: overlay.hiddenSessions(), messages: overlay.allHiddenMessages() })))

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
    const withProject = <T extends SessionSummary>(l: T[]) => Promise.all(l.map(async (x) => ({ ...x, project: await resolveProject(x.cwd) })))
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
  return { app, rescan, startWatching, stopRuns: () => runs.stopAll() }
}
