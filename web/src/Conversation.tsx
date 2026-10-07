import { useVirtualizer } from '@tanstack/react-virtual'
import { t, useT } from './i18n'
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentIcon } from './AgentIcon'
import { BlockView, Steps, useOpen, ViewPrefs } from './Blocks'
import { ChangesView } from './ChangesView'
import { Composer } from './Composer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FindBar } from './FindBar'
import { Outline, type OutlineEntry } from './Outline'
import { useApi } from './machines'
import { cleanTitle, clock, compact, duration, fullTime, shortDate } from './format'
import { Markdown } from './Markdown'
import { Icon } from './Icon'
import type { Block, ChangeFocus, EditBlock, Message, Run as AgentRun, Session, SessionSummary, ToolBlock } from './types'

type Run = ToolBlock | Extract<Block, { type: 'thinking' }>
/** `mi` is the index of the (first) message an item comes from — the unit search results point at. */
type Item = { mi: number; mj?: number } & (
  | { kind: 'user'; id: string; time?: number; blocks: Block[] }
  | { kind: 'assistant'; id: string; time?: number; model?: string; block: Block; head: boolean }
  | { kind: 'steps'; id: string; blocks: Run[]; bmi: number[] }
  | { kind: 'system'; id: string; block: Block }
  | { kind: 'hidden'; id: string; ids: string[] })

/** Reading order: prompts, prose, and runs of tool calls folded onto a rail. */
function toItems(messages: Message[]): Item[] {
  const items: Item[] = []
  let run: Run[] = []
  let voiced = false // the agent's name is shown once per stretch of its own output
  let runMi = 0, runMj = 0
  let bmi: number[] = [] // message index of each block in the run
  const flush = (id: string) => { if (run.length) { items.push({ kind: 'steps', id: id + ':steps', blocks: run, bmi, mi: runMi, mj: runMj }); run = []; bmi = [] } }
  const add = (blocks: Run[], mi: number) => { if (!run.length) runMi = mi; runMj = mi; run.push(...blocks); bmi.push(...blocks.map(() => mi)) }
  messages.forEach((m, mi) => {
    if (m.hidden) {
      flush(m.id)
      const last = items[items.length - 1]
      if (last?.kind === 'hidden') { last.ids.push(m.id); last.mj = mi } else items.push({ kind: 'hidden', id: m.id + ':hidden', ids: [m.id], mi, mj: mi })
      voiced = false
      return
    }
    if (m.role === 'system') { flush(m.id); items.push({ kind: 'system', id: m.id, block: m.blocks[0]!, mi }); voiced = false; return }
    if (m.role === 'user') {
      const tools = m.blocks.filter((b): b is ToolBlock => b.type === 'tool') // user-run shell escapes
      const rest = m.blocks.filter((b) => b.type !== 'tool')
      flush(m.id)
      if (rest.length && rest.every((b) => b.type === 'note')) rest.forEach((b, i) => items.push({ kind: 'system', id: `${m.id}:${i}`, block: b, mi }))
      else if (rest.length) { items.push({ kind: 'user', id: m.id, time: m.time, blocks: rest, mi }); voiced = false }
      if (tools.length) add(tools, mi)
      return
    }
    m.blocks.forEach((b, i) => {
      if (b.type === 'thinking') { if (!b.redacted) add([b], mi); return } // redacted thinking carries nothing
      if (b.type === 'tool') { add([b], mi); return }
      flush(m.id + i)
      items.push({ kind: 'assistant', id: `${m.id}:${i}`, time: m.time, model: m.model, block: b, head: !voiced, mi })
      voiced = true
    })
  })
  flush('end')
  return items
}

/** Row actions, provided by the conversation so memoised rows don't need new props. */
const Actions = createContext({ hideTurn: (_mi: number) => {}, hideMessage: (_mi: number) => {}, restore: (_ids: string[]) => {} })

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', opencode: 'OpenCode', pi: 'Pi', hermes: 'Hermes', codex: 'Codex', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI' }
export const agentName = (id: string) => NAMES[id] ?? id

