import { useMemo, useState } from 'react'
import { t, tx, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { controlApi } from './api'
import { AGENT_NAME, GroupMark, ModelPicker, PROTOCOL_NAME, ProviderMark, Switch, TargetButton, describeTarget, restText, useControl, useMachineRoutes, useTick, whyText } from './control'
import { Icon } from './Icon'
import { go, href } from './route'
import { useMachines } from './machines'
import { MoreMenu, PageHead, shortPath, useUi } from './ui'
import type { CtlAgent, CtlGroup, CtlRoute, CtlState, Machine, RouteEvent } from './types'

/**
 * Routing: which agent uses what, per machine (each agent's row holds its model picker), then the routing groups —
 * models an agent picks as one, tried in order or in turn — each with a live picture of where its requests go.
 *
 * A route belongs to a machine: what is chosen for Pi on one node never moves Pi on another. Each machine's agents
 * inherit, in order, from their session, project, agent, the machine, and the default for every machine (`machine` '').
 */
export function RoutingPage({ group: chosen, machine: scope }: { group?: string; machine: string }) {
  useT()
  const { state, reload } = useControl()
  const { machines } = useMachines()
  const ui = useUi()
  const groups = state?.groups ?? []
  const current = groups.find((g) => g.id === chosen) ?? groups[0]
  // the machines Sessionary starts agents on: this computer and the nodes it reaches over ssh
  const routable = machines.filter((m) => m.kind === 'local' || m.kind === 'ssh')
  const open = scope === '' ? undefined : routable.find((m) => m.id === scope) ?? routable.find((m) => m.kind === 'local')

  const newGroup = () => ui.prompt({
    title: t('New routing group'), label: t('Name'), value: '', confirm: t('Create'), placeholder: t('Daily coding'),
    onSubmit: async (name) => {
      if (!name.trim()) return
      try { const g = await controlApi.addGroup({ name: name.trim() }); await reload(); go(href.routing(g.id)) } catch (e) { ui.say((e as Error).message) }
    },
  })

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Model Control') }, { label: t('Routing') }]}>
          <button className="btn" onClick={newGroup}><Icon name="other" size={14} />{t('New group')}</button>
        </PageHead>
        <h1>{t('Routing')}</h1>
        <p className="page-lede">{t('Choose the model each agent uses. A routing group is several models an agent picks as one: when one cannot answer, the next one does.')}</p>

        <div className="section-label row-label"><span>{t('Agents')}</span><span className="grow" /><span className="r-meta">{t('applies to sessions Sessionary starts on that machine')}</span></div>
        <div className="seg sm route-scope" role="radiogroup" aria-label={t('Machine')}>
          <button role="radio" aria-checked={!open} className={!open ? 'on' : ''} onClick={() => go(href.routing(chosen, ''))} title={t('What every agent on every machine starts on, unless the machine or the agent says otherwise')}>{t('Every machine')}</button>
          {routable.map((m) => <button key={m.id} role="radio" aria-checked={open?.id === m.id} className={open?.id === m.id ? 'on' : ''} onClick={() => go(href.routing(chosen, m.id))}>{m.name}</button>)}
        </div>
        {!state ? <div className="sk-line" /> : open ? <MachineRoutes key={open.id} machine={open} state={state} /> : (
          <div className="group-card bind-list">
            <ScopeRow state={state} scope={{ machine: '' }} title={t('Every agent, on every machine')} sub={t('The default: a machine or an agent with its own route does not use it.')} />
          </div>
        )}

        <div className="section-label row-label"><span>{t('Routing groups')}</span><span className="grow" /><span className="r-meta">{t('models agents pick as one')}</span></div>
        {state && !groups.length ? (
          <div className="empty-state compact">
            <span className="tile"><Icon name="route" size={26} stroke={1.5} /></span>
            <b>{t('No routing groups yet')}</b>
            <span className="es-sub">{state.providers.length ? t('Put a few models from different providers in a group, and bind an agent to it. When one is rate limited or down, the next one answers.') : t('Add a provider on the Models page first.')}</span>
            {state.providers.length ? <button className="btn primary" onClick={newGroup}><Icon name="other" size={14} />{t('New group')}</button> : <button className="btn primary" onClick={() => go(href.models(undefined, { add: '1' }))}>{t('Add provider')}</button>}
          </div>
        ) : state && current && (
          <div className="ctl-split groups">
            <div className="plist group-card" role="list">
              {groups.map((g) => (
                <a key={g.id} role="listitem" className={`lrow ${g.id === current.id ? 'on' : ''} ${g.on ? '' : 'off'}`} href={href.routing(g.id)} aria-current={g.id === current.id ? 'true' : undefined}>
                  <MemberStack state={state} members={g.members} />
                  <span className="lrow-text">
                    <span className="lrow-name">{g.name}</span>
                    <span className="lrow-sub mono">group/{g.id}</span>
                  </span>
                  <span className="pill-quiet">{g.mode === 'rotate' ? t('In turn') : t('In order')}</span>
                </a>
              ))}
            </div>
            <GroupDetail key={current.id} g={current} />
          </div>
        )}
      </div>
    </div>
  )
}

