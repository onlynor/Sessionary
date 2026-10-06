import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentAdapter, Block, Message, Session, Source } from '../core/model.ts'
import { cleanPrompt, derive, fallbackTitle, pickTitle } from '../core/derive.ts'
import { jsonlLines, localRoots, toMs, type Roots } from '../core/util.ts'

// WorkBuddy is Tencent's desktop agent workbench, built on the CodeBuddy engine. Its conversations are JSONL files at
// <home>/projects/<project>/<session>.jsonl (the session id is the file name) in CodeBuddy's OpenAI-Responses-like
// shape, one item per line:
//   {type:'message', role, content:[{type:'input_text'|'output_text', text}], sessionId, cwd, timestamp(ms), providerData:{messageId, model}}
//   {type:'reasoning', …}  {type:'function_call', name, arguments(JSON string), callId}  {type:'function_call_result', callId, output}
//   and bookkeeping lines carrying a title ('ai-title', 'summary', 'initial-user-message', 'periodic') or run metadata.
// There are two apps with the same format and separate homes: the China edition (~/.workbuddy) and the
// international edition, WorkBuddy AI (~/.workbuddy-ai). No documentation of the format exists, so the reader takes
// each field from the places it has been seen, and skips what it does not understand.

const TITLE_TYPES = new Set(['ai-title', 'summary', 'initial-user-message', 'periodic', 'title', 'custom-title'])
/** context the app adds to the model's input that the person did not write */
const INJECTED = /^\s*<(user_info|environment_details|environment_context|system-reminder|system_reminder|project_context|additional_data)\b/

async function walk(dir: string, depth = 0): Promise<string[]> {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory() && depth < 1) out.push(...(await walk(p, depth + 1))) // projects/<dir>/<id>.jsonl; deeper is tool output
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const parseJson = (v: unknown): any => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return undefined } }
const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n')
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; return textOf(o.text ?? o.content ?? o.output ?? o.value ?? '') }
  return ''
}

export interface BuddyOptions { id: string; label: string; home: (r: Roots) => string }

export const makeBuddy = (o: BuddyOptions, roots: () => Roots = localRoots): AgentAdapter => {
  const root = () => path.join(o.home(roots()), 'projects')

  async function parse(source: Source): Promise<Session | null> {
    const file = source.ref
    let text: string
    try { text = await fs.readFile(file, 'utf8') } catch { return null }
    const id = path.basename(file, '.jsonl')

    const messages: Message[] = []
    const tools = new Map<string, Extract<Block, { type: 'tool' }>>()
    let turn: Message | undefined
    let cwd: string | undefined
    let model: string | undefined
    let aiTitle: string | undefined
    let first: number | undefined
    let last: number | undefined
    let firstPrompt: string | undefined
    let n = 0
    const push = (b: Block, rid: string, time?: number) => { if (!turn) { turn = { id: rid, role: 'assistant', time, model, blocks: [] }; messages.push(turn) } turn.blocks.push(b) }

    for (const r of jsonlLines(text)) {
      n++
      const rid = String(r.id ?? r.uuid ?? r.providerData?.messageId ?? n)
      const time = toMs(r.timestamp ?? r.createdAt)
      if (time) { first ??= time; last = Math.max(last ?? 0, time) }
      cwd ??= typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined
      model = r.providerData?.model ?? r.model ?? model
      const type = String(r.type ?? '')

      if (TITLE_TYPES.has(type)) {
        const t = r.title ?? r.aiTitle ?? r.summary ?? r.text ?? r.content
        if (typeof t === 'string' && t.trim() && type !== 'initial-user-message') aiTitle = t
        continue
      }
      switch (type) {
        case 'message': {
          const body = textOf(r.content)
          if (r.role === 'user') {
            if (!body.trim() || INJECTED.test(body)) break
            turn = undefined
            messages.push({ id: rid, role: 'user', time, blocks: [{ type: 'text', text: body }] })
            if (cleanPrompt(body)) firstPrompt ??= body
          } else if (r.role === 'assistant') {
            if (body.trim()) push({ type: 'text', text: body }, rid, time)
          }
          break
        }
        case 'reasoning': {
          const t = textOf(r.content ?? r.rawContent ?? r.summary ?? r.text)
          push({ type: 'thinking', text: t, redacted: !t }, rid, time)
          break
        }
        case 'function_call': {
          const callId = String(r.callId ?? r.call_id ?? r.id ?? rid)
          const args = parseJson(r.arguments)
          const tb: Extract<Block, { type: 'tool' }> = { type: 'tool', id: callId, name: String(r.name ?? 'tool'), input: args && typeof args === 'object' ? args : { arguments: r.arguments }, status: 'pending' }
          tools.set(callId, tb)
          push(tb, rid, time)
          break
        }
        case 'function_call_result': {
          const tb = tools.get(String(r.callId ?? r.call_id ?? r.id))
          if (!tb) break
          tb.output = textOf(r.output ?? r.result ?? r.content)
          tb.status = r.status === 'failed' || r.status === 'error' || r.isError || r.providerData?.isError ? 'error' : 'ok'
          break
        }
      }
    }
    if (!messages.length) return null
    const created = first ?? 0
    return {
      id: `${o.id}:${id}`,
      agent: o.id,
      nativeId: id,
      title: pickTitle([aiTitle], firstPrompt, fallbackTitle(messages, created)),
      cwd,
      model,
      createdAt: created,
      updatedAt: last ?? created,
      messageCount: messages.length,
      ...derive(messages),
      messages,
    }
  }

  return {
    id: o.id,
    label: o.label,
    // a desktop app: there is no program on PATH to look for, start or resume
    bin: '',
    async listSources() {
      const out: Source[] = []
      for (const file of await walk(root())) {
        const st = await fs.stat(file).catch(() => null)
        if (st) out.push({ key: file, ref: file, fingerprint: `${st.size}:${Math.floor(st.mtimeMs)}` })
      }
      return out
    },
    async summarize(source) {
      const s = await parse(source)
      if (!s) return null
      const { messages, ...summary } = s
      return summary
    },
    load: parse,
    storage() { return { path: root(), watch: [{ path: root(), recursive: true }] } },
  }
}

/** WorkBuddy, China edition */
export const makeWorkbuddy = (roots: () => Roots = localRoots) => makeBuddy({ id: 'workbuddy', label: 'WorkBuddy', home: (r) => r.workbuddy }, roots)
/** WorkBuddy AI, the international edition */
export const makeWorkbuddyAi = (roots: () => Roots = localRoots) => makeBuddy({ id: 'workbuddy-ai', label: 'WorkBuddy AI', home: (r) => r.workbuddyAi }, roots)
export const workbuddy = makeWorkbuddy()
export const workbuddyAi = makeWorkbuddyAi()