const ItemView = memo(function ItemView({ it, agent }: { it: Item; agent: string }) {
  useT()
  switch (it.kind) {
    case 'user':
      return (
        <section className="it user" aria-label={t('Prompt')}>
          <div className="who">{t('You')}{it.time && <time title={fullTime(it.time)}>{clock(it.time)}</time>}<HideButton label={t('Hide turn')} title={t('Hide this prompt and everything the agent did for it')} on={(a) => a.hideTurn(it.mi)} /></div>
          <Bubble okey={it.id}>{it.blocks.map((b, i) => (b.type === 'text' ? <UserText key={i} text={b.text} okey={`${it.id}:${i}`} /> : <BlockView key={i} b={b} />))}</Bubble>
        </section>
      )
    case 'assistant':
      return (
        <section className={`it assistant ${it.head ? 'head' : ''}`}>
          {it.head && <div className="who" title={it.model}><span className={`who-tile at-${agent}`}><AgentIcon agent={agent} size={14} /></span>{agentName(agent)}{it.time && <time title={fullTime(it.time)}>{clock(it.time)}</time>}<HideButton label={t('Hide')} title={t('Hide this message')} on={(a) => a.hideMessage(it.mi)} /></div>}
          <div className="prose">{!it.head && <HideButton label={t('Hide')} title={t('Hide this message')} on={(a) => a.hideMessage(it.mi)} floating />}<BlockView b={it.block} /></div>
        </section>
      )
    case 'steps': return <div className="it steps"><Steps blocks={it.blocks} bmi={it.bmi} okey={it.id} /></div>
    case 'system': return <div className="it system"><BlockView b={it.block} /></div>
    case 'hidden': return <HiddenRow ids={it.ids} />
  }
})

function HideButton({ label, title, on, floating }: { label: string; title: string; on: (a: React.ContextType<typeof Actions>) => void; floating?: boolean }) {
  const a = useContext(Actions)
  return <button className={`who-act ${floating ? 'floating' : ''}`} onClick={() => on(a)} title={title}><Icon name="eyeoff" size={14} />{label}</button>
}

function HiddenRow({ ids }: { ids: string[] }) {
  useT()
  const a = useContext(Actions)
  return (
    <div className="it system hidden-row">
      <Icon name="eyeoff" size={14} />
      <span>{t(ids.length > 1 ? '{n} hidden messages' : '{n} hidden message', { n: ids.length })}</span>
      <button className="more" onClick={() => a.restore(ids)}>{t('Restore')}</button>
    </div>
  )
}

const PASTED = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g

/** User text, with pasted blocks folded so a long paste does not drown the actual request. */
function UserText({ text, okey }: { text: string; okey: string }) {
  const parts: { pasted: boolean; text: string }[] = []
  let last = 0
  for (const m of text.matchAll(PASTED)) {
    if (m.index! > last) parts.push({ pasted: false, text: text.slice(last, m.index) })
    parts.push({ pasted: true, text: m[1]!.trim() })
    last = m.index! + m[0].length
  }
  if (last < text.length) parts.push({ pasted: false, text: text.slice(last) })
  return <>{parts.filter((p) => p.text.trim()).map((p, i) => (p.pasted ? <Pasted key={i} text={p.text} okey={`${okey}:${i}`} /> : <Markdown key={i} text={p.text} />))}</>
}

function Pasted({ text, okey }: { text: string; okey: string }) {
  useT()
  const { open: store } = useContext(ViewPrefs)
  const [open, setOpenRaw] = useState(store.get(okey) ?? false)
  const setOpen = (v: boolean) => { store.set(okey, v); setOpenRaw(v) }
  const lines = text.split('\n').length
  return (
    <div className={`pasted ${open ? 'open' : ''}`}>
      <button className="pasted-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={14} /></span>{t('Pasted text')}<span className="pasted-meta">{t('{n} lines', { n: lines })} · {open ? t('collapse') : t('expand')}</span>
      </button>
      <div className="pasted-body" onClick={() => !open && setOpen(true)}><Markdown text={text} /></div>
    </div>
  )
}

/** Long prompts are clamped with a fade; the full text is one click away. */
function Bubble({ children, okey }: { children: React.ReactNode; okey: string }) {
  useT()
  const ref = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useOpen('b:' + okey)
  useLayoutEffect(() => { const el = ref.current; if (el) setLong(el.scrollHeight > 380) }, [])
  return (
    <div className={`bubble ${long && !open ? 'clamped' : ''}`} ref={ref}>
      {children}
      {long && <button className="bubble-more" onClick={() => setOpen(!open)}>{open ? t('Show less') : t('Show full prompt')}</button>}
    </div>
  )
}