/** up to three members' marks, overlapping */
function MemberStack({ state, members }: { state: CtlState; members: string[] }) {
  const ps = [...new Set(members.map((m) => m.slice(0, m.indexOf('/'))))].map((id) => state.providers.find((p) => p.id === id)).filter(Boolean).slice(0, 3)
  if (!ps.length) return <GroupMark size={30} />
  return <span className="mstack">{ps.map((p) => <ProviderMark key={p!.id} provider={p} presets={state.presets} size={24} />)}</span>
}

const viaText = (a: CtlAgent) => {
  // the provider is named only when the route does not already say it
  const own = [a.model, a.provider && a.via !== 'magpie' && a.via !== 'sessionary' && a.provider !== a.model?.split('/')[0] ? a.provider : undefined].filter(Boolean).join(' · ')
  switch (a.via) {
    case 'magpie': return t('By itself: through Magpie{own}', { own: own ? ` · ${own}` : '' })
    case 'sessionary': return t('By itself: through this gateway{own}', { own: own ? ` · ${own}` : '' })
    case 'custom': return t('By itself: a custom endpoint{own}', { own: own ? ` · ${own}` : '' })
    default: return own ? t('By itself: {own}', { own }) : t('By itself: its own default')
  }
}

type Scope = { machine: string; agent?: string; project?: string; session?: string }
const ownRoute = (state: CtlState, s: Scope) => state.routes.find((r) => r.machine === s.machine && r.agent === (s.agent ?? '') && r.project === (s.project ?? '') && r.session === (s.session ?? ''))

/** sets or clears one scope's route, and says what changed */
function useSetRoute() {
  const ui = useUi()
  const { reload } = useControl()
  return async (scope: Scope, target: string, said: string) => {
    try { await controlApi.route(scope, target); await reload(); ui.say(said) } catch (e) { ui.say((e as Error).message) }
  }
}

/** a route for a whole scope (every machine, or every agent on one machine) */
function ScopeRow({ state, scope, title, sub, inherited }: { state: CtlState; scope: Scope; title: string; sub: string; inherited?: string }) {
  useT()
  const set = useSetRoute()
  const own = ownRoute(state, scope)?.target
  return (
    <div className="bind-row">
      <span className="app-tile scope-tile"><Icon name={scope.machine ? 'server' : 'route'} size={20} /></span>
      <span className="bind-text">
        <span className="bind-name">{title}</span>
        <span className="bind-sub">{sub}</span>
      </span>
      <span className="bind-pick"><TargetButton value={own} onChange={(v) => set(scope, v, v ? t('{scope} now starts on {target}', { scope: title, target: v }) : t('{scope} no longer has a route of its own', { scope: title }))}
        defaultLabel={inherited ? t('inherits {target}', { target: inherited }) : t('each agent’s own setting')} placeholder={inherited ? t('inherits {target}', { target: inherited }) : undefined} /></span>
    </div>
  )
}

