import { useEffect, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { controlApi } from './api'
import { AGENT_NAME, fmtTokens, useControl } from './control'
import { shortDate } from './format'
import { Icon } from './Icon'
import { useMachine } from './machines'
import { go, href } from './route'
import { PageHead } from './ui'
import type { UsageBucket, UsageSummary } from './types'

const RANGES = [{ days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 0, label: 'All' }] as const
const DAY = 86_400_000

/**
 * Usage, from two places: what went through the gateway (recorded per request), and what the agents' own session
 * files say they used — so there is something to see before any agent is routed (the history is the open machine's).
 */
export function UsagePage({ source }: { source: 'gateway' | 'history' }) {
  useT()
  const [days, setDays] = useState<number>(30)
  const { events } = useControl()
  const { machine, sessions } = useMachine()
  const [gw, setGw] = useState<UsageSummary>()
  const [err, setErr] = useState<string>()
  const done = events.filter((e) => e.phase === 'done').length
  useEffect(() => {
    if (source !== 'gateway') return
    controlApi.usage(days).then((u) => { setGw(u); setErr(undefined) }, (e) => setErr((e as Error).message))
  }, [source, days, done])

  // the sessions' own counts, bucketed the same way
  const history = useMemo<UsageSummary>(() => {
    const since = days ? startOfDay(Date.now() - (days - 1) * DAY) : 0
    const rows = sessions.filter((s) => s.tokens && s.updatedAt >= since && !s.parentId)
    const by = (key: (s: (typeof rows)[number]) => string) => {
      const m = new Map<string, UsageBucket>()
      for (const s of rows) {
        const k = key(s)
        const e = m.get(k) ?? { key: k, calls: 0, input: 0, output: 0, cacheRead: 0, failed: 0 }
        e.calls++; e.input += s.tokens!.input; e.output += s.tokens!.output
        m.set(k, e)
      }
      return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
    }
    const totals = rows.reduce((a, s) => ({ ...a, calls: a.calls + 1, input: a.input + s.tokens!.input, output: a.output + s.tokens!.output }), { calls: 0, failed: 0, input: 0, output: 0, cacheRead: 0, ms: 0, rerouted: 0 })
    return { totals, byDay: by((s) => String(startOfDay(s.updatedAt))).sort((a, b) => Number(a.key) - Number(b.key)), byModel: by((s) => s.model ?? '—'), byAgent: by((s) => s.agent), byTarget: [], recent: [] }
  }, [sessions, days])

  const u = source === 'gateway' ? gw : history
  const tot = u?.totals
  const cost = source === 'history' ? sessions.filter((s) => s.cost && s.updatedAt >= (days ? startOfDay(Date.now() - (days - 1) * DAY) : 0)).reduce((a, s) => a + s.cost!, 0) : 0

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Model Control') }, { label: t('Usage') }]} />
        <h1>{t('Usage')}</h1>
        <div className="usage-bar">
          <div className="seg" role="radiogroup" aria-label={t('Source')}>
            <button role="radio" aria-checked={source === 'gateway'} className={source === 'gateway' ? 'on' : ''} onClick={() => go(href.usage())}><Icon name="gateway" size={13} />{t('Through the gateway')}</button>
            <button role="radio" aria-checked={source === 'history'} className={source === 'history' ? 'on' : ''} onClick={() => go(href.usage('history'))}><Icon name="message" size={13} />{t('From session history')}</button>
          </div>
          <span className="grow" />
          <div className="seg" role="radiogroup" aria-label={t('Period')}>
            {RANGES.map((r) => <button key={r.days} role="radio" aria-checked={days === r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>{t(r.label)}</button>)}
          </div>
        </div>
        <p className="quiet-note usage-note">{source === 'gateway' ? t('Every request an agent sent through the gateway, with the tokens its provider reported.') : t('What the agents recorded in their own session files on {machine}, by the day each session was last active. Sessions that record no token counts are not included.', { machine: machine.name })}</p>

        {err && source === 'gateway' ? <div className="form-error">{err}</div> : !u ? <div className="sk-line" /> : !tot?.calls ? (
          <div className="empty-state compact">
            <span className="tile"><Icon name="usage" size={26} stroke={1.5} /></span>
            <b>{source === 'gateway' ? t('Nothing has gone through the gateway in this period') : t('No token counts in this period')}</b>
            {source === 'gateway' && <span className="es-sub">{t('Choose a model for an agent on Routing, then start a session of it from Sessionary.')}</span>}
            {source === 'gateway' && <a className="btn" href={href.routing()}>{t('Routing')}</a>}
          </div>
        ) : (
          <>
            <div className="usage-tiles">
              <div className="stat-tile"><span className="stat-v">{fmtTokens(tot.input + tot.output)}</span><span className="stat-l">{t('Tokens')}</span><span className="stat-s">{t('{input} in · {output} out', { input: fmtTokens(tot.input), output: fmtTokens(tot.output) })}</span></div>
              {source === 'gateway' ? (
                <>
                  <div className="stat-tile"><span className="stat-v">{fmtTokens(tot.cacheRead)}</span><span className="stat-l">{t('Cache read')}</span><span className="stat-s">{tot.input ? t('hit rate {p}%', { p: Math.round((tot.cacheRead / tot.input) * 100) }) : '—'}</span></div>
                  <div className="stat-tile"><span className="stat-v">{tot.calls}</span><span className="stat-l">{t('Requests')}</span><span className="stat-s">{t('{n} rerouted · {f} failed', { n: tot.rerouted, f: tot.failed })}</span></div>
                  <div className="stat-tile"><span className="stat-v">{tot.calls ? `${(tot.ms / tot.calls / 1000).toFixed(1)} s` : '—'}</span><span className="stat-l">{t('Average reply')}</span><span className="stat-s">{t('to the last byte')}</span></div>
                </>
              ) : (
                <>
                  <div className="stat-tile"><span className="stat-v">{tot.calls}</span><span className="stat-l">{t('Sessions')}</span><span className="stat-s">{t('with token counts')}</span></div>
                  <div className="stat-tile"><span className="stat-v">{cost ? `$${cost.toFixed(2)}` : '—'}</span><span className="stat-l">{t('Cost')}</span><span className="stat-s">{t('as the agents recorded it')}</span></div>
                </>
              )}
            </div>
            <DayChart days={days} rows={u.byDay} />
            <div className="usage-tables">
              <Board title={t('By model')} rows={u.byModel} unit={source === 'gateway' ? t('requests') : t('sessions')} render={(k) => <span className="mono ellip">{k}</span>} />
              <Board title={t('By agent')} rows={u.byAgent} unit={source === 'gateway' ? t('requests') : t('sessions')} render={(k) => <><AgentIcon agent={k} size={14} /><span className="ellip">{AGENT_NAME[k] ?? k}</span></>} />
              {source === 'gateway' && <Board title={t('By route')} rows={u.byTarget} unit={t('requests')} render={(k) => <a className="mono ellip" href={k.startsWith('group/') ? href.routing(k.slice(6)) : href.models(k.slice(0, k.indexOf('/')))}>{k}</a>} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

/** tokens per day, input under output */
function DayChart({ days, rows }: { days: number; rows: UsageBucket[] }) {
  useT()
  const by = new Map(rows.map((r) => [Number(r.key), r]))
  const first = days ? startOfDay(Date.now() - (days - 1) * DAY) : rows.length ? Number(rows[0]!.key) : startOfDay(Date.now())
  const span = Math.min(120, Math.round((startOfDay(Date.now()) - first) / DAY) + 1)
  const cols = Array.from({ length: Math.max(span, 1) }, (_, i) => startOfDay(first + i * DAY + DAY / 2))
  const max = Math.max(1, ...cols.map((d) => { const r = by.get(d); return r ? r.input + r.output : 0 }))
  if (days === 1) return null
  return (
    <div className="chart group-card" role="img" aria-label={t('Tokens per day')}>
      <span className="chart-max r-meta">{fmtTokens(max)}</span>
      <div className="chart-bars">
        {cols.map((d) => {
          const r = by.get(d)
          const total = r ? r.input + r.output : 0
          return (
            <div key={d} className="chart-col" title={`${shortDate(d)} · ${fmtTokens(r?.input ?? 0)} ${t('in')} · ${fmtTokens(r?.output ?? 0)} ${t('out')}`}>
              <span className="bar-in" style={{ height: `${((r?.input ?? 0) / max) * 100}%` }} />
              <span className="bar-out" style={{ height: `${((r?.output ?? 0) / max) * 100}%`, minHeight: total ? 2 : 0 }} />
            </div>
          )
        })}
      </div>
      <div className="chart-axis r-meta"><span>{shortDate(cols[0]!)}</span><span>{shortDate(cols.at(-1)!)}</span></div>
      <div className="chart-legend r-meta"><span className="lg in" />{t('in')}<span className="lg out" />{t('out')}</div>
    </div>
  )
}

function Board({ title, rows, unit, render }: { title: string; rows: UsageBucket[]; unit: string; render: (key: string) => React.ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.input + r.output))
  return (
    <section className="board">
      <div className="section-label">{title}</div>
      <div className="group-card">
        {rows.slice(0, 8).map((r) => (
          <div key={r.key} className="board-row">
            <span className="board-name">{render(r.key)}</span>
            <span className="board-bar"><span style={{ width: `${((r.input + r.output) / max) * 100}%` }} /></span>
            <span className="r-meta board-num">{fmtTokens(r.input + r.output)}</span>
            <span className="r-meta board-calls" title={unit}>×{r.calls}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