/** Vertical rhythm lives on the virtual row wrapper (measured heights exclude margins). */
function spacing(prev: Item | undefined, it: Item): string {
  if (!prev) return 'sp-0'
  if (it.kind === 'user') return 'sp-xl'
  if (it.kind === 'system') return 'sp-lg'
  if (prev.kind === 'user') return 'sp-md'
  if (it.kind === 'assistant' && it.head) return 'sp-lg'
  return 'sp-sm'
}
const estimate = (it: Item | undefined) => (it?.kind === 'user' ? 140 : it?.kind === 'assistant' ? 90 : it?.kind === 'system' ? 56 : 42)

/** Paint find matches with the CSS Custom Highlight API: no DOM changes, so virtual rows stay untouched. */
function paintMatches(root: HTMLElement | null, q: string, current: number | null): Range | undefined {
  const reg = (globalThis as any).CSS?.highlights
  const H = (globalThis as any).Highlight
  if (!reg || !H) return
  reg.delete('find'); reg.delete('find-current')
  const ts = q.toLowerCase().match(/"[^"]+"|\S+/g)?.map((t) => t.replace(/"/g, '')).filter(Boolean) ?? []
  if (!root || !ts.length) return
  const all: Range[] = []
  const cur: Range[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n && all.length < 3000; n = walk.nextNode()) {
    const text = n.nodeValue?.toLowerCase()
    if (!text) continue
    // inside a run of steps each call knows its own message; elsewhere the row's message range decides
    const holder = n.parentElement?.closest('[data-bmi], .vrow') as HTMLElement | null
    const isCur = current != null && !!holder && (holder.dataset.bmi != null ? Number(holder.dataset.bmi) === current : Number(holder.dataset.mi) <= current && current <= Number(holder.dataset.mj))
    for (const t of ts)
      for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
        const r = document.createRange()
        r.setStart(n, i); r.setEnd(n, i + t.length)
        ;(isCur ? cur : all).push(r)
      }
  }
  reg.set('find', new H(...all))
  reg.set('find-current', new H(...cur))
  return cur[0]
}

function Skeleton() {
  return (
    <div className="thread skeleton" aria-busy="true" aria-label={t('Loading session')}>
      {[0.62, 0.9, 0.75, 0.4, 0.85, 0.55].map((w, i) => (
        <div key={i} className="sk-row"><span className="sk-lines"><span style={{ width: `${w * 100}%` }} /><span style={{ width: `${w * 70}%` }} /></span></div>
      ))}
    </div>
  )
}

interface Props {
  summary: SessionSummary
  session?: Session
  error?: string
  view: 'chat' | 'changes'
  onView: (v: 'chat' | 'changes') => void
  focus?: ChangeFocus
  onFocus: (f: ChangeFocus) => void
  onOpen: (id: string) => void
  onLoadMore: () => void
  onLoadAll: () => Promise<void>
  edits?: EditBlock[]
  hiddenRev: number
  run?: AgentRun
  pending?: string
  /** a live chat: what it is saying now (drawn after the history), the box that talks to it, and a counter that moves when it does */
  live?: React.ReactNode
  liveTick?: number
  composer?: (h: { onSent: () => void }) => React.ReactNode
  onSend: (prompt: string, allowWrite: boolean) => Promise<boolean>
  onStop: () => void
  onTrash: () => void
  onDeleteFromDisk: () => void
  onRestoreSession: () => void
  onHide: (ids: string[], what: string) => void
  onRestoreMessages: (ids: string[]) => void
  /** from the URL: open find with this query and jump to this message */
  findInit?: { q: string; m?: number }
  /** where this session sits: machine / agent / project, shown at the left of the toolbar */
  crumbs?: React.ReactNode
  onRename: (title: string) => void
  inspectorOpen: boolean
  onToggleInspector: () => void
  /** actions on this session, shared with the sidebar menu */
  quick: Quick
  menu: (MenuItem | '-')[]
  canContinue: boolean
}