/** one machine: a route for all its agents, each agent's own, and the project and session routes made there */
function MachineRoutes({ machine, state }: { machine: Machine; state: CtlState }) {
  useT()
  const set = useSetRoute()
  const agents = useMachineRoutes(machine)
  const narrow = state.routes.filter((r) => r.machine === machine.id && (r.project || r.session))
  const fallback = ownRoute(state, { machine: '' })?.target
  return (
    <>
      <div className="group-card bind-list">
        <ScopeRow state={state} scope={{ machine: machine.id }} title={t('Every agent on {machine}', { machine: machine.name })}
          sub={t('Agents on {machine} without a route of their own start on this.', { machine: machine.name })} inherited={fallback} />
        {!agents ? <div className="sk-line" /> : agents.map((a) => <AgentRow key={a.agent} a={a} machine={machine} state={state} />)}
      </div>
      {narrow.length > 0 && (
        <>
          <div className="section-label row-label"><span>{t('Projects and sessions on {machine}', { machine: machine.name })}</span><span className="grow" /><span className="r-meta">{t('these win over the agent’s route')}</span></div>
          <div className="group-card bind-list">
            {narrow.map((r) => <NarrowRow key={`${r.agent}|${r.project}|${r.session}`} r={r} onClear={() => set(r, '', t('The route was removed'))} />)}
          </div>
        </>
      )}
    </>
  )
}

const LEVEL_TEXT = (a: CtlAgent, machine: string) =>
  a.level === 'machine' ? t('inherits {target} from {machine}', { target: a.target!, machine }) : a.level === 'default' ? t('inherits {target} from every machine', { target: a.target! }) : undefined

/** one agent on one machine: what it runs on by itself (known only here), and what Sessionary starts it with */
function AgentRow({ a, machine, state }: { a: CtlAgent; machine: Machine; state: CtlState }) {
  useT()
  const set = useSetRoute()
  const name = AGENT_NAME[a.agent] ?? a.agent
  const own = ownRoute(state, { machine: machine.id, agent: a.agent })?.target
  const inherited = own ? undefined : LEVEL_TEXT(a, machine.name)
  const pick = (target: string) => set({ machine: machine.id, agent: a.agent }, target, target
    ? t('{agent} on {machine} now starts on {target}', { agent: name, machine: machine.name, target })
    : t('{agent} on {machine} no longer has a route of its own', { agent: name, machine: machine.name }))
  return (
    <div className="bind-row">
      <span className={`app-tile at-${a.agent}`}><AgentIcon agent={a.agent} size={22} /></span>
      <span className="bind-text">
        <span className="bind-name">{name}</span>
        <span className="bind-sub" title={a.file}>{machine.kind === 'local' ? viaText(a) : inherited ?? t('By itself: what it is set to on {machine}', { machine: machine.name })}</span>
        {machine.kind === 'local' && inherited && <span className="bind-sub">{inherited}</span>}
        {a.skipped && <span className="bind-note"><Icon name="route" size={12} />{t('Passes over {target}: nothing in it speaks {protocol}.', { target: a.skipped, protocol: PROTOCOL_NAME[a.protocol] })}</span>}
        {a.target && a.reachable === 0 && <span className="bind-warn"><Icon name="warn" size={12} />{t('Nothing in {target} can answer {agent}: it needs a model whose provider speaks {protocol}.', { target: a.target, agent: name, protocol: PROTOCOL_NAME[a.protocol] })}</span>}
        {a.target && a.launch === 'manual' && <span className="bind-note"><Icon name="gateway" size={12} />{tx('Sessionary cannot start {agent} with this yet — {link}.', { agent: name, link: <a href={href.gateway}>{t('set it up by hand')}</a> })}</span>}
        {a.target && a.conflict && <span className="bind-warn"><Icon name="warn" size={12} />{t('Its settings set {key}, which wins over how Sessionary starts it.', { key: a.conflict })}</span>}
      </span>
      <span className="bind-pick"><TargetButton value={own} onChange={pick} defaultLabel={inherited ? t('inherits {target}', { target: a.target! }) : t('what {agent} is set to', { agent: name })} placeholder={inherited ? t('inherits {target}', { target: a.target! }) : undefined} protocol={a.protocol} /></span>
    </div>
  )
}

