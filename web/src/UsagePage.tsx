import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getLang, t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { controlApi, host } from './api'
import { AGENT_NAME, fmtTokens, useControl } from './control'
import { Icon } from './Icon'
import { useMachine, useMachines } from './machines'
import { go, href } from './route'
import { PageHead } from './ui'
import type { UsageDayRow } from './types'

/**
 * Usage, at a glance: how much the agents did, day by day, over months — a year of days drawn as a calendar whose
 * shade is each day's tokens — and what that was made of. Everything below the calendar answers for the period (or
 * the day) chosen in it.
 *
 * Two sources, drawn the same way: the agents' own records on the open machine (each call on the day it was made),
 * and what went through the gateway (each request).
 */

const DAY = 86_400_000
// labels as functions: each one a literal t() call, so the translation check sees them
const PERIODS = [{ days: 7, label: () => t('7 days') }, { days: 30, label: () => t('30 days') }, { days: 90, label: () => t('3 months') }, { days: 365, label: () => t('Year') }] as const

// ---- days ----
const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dateOf = (k: string) => new Date(`${k}T12:00:00`)
const today = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const daysAgo = (n: number) => keyOf(addDays(today(), -n))
/** the first day of the week where the page's language puts it */
const weekStart = () => (getLang().startsWith('zh') ? 1 : 0)
const fmtDate = (k: string, o: Intl.DateTimeFormatOptions) => dateOf(k).toLocaleDateString(getLang(), o)

