import type { Block, Message, SessionSummary } from './model.ts'

/** Agent-neutral tool taxonomy; each agent names the same tool differently (Bash vs bash, Read vs read). */
export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'task' | 'todo' | 'other'

const KINDS: Record<string, ToolKind> = {
  bash: 'shell', shell: 'shell', exec: 'shell', powershell: 'shell', exec_command: 'shell', local_shell: 'shell', 'container.exec': 'shell', write_stdin: 'shell',
  read: 'read', view: 'read', ls: 'read', list: 'read',
  edit: 'edit', multiedit: 'edit', patch: 'edit', apply_patch: 'edit', notebookedit: 'edit',
  write: 'write',
  grep: 'search', glob: 'search', find: 'search', search: 'search',
  webfetch: 'web', websearch: 'web', fetch: 'web', web_search: 'web', view_image: 'read',
  task: 'task', agent: 'task',
  todowrite: 'todo', todoread: 'todo', todo: 'todo', update_plan: 'todo',
}

export const toolKind = (name: string): ToolKind => KINDS[name.toLowerCase()] ?? 'other'

const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path']

export function toolPath(input: unknown): string | undefined {
  const o = input as Record<string, unknown> | null | undefined
  for (const k of PATH_KEYS) {
    const v = o?.[k]
    if (typeof v === 'string' && v) return v
  }
}

type ToolBlock = Extract<Block, { type: 'tool' }>

/** Summary fields that need the whole conversation. Computed once per changed source, stored in the index. */
export function derive(messages: Message[]): Pick<SessionSummary, 'preview' | 'toolCalls' | 'filesChanged'> {
  let toolCalls = 0
  const changed = new Set<string>()
  let preview: string | undefined
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'tool') {
        toolCalls++
        const k = toolKind(b.name)
        const p = toolPath((b as ToolBlock).input)
        if (p && (k === 'edit' || k === 'write')) changed.add(p)
      } else if (b.type === 'text' && m.role === 'assistant') {
        preview = b.text
      }
    }
  }
  return {
    preview: preview ? preview.replace(/\s+/g, ' ').trim().slice(0, 160) : undefined,
    toolCalls,
    filesChanged: changed.size,
  }
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-|^ses_[0-9a-z]+$/i
const GENERIC = /^(new session\b|untitled\b)/i

/**
 * A prompt as a human would recognise it: wrapper tags (<skill …>, <command-*>, <system-reminder>) removed.
 * Returns undefined for turns that carry no intent of their own, e.g. a bare `/exit` or `/help`.
 */
export function cleanPrompt(text: string | undefined): string | undefined {
  if (!text) return
  let t = text
    .replace(/<(system-reminder|local-command-[a-z]+|command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^\/[\w:-]+$/.test(t)) return // slash command with no arguments
  return t || undefined
}

/** First usable title: agent-provided names unless they are placeholders, then the first real prompt. */
export function pickTitle(candidates: (string | undefined)[], firstPrompt: string | undefined, fallback: string): string {
  for (const c of candidates) {
    const t = c?.trim()
    if (t && !UUIDISH.test(t) && !GENERIC.test(t) && cleanPrompt(t)) return truncate(cleanPrompt(t)!)
  }
  const p = cleanPrompt(firstPrompt)
  return p ? truncate(p) : fallback
}

const truncate = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** Fallback title when no prompt is usable: the agent's first reply, else the date. */
export function fallbackTitle(messages: Message[], at: number): string {
  for (const m of messages)
    for (const b of m.blocks)
      if (m.role === 'assistant' && b.type === 'text' && b.text.trim()) return truncate(b.text.replace(/\s+/g, ' ').trim(), 60)
  return `Session · ${new Date(at).toISOString().slice(0, 10)}`
}