/** a route made for one project or one session */
function NarrowRow({ r, onClear }: { r: CtlRoute; onClear: () => void }) {
  useT()
  return (
    <div className="bind-row">
      <span className={`app-tile at-${r.agent}`}><AgentIcon agent={r.agent} size={22} /></span>
      <span className="bind-text">
        <span className="bind-name">{AGENT_NAME[r.agent] ?? r.agent} · {r.session ? t('one session') : t('one project')}</span>
        <span className="bind-sub mono ellip" title={r.session || r.project}>{r.session ? r.session.slice(r.session.indexOf(':') + 1) : shortPath(r.project)}</span>
      </span>
      <span className="bind-pick row-gap"><span className="mono ellip">{r.target}</span><button className="btn icon sm danger-quiet" onClick={onClear} aria-label={t('Remove this route')}><Icon name="x" size={13} /></button></span>
    </div>
  )
}

/** a routing group: its picture, its members in order, how it chooses */
function GroupDetail({ g }: { g: CtlGroup }) {
  useT()
  const ui = useUi()
  const { state, reload, events } = useControl()
  const [adding, setAdding] = useState<{ left: number; top: number }>()
  if (!state) return null
  const save = async (patch: Partial<Pick<CtlGroup, 'name' | 'mode' | 'members' | 'on'>>) => {
    try { await controlApi.updateGroup(g.id, patch); await reload() } catch (e) { ui.say((e as Error).message) }
  }
  const move = (i: number, d: number) => { const m = [...g.members]; const [x] = m.splice(i, 1); m.splice(i + d, 0, x!); save({ members: m }) }
  const remove = () => ui.confirm({
    title: t('Delete {name}?', { name: g.name }), danger: true, confirm: t('Delete'),
    body: <p>{t('Agents bound to it start on their own default again.')}</p>,
    onConfirm: async () => { try { await controlApi.removeGroup(g.id); await reload(); go(href.routing()) } catch (e) { ui.say((e as Error).message) } },
  })
  const rename = () => ui.prompt({ title: t('Rename group'), label: t('Name'), value: g.name, confirm: t('Rename'), onSubmit: (v) => { if (v.trim()) save({ name: v.trim() }) } })
  const target = `group/${g.id}`
  const mine = events.filter((e) => e.target === target)

  return (
    <section className="pdetail" aria-label={g.name}>
      <header className="pd-head">
        <GroupMark size={44} />
        <div className="grow">
          <h2>{g.name}</h2>
          <div className="pd-sub"><span className="mono">{target}</span> · {t('{n} models', { n: g.members.length })}</div>
        </div>
        <div className="seg sm" role="radiogroup" aria-label={t('How it chooses')}>
          <button role="radio" aria-checked={g.mode === 'order'} className={g.mode === 'order' ? 'on' : ''} onClick={() => save({ mode: 'order' })} title={t('The first model until it cannot answer, then the next')}>{t('In order')}</button>
          <button role="radio" aria-checked={g.mode === 'rotate'} className={g.mode === 'rotate' ? 'on' : ''} onClick={() => save({ mode: 'rotate' })} title={t('Each request starts one model further on')}>{t('In turn')}</button>
        </div>
        <Switch on={g.on} onChange={(on) => save({ on })} label={g.on ? t('Turn this group off') : t('Turn this group on')} />
        <MoreMenu items={[{ label: t('Rename…'), icon: 'edit2', onSelect: rename }, '-', { label: t('Delete group…'), icon: 'trash', danger: true, onSelect: remove }]} />
      </header>

      <Flow state={state} group={g} events={mine} />

      <div className="section-label row-label"><span>{t('Members')}</span><span className="grow" /><span className="r-meta">{g.mode === 'order' ? t('tried top to bottom') : t('each request starts one further down')}</span></div>
      <div className="group-card mlist">
        {!g.members.length && <div className="quiet-note pad">{t('Add the models this group may use.')}</div>}
        {g.members.map((m, i) => {
          const d = describeTarget(state, m)
          const eps = d.provider?.endpoints ?? {}
          return (
            <div key={m} className={`mrow member ${d.missing ? 'off' : ''}`}>
              <span className="mrow-n">{i + 1}</span>
              <ProviderMark provider={d.provider ?? { name: d.sub, preset: '' }} presets={state.presets} size={22} />
              <span className="grow ellip"><span className="mrow-name">{d.title}</span> <span className="mrow-id">{d.sub}</span></span>
              <span className="proto-tags">{(['anthropic', 'chat', 'responses'] as const).map((p) => <span key={p} className={`ptag ${eps[p] ? 'on' : ''}`} title={`${PROTOCOL_NAME[p]}: ${eps[p] ? t('yes') : t('no')}`}>{p === 'anthropic' ? 'A' : p === 'chat' ? 'C' : 'R'}</span>)}</span>
              <button className="btn icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move up')}><Icon name="arrowup" size={13} /></button>
              <button className="btn icon sm" disabled={i === g.members.length - 1} onClick={() => move(i, 1)} aria-label={t('Move down')}><Icon name="arrowdown" size={13} /></button>
              <button className="btn icon sm danger-quiet" onClick={() => save({ members: g.members.filter((x) => x !== m) })} aria-label={t('Remove from group')}><Icon name="x" size={13} /></button>
            </div>
          )
        })}
        <div className="mrow add">
          <button className="btn sm" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAdding(adding ? undefined : { left: r.left, top: r.bottom + 6 }) }}><Icon name="other" size={12} />{t('Add model')}</button>
          <span className="quiet-note">{t('A: Anthropic Messages · C: OpenAI Chat · R: OpenAI Responses — an agent is only sent to members that speak its protocol.')}</span>
        </div>
      </div>
      {adding && <ModelPicker at={adding} groups={false} exclude={g.members} onPick={(m) => { if (m) save({ members: [...g.members, m] }) }} onClose={() => setAdding(undefined)} />}

      <LastDecision state={state} events={mine} />
    </section>
  )
}