// ---- sums ----
interface Tot { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number; failed: number; cost: number; priced: number; rows: number; sessions: Set<string>; costBy: Set<string> }
const zero = (): Tot => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, failed: 0, cost: 0, priced: 0, rows: 0, sessions: new Set(), costBy: new Set() })
const add = (t: Tot, r: UsageDayRow) => {
  t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.requests += r.requests; t.failed += r.failed ?? 0; t.rows++
  if (r.cost != null) { t.cost += r.cost; t.priced++; if (r.cost > 0) t.costBy.add(r.agent) }
  if (r.sessionId) t.sessions.add(r.sessionId)
  return t
}
const sum = (rows: UsageDayRow[]) => rows.reduce(add, zero())
/** everything the model read and wrote: fresh input, the cache read and written, and the output */
const tokens = (t: Pick<Tot, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => t.input + t.output + t.cacheRead + t.cacheWrite
const group = (rows: UsageDayRow[], key: (r: UsageDayRow) => string) => {
  const m = new Map<string, Tot>()
  for (const r of rows) { const k = key(r); add(m.get(k) ?? m.set(k, zero()).get(k)!, r) }
  return [...m].map(([k, v]) => ({ key: k, tot: v })).sort((a, b) => tokens(b.tot) - tokens(a.tot))
}
const money = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
const pct = (part: number, whole: number) => {
  const r = whole ? part / whole : 0
  return !whole ? '—' : r >= 1 ? '100%' : part > 0 && r < 0.001 ? '<0.1%' : `${(r * 100).toFixed(r < 0.1 || r > 0.99 ? 1 : 0)}%`
}
const activeDays = (n: number) => t(n === 1 ? '{n} active day' : '{n} active days', { n })

type Focus = { days: number } | { day: string }

export function UsagePage({ source }: { source: 'gateway' | 'history' }) {
  useT()
  const { sessions } = useMachine()
  const { machines } = useMachines()
  const { events } = useControl()
  const [rows, setRows] = useState<UsageDayRow[]>()
  const [missing, setMissing] = useState<string[]>([])
  const [err, setErr] = useState<string>()
  const [focus, setFocus] = useState<Focus>({ days: 30 })
  const done = events.filter((e) => e.phase === 'done').length

  // two years: the calendar's year, and the period before any period for the comparison
  useEffect(() => {
    let live = true
    const since = daysAgo(2 * 371)
    // history: each machine's own record, added up here; the gateway's requests are recorded with their machine
    const get = source === 'gateway' ? controlApi.usageDays(since).then((rows) => ({ rows, missing: [] as string[] })) : host.usageMachines(since)
    get.then((r) => { if (live) { setRows(r.rows); setMissing(r.missing); setErr(undefined) } }, (e) => live && setErr((e as Error).message))
    return () => { live = false }
  }, [source, source === 'gateway' ? done : sessions])
  const nameOf = (id?: string) => (!id || id === 'local' ? machines.find((m) => m.kind === 'local')?.name ?? t('This computer') : machines.find((m) => m.id === id)?.name ?? id)

  const byDay = useMemo(() => { const m = new Map<string, Tot>(); for (const r of rows ?? []) add(m.get(r.day) ?? m.set(r.day, zero()).get(r.day)!, r); return m }, [rows])
  const from = 'day' in focus ? focus.day : daysAgo(focus.days - 1)
  const to = 'day' in focus ? focus.day : daysAgo(0)
  const inFocus = useMemo(() => (rows ?? []).filter((r) => r.day >= from && r.day <= to), [rows, from, to])
  const tot = useMemo(() => sum(inFocus), [inFocus])
  // the same length of time just before, for the change
  const before = useMemo(() => {
    if ('day' in focus) return undefined
    const a = daysAgo(2 * focus.days - 1), b = daysAgo(focus.days)
    const r = (rows ?? []).filter((x) => x.day >= a && x.day <= b)
    return r.length ? sum(r) : undefined
  }, [rows, focus])

  const project = useMemo(() => {
    const m = new Map(sessions.map((s) => [s.id, s]))
    return (r: UsageDayRow) => {
      // another machine's sessions are not listed here: its work is named by the machine
      if (r.machine && r.machine !== 'local') return t('On {machine}', { machine: nameOf(r.machine) })
      let s = r.sessionId ? m.get(r.sessionId) : undefined
      if (s?.parentId) s = m.get(s.parentId) ?? s // a sub-agent's work is its parent's project's
      return s && !s.project.generic ? s.project.name : t('Elsewhere')
    }
  }, [sessions, machines])
  const byMachine = useMemo(() => group(inFocus, (r) => r.machine ?? 'local'), [inFocus])

  const empty = rows && !rows.length
  const periodLabel = 'day' in focus ? fmtDate(focus.day, { weekday: 'long', month: 'long', day: 'numeric' }) : focus.days === 365 ? t('in the last year') : t('in the last {n} days', { n: focus.days })

  return (
    <div className="page">
      <div className="page-inner wide enter usage-page">
        <PageHead crumbs={[{ label: t('Model Control') }, { label: t('Usage') }]} />
        <div className="usage-title">
          <h1>{t('Usage')}</h1>
          <div className="seg usage-source" role="radiogroup" aria-label={t('Source')}>
            <button role="radio" aria-checked={source === 'history'} className={source === 'history' ? 'on' : ''} onClick={() => go(href.usage('history'))} title={t('What the agents recorded in their own session files, on every machine')}><Icon name="message" size={13} />{t('Session history')}</button>
            <button role="radio" aria-checked={source === 'gateway'} className={source === 'gateway' ? 'on' : ''} onClick={() => go(href.usage())} title={t('Every request an agent sent through the gateway, with the tokens its provider reported.')}><Icon name="gateway" size={13} />{t('Gateway')}</button>
          </div>
        </div>
        <p className="usage-lede">{source === 'gateway' ? t('Every request an agent sent through the gateway, with the tokens its provider reported.') : t('What the agents recorded on each machine: each model call on the day it was made.')}
          {missing.length > 0 && <span className="usage-missing"> {t('Not included: {machines}, not connected.', { machines: missing.map(nameOf).join(', ') })}</span>}</p>

        {err ? <div className="form-error">{err}</div> : !rows ? <div className="uh-card uh-loading" /> : empty ? (
          <div className="empty-state compact">
            <span className="tile"><Icon name="usage" size={26} stroke={1.5} /></span>
            <b>{source === 'gateway' ? t('Nothing has gone through the gateway yet') : t('No token counts yet')}</b>
            <span className="es-sub">{source === 'gateway' ? t('Choose a model for an agent on Routing, then start a session of it from Sessionary.') : t('Sessions appear here once an agent records how many tokens it used.')}</span>
            {source === 'gateway' && <a className="btn" href={href.routing()}>{t('Routing')}</a>}
          </div>
        ) : (
          <>
            <section className="uh-card" aria-label={t('Activity')}>
              <header className="uh-head">
                <div className="uh-total">
                  <div className="uh-big">
                    <span className="uh-num">{fmtTokens(tokens(tot))}</span>
                    <span className="uh-unit">{t('tokens')}</span>
                    <span className="uh-when">{periodLabel}</span>
                    {before && <Change now={tokens(tot)} then={tokens(before)} days={'days' in focus ? focus.days : 0} />}
                    {'day' in focus && <button className="uh-clear" onClick={() => setFocus({ days: 30 })} aria-label={t('Back to the last 30 days')}><Icon name="x" size={12} /></button>}
                  </div>
                  <Composition t={tot} />
                </div>
                <div className="seg uh-periods" role="radiogroup" aria-label={t('Period')}>
                  {PERIODS.map((p) => <button key={p.days} role="radio" aria-checked={'days' in focus && focus.days === p.days} className={'days' in focus && focus.days === p.days ? 'on' : ''} onClick={() => setFocus({ days: p.days })}>{p.label()}</button>)}
                </div>
              </header>
              <Heatmap byDay={byDay} from={from} to={to} picked={'day' in focus ? focus.day : undefined} onPick={(d) => setFocus('day' in focus && focus.day === d ? { days: 30 } : { day: d })} source={source} />
            </section>

            <Facts t={tot} source={source} active={new Set(inFocus.map((r) => r.day)).size} />

            <div className="ub-grid">
              <Breakdown title={t('By model')} rows={group(inFocus, (r) => r.model || '—')} total={tokens(tot)} render={(k) => <span className="mono ellip">{k}</span>} />
              <Breakdown title={t('By agent')} rows={group(inFocus, (r) => r.agent)} total={tokens(tot)} render={(k) => <><AgentIcon agent={k} size={14} /><span className="ellip">{AGENT_NAME[k] ?? k}</span></>} />
              {source === 'gateway'
                ? <Breakdown title={t('By route')} rows={group(inFocus, (r) => r.route ?? '—')} total={tokens(tot)} render={(k) => <a className="mono ellip" href={k.startsWith('group/') ? href.routing(k.slice(6)) : href.models(k.slice(0, k.indexOf('/')))}>{k}</a>} />
                : <Breakdown title={t('By project')} rows={group(inFocus, project)} total={tokens(tot)} render={(k) => <span className="ellip">{k}</span>} />}
              {byMachine.length > 1 && <Breakdown title={t('By machine')} rows={byMachine} total={tokens(tot)} render={(k) => <span className="ellip">{nameOf(k)}</span>} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** up or down against the same length of time just before */
function Change({ now, then, days }: { now: number; then: number; days: number }) {
  if (!then) return null
  const r = now / then - 1
  if (Math.abs(r) < 0.005) return <span className="uh-change">{t('same as the {n} days before', { n: days })}</span>
  const n = r >= 1 ? `${(r + 1).toFixed(r + 1 < 10 ? 1 : 0)}×` : `${Math.round(Math.abs(r) * 100)}%`
  return <span className={`uh-change ${r > 0 ? 'up' : 'down'}`} title={t('{n} tokens in the {d} days before', { n: fmtTokens(then), d: days })}>{r > 0 ? '↑' : '↓'} {n} <span className="uh-change-s">{t('vs the {n} days before', { n: days })}</span></span>
}

/** what the tokens were: mostly what the cache gave back, a little fresh input, the output */
function Composition({ t: x }: { t: Tot }) {
  const all = tokens(x)
  const parts = [
    { k: 'cr', label: t('Cache read'), v: x.cacheRead },
    { k: 'cw', label: t('Cache write'), v: x.cacheWrite },
    { k: 'in', label: t('Fresh input'), v: x.input },
    { k: 'out', label: t('Output'), v: x.output },
  ]
  if (!all) return null
  return (
    <div className="uh-comp">
      <div className="uh-bar" role="img" aria-label={parts.map((p) => `${p.label} ${fmtTokens(p.v)}`).join(', ')}>
        {parts.map((p) => p.v > 0 && <span key={p.k} className={`c-${p.k}`} style={{ flexGrow: p.v, minWidth: 3 }} />)}
      </div>
      <div className="uh-keys">
        {parts.map((p) => <span key={p.k} className="uh-key"><i className={`c-${p.k}`} />{p.label}<b>{fmtTokens(p.v)}</b>{p.k === 'cr' && p.v > 0 && <span className="uh-key-s">{pct(p.v, all)}</span>}</span>)}
      </div>
    </div>
  )
}

/**
 * The calendar: a column per week, a row per weekday, today in the last column. It spans the history (half a year
 * at least, a year at most) and fills the card's width; the shade is the day's tokens against the other active days
 * shown (quartiles, as most days are small and a few very large). Days outside the chosen period are dimmed.
 */
function Heatmap({ byDay, from, to, picked, onPick, source }: { byDay: Map<string, Tot>; from: string; to: string; picked?: string; onPick: (day: string) => void; source: 'gateway' | 'history' }) {
  useT()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [tip, setTip] = useState<{ day: string; x: number; y: number }>()
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const first = useMemo(() => [...byDay.keys()].sort()[0], [byDay])
  const LABELS = 30
  // weeks: the whole history, and as many more as fill the card at a comfortable size, up to a year; a narrow card
  // shows the latest weeks that fit
  const gap = 3
  const avail = Math.max(0, width - LABELS)
  const history = first ? Math.ceil((today().getTime() - dateOf(first).getTime()) / (7 * DAY)) + 1 : 0
  const fit = (cell: number) => Math.floor((avail + gap) / (cell + gap))
  const weeks = !width ? 26 : Math.max(8, Math.min(53, Math.max(fit(18), Math.min(history, fit(11)))))
  const cell = !width ? 14 : Math.max(10, Math.min(22, Math.floor((avail + gap) / weeks) - gap))

  const end = today()
  const start = addDays(end, -(((end.getDay() - weekStart()) + 7) % 7) - (weeks - 1) * 7)
  const days = useMemo(() => Array.from({ length: weeks * 7 }, (_, i) => keyOf(addDays(start, i))), [start.getTime(), weeks])
  const last = keyOf(end)

  // the shades: quartiles of the active days shown; with too few days for quartiles, a share of the busiest
  const cuts = useMemo(() => {
    const v = days.map((d) => byDay.get(d)).filter(Boolean).map((x) => tokens(x!)).filter((n) => n > 0).sort((a, b) => a - b)
    if (new Set(v).size < 4) { const max = v.at(-1) ?? 0; return [max / 4, max / 2, (max * 3) / 4] }
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!
    return [q(0.25), q(0.5), q(0.75)]
  }, [days, byDay])
  const level = (n: number) => (!n ? 0 : 1 + cuts.filter((c) => n > c).length)

  // a month's name over the week its first day falls in, if there is room
  const month = (k: string) => fmtDate(k, { month: 'short' })
  const firsts = Array.from({ length: weeks }, (_, c) => ({ col: c, day: days.slice(c * 7, c * 7 + 7).find((k) => k.endsWith('-01')) }))
    .filter((m): m is { col: number; day: string } => !!m.day).map((m) => ({ col: m.col, label: month(m.day) }))
  // the first column is named too when the next name is far enough away
  const months = (firsts[0]?.col ?? weeks) >= 3 ? [{ col: 0, label: month(days[0]!) }, ...firsts] : firsts
  // the chosen period, marked under the months (the calendar itself stays whole); a single day is ringed instead
  const col = (k: string) => Math.floor(days.indexOf(k) / 7)
  const range = !picked && to >= days[0]! ? [col(from < days[0]! ? days[0]! : from), col(to > last ? last : to)] as const : undefined
  // Monday, Wednesday and Friday, wherever the week starts
  const weekdays = (weekStart() === 1 ? [0, 2, 4] : [1, 3, 5]).map((row) => ({ row, label: dateOf(days[row]!).toLocaleDateString(getLang(), { weekday: 'short' }) }))

  // the stretch of days ending today with something on each, and the busiest day shown
  let streak = 0
  for (let d = end; byDay.get(keyOf(d)) && tokens(byDay.get(keyOf(d))!) > 0; d = addDays(d, -1)) streak++
  const shown = days.filter((d) => d <= last && byDay.get(d))
  const busiest = shown.reduce<string | undefined>((b, d) => (!b || tokens(byDay.get(d)!) > tokens(byDay.get(b)!) ? d : b), undefined)

  const move = (e: React.KeyboardEvent, day: string) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = keyOf(addDays(dateOf(day), step))
    if (next < days[0]! || next > last) return
    ;(box.current?.querySelector(`[data-day="${next}"]`) as HTMLElement | null)?.focus()
  }
  const show = (el: HTMLElement, day: string) => {
    const b = box.current!.getBoundingClientRect(), r = el.getBoundingClientRect()
    setTip({ day, x: r.left - b.left + r.width / 2, y: r.top - b.top })
  }

  return (
    <div className="hm" ref={box} onMouseLeave={() => setTip(undefined)}>
      <div className="hm-grid" role="grid" aria-label={t('Tokens per day')} style={{ '--cell': `${cell}px`, '--gap': `${gap}px`, '--weeks': weeks, '--labels': `${LABELS}px` } as React.CSSProperties}>
        <div className="hm-months" aria-hidden>
          {months.map((m) => <span key={m.col} style={{ gridColumn: m.col + 1, gridRow: 1 }}>{m.label}</span>)}
          {range && <i className="hm-range" style={{ gridColumn: `${range[0] + 1} / ${range[1] + 2}`, gridRow: 2 }} />}
        </div>
        <div className="hm-weekdays" aria-hidden>{weekdays.map((w) => <span key={w.row} style={{ gridRow: w.row + 1 }}>{w.label}</span>)}</div>
        <div className="hm-cells">
          {days.map((d) => {
            if (d > last) return <span key={d} className="hm-cell future" aria-hidden />
            const x = byDay.get(d)
            const n = x ? tokens(x) : 0
            return (
              <button key={d} data-day={d} className={`hm-cell l${level(n)} ${d === picked ? 'picked' : ''} ${d === last ? 'today' : ''}`}
                aria-label={`${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}: ${n ? t('{n} tokens', { n: fmtTokens(n) }) : t('no usage')}`}
                aria-pressed={d === picked}
                onClick={() => onPick(d)} onKeyDown={(e) => move(e, d)}
                onMouseEnter={(e) => show(e.currentTarget, d)} onFocus={(e) => show(e.currentTarget, d)} onBlur={() => setTip(undefined)} />
            )
          })}
        </div>
      </div>
      <footer className="hm-foot">
        <span className="hm-sum">
          {activeDays(shown.length)}
          {streak > 1 && <> · {t('{n}-day streak', { n: streak })}</>}
          {busiest && <> · <button className="hm-link" onClick={() => onPick(busiest)}>{t('busiest {date}', { date: fmtDate(busiest, { month: 'short', day: 'numeric' }) })}</button></>}
        </span>
        <span className="hm-legend" aria-label={t('Less to more tokens')}>
          {t('Less')}
          {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`hm-cell l${l}`} title={l === 0 ? t('no usage') : l === 1 ? `≤ ${fmtTokens(cuts[0] ?? 0)}` : l === 4 ? `> ${fmtTokens(cuts[2] ?? 0)}` : `${fmtTokens(cuts[l - 2] ?? 0)} – ${fmtTokens(cuts[l - 1] ?? 0)}`} />)}
          {t('More')}
        </span>
      </footer>
      {tip && <DayTip day={tip.day} x={tip.x} y={tip.y} t={byDay.get(tip.day)} width={width} source={source} />}
    </div>
  )
}

/** a day, in full: what it came to and what it was made of */
function DayTip({ day, x, y, t: d, width, source }: { day: string; x: number; y: number; t?: Tot; width: number; source: 'gateway' | 'history' }) {
  const all = d ? tokens(d) : 0
  const left = Math.max(110, Math.min(width - 110, x))
  return (
    <div className="hm-tip" role="tooltip" style={{ left, top: y }}>
      <div className="hm-tip-date">{fmtDate(day, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      {!d || !all ? <div className="hm-tip-none">{t('no usage')}</div> : (
        <>
          <div className="hm-tip-total"><b>{fmtTokens(all)}</b> {t('tokens')}</div>
          <div className="uh-bar small">{[['cr', d.cacheRead], ['cw', d.cacheWrite], ['in', d.input], ['out', d.output]].map(([k, v]) => (v as number) > 0 && <span key={k as string} className={`c-${k}`} style={{ flexGrow: v as number, minWidth: 2 }} />)}</div>
          <dl className="hm-tip-rows">
            <dt><i className="c-cr" />{t('Cache read')}</dt><dd>{fmtTokens(d.cacheRead)}</dd>
            {d.cacheWrite > 0 && <><dt><i className="c-cw" />{t('Cache write')}</dt><dd>{fmtTokens(d.cacheWrite)}</dd></>}
            <dt><i className="c-in" />{t('Fresh input')}</dt><dd>{fmtTokens(d.input)}</dd>
            <dt><i className="c-out" />{t('Output')}</dt><dd>{fmtTokens(d.output)}</dd>
            <dt>{t('Requests')}</dt><dd>{d.requests.toLocaleString(getLang())}{d.failed ? ` · ${t('{n} failed', { n: d.failed })}` : ''}</dd>
            {source === 'history' && <><dt>{t('Sessions')}</dt><dd>{d.sessions.size}</dd></>}
            {d.cost > 0 && <><dt>{t('Cost')}</dt><dd>{money(d.cost)}</dd></>}
          </dl>
        </>
      )}
    </div>
  )
}

/** the period in a few quiet figures */
function Facts({ t: x, source, active }: { t: Tot; source: 'gateway' | 'history'; active: number }) {
  useT()
  const all = tokens(x)
  return (
    <div className="uf-row">
      <div className="uf"><span className="uf-l">{t('Requests')}</span><span className="uf-v">{x.requests.toLocaleString(getLang())}</span><span className="uf-s">{x.failed ? t('{n} failed', { n: x.failed }) : t('model calls')}</span></div>
      {source === 'history'
        ? <div className="uf"><span className="uf-l">{t('Sessions')}</span><span className="uf-v">{x.sessions.size.toLocaleString(getLang())}</span><span className="uf-s">{activeDays(active)}</span></div>
        : <div className="uf"><span className="uf-l">{t('Active days')}</span><span className="uf-v">{active}</span><span className="uf-s">{t('with a request')}</span></div>}
      <div className="uf"><span className="uf-l">{t('Per active day')}</span><span className="uf-v">{active ? fmtTokens(Math.round(all / active)) : '—'}</span><span className="uf-s">{t('tokens on average')}</span></div>
      <div className="uf"><span className="uf-l">{t('Cost')}</span><span className="uf-v">{x.cost > 0 ? money(x.cost) : '—'}</span>
        <span className="uf-s" title={x.cost > 0 && x.priced < x.rows ? t('Only some agents record what a call cost; the rest is not included.') : undefined}>
          {!x.cost ? t('not recorded by these agents') : x.priced < x.rows ? t('recorded by {agents} only', { agents: [...x.costBy].map((a) => AGENT_NAME[a] ?? a).join(', ') }) : t('as the agents recorded it')}</span></div>
    </div>
  )
}

function Breakdown({ title, rows, total, render }: { title: string; rows: { key: string; tot: Tot }[]; total: number; render: (key: string) => React.ReactNode }) {
  useT()
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 6)
  return (
    <section className="ub">
      <div className="section-label">{title}</div>
      <div className="ub-list">
        {shown.map((r) => {
          const n = tokens(r.tot)
          return (
            <div key={r.key} className="ub-row" title={`${fmtTokens(n)} · ${t('{n} requests', { n: r.tot.requests })}`}>
              <span className="ub-name">{render(r.key)}</span>
              <span className="ub-num">{fmtTokens(n)}</span>
              <span className="ub-share">{pct(n, total)}</span>
              <span className="ub-bar"><span style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></span>
            </div>
          )
        })}
        {!rows.length && <div className="ub-none">{t('Nothing in this period')}</div>}
        {rows.length > 6 && <button className="ub-more" onClick={() => setAll(!all)}>{all ? t('Show fewer') : t('{n} more', { n: rows.length - 6 })}</button>}
      </div>
    </section>
  )
}
