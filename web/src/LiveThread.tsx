import { memo, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { agentName } from './Conversation'
import { AgentIcon } from './AgentIcon'
import { Steps } from './Blocks'
import type { LiveItem } from './chat'
import { Code, Markdown } from './Markdown'
import { DiffView } from './DiffView'
import { Icon } from './Icon'
import type { ApprovalOption, ChatQuestion, Message, ToolBlock } from './types'

type Run = ToolBlock | { type: 'thinking'; text: string }

/** A turn: what the person asked, and everything the agent did for it. */
export interface LiveTurn { id: string; at: number; items: LiveItem[]; done: boolean }

/** The live events as turns. A message sent while the agent was working joins the turn it was sent into. */
export function toTurns(items: LiveItem[]): LiveTurn[] {
  const turns: LiveTurn[] = []
  for (const it of items) {
    if (it.k === 'user' && !it.queued) turns.push({ id: it.id, at: it.at, items: [it], done: false })
    else {
      if (!turns.length) turns.push({ id: `pre${it.id}`, at: 0, items: [], done: false })
      const cur = turns[turns.length - 1]!
      cur.items.push(it)
      if (it.k === 'end') cur.done = true
    }
  }
  return turns
}

const textOf = (m: Message) => m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim()

/**
 * The turns the page should still draw itself. The agent writes its own history too, and once that has caught up the
 * session shows the turn; until then (or if it never does) the live turn stays on screen.
 */
export function pendingTurns(turns: LiveTurn[], history: Message[] | undefined): LiveTurn[] {
  if (!history) return turns
  const users = history.filter((m) => m.role === 'user' && !m.hidden).map((m) => ({ text: textOf(m), time: m.time }))
  return turns.filter((turn) => {
    if (!turn.done) return true
    const u = turn.items[0]
    if (!u || u.k !== 'user') return true
    const want = u.text.trim()
    return !users.some((h) => h.text === want && (h.time == null || h.time >= turn.at - 120_000))
  })
}

export function LiveThread({ turns, agent, cwd, onRespond, onAnswer }: {
  turns: LiveTurn[]; agent: string; cwd?: string
  onRespond: (approval: string, option: string) => Promise<void>
  onAnswer: (question: string, answers: Record<string, string[]>) => Promise<void>
}) {
  useT()
  return (
    <div className="live" aria-live="polite">
      {turns.map((turn) => <Turn key={turn.id} turn={turn} agent={agent} cwd={cwd} onRespond={onRespond} onAnswer={onAnswer} />)}
    </div>
  )
}

const Turn = memo(function Turn({ turn, agent, cwd, onRespond, onAnswer }: { turn: LiveTurn; agent: string; cwd?: string; onRespond: (a: string, o: string) => Promise<void>; onAnswer: (q: string, a: Record<string, string[]>) => Promise<void> }) {
  const rows = useMemo(() => {
    const out: React.ReactNode[] = []
    let run: Run[] = []
    let head = true
    const flush = (key: string) => { if (run.length) { out.push(<div className="it steps" key={key}><Steps blocks={run} okey={`live:${key}`} /></div>); run = [] } }
    for (const it of turn.items) {
      switch (it.k) {
        case 'tool': run.push(it.block); break
        case 'thinking': if (it.text.trim()) run.push({ type: 'thinking', text: it.text }); break
        case 'user':
          flush('u' + it.id)
          out.push(
            <section className={`it user ${it.queued ? 'pending' : ''}`} key={it.id} aria-label={t('Prompt')}>
              <div className="who">{it.queued ? t('You · queued') : t('You')}</div>
              <div className="bubble"><Markdown text={it.text} /></div>
            </section>,
          )
          break
        case 'text':
          flush('t' + it.id)
          if (!it.text.trim()) break
          out.push(
            <section className={`it assistant ${head ? 'head' : ''}`} key={it.id}>
              {head && <div className="who"><span className={`who-tile at-${agent}`}><AgentIcon agent={agent} size={14} /></span>{agentName(agent)}</div>}
              <div className="prose"><Markdown text={it.text} />{!it.done && <span className="caret" aria-hidden="true" />}</div>
            </section>,
          )
          head = false
          break
        case 'approval': flush('a' + it.id); out.push(<Approval key={it.id} it={it} cwd={cwd} onRespond={onRespond} />); break
        case 'question': flush('q' + it.id); out.push(<Question key={it.id} it={it} onAnswer={onAnswer} />); break
        case 'note': flush('n' + it.id); out.push(<div className={`it note-live ${it.level}`} key={it.id}>{t(it.text)}</div>); break
        case 'end':
          flush('e' + it.id)
          if (it.stop === 'interrupted') out.push(<div className="it system" key={it.id}>{t('Stopped')}</div>)
          else if (it.stop === 'error') out.push(<div className="it note-live error" key={it.id}>{it.error ?? t('The agent stopped with an error')}</div>)
          break
      }
    }
    flush('tail')
    return out
  }, [turn.items, agent, cwd, onRespond, onAnswer])
  return <div className="live-turn">{rows}</div>
})

const ORDER: Record<ApprovalOption['kind'], number> = { allow: 0, allow_always: 1, deny: 2, abort: 3 }
const KIND_CLASS: Record<ApprovalOption['kind'], string> = { allow: 'primary', allow_always: '', deny: '', abort: 'danger' }

function Approval({ it, cwd, onRespond }: { it: Extract<LiveItem, { k: 'approval' }>; cwd?: string; onRespond: (a: string, o: string) => Promise<void> }) {
  useT()
  const [busy, setBusy] = useState<string>()
  const [err, setErr] = useState<string>()
  const done = it.outcome != null
  const chosen = it.options.find((o) => o.id === it.outcome)
  const answer = async (o: ApprovalOption) => {
    setBusy(o.id); setErr(undefined)
    try { await onRespond(it.id, o.id) } catch (e) { setErr((e as Error).message) } finally { setBusy(undefined) }
  }
  const detail = it.detail?.startsWith(cwd + '/') ? it.detail.slice((cwd?.length ?? 0) + 1) : it.detail
  const multi = !!detail && detail.includes('\n')
  return (
    <div className={`it approval ${done ? 'done' : ''} ${chosen && (chosen.kind === 'deny' || chosen.kind === 'abort') ? 'denied' : ''}`} role="group" aria-label={t('Permission request')}>
      <div className="ap-head">
        <span className="ap-icon"><Icon name={done ? (chosen && (chosen.kind === 'deny' || chosen.kind === 'abort') ? 'x' : 'check') : 'lock'} size={14} stroke={1.75} /></span>
        <b>{it.title}</b>
        {it.tool !== it.title && <span className="ap-tool">{it.tool}</span>}
        {done && <span className="ap-outcome">{chosen?.label ?? it.outcome}</span>}
      </div>
      {detail && !done && (multi ? <Code code={detail} lang={it.tool === 'Bash' ? 'bash' : undefined} /> : <div className="ap-detail mono">{detail}</div>)}
      {it.diff && !done && <div className="diff-wrap"><DiffView text={it.diff} /></div>}
      {!done && (
        <div className="ap-actions">
          {[...it.options].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).map((o) => <button key={o.id} className={`btn ${KIND_CLASS[o.kind]}`} disabled={!!busy} onClick={() => answer(o)}>{busy === o.id ? <span className="spinner" /> : o.label}</button>)}
        </div>
      )}
      {err && <div className="ap-err">{err}</div>}
    </div>
  )
}