const ROW = 46, GAP = 8

/**
 * Agents bound to the group → the gateway → its members, drawn live: the member answering now is solid, one that
 * is resting says until when.
 */
function Flow({ state, group, events }: { state: CtlState; group: CtlGroup; events: RouteEvent[] }) {
  useT()
  const target = `group/${group.id}`
  const agents = state.agents.filter((a) => a.target === target)
  const health = new Map(state.health.map((h) => [h.member, h]))
  const resting = group.members.some((m) => (health.get(m)?.restingUntil ?? 0) > Date.now())
  useTick(resting)
  // who answered last and is still answering, by the latest event per member
  const latest = useMemo(() => {
    const m = new Map<string, RouteEvent>()
    for (const e of events) if (e.member) m.set(e.member, e)
    return m
  }, [events])
  // an agent is being answered while the latest word from that member is still "answering"
  const busyAgent = new Set([...latest.values()].filter((e) => e.phase === 'answering').map((e) => e.agent))
  const left = Math.max(agents.length, 1), right = Math.max(group.members.length, 1)
  const h = Math.max(left, right) * (ROW + GAP) - GAP
  const yL = (i: number) => (h - (left * (ROW + GAP) - GAP)) / 2 + i * (ROW + GAP) + ROW / 2
  const yR = (i: number) => (h - (right * (ROW + GAP) - GAP)) / 2 + i * (ROW + GAP) + ROW / 2
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
  const stats = { requests: new Set(events.map((e) => e.id)).size, rerouted: new Set(events.filter((e) => e.phase === 'failed').map((e) => e.id)).size, errors: events.filter((e) => e.phase === 'refused' || (e.phase === 'failed' && !events.some((x) => x.id === e.id && x.phase === 'answering'))).length }

  return (
    <div className="flow-card">
      <div className="flow" style={{ height: h }}>
        <svg className="flow-lines" viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" aria-hidden="true">
          {agents.map((a, i) => <path key={a.agent} d={curve(220, yL(i), 340, h / 2)} className={busyAgent.has(a.agent) ? 'live' : ''} />)}
          {group.members.map((m, i) => {
            const e = latest.get(m)
            return <path key={m} d={curve(500, h / 2, 560, yR(i))} className={e?.phase === 'answering' ? 'live' : e?.phase === 'failed' ? 'failed' : ''} />
          })}
        </svg>
        <div className="flow-col agents">
          {agents.length ? agents.map((a, i) => (
            <div key={a.agent} className="flow-node" style={{ top: yL(i) - ROW / 2 }}><AgentIcon agent={a.agent} size={18} /><span className="ellip">{AGENT_NAME[a.agent]}</span>{busyAgent.has(a.agent) && <span className="live-dot" />}</div>
          )) : <div className="flow-node ghost" style={{ top: yL(0) - ROW / 2 }}>{t('No agent uses it yet')}</div>}
        </div>
        <div className="flow-hub" style={{ top: h / 2 - 34 }}>
          <img src="/favicon-32.png" alt="" width={20} height={20} />
          <b>{t('Gateway')}</b>
          <span className="pill-quiet">{group.mode === 'rotate' ? t('In turn') : t('In order')}</span>
        </div>
        <div className="flow-col members">
          {group.members.map((m, i) => {
            const d = describeTarget(state, m)
            const hl = health.get(m)
            const e = latest.get(m)
            const rest = hl?.restingUntil && hl.restingUntil > Date.now()
            const status = rest ? restText(hl!.restingUntil!, hl!.why) : e?.phase === 'answering' ? t('answering {agent}…', { agent: AGENT_NAME[e.agent] ?? e.agent }) : e?.phase === 'done' ? t('answered {agent}', { agent: AGENT_NAME[e.agent] ?? e.agent }) : e?.phase === 'failed' ? whyText(e.why) : d.missing ? t('gone') : ''
            return (
              <div key={m} className={`flow-node member ${e?.phase === 'answering' ? 'live' : ''} ${rest ? 'resting' : ''}`} style={{ top: yR(i) - ROW / 2 }}>
                <span className={`fdot ${e?.phase === 'answering' ? 'on' : ''}`} />
                <ProviderMark provider={d.provider ?? { name: d.sub, preset: '' }} presets={state.presets} size={20} />
                <b className="ellip">{d.sub}</b><span className="mono ellip fn-model">{d.title}</span>
                <span className="grow" />
                <span className="fn-status">{status}</span>
              </div>
            )
          })}
          {!group.members.length && <div className="flow-node ghost" style={{ top: yR(0) - ROW / 2 }}>{t('No models yet')}</div>}
        </div>
      </div>
      <div className="flow-stats">
        <span className="grow quiet-note"><span className="live-dot" />{t('Live, as the gateway decides')}</span>
        <div><b>{stats.requests}</b><span>{t('requests')}</span></div>
        <div><b>{stats.rerouted}</b><span>{t('rerouted')}</span></div>
        <div><b>{stats.errors}</b><span>{t('errors your agent saw')}</span></div>
      </div>
    </div>
  )
}