export function Conversation(p: Props) {
  useT()
  const api = useApi()
  const s = p.session ?? p.summary
  const scroller = useRef<HTMLDivElement>(null)
  const [expandAll, setExpandAll] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [farFromEnd, setFarFromEnd] = useState(false)
  const items = useMemo(() => (p.session ? toItems(p.session.messages) : []), [p.session])
  const openStore = useMemo(() => new Map<string, boolean>(), [s.id, expandAll])
  const [prefRev, bumpPrefs] = useState(0)
  const prefs = useMemo(() => ({ expandAll, sessionId: s.id, cwd: s.cwd, open: openStore }), [expandAll, s.id, s.cwd, openStore, prefRev])
  const spaced = useMemo(() => items.map((it, i) => spacing(items[i - 1], it)), [items])
  const listRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  // the virtual list starts below the session header, whose height changes with the title's wrapping
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const set = () => setMargin(el.offsetTop)
    set()
    const ro = new ResizeObserver(set)
    if (el.previousElementSibling) ro.observe(el.previousElementSibling)
    return () => ro.disconnect()
  }, [p.session?.id, !!p.session])
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => estimate(items[i]),
    getItemKey: (i) => items[i]?.id ?? i,
    overscan: 8,
    scrollMargin: margin,
  })
  const rows = virt.getVirtualItems()
  // the server sends the transcript a page of turns at a time; the next page loads as you approach the end
  const hasMore = p.session?.page.next != null
  const lastRendered = rows[rows.length - 1]?.index ?? -1
  useEffect(() => { if (hasMore && lastRendered >= items.length - 12) p.onLoadMore() }, [hasMore, lastRendered, items.length])
  const pendingJump = useRef(false)
  useEffect(() => {
    if (!pendingJump.current || hasMore || !items.length) return
    pendingJump.current = false
    virt.scrollToIndex(items.length - 1, { align: 'end' })
  }, [items.length, hasMore])
  // ---- in-session find ----
  const [findQ, setFindQ] = useState<string | null>(null)
  const [findText, setFindText] = useState('')
  const [currentItem, setCurrentItem] = useState<number | null>(null)
  const [rev, setRev] = useState(0)
  const pendingGoto = useRef<number | null>(null)
  const needReveal = useRef(false) // after jumping to an item, centre the match itself (items can be taller than the view)
  const loaded = p.session?.messages.length ?? 0
  const covers = (it: Item, m: number) => it.mi <= m && m <= (it.mj ?? it.mi)
  /** first item that shows any part of message `m` */
  const itemOf = (m: number) => {
    let lo = 0, hi = items.length - 1, best = 0
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (items[mid]!.mi <= m) { best = mid; lo = mid + 1 } else hi = mid - 1 }
    while (best > 0 && covers(items[best - 1]!, m)) best--
    return best
  }
  const goto = (msgIndex: number) => {
    if (msgIndex >= loaded && hasMore) { pendingGoto.current = msgIndex; p.onLoadAll(); return }
    const idx = itemOf(msgIndex)
    // a match inside folded steps must be visible
    const ts = findText.toLowerCase().match(/"[^"]+"|\S+/g)?.map((t) => t.replace(/"/g, '')) ?? []
    for (let i = idx; i < items.length && covers(items[i]!, msgIndex); i++) {
      const it = items[i]!
      if (it.kind !== 'steps') continue
      openStore.set('s:' + it.id, true)
      // the row only shows a command's first line; open the call when the match is further down
      for (const [k, b] of it.blocks.entries()) if (it.bmi[k] === msgIndex && b.type === 'tool' && ts.some((t) => JSON.stringify(b.input ?? '').toLowerCase().includes(t))) openStore.set('t:' + b.id, true)
      bumpPrefs((r) => r + 1)
    }
    setRev((r) => r + 1)
    setCurrentItem(msgIndex)
    needReveal.current = true
    virt.scrollToIndex(idx, { align: 'center' })
  }
  // ---- prompt index ----
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [flash, setFlash] = useState<number | null>(null)
  const pendingPrompt = useRef<number | null>(null)
  useEffect(() => {
    setOutline([])
    const ctl = new AbortController()
    api.outline(s.id).then(setOutline, () => {})
    return () => ctl.abort()
  }, [s.id, p.hiddenRev])
  const jumpToPrompt = (msgIndex: number) => {
    if (msgIndex >= loaded && hasMore) { pendingPrompt.current = msgIndex; p.onLoadAll(); return }
    const idx = itemOf(msgIndex)
    virt.scrollToIndex(idx, { align: 'start' })
    setFlash(msgIndex)
    window.setTimeout(() => setFlash((f) => (f === msgIndex ? null : f)), 1200)
  }
  // which prompt the reader is in: the last one that starts above the top of the view
  const topRow = rows.find((r) => r.end > (virt.scrollOffset ?? 0) + 60)
  const topMi = topRow ? items[topRow.index]?.mi ?? 0 : 0
  let activePrompt = 0
  for (let i = 0; i < outline.length && outline[i]!.msgIndex <= topMi; i++) activePrompt = i
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !outline.length) return
      e.preventDefault()
      const n = Math.max(0, Math.min(outline.length - 1, activePrompt + (e.key === 'ArrowDown' ? 1 : -1)))
      jumpToPrompt(outline[n]!.msgIndex)
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  useEffect(() => {
    if (pendingGoto.current != null && pendingGoto.current < loaded) { const m = pendingGoto.current; pendingGoto.current = null; goto(m) }
    if (pendingPrompt.current != null && pendingPrompt.current < loaded) { const m = pendingPrompt.current; pendingPrompt.current = null; jumpToPrompt(m) }
  }, [loaded])
  useEffect(() => {
    if (!p.findInit || !p.session) return
    setFindQ(p.findInit.q); setFindText(p.findInit.q)
    if (p.findInit.m != null) goto(p.findInit.m)
  }, [p.session?.id, p.findInit?.q, p.findInit?.m])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && p.view === 'chat' && p.session) { e.preventDefault(); setFindQ((q) => q ?? findText) }
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })
  useEffect(() => {
    const root = listRef.current
    const q = findQ == null ? '' : findText
    const timers: number[] = []
    const reveal = (smooth: boolean) => {
      const first = paintMatches(root, q, currentItem)
      const sc = scroller.current
      if (!first || !sc) return
      const r = first.getBoundingClientRect(), box = sc.getBoundingClientRect()
      if (r.top < box.top + 80 || r.bottom > box.bottom - 80) sc.scrollBy({ top: r.top - box.top - box.height / 2, behavior: smooth ? 'smooth' : 'auto' })
    }
    const paint = () => {
      paintMatches(root, q, currentItem)
      // folds open with a 200ms transition and rows get re-measured; centre the match once layout has settled
      if (needReveal.current) { needReveal.current = false; [320, 700, 1100].forEach((ms, i) => timers.push(window.setTimeout(() => reveal(i === 0), ms))) }
    }
    const id = requestAnimationFrame(paint)
    if (!root || !q) return () => { cancelAnimationFrame(id); timers.forEach(clearTimeout) }
    let t: number | undefined
    const mo = new MutationObserver(() => { clearTimeout(t); t = window.setTimeout(paint, 60) })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => { cancelAnimationFrame(id); mo.disconnect(); clearTimeout(t); timers.forEach(clearTimeout) }
  }, [findQ, findText, currentItem, items, rev])
  useEffect(() => { setFindQ(null); setFindText(''); setCurrentItem(null) }, [s.id])

  const running = p.run?.status === 'running'
  useEffect(() => {
    if ((running || p.pending) && stick.current && items.length) virt.scrollToIndex(items.length - 1, { align: 'end' })
  }, [items.length, items[items.length - 1], running, p.pending])
  // a live chat grows below the virtual list: stay at its end while the reader is
  useEffect(() => {
    if (p.liveTick == null || !stick.current) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [p.liveTick])
  const send = async (prompt: string, allowWrite: boolean) => {
    stick.current = true
    const ok = await p.onSend(prompt, allowWrite)
    if (ok) requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }))
    return ok
  }

  // ---- hiding (Sessionary-only; files untouched) ----
  const msgs = p.session?.messages ?? []
  const isTurn = (m: (typeof msgs)[number]) => m.role === 'user' && !m.hidden && m.blocks.some((b) => b.type !== 'tool')
  const actions = useMemo(() => ({
    hideTurn: (mi: number) => {
      const ids = [msgs[mi]!.id]
      for (let i = mi + 1; i < msgs.length && !isTurn(msgs[i]!); i++) if (!msgs[i]!.hidden) ids.push(msgs[i]!.id)
      p.onHide(ids, t(ids.length > 1 ? 'Hid a turn ({n} messages)' : 'Hid a turn ({n} message)', { n: ids.length }))
    },
    hideMessage: (mi: number) => p.onHide([msgs[mi]!.id], t('Hid a message')),
    restore: (ids: string[]) => p.onRestoreMessages(ids),
  }), [msgs, p.onHide, p.onRestoreMessages])
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)

  const jumpToEnd = async () => {
    if (hasMore) { pendingJump.current = true; await p.onLoadAll(); return }
    virt.scrollToIndex(items.length - 1, { align: 'end' })
  }

  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setExpandAll(false); setScrolled(false) }, [s.id])
  const stick = useRef(false) // follow new output while the agent is running, until the reader scrolls up
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    setScrolled(el.scrollTop > 72)
    setFarFromEnd(p.session?.page.next != null || el.scrollHeight - el.scrollTop - el.clientHeight > 1600)
  }

  return (
    <main className="content">
      <header className={`toolbar ${scrolled || p.view === 'changes' ? 'edge' : ''}`}>
        {/* the crumbs and, once scrolled, the title: together they stay left of the centred switch */}
        <div className="tb-lead">
          {p.crumbs}
          <div className="tb-title" title={s.title} aria-hidden={!scrolled && p.view !== 'changes'}>{cleanTitle(s.title)}</div>
        </div>
        <div className="seg tb-center" role="tablist" aria-label={t('View')}>
          <button role="tab" aria-selected={p.view === 'chat'} className={p.view === 'chat' ? 'on' : ''} onClick={() => p.onView('chat')}>{t('Conversation')}</button>
          <button role="tab" aria-selected={p.view === 'changes'} className={p.view === 'changes' ? 'on' : ''} onClick={() => p.onView('changes')}>
            {t('Changes')}{!!s.filesChanged && <span className="seg-count">{s.filesChanged}</span>}
          </button>
        </div>
        <div className="tb-actions tb-group">
          <button className={`tb-btn tb-opt ${findQ != null ? 'pressed' : ''}`} onClick={() => setFindQ(findQ == null ? findText : null)} disabled={p.view !== 'chat'} title={`${t('Find in conversation')}  Ctrl F`} aria-label={t('Find in conversation')}><Icon name="find" /></button>
          <button className={`tb-btn tb-opt ${expandAll ? 'pressed' : ''}`} onClick={() => setExpandAll(!expandAll)} disabled={p.view !== 'chat'} title={`${expandAll ? t('Collapse all steps') : t('Expand all steps')}  E`} aria-pressed={expandAll}><Icon name={expandAll ? 'collapse' : 'expand'} /></button>
          <button className={`tb-btn ${more ? 'pressed' : ''}`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.right - 220, y: r.bottom + 6 }) }} title={t('More')} aria-label={t('More actions')}><Icon name="more" /></button>
          <button className={`tb-btn ${p.inspectorOpen ? 'pressed' : ''}`} onClick={p.onToggleInspector} title={`${t('Project context')}  ]`} aria-label={t('Toggle project context')} aria-pressed={p.inspectorOpen}><Icon name="panel" /></button>
        </div>
      </header>

      {p.session?.trashed && (
        <div className="banner fade-in"><Icon name="trash" /><span>{t("This session is in Sessionary's Trash. Its file is untouched.")}</span><button className="btn" onClick={p.onRestoreSession}>{t('Restore')}</button></div>
      )}
      {more && (
        <ContextMenu x={more.x} y={more.y} onClose={() => setMore(null)} items={[
          ...(p.view === 'chat' && p.session ? [
            { label: t('Find in conversation'), onSelect: () => setFindQ(findText), hint: 'Ctrl F' },
            { label: expandAll ? t('Collapse all steps') : t('Expand all steps'), onSelect: () => setExpandAll(!expandAll), hint: 'E' },
            '-' as const,
          ] : []),
          ...(p.session?.trashed ? [{ label: t('Restore from Trash'), icon: 'refresh', onSelect: p.onRestoreSession }, '-' as const] : []),
          ...p.menu.filter((m) => !(p.session?.trashed && m !== '-' && m.label === t('Move to Trash'))),
        ]} />
      )}
      {findQ != null && p.view === 'chat' && p.session && (
        <FindBar key={s.id} sessionId={s.id} initial={findQ} onQuery={setFindText} onGoto={goto} onClose={() => { setFindQ(null); setFindText(''); setCurrentItem(null) }} />
      )}
      {p.view === 'changes' ? (
        p.edits ? <ChangesView summary={s} edits={p.edits} focus={p.focus} onFocus={p.onFocus} /> : <div className="scroll"><Skeleton /></div>
      ) : (
        <div className="scroll" ref={scroller} tabIndex={0} aria-label={t('Conversation')} onScroll={onScroll}>
          <Actions.Provider value={actions}><ViewPrefs.Provider value={prefs}>
            {p.error ? <div className="thread"><div className="empty-note"><b>{t('Could not read this session')}</b><br />{p.error}</div></div>
              : !p.session ? <Skeleton />
              : (
                <div className="thread enter" key={s.id}>
                  <header className="doc-head">
                    <div className="doc-title-row">
                      <TitleEditor title={cleanTitle(s.title)} renamed={!!s.renamed} onSave={p.onRename} />
                      {s.active && <span className="live-badge" title={p.run?.status === 'running' ? t('Sessionary is running a prompt in this session') : t('Written to in the last two minutes — probably open in {agent}', { agent: agentName(s.agent) })}><span className="live-dot" />{t('Active')}</span>}
                    </div>
                    <div className="doc-meta">
                      <span><AgentIcon agent={s.agent} size={14} />{agentName(s.agent)}</span>
                      <span className="sep">·</span>
                      <button className="meta-link" onClick={p.quick.onProject} title={t('Show only this project')}><Icon name="folder" size={14} />{s.project.generic ? t('No project') : s.project.name}{s.project.sub ? ` / ${s.project.sub}` : ''}</button>
                      {s.gitBranch && <><span className="sep">·</span><span><Icon name="branch" size={14} /><span className="mono">{s.gitBranch}</span></span></>}
                      <span className="sep">·</span>
                      <time title={fullTime(s.createdAt)}>{shortDate(s.createdAt)}</time>
                      {s.model && <><span className="sep">·</span><span>{s.model}</span></>}
                    </div>
                    <SessionActions q={p.quick} canContinue={p.canContinue && !p.session?.trashed && !s.parentId} onContinueHere={() => (document.querySelector('.composer textarea') as HTMLTextAreaElement | null)?.focus()} />
                    <div className="doc-stats">
                      <StatTile label={t('Messages')} value={String(s.messageCount)} />
                      {!!s.toolCalls && <StatTile label={t('Tool calls')} value={String(s.toolCalls)} />}
                      {!!s.filesChanged && <StatTile label={t('Files changed')} value={String(s.filesChanged)} onClick={() => p.onView('changes')} />}
                      <StatTile label={t('Duration')} value={duration(s.updatedAt - s.createdAt)} />
                      {!!s.tokens && s.tokens.input + s.tokens.output > 0 && <StatTile label={t('Tokens')} value={compact(s.tokens.input + s.tokens.output)} />}
                      {!!s.cost && <StatTile label={t('Cost')} value={`$${s.cost.toFixed(2)}`} />}
                    </div>
                  </header>
                  <div ref={listRef} className="vlist" style={{ height: virt.getTotalSize() }}>
                    {rows.map((r) => (
                      <div key={r.key} data-index={r.index} data-mi={items[r.index]!.mi} data-mj={items[r.index]!.mj ?? items[r.index]!.mi} ref={virt.measureElement} className={`vrow ${spaced[r.index]} ${flash != null && items[r.index]!.mi === flash && items[r.index]!.kind === 'user' ? 'flash' : ''}`} style={{ transform: `translateY(${r.start - margin}px)` }}>
                        <ItemView it={items[r.index]!} agent={s.agent} />
                      </div>
                    ))}
                  </div>
                  {p.pending && (
                    <section className="it user pending sp-xl">
                      <div className="who">{t('You')}<time>{t('sending…')}</time></div><div className="bubble">{p.pending}</div>
                    </section>
                  )}
                  {p.live}
                  {running && !p.pending && <div className="working-row"><span className="spinner" />{t('{agent} is working…', { agent: agentName(s.agent) })}</div>}
                  {hasMore && <div className="more-below">{t('Loading more · {n} messages left', { n: p.session.page.total - p.session.page.end })}</div>}
                  {!hasMore && p.session.children.length > 0 && (
                    <div className="children">
                      <div className="section-label">{t('Sub-agent sessions')}</div>
                      {p.session.children.map((c) => <button key={c.id} className="child" onClick={() => p.onOpen(c.id)}><Icon name="task" />{c.title}</button>)}
                    </div>
                  )}
                </div>
              )}
          </ViewPrefs.Provider></Actions.Provider>
          <KeyExpand onToggle={() => setExpandAll((v) => !v)} />
        </div>
      )}
      {p.view === 'chat' && p.session && p.composer?.({ onSent: () => { stick.current = true; requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })) } })}
      {p.view === 'chat' && p.session && !p.composer && (
        <Composer agent={s.agent} agentName={agentName(s.agent)} run={p.run} onSend={send} onStop={p.onStop}
          disabled={p.session.trashed ? t('This session is in the Trash — restore it to continue') : s.parentId ? t('Sub-agent sessions can’t be continued — continue the parent session') : undefined} />
      )}
      {p.view === 'chat' && p.session && <Outline entries={outline} active={activePrompt} onJump={jumpToPrompt} />}
      {p.view === 'chat' && farFromEnd && (
        <button className="jump pop-in" onClick={jumpToEnd}><Icon name="arrowdown" size={14} /> {t('Latest')}</button>
      )}
    </main>
  )
}

