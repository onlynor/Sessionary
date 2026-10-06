import { useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { controlApi } from './api'
import { AGENT_NAME, PROTOCOL_NAME, ProviderMark, describeTarget, fmtTokens, restText, useControl, useTick, whyText } from './control'
import { clock, relAgo } from './format'
import { Icon } from './Icon'
import { href } from './route'
import { CodeBlock, PageHead, useUi } from './ui'
import type { Protocol, RouteEvent } from './types'

/**
 * Gateway: the one local address agents are pointed at — how to reach it, its key, how each agent gets connected,
 * the health of every model behind it, and the requests going through.
 */
export function GatewayPage() {
  useT()
  const ui = useUi()
  const { state, reload, events } = useControl()
  const [key, setKey] = useState<string>()
  const [open, setOpen] = useState<string>()
  const [snip, setSnip] = useState<{ file: string; lang: string; text: string }>()
  const resting = !!state?.health.some((h) => (h.restingUntil ?? 0) > Date.now())
  useTick(resting)

  const reveal = async () => {
    if (key) { setKey(undefined); return }
    try { setKey((await controlApi.gatewayKey()).key) } catch (e) { ui.say((e as Error).message) }
  }
  const copyKey = async () => {
    try { await navigator.clipboard.writeText((await controlApi.gatewayKey()).key); ui.say(t('Gateway key copied')) } catch (e) { ui.say((e as Error).message) }
  }
  const rotate = () => ui.confirm({
    title: t('Make a new gateway key?'), confirm: t('Make new key'), danger: true,
    body: <p>{t('Sessions Sessionary starts get the new key by themselves. Anything you set up by hand stops working until you paste the new key there.')}</p>,
    onConfirm: async () => { try { await controlApi.rotateKey(); setKey(undefined); await reload(); ui.say(t('New gateway key made')) } catch (e) { ui.say((e as Error).message) } },
  })
  const show = async (agent: string, target?: string) => {
    if (open === agent) { setOpen(undefined); return }
    try { setSnip(await controlApi.snippet(agent, target)); setOpen(agent) } catch (e) { ui.say((e as Error).message) }
  }

  const requests = useMemo(() => {
    const byId = new Map<string, RouteEvent[]>()
    for (const e of events) byId.set(e.id, [...(byId.get(e.id) ?? []), e])
    return [...byId.values()].reverse().slice(0, 30)
  }, [events])

  if (!state) return <div className="page"><div className="page-inner wide"><div className="sk-line" /></div></div>
  const base = state.gateway.base
  const members = state.health.filter((h) => h.member).sort((a, b) => a.member.localeCompare(b.member))

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Model Control') }, { label: t('Gateway') }]} />
        <h1>{t('Gateway')}</h1>
        <p className="page-lede">{t('One address on this computer that speaks the APIs agents use. It sends each request to a model of the group the agent asked for, and moves on when one cannot answer.')}</p>

        <div className="gw-hero group-card">
          <div className="gw-addr">
            <span className="gw-dot" />
            <span className="mono grow ellip">{base}</span>
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(base).then(() => ui.say(t('Address copied')), () => {})}><Icon name="copy" size={12} />{t('Copy')}</button>
          </div>
          <div className="form-row"><span>{t('Key')}</span>
            <span className="key-row"><span className="mono key-mask ellip">{key ?? state.gateway.key}</span><span className="grow" />
              <button className="btn sm" onClick={reveal}><Icon name="eye" size={12} />{key ? t('Hide') : t('Show')}</button>
              <button className="btn sm" onClick={copyKey}><Icon name="copy" size={12} />{t('Copy')}</button>
              <button className="btn sm" onClick={rotate}><Icon name="restart" size={12} />{t('New key…')}</button>
            </span>
          </div>
          {(Object.entries(state.gateway.protocols) as [Protocol, string][]).map(([p, path]) => (
            <div key={p} className="form-row"><span>{PROTOCOL_NAME[p]}</span><span className="mono ellip quiet">POST {base}{path}</span></div>
          ))}
          <p className="form-hint flat">{t('Listens on 127.0.0.1 only, and refuses requests from web pages on other sites. The key is sent as Bearer or x-api-key. A session started on an SSH node reaches it through a tunnel in that session’s own connection, which leads to the gateway alone.')}</p>
        </div>

        <div className="section-label row-label"><span>{t('Connecting agents')}</span><span className="grow" /><a className="more" href={href.routing()}>{t('Choose models on Routing')}</a></div>
        <div className="group-card bind-list">
          {state.agents.map((a) => (
            <div key={a.agent}>
              <div className="bind-row">
                <span className={`app-tile at-${a.agent}`}><AgentIcon agent={a.agent} size={22} /></span>
                <span className="bind-text">
                  <span className="bind-name">{AGENT_NAME[a.agent]}<span className="pill-quiet">{PROTOCOL_NAME[a.protocol]}</span></span>
                  <span className="bind-sub">{a.launch === 'env'
                    ? (a.target ? t('Started from Sessionary: connected automatically, on {target}', { target: a.target }) : t('Started from Sessionary: connected automatically once you choose a model'))
                    : t('Sessionary does not start it with routing yet: paste the setup into its configuration')}</span>
                </span>
                <button className={`btn sm ${open === a.agent ? 'on' : ''}`} onClick={() => show(a.agent, a.target)}><Icon name="code" size={12} />{open === a.agent ? t('Hide setup') : t('Set up by hand')}</button>
              </div>
              {open === a.agent && snip && (
                <div className="bind-snip">
                  <p className="quiet-note">{t('To use the gateway outside Sessionary too, merge this into {file}. Sessionary does not edit it for you.', { file: snip.file })}</p>
                  <CodeBlock code={snip.text} label={snip.file} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="section-label row-label"><span>{t('Models behind it')}</span><span className="grow" /><span className="r-meta">{t('since Sessionary started')}</span></div>
        {!members.length ? <p className="quiet-note">{t('Nothing has gone through the gateway yet.')}</p> : (
          <div className="group-card mlist">
            {members.map((h) => {
              const d = describeTarget(state, h.member)
              const rest = (h.restingUntil ?? 0) > Date.now()
              return (
                <div key={h.member} className={`mrow ${rest ? 'resting' : ''}`}>
                  <span className={`sdot ${rest ? 'sd-error' : h.answering ? 'sd-connecting' : h.lastOk ? 'sd-online' : 'sd-offline'}`} />
                  <ProviderMark provider={d.provider ?? { name: d.sub, preset: '' }} presets={state.presets} size={22} />
                  <span className="grow ellip"><span className="mrow-name">{d.sub}</span> <span className="mono mrow-id">{d.title}</span></span>
                  <span className="r-meta">{rest ? restText(h.restingUntil!, h.why) : h.answering ? t('answering {n}', { n: h.answering }) : h.lastOk ? t('answered {when}', { when: relAgo(h.lastOk) }) : h.lastFail ? t('failed {when}', { when: relAgo(h.lastFail) }) : t('not used yet')}</span>
                  {rest && <button className="btn sm" onClick={async () => { await controlApi.wake(h.member); await reload() }}>{t('Try it first again')}</button>}
                </div>
              )
            })}
          </div>
        )}

        <div className="section-label row-label"><span>{t('Requests')}</span><span className="grow" /><a className="more" href={href.usage()}>{t('Usage')}</a></div>
        {!requests.length ? <p className="quiet-note">{t('Requests show up here as they happen.')}</p> : (
          <div className="group-card req-list">
            {requests.map((steps) => {
              const first = steps[0]!, last = steps.at(-1)!
              const ok = steps.some((s) => s.phase === 'done' || s.phase === 'answering')
              const answered = steps.find((s) => s.phase === 'answering')?.member
              return (
                <div key={first.id} className="req-row">
                  <span className="r-meta mono">{clock(first.at)}</span>
                  <AgentIcon agent={first.agent} size={14} />
                  <span className="grow ellip"><b>{first.target}</b>{answered && <span className="quiet"> → {answered}</span>}{steps.filter((s) => s.phase === 'failed').length > 0 && <span className="badge warn">{t('rerouted')}</span>}</span>
                  <span className="r-meta">{last.phase === 'done' ? `${fmtTokens(last.input ?? 0)} / ${fmtTokens(last.output ?? 0)} · ${((last.ms ?? 0) / 1000).toFixed(1)} s` : last.phase === 'answering' ? t('answering…') : last.phase === 'trying' ? t('trying…') : whyText(last.why) || last.why}</span>
                  <span className={`sdot ${ok ? 'sd-online' : last.phase === 'trying' || last.phase === 'answering' ? 'sd-connecting' : 'sd-error'}`} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