/** the last request through the group, told step by step */
function LastDecision({ state, events }: { state: CtlState; events: RouteEvent[] }) {
  useT()
  const last = events.at(-1)
  if (!last) return null
  const steps = events.filter((e) => e.id === last.id)
  const name = (m?: string) => (m ? describeTarget(state, m).sub + ' · ' + describeTarget(state, m).title : '')
  return (
    <>
      <div className="section-label">{t('How the last request was routed')}</div>
      <ol className="decision group-card">
        <li className="d-ask">{t('{agent} asked for {target} ({protocol}).', { agent: AGENT_NAME[last.agent] ?? last.agent, target: last.target, protocol: PROTOCOL_NAME[last.protocol] })}</li>
        {steps.map((e, i) => (
          e.phase === 'trying' ? <li key={i} className="d-try">{t('Tried {member}.', { member: name(e.member) })}</li>
            : e.phase === 'failed' ? <li key={i} className="d-fail">{t('{member} could not answer ({why}); it rests and the next one is tried.', { member: name(e.member), why: `${e.status || ''} ${whyText(e.why)}`.trim() })}</li>
            : e.phase === 'answering' ? <li key={i} className="d-ok">{t('{member} is answering ({ms} ms to the first byte).', { member: name(e.member), ms: e.ms ?? 0 })}</li>
            : e.phase === 'done' ? <li key={i} className="d-ok">{t('Done in {s} s · {input} in, {output} out.', { s: ((e.ms ?? 0) / 1000).toFixed(1), input: e.input ?? 0, output: e.output ?? 0 })}</li>
            : <li key={i} className="d-fail">{e.why}</li>
        ))}
      </ol>
    </>
  )
}