export interface Quick {
  pinned: boolean; onPin: () => void
  canResume: boolean; onResume: () => void; terminal?: string | null
  onFolder?: () => void; onTerminal?: () => void; onEditor?: () => void; editor?: string | null
  onProject: () => void; onOpenFile: (path: string) => void
}

/**
 * The session's own verbs, under its title. Where the agent can chat, the conversation below is the way to carry on
 * (its composer is always live), so the agent's own terminal is a secondary choice; where it cannot, resuming in a
 * terminal is the way, and leads.
 */
function SessionActions({ q, canContinue }: { q: Quick; canContinue: boolean; onContinueHere: () => void }) {
  useT()
  return (
    <div className="doc-actions">
      <button className={`btn ${canContinue ? '' : 'primary'}`} onClick={q.onResume} disabled={!q.canResume}
        title={q.canResume ? t('Reopen this session in a terminal here') : t('This agent has no resume command')}>
        <Icon name="terminal" size={14} />{t('Resume in Terminal')}
      </button>
      <span className="doc-actions-sep" />
      {q.onFolder && <button className="btn icon" onClick={q.onFolder} title={t('Open folder')} aria-label={t('Open folder')}><Icon name="folder-open" size={15} /></button>}
      {q.onTerminal && <button className="btn icon" onClick={q.onTerminal} title={t('Open terminal here')} aria-label={t('Open terminal here')}><Icon name="terminal" size={15} /></button>}
      {q.onEditor && <button className="btn icon" onClick={q.onEditor} title={q.editor ? t('Open in {editor}', { editor: q.editor }) : t('Open in editor')} aria-label={t('Open in editor')}><Icon name="code" size={15} /></button>}
      <button className={`btn icon ${q.pinned ? 'on' : ''}`} onClick={q.onPin} title={`${q.pinned ? t('Unpin') : t('Pin')}  P`} aria-label={q.pinned ? t('Unpin') : t('Pin')} aria-pressed={q.pinned}><Icon name="pin" size={15} /></button>
    </div>
  )
}

