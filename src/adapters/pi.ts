import fs from 'node:fs/promises'
import path from 'node:path'
import { assertIdle, moveAll, moveBack, type MovedEntry } from '../core/fsmove.ts'
import type { AgentAdapter, Block, Message, Session, Source } from '../core/model.ts'
import { cleanPrompt, derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import { argSafe, home, jsonlLines, toMs } from '../core/util.ts'

// ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
// Header line {type:"session", id, cwd}; then tree entries {id, parentId, type:"message"|"model_change"|...}.
// A tool call lives in an assistant message (toolCall block); its result is a separate `toolResult` message.
// The tree can fork; we render the path from the last entry back to the root (the active branch).

const root = () => path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(home(), '.pi', 'agent'), 'sessions')

export const pi: AgentAdapter = {
  id: 'pi',
  label: 'Pi',

  async listSources() {
    const out: Source[] = []
    let dirs
    try { dirs = await fs.readdir(root(), { withFileTypes: true }) } catch { return out }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      for (const f of await fs.readdir(path.join(root(), d.name)).catch(() => [])) {
        if (!f.endsWith('.jsonl')) continue
        const file = path.join(root(), d.name, f)
        const st = await fs.stat(file).catch(() => null)
        if (st) out.push({ key: file, ref: file, fingerprint: `${st.size}:${Math.floor(st.mtimeMs)}` })
      }
    }
    return out
  },

  async summarize(source) {
    const s = await parse(source)
    if (!s) return null
    const { messages, ...summary } = s
    return summary
  },
  load: (source) => parse(source),

  // A Pi session is exactly one file.
  async remove(source, backupDir) {
    await assertIdle([source.ref])
    return { entries: await moveAll([source.ref], backupDir) }
  },
  async restore(manifest) {
    await moveBack(manifest.entries as MovedEntry[])
  },

  storage() { return { path: root(), watch: [{ path: root(), recursive: true }] } },
  resumeCommand(source, session) {
    return { bin: process.env.SESSIONARY_PI_BIN ?? 'pi', args: ['--session', source.ref], cwd: session.cwd ?? '' }
  },

  // read-only = Pi's own documented allowlist of non-mutating tools
  continueCommand(source, session, prompt, { allowWrite }) {
    return {
      bin: process.env.SESSIONARY_PI_BIN ?? 'pi',
      args: ['--session', source.ref, '-p', ...(allowWrite ? [] : ['--tools', 'read,grep,find,ls']), argSafe(prompt)],
      cwd: session.cwd ?? '',
    }
  },
}

function text(content: any): string {
  if (typeof content === 'string') return content
  return (content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
}

async function parse(source: Source): Promise<Session | null> {
  let raw: string
  try { raw = await fs.readFile(source.ref, 'utf8') } catch { return null }

  let header: any
  const entries = new Map<string, any>()
  let leaf: string | undefined
  let name: string | undefined
  for (const o of jsonlLines(raw)) {
    if (o.type === 'session') header = o
    else if (o.id) { entries.set(o.id, o); leaf = o.id }
    if (o.type === 'session_info' && o.name) name = o.name
  }
  if (!header) return null

  const path_: any[] = []
  for (let id = leaf; id; ) {
    const e = entries.get(id)
    if (!e) break
    path_.push(e)
    id = e.parentId ?? undefined
  }
  path_.reverse()

  const messages: Message[] = []
  const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
  let model: string | undefined
  let cost = 0
  const tokens = { input: 0, output: 0 }
  let firstPrompt: string | undefined
  let last = toMs(header.timestamp)

  for (const e of path_) {
    const t = toMs(e.timestamp)
    if (t) last = t
    if (e.type === 'model_change') { model = e.modelId; continue }
    if (e.type === 'compaction') {
      messages.push({ id: e.id, role: 'system', time: t, blocks: [{ type: 'note', kind: 'compaction', text: e.summary ?? 'Conversation compacted' }] })
      continue
    }
    if (e.type !== 'message') continue
    const m = e.message
    switch (m.role) {
      case 'user': {
        const blocks: Block[] = []
        for (const b of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []) {
          if (b.type === 'text') { if (cleanPrompt(b.text)) firstPrompt ??= b.text; blocks.push({ type: 'text', text: b.text }) }
          else if (b.type === 'image') blocks.push({ type: 'image', mime: b.mimeType ?? 'image/png', data: b.data })
        }
        if (blocks.length) messages.push({ id: e.id, role: 'user', time: t, blocks })
        break
      }
      case 'assistant': {
        const blocks: Block[] = []
        for (const b of m.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) blocks.push({ type: 'text', text: b.text })
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: b.thinking ?? '', redacted: !b.thinking })
          else if (b.type === 'toolCall') {
            const tb: Extract<Block, { type: 'tool' }> = { type: 'tool', id: b.id, name: b.name, input: b.arguments, status: 'pending' }
            tools.set(b.id, tb)
            blocks.push(tb)
          }
        }
        if (m.errorMessage && !blocks.length) blocks.push({ type: 'note', kind: 'error', text: m.errorMessage })
        if (m.model) model = m.model
        if (m.usage) {
          tokens.input += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0)
          tokens.output += m.usage.output ?? 0
          cost += m.usage.cost?.total ?? 0
        }
        if (blocks.length) messages.push({ id: e.id, role: 'assistant', time: t, model: m.model, blocks })
        break
      }
      case 'toolResult': {
        const tb = tools.get(m.toolCallId)
        if (tb) { tb.output = text(m.content); tb.status = m.isError ? 'error' : 'ok' }
        break
      }
      case 'bashExecution': {
        // user-run `!cmd` shell escapes
        const status = m.exitCode === 0 ? 'ok' : 'error'
        messages.push({
          id: e.id, role: 'user', time: t,
          blocks: [{ type: 'tool', id: e.id, name: 'bash', input: { command: m.command }, output: m.output, status }],
        })
        break
      }
    }
  }

  // sessions that only ever saw slash commands (/help, /exit) hold no conversation
  if (!firstPrompt && !messages.some((m) => m.role === 'assistant')) return null
  const created = toMs(header.timestamp) ?? 0
  return {
    id: `pi:${header.id}`,
    agent: 'pi',
    nativeId: header.id,
    title: pickTitle([name], firstPrompt, fallbackTitle(messages, created)),
    cwd: header.cwd,
    model,
    createdAt: created,
    updatedAt: last ?? created,
    messageCount: messages.length,
    tokens,
    cost,
    ...derive(messages),
    messages,
  }
}
