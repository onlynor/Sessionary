import { createContext, useContext, useId, useState } from 'react'
import { t, useT } from './i18n'
import { useApi } from './machines'
import { diffOf, diffStats } from './diff'
import { DiffView } from './DiffView'
import { Icon } from './Icon'
import { Code, Markdown } from './Markdown'
import { Reveal } from './Reveal'
import type { Block, ToolBlock } from './types'

/**
 * View state owned by the conversation. `expandAll` opens every step at once; `open` remembers what the reader
 * expanded by key, because virtualised rows unmount when they scroll away and must come back as they were left.
 */
export const ViewPrefs = createContext({ expandAll: false, sessionId: '', cwd: undefined as string | undefined, open: new Map<string, boolean>() })

export const VERB: Record<string, string> = { shell: 'Ran', read: 'Read', edit: 'Edited', write: 'Wrote', search: 'Searched', web: 'Fetched', task: 'Delegated', todo: 'Updated todos' }
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path']
const TARGET_KEYS = ['command', 'pattern', 'url', 'query', 'description', 'prompt']
const CLAMP = 14

export function useOpen(key: string): [boolean, (v: boolean) => void] {
  const { expandAll, open } = useContext(ViewPrefs)
  const [, rerender] = useState(0)
  return [open.get(key) ?? expandAll, (v) => { open.set(key, v); rerender((n) => n + 1) }]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
export const pathOf = (b: ToolBlock) => PATH_KEYS.map((k) => str(b.input?.[k])).find(Boolean)

function targetOf(b: ToolBlock, cwd?: string): string {
  const p = pathOf(b)
  if (p) return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p
  const i = b.input ?? {}
  const t = TARGET_KEYS.map((k) => str(i[k])).find(Boolean) ?? (Object.values(i).find((v) => typeof v === 'string') as string | undefined) ?? ''
  return t.split('\n')[0]!
}

function Output({ text, error }: { text: string; error?: boolean }) {
  useT()
  const lines = text.split('\n')
  const [all, setAll] = useState(false)
  const long = lines.length > CLAMP
  return (
    <div className={`output ${error ? 'err' : ''} ${long && !all ? 'clamped' : ''}`}>
      <pre>{long && !all ? lines.slice(0, CLAMP).join('\n') : text}</pre>
      {long && <button className="more" onClick={() => setAll(!all)}>{all ? t('Show less') : t('Show all {n} lines', { n: lines.length })}</button>}
    </div>
  )
}

/** One row on the step rail: node in the gutter, verb + target, quiet trailing metadata. */
function StepRow({ icon, open, onToggle, children, meta, tone = '' }: { icon: string; open?: boolean; onToggle?: () => void; children: React.ReactNode; meta?: React.ReactNode; tone?: string }) {
  return (
    <button className={`step-row ${open ? 'open' : ''} ${tone}`} onClick={onToggle} aria-expanded={onToggle ? !!open : undefined} disabled={!onToggle}>
      <span className={`kind k-${icon}`}><Icon name={icon} size={12} stroke={1.6} /></span>
      <span className="step-main">{children}</span>
      {meta}
      {onToggle && <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={14} /></span>}
    </button>
  )
}

export function Tool({ b, mi }: { b: ToolBlock; mi?: number }) {
  const { cwd } = useContext(ViewPrefs)
  useT()
  const [open, setOpen] = useOpen('t:' + b.id)
  const kind = b.kind ?? 'other'
  const target = targetOf(b, cwd)
  const diff = diffOf(b)
  const { add, del } = diffStats(diff)
  const cmd = kind === 'shell' ? str(b.input?.command) : undefined
  const extra = Object.keys(b.input ?? {}).filter((k) => ![...PATH_KEYS, ...TARGET_KEYS, 'content', 'old_string', 'new_string', 'oldString', 'newString'].includes(k))
  const showInput = !diff && !cmd && (['other', 'todo', 'task'].includes(kind) ? Object.keys(b.input ?? {}).length > 0 : extra.length > 0)
  const multiLineCmd = !!cmd && cmd.includes('\n')
  return (
    <div className="step" data-bmi={mi}>
      <StepRow icon={kind === 'other' ? 'task' : kind} open={open} onToggle={() => setOpen(!open)} tone={b.status === 'error' ? 'failed' : ''}
        meta={<span className="step-meta">
          {diff && <span className="stat"><b className="plus">+{add}</b><b className="minus">−{del}</b></span>}
          {b.status === 'error' && <span className="flag">{t('failed')}</span>}
          {b.status === 'pending' && <span className="flag quiet">{t('no result')}</span>}
        </span>}>
        <span className="verb">{VERB[kind] ? t(VERB[kind]!) : b.name}</span>
        <span className="target" title={target}>{target}</span>
      </StepRow>
      <Reveal open={open}>
        <div className="step-body">
          {multiLineCmd && <Code code={cmd!} lang="bash" />}
          {showInput && <Code code={JSON.stringify(b.input, null, 2)} lang="json" />}
          {diff && <div className="diff-wrap"><DiffView text={diff} /></div>}
          {b.output ? <Output text={b.output} error={b.status === 'error'} /> : !diff && <div className="quiet-note">{b.status === 'pending' ? t('No result was recorded.') : t('No output.')}</div>}
          {b.truncated && <div className="quiet-note">{t('Output truncated for display.')}</div>}
        </div>
      </Reveal>
    </div>
  )
}

export function Thinking({ b, okey, mi }: { b: Extract<Block, { type: 'thinking' }>; okey?: string; mi?: number }) {
  useT()
  const fallback = useId()
  const [open, setOpen] = useOpen('h:' + (okey ?? fallback))
  const preview = b.text.replace(/\s+/g, ' ').trim()
  return (
    <div className="step" data-bmi={mi}>
      <StepRow icon="think" open={open} onToggle={() => setOpen(!open)} tone="thought">
        <span className="verb">{t('Thought')}</span>
        {!open && <span className="target prose">{preview}</span>}
      </StepRow>
      <Reveal open={open}><div className="step-body thought-body">{b.text}</div></Reveal>
    </div>
  )
}

type Run = ToolBlock | Extract<Block, { type: 'thinking' }>

/** A run of consecutive tool calls (and thinking) between two pieces of prose, drawn on one rail. */
export function Steps({ blocks, okey, bmi }: { blocks: Run[]; okey: string; bmi?: number[] }) {
  useT()
  const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool')
  const [open, setOpen] = useOpen('s:' + okey)
  const rows = blocks.map((b, i) => (b.type === 'tool' ? <Tool key={i} b={b} mi={bmi?.[i]} /> : <Thinking key={i} b={b} okey={`${okey}:${i}`} mi={bmi?.[i]} />))
  if (tools.length < 3) return <div className="rail">{rows}</div>

  const counts = new Map<string, number>()
  for (const tb of tools) { const v = VERB[tb.kind ?? '']; const k = v ? t(v.replace(/^Updated todos$/, 'Todos')) : tb.name; counts.set(k, (counts.get(k) ?? 0) + 1) }
  const errors = tools.filter((tb) => tb.status === 'error').length
  const edited = new Set(tools.filter((tb) => tb.kind === 'edit' || tb.kind === 'write').map(pathOf).filter(Boolean))
  return (
    <div className={`rail folded ${open ? 'open' : ''}`}>
      <StepRow icon="layers" open={open} onToggle={() => setOpen(!open)} tone="summary"
        meta={<span className="step-meta">
          {edited.size > 0 && <span className="pill-quiet">{t(edited.size > 1 ? '{n} files edited' : '{n} file edited', { n: edited.size })}</span>}
          {errors > 0 && <span className="flag">{t('{n} failed', { n: errors })}</span>}
        </span>}>
        <span className="verb">{t('{n} steps', { n: tools.length })}</span>
        <span className="target prose">{[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}</span>
      </StepRow>
      <Reveal open={open}><div className="rail-children">{rows}</div></Reveal>
    </div>
  )
}

export function BlockView({ b }: { b: Block }) {
  const { sessionId } = useContext(ViewPrefs)
  const api = useApi()
  switch (b.type) {
    case 'text': return <Markdown text={b.text} />
    case 'thinking': return <div className="rail"><Thinking b={b} /></div>
    case 'tool': return <div className="rail"><Tool b={b} /></div>
    case 'image': {
      const src = b.ref ? api.imageUrl(sessionId, b.ref) : b.data ? `data:${b.mime};base64,${b.data}` : undefined
      return src ? <img className="img" src={src} loading="lazy" alt="" /> : null
    }
    case 'note': return <div className={`note ${b.kind}`}>{b.kind === 'command' ? '⌘ ' : ''}{b.text}</div>
  }
}
