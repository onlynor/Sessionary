import fs from 'node:fs/promises'
import path from 'node:path'
import { assertIdle, exists, moveAll, moveBack, type MovedEntry } from '../core/fsmove.ts'
import { RemovalError, type AgentAdapter, type Block, type Message, type Session, type Source, type UsageEntry } from '../core/model.ts'
import { totalsOf } from '../core/usage.ts'
import { cleanPrompt, derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import { argSafe, jsonlLines, localRoots, toMs, type Roots } from '../core/util.ts'

// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)
// One JSON record per line. An assistant API message is split over several records (one content block each)
// sharing message.id; tool results come back as `user` records carrying tool_result blocks.

async function readdir(dir: string) {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

export const makeClaude = (roots: () => Roots = localRoots): AgentAdapter => {
  const root = () => path.join(roots().claude, 'projects')
  return {
    id: 'claude-code',
    label: 'Claude Code',
    bin: 'claude',

    async listSources() {
      const out: Source[] = []
      const add = async (file: string) => {
        try {
          const st = await fs.stat(file)
          out.push({ key: file, ref: file, fingerprint: `${st.size}:${Math.floor(st.mtimeMs)}` })
        } catch { /* vanished */ }
      }
      for (const proj of await readdir(root())) {
        if (!proj.isDirectory()) continue
        const dir = path.join(root(), proj.name)
        for (const e of await readdir(dir)) {
          if (e.isFile() && e.name.endsWith('.jsonl')) await add(path.join(dir, e.name))
          else if (e.isDirectory()) {
            for (const s of await readdir(path.join(dir, e.name, 'subagents')))
              if (s.isFile() && s.name.endsWith('.jsonl')) await add(path.join(dir, e.name, 'subagents', s.name))
          }
        }
      }
      return out
    },

    async summarize(source) {
      const s = await parse(source)
      if (!s) return null
      const { messages, usage, ...summary } = s
      return summary
    },
    load: (source) => parse(source),

    // A Claude Code session is its transcript plus a few per-session folders keyed by the same id.
    async remove(source, backupDir) {
      const file = source.ref
      if (path.basename(file).startsWith('agent-')) throw new RemovalError('unsupported', 'Sub-agent transcripts are removed together with their parent session.')
      const id = path.basename(file, '.jsonl')
      const configDir = path.dirname(root())
      const candidates = [file, path.join(path.dirname(file), id), ...['file-history', 'session-env', 'tasks', 'todos'].map((d) => path.join(configDir, d, id))]
      const present = []
      for (const c of candidates) if (await exists(c)) present.push(c)
      await assertIdle([file])
      return { entries: await moveAll(present, backupDir) }
    },
    async restore(manifest) {
      await moveBack(manifest.entries as MovedEntry[])
    },

    storage() { return { path: root(), watch: [{ path: root(), recursive: true }] } },
    // interactive: Claude Code finds transcripts by working directory, so it has to start in the session's cwd
    newCommand(cwd) {
      return { bin: process.env.SESSIONARY_CLAUDE_BIN ?? 'claude', args: [], cwd }
    },
    resumeCommand(_source, session) {
      return { bin: process.env.SESSIONARY_CLAUDE_BIN ?? 'claude', args: ['--resume', session.nativeId], cwd: session.cwd ?? '' }
    },

    // `claude -p --resume` appends to the same transcript (verified); `plan` is Claude Code's read-only mode.
    continueCommand(source, session, prompt, { allowWrite }) {
      return {
        bin: process.env.SESSIONARY_CLAUDE_BIN ?? 'claude',
        args: ['-p', argSafe(prompt), '--resume', session.nativeId, '--permission-mode', allowWrite ? 'acceptEdits' : 'plan', '--output-format', 'stream-json', '--verbose'],
        cwd: session.cwd ?? '',
        sessionIdFrom: (line) => { try { const id = JSON.parse(line)?.session_id; return typeof id === 'string' ? `claude-code:${id}` : undefined } catch { return undefined } },
      }
    },
  }
}
export const claude = makeClaude()

const COMMAND_RE = /<command-name>([^<]*)<\/command-name>/
const SYSTEM_NOISE = ['<local-command-caveat>', '<local-command-stdout>', '<local-command-stderr>', '<system-reminder>']

function toolOutput(content: unknown): { text: string; images: Block[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const parts: string[] = []
  const images: Block[] = []
  for (const c of (content as any[]) ?? []) {
    if (c?.type === 'text') parts.push(c.text)
    else if (c?.type === 'image') images.push({ type: 'image', mime: c.source?.media_type ?? 'image/png', data: c.source?.data })
  }
  return { text: parts.join('\n'), images }
}

async function parse(source: Source): Promise<Session | null> {
  let raw: string
  try { raw = await fs.readFile(source.ref, 'utf8') } catch { return null }

  const isSub = path.basename(source.ref).startsWith('agent-')
  const base = path.basename(source.ref, '.jsonl')
  let nativeId = base
  let parentId: string | undefined
  let title: string | undefined
  let customTitle: string | undefined
  let cwd: string | undefined
  let gitBranch: string | undefined
  let model: string | undefined
  let firstPrompt: string | undefined
  let first: number | undefined
  let last: number | undefined
  // one entry per reply: a reply split over several lines repeats its usage, the last line's counts being final
  const usage = new Map<string, UsageEntry>()

  if (isSub) {
    // …/<parentSessionId>/subagents/agent-x.jsonl
    parentId = 'claude-code:' + path.basename(path.dirname(path.dirname(source.ref)))
    try {
      const meta = JSON.parse(await fs.readFile(source.ref.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
      title = meta.description
    } catch { /* optional */ }
  }

  const messages: Message[] = []
  const toolBlocks = new Map<string, Extract<Block, { type: 'tool' }>>()
  const lastAssistantById = new Map<string, Message>()

  for (const o of jsonlLines(raw)) {
    if (o.sessionId && !isSub) nativeId = o.sessionId
    const t = toMs(o.timestamp)
    if (t) { first ??= t; last = t }
    if (o.cwd) cwd ??= o.cwd
    if (o.gitBranch && o.gitBranch !== 'HEAD') gitBranch ??= o.gitBranch

    switch (o.type) {
      case 'ai-title': title = o.aiTitle; break
      case 'custom-title': customTitle = o.customTitle; break
      case 'system':
        if (o.subtype === 'compact_boundary')
          messages.push({ id: o.uuid, role: 'system', time: t, blocks: [{ type: 'note', kind: 'compaction', text: 'Conversation compacted' }] })
        break
      case 'assistant': {
        const m = o.message
        if (!m || o.isApiErrorMessage) { /* still show errors as text below */ }
        const blocks: Block[] = []
        for (const b of m?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) blocks.push({ type: 'text', text: b.text })
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: b.thinking ?? '', redacted: !b.thinking })
          else if (b.type === 'tool_use') {
            const tb: Extract<Block, { type: 'tool' }> = { type: 'tool', id: b.id, name: b.name, input: b.input, status: 'pending' }
            toolBlocks.set(b.id, tb)
            blocks.push(tb)
          }
        }
        if (m?.usage && t) {
          const u = m.usage
          usage.set(m.id ?? o.uuid, { time: usage.get(m.id ?? o.uuid)?.time ?? t, model: m.model, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 })
        }
        if (!blocks.length) break
        const prev = m?.id ? lastAssistantById.get(m.id) : undefined
        if (prev) prev.blocks.push(...blocks)
        else {
          const msg: Message = { id: o.uuid, role: 'assistant', time: t, model: m?.model, blocks }
          messages.push(msg)
          if (m?.id) lastAssistantById.set(m.id, msg)
          if (m?.model && m.model !== '<synthetic>') model = m.model
        }
        break
      }
      case 'user': {
        if (o.isMeta) break
        const c = o.message?.content
        if (typeof c === 'string') {
          const cmd = COMMAND_RE.exec(c)
          if (cmd) {
            messages.push({ id: o.uuid, role: 'user', time: t, blocks: [{ type: 'note', kind: 'command', text: cmd[1]!.trim() }] })
          } else if (!SYSTEM_NOISE.some((p) => c.startsWith(p))) {
            if (cleanPrompt(c)) firstPrompt ??= c
            messages.push({ id: o.uuid, role: 'user', time: t, blocks: [{ type: 'text', text: c }] })
          }
          break
        }
        const blocks: Block[] = []
        for (const b of c ?? []) {
          if (b.type === 'tool_result') {
            const tb = toolBlocks.get(b.tool_use_id)
            if (!tb) continue
            const { text, images } = toolOutput(b.content)
            tb.output = text
            tb.status = b.is_error ? 'error' : 'ok'
            if (images.length) blocks.push(...images)
          } else if (b.type === 'text' && b.text?.trim() && !SYSTEM_NOISE.some((p) => b.text.startsWith(p))) {
            if (cleanPrompt(b.text)) firstPrompt ??= b.text
            blocks.push({ type: 'text', text: b.text })
          } else if (b.type === 'image') {
            blocks.push({ type: 'image', mime: b.source?.media_type ?? 'image/png', data: b.source?.data })
          }
        }
        // user records that only carried tool results produce no message of their own
        if (blocks.length) messages.push({ id: o.uuid, role: 'user', time: t, blocks })
        break
      }
    }
  }

  // sessions that only contain slash-commands (e.g. a bare /exit) carry no conversation
  if (firstPrompt === undefined && !messages.some((m) => m.role === 'assistant')) return null
  const stat = await fs.stat(source.ref).catch(() => null)
  return {
    id: `claude-code:${nativeId}`,
    agent: 'claude-code',
    nativeId,
    title: pickTitle([customTitle, title], firstPrompt, fallbackTitle(messages, first ?? 0)),
    cwd,
    gitBranch,
    model,
    createdAt: first ?? stat?.birthtimeMs ?? 0,
    updatedAt: last ?? stat?.mtimeMs ?? 0,
    messageCount: messages.length,
    parentId,
    ...totalsOf([...usage.values()]),
    ...derive(messages),
    messages,
    usage: [...usage.values()],
  }
}