function Question({ it, onAnswer }: { it: Extract<LiveItem, { k: 'question' }>; onAnswer: (q: string, a: Record<string, string[]>) => Promise<void> }) {
  useT()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const value = (q: ChatQuestion) => [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id]!.trim()] : [])]
  const ready = it.questions.every((q) => value(q).length > 0)
  const toggle = (q: ChatQuestion, label: string) => setPicked((p) => {
    const cur = p[q.id] ?? []
    return { ...p, [q.id]: q.multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] }
  })
  const submit = async () => {
    setBusy(true); setErr(undefined)
    try { await onAnswer(it.id, Object.fromEntries(it.questions.map((q) => [q.id, value(q)]))) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className={`it approval question ${it.done ? 'done' : ''}`} role="group" aria-label={t('Question from the agent')}>
      <div className="ap-head"><span className="ap-icon"><Icon name="message" size={14} stroke={1.75} /></span><b>{it.questions[0]?.header || t('The agent has a question')}</b>{it.done && <span className="ap-outcome">{t('Answered')}</span>}</div>
      {!it.done && it.questions.map((q) => (
        <div className="q-block" key={q.id}>
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {(q.options ?? []).map((o) => (
              <button key={o.label} className={`q-opt ${(picked[q.id] ?? []).includes(o.label) ? 'on' : ''}`} onClick={() => toggle(q, o.label)} aria-pressed={(picked[q.id] ?? []).includes(o.label)} title={o.description}>
                <span className="q-label">{o.label}</span>{o.description && <span className="q-desc">{o.description}</span>}
              </button>
            ))}
          </div>
          {(q.other || !q.options?.length) && <label className="field q-other"><input type={q.secret ? 'password' : 'text'} value={other[q.id] ?? ''} onChange={(e) => setOther({ ...other, [q.id]: e.target.value })} placeholder={q.options?.length ? t('Something else…') : t('Your answer')} spellCheck={false} /></label>}
        </div>
      ))}
      {!it.done && <div className="ap-actions"><button className="btn primary" disabled={!ready || busy} onClick={submit}>{busy ? <span className="spinner" /> : t('Send answer')}</button></div>}
      {err && <div className="ap-err">{err}</div>}
    </div>
  )
}