/** the session's name, with a pencil to give it one of your own (the agent's files keep theirs) */
function TitleEditor({ title, renamed, onSave }: { title: string; renamed: boolean; onSave: (title: string) => void }) {
  useT()
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(title)
  useEffect(() => { setV(title); setEditing(false) }, [title])
  if (editing) return (
    <form className="title-edit" onSubmit={(e) => { e.preventDefault(); setEditing(false); if (v.trim() !== title) onSave(v.trim()) }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }} onBlur={() => setEditing(false)} aria-label={t('Rename')} maxLength={200} placeholder={t('Name this session')} />
    </form>
  )
  return (
    <>
      <h1>{title}</h1>
      <button className="tb-btn sm title-pencil" onClick={() => setEditing(true)} title={t('Rename')} aria-label={t('Rename')}><Icon name="edit2" size={14} /></button>
      {renamed && <button className="chip link" onClick={() => onSave('')} title={t('Use the name the agent gave it')}>{t('Renamed')} ✕</button>}
    </>
  )
}

function StatTile({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const body = <><span className="stat-v">{value}</span><span className="stat-l">{label}</span></>
  return onClick ? <button className="stat-tile link" onClick={onClick}>{body}</button> : <div className="stat-tile">{body}</div>
}

function KeyExpand({ onToggle }: { onToggle: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== 'e' || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(t.tagName)) return
      onToggle()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [onToggle])
  return null
}
