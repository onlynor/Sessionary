import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from '../core/sqlite.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RemovalError, type AgentAdapter, type Block, type Message, type Session, type SessionSummary, type Source, type UsageEntry } from '../core/model.ts'
import { totalsOf } from '../core/usage.ts'
import { derive, pickTitle } from '../core/derive.ts'
import { argSafe, localRoots, type Roots } from '../core/util.ts'

// <XDG_DATA_HOME>/opencode/opencode.db  (SQLite, WAL). Tables: session, message(data JSON), part(data JSON).
// Opened strictly read-only. The db is huge (event log), so we only ever touch session/message/part.

function open(file: string): DatabaseSync | null {
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

function withDb<T>(file: string, fn: (db: DatabaseSync) => T, fallback: T): T {
  const db = open(file)
  if (!db) return fallback
  try { return fn(db) } catch { return fallback } finally { db.close() }
}

const modelName = (json: string | null) => {
  try { return JSON.parse(json ?? '')?.id as string | undefined } catch { return undefined }
}

function summaryOf(db: DatabaseSync, id: string): SessionSummary | null {
  const r = db.prepare(`
    select s.*, (select count(*) from message m where m.session_id = s.id) as n
    from session s where s.id = ?`).get(id) as any
  if (!r) return null
  return {
    id: `opencode:${r.id}`,
    agent: 'opencode',
    nativeId: r.id,
    title: r.title,
    cwd: r.directory,
    model: modelName(r.model),
    createdAt: r.time_created,
    updatedAt: r.time_updated,
    messageCount: r.n,
    parentId: r.parent_id ? `opencode:${r.parent_id}` : undefined,
    tokens: { input: r.tokens_input + r.tokens_cache_read, output: r.tokens_output + r.tokens_reasoning },
    cost: r.cost,
  }
}

// OpenCode's database is never written by Sessionary. Removal goes through OpenCode's own CLI:
// `opencode export` to a backup file, then `opencode session delete`; restore is `opencode import`.
const run = promisify(execFile)
const bin = () => process.env.SESSIONARY_OPENCODE_BIN ?? 'opencode'
async function cli(...args: string[]) {
  try {
    return (await run(bin(), args, { timeout: 180_000, maxBuffer: 1 << 30, shell: process.platform === 'win32', env: { ...process.env, NO_COLOR: '1' } })).stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') throw new RemovalError('tool', 'The opencode command is not on PATH, so OpenCode sessions cannot be removed or restored.')
    throw new RemovalError('tool', `opencode ${args[0]} failed: ${(err.stderr || err.message).trim().split('\n').pop()}`)
  }
}

/** the session and every sub-agent session below it, parents first */
function family(file: string, id: string): { ids: string[]; lastUpdate: number } {
  return withDb(file, (db) => {
    const ids = [id]
    let last = (db.prepare('select time_updated t from session where id = ?').get(id) as any)?.t ?? 0
    for (let i = 0; i < ids.length; i++)
      for (const r of db.prepare('select id, time_updated t from session where parent_id = ?').all(ids[i]!) as any[]) { ids.push(r.id); last = Math.max(last, r.t) }
    return { ids, lastUpdate: last }
  }, { ids: [id], lastUpdate: 0 })
}

export const makeOpencode = (roots: () => Roots = localRoots): AgentAdapter => {
  const dbPath = () => path.join(roots().xdgData, 'opencode', 'opencode.db')
  const self: AgentAdapter = {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',

    async listSources() {
      return withDb(dbPath(), (db) => {
        const rows = db.prepare('select id, time_updated from session').all() as any[]
        return rows.map((r): Source => ({ key: r.id, ref: r.id, fingerprint: String(r.time_updated) }))
      }, [])
    },

    async summarize(source) {
      const s = await self.load(source)
      if (!s) return null
      const { messages, usage, ...summary } = s
      return summary
    },

    async load(source) {
      return withDb<Session | null>(dbPath(), (db) => {
        const summary = summaryOf(db, source.ref)
        if (!summary) return null
        const msgs = db.prepare('select id, time_created, data from message where session_id = ? order by time_created, id').all(source.ref) as any[]
        const parts = db.prepare('select message_id, data from part where session_id = ? order by id').all(source.ref) as any[]
        const byMsg = new Map<string, any[]>()
        for (const p of parts) {
          const list = byMsg.get(p.message_id) ?? []
          try { list.push(JSON.parse(p.data)) } catch { continue } // one corrupt row must not lose the session
          byMsg.set(p.message_id, list)
        }

        const messages: Message[] = []
        // each reply's own counts (OpenCode's input already leaves the cache out; reasoning is kept apart from output)
        const usage: UsageEntry[] = []
        for (const m of msgs) {
          let d: any
          try { d = JSON.parse(m.data) } catch { continue }
          const k = d.role === 'assistant' ? d.tokens : undefined
          if (k) usage.push({ time: d.time?.created ?? m.time_created, model: d.modelID, input: k.input ?? 0, output: (k.output ?? 0) + (k.reasoning ?? 0), cacheRead: k.cache?.read ?? 0, cacheWrite: k.cache?.write ?? 0, ...(typeof d.cost === 'number' && { cost: d.cost }) })
          const blocks: Block[] = []
          for (const p of byMsg.get(m.id) ?? []) {
            switch (p.type) {
              case 'text':
                if (p.text?.trim() && !p.synthetic) blocks.push({ type: 'text', text: p.text })
                break
              case 'reasoning':
                blocks.push({ type: 'thinking', text: p.text ?? '', redacted: !p.text })
                break
              case 'tool': {
                const st = p.state ?? {}
                blocks.push({
                  type: 'tool', id: p.callID, name: p.tool, input: st.input,
                  output: st.status === 'error' ? st.error : st.output,
                  status: st.status === 'completed' ? 'ok' : st.status === 'error' ? 'error' : 'pending',
                  diff: typeof st.metadata?.diff === 'string' ? st.metadata.diff : undefined,
                })
                break
              }
              case 'file':
                if (p.mime?.startsWith('image/') && p.url?.startsWith('data:'))
                  blocks.push({ type: 'image', mime: p.mime, data: p.url.split(',')[1] })
                else blocks.push({ type: 'note', kind: 'file', text: p.filename ?? p.url ?? 'file' })
                break
              case 'compaction':
                blocks.push({ type: 'note', kind: 'compaction', text: 'Conversation compacted' })
                break
              // step-start / step-finish / patch: bookkeeping, covered by tool diffs
            }
          }
          if (!blocks.length) continue
          messages.push({
            id: m.id, role: d.role === 'user' ? 'user' : 'assistant', time: m.time_created,
            model: d.modelID ?? d.model?.modelID, blocks,
          })
        }
        const firstPrompt = messages.find((m) => m.role === 'user')?.blocks.find((b) => b.type === 'text')
        const title = pickTitle([summary.title], firstPrompt?.type === 'text' ? firstPrompt.text : undefined, summary.title)
        return { ...summary, title, messageCount: messages.length, ...totalsOf(usage), ...derive(messages), messages, usage }
      }, null)
    },

    async remove(source, backupDir) {
      const { ids, lastUpdate } = family(dbPath(), source.ref)
      if (Date.now() - lastUpdate < 120_000) throw new RemovalError('busy', 'This session was updated in the last two minutes and may still be running. Close it in OpenCode first.')
      await fs.mkdir(backupDir, { recursive: true })
      const files: string[] = []
      for (const [i, id] of ids.entries()) {
        const json = await cli('export', id)
        try { if (JSON.parse(json)?.info?.id !== id) throw new Error() } catch { throw new RemovalError('tool', `opencode export did not return session ${id}; nothing was deleted.`) }
        const f = path.join(backupDir, `${i}-${id}.json`)
        await fs.writeFile(f, json)
        files.push(f)
      }
      // children first, so a parent is never left pointing at a half-deleted tree
      for (const id of [...ids].reverse()) await cli('session', 'delete', id)
      return { files }
    },
    async restore(manifest) {
      for (const f of manifest.files as string[]) await cli('import', f)
    },

    // the database is rewritten in place (plus its WAL), so watch its directory, not a tree
    storage() { return { path: dbPath(), watch: [{ path: path.dirname(dbPath()), recursive: false }] } },
    newCommand(cwd) {
      return { bin: bin(), args: [], cwd }
    },
    resumeCommand(source, session) {
      return { bin: bin(), args: ['--session', source.ref], cwd: session.cwd ?? '' }
    },

    // read-only = OpenCode's built-in `plan` agent
    continueCommand(source, session, prompt, { allowWrite }) {
      return {
        bin: bin(),
        args: ['run', '-s', source.ref, '--format', 'json', ...(allowWrite ? [] : ['--agent', 'plan']), argSafe(prompt)],
        cwd: session.cwd ?? '',
      }
    },
  }
  return self
}
export const opencode = makeOpencode()
