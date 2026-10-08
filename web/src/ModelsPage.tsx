import { useEffect, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { controlApi } from './api'
import { AgentIcon } from './AgentIcon'
import { AGENT_NAME, PROTOCOL_NAME, ProviderMark, Switch, hostOf, useControl } from './control'
import { relAgo } from './format'
import { Icon } from './Icon'
import { go, href } from './route'
import { MoreMenu, PageHead, useUi } from './ui'
import type { CtlPreset, CtlProvider, Protocol } from './types'

const PROTOCOLS: Protocol[] = ['anthropic', 'chat', 'responses']

/**
 * Models: the providers this computer can reach and the models each one serves. A list on the left, the chosen
 * provider on the right (as in System Settings); adding one is "pick a preset, paste a key".
 */
export function ModelsPage({ provider: chosen, add }: { provider?: string; add: boolean }) {
  useT()
  const { state, reload, error } = useControl()
  const [magpie, setMagpie] = useState<{ models: number } | null>(null)
  useEffect(() => { controlApi.magpie().then(setMagpie, () => {}) }, [])
  const providers = state?.providers ?? []
  const current = providers.find((p) => p.id === chosen) ?? providers[0]
  const hasMagpie = providers.some((p) => p.preset === 'magpie')

  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Model Control') }, { label: t('Models') }]}>
          <button className="btn primary" onClick={() => go(href.models(current?.id, { add: '1' }))}><Icon name="other" size={14} />{t('Add provider')}</button>
        </PageHead>
        <h1>{t('Models')}</h1>
        <p className="page-lede">{t('The providers this computer can reach, and the models each one serves. Agents use them through routing groups and the gateway.')}</p>

        {magpie && !hasMagpie && (
          <div className="ctl-banner">
            <ProviderMark provider={{ name: 'Magpie', hue: 210 }} size={30} />
            <span className="grow"><b>{t('Magpie is running on this computer')}</b><span>{t('Add it as one provider and everything it routes ({n} models) is available here too. Magpie keeps working as before.', { n: magpie.models })}</span></span>
            <AddMagpie />
          </div>
        )}

        {error && !state ? <div className="form-error">{error}</div>
          : !state ? <div className="sk-line" />
          : !providers.length ? (
            <div className="empty-state">
              <span className="tile"><Icon name="models" size={28} stroke={1.5} /></span>
              <b>{t('No providers yet')}</b>
              <span className="es-sub">{t('Add the API keys you already have — DeepSeek, Kimi, OpenRouter, a local Ollama… Their models show up here.')}</span>
              <button className="btn primary" onClick={() => go(href.models(undefined, { add: '1' }))}><Icon name="other" size={14} />{t('Add provider')}</button>
            </div>
          ) : (
            <div className="ctl-split">
              <div className="plist group-card" role="list">
                {providers.map((p) => {
                  // the agents routed to it on any machine (a route for a whole machine names no agent)
                  const uses = (target: string) => target.startsWith(p.id + '/') || (target.startsWith('group/') && !!state.groups.find((g) => `group/${g.id}` === target)?.members.some((m) => m.startsWith(p.id + '/')))
                  const users = [...new Set(state.routes.filter((r) => r.agent && uses(r.target)).map((r) => r.agent))].map((agent) => ({ agent }))
                  return (
                    <a key={p.id} role="listitem" className={`lrow ${p.id === current?.id ? 'on' : ''} ${p.on ? '' : 'off'}`} href={href.models(p.id)} aria-current={p.id === current?.id ? 'true' : undefined}>
                      <ProviderMark provider={p} presets={state.presets} size={30} />
                      <span className="lrow-text">
                        <span className="lrow-name">{p.name}</span>
                        <span className="lrow-sub">{hostOf(Object.values(p.endpoints)[0])} · {t('{n} models', { n: p.models.filter((m) => m.on).length })}</span>
                      </span>
                      {users.length > 0 && <span className="lrow-users">{users.slice(0, 3).map((a) => <span key={a.agent} className="agent-dot" title={AGENT_NAME[a.agent]}><AgentIcon agent={a.agent} size={11} /></span>)}</span>}
                      <span className={`sdot ${p.on ? (p.hasKey || presetOf(state.presets, p)?.keyless ? 'sd-online' : 'sd-error') : 'sd-offline'}`} />
                    </a>
                  )
                })}
              </div>
              {current && <ProviderDetail key={current.id} p={current} onChanged={reload} />}
            </div>
          )}
      </div>
      {add && state && <AddProvider presets={state.presets} onClose={() => go(href.models(chosen))} onAdded={async (id) => { await reload(); go(href.models(id)) }} />}
    </div>
  )
}

const presetOf = (presets: CtlPreset[], p: CtlProvider) => presets.find((x) => x.id === p.preset)

function AddMagpie() {
  useT()
  const ui = useUi()
  const { reload } = useControl()
  const [busy, setBusy] = useState(false)
  return (
    <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true)
      try { const r = await controlApi.addProvider({ preset: 'magpie' }); await reload(); go(href.models(r.provider.id)); if (r.warning) ui.say(r.warning) } catch (e) { ui.say((e as Error).message) } finally { setBusy(false) }
    }}><Icon name="other" size={13} />{busy ? t('Adding…') : t('Add Magpie')}</button>
  )
}

/** one provider: its addresses, its key, its models */
function ProviderDetail({ p, onChanged }: { p: CtlProvider; onChanged: () => Promise<void> }) {
  useT()
  const ui = useUi()
  const { state } = useControl()
  const [busy, setBusy] = useState<string>()
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const preset = state ? presetOf(state.presets, p) : undefined

  const save = async (patch: Parameters<typeof controlApi.updateProvider>[1], what = 'save') => {
    setBusy(what)
    try { await controlApi.updateProvider(p.id, patch); await onChanged() } catch (e) { ui.say((e as Error).message) } finally { setBusy(undefined) }
  }
  const refresh = async () => {
    setBusy('refresh')
    try { const n = await controlApi.refresh(p.id); await onChanged(); ui.say(t('{n} models from {name}', { n: n.models.length, name: p.name })) } catch (e) { ui.say((e as Error).message) } finally { setBusy(undefined) }
  }
  const remove = () => ui.confirm({
    title: t('Remove {name}?', { name: p.name }), danger: true, confirm: t('Remove'),
    body: <p>{t('Its models leave every routing group, and agents bound to one of them start on their own default again. Nothing outside Sessionary changes.')}</p>,
    onConfirm: async () => { try { await controlApi.removeProvider(p.id); await onChanged(); go(href.models()) } catch (e) { ui.say((e as Error).message) } },
  })
  const setKey = () => ui.prompt({
    title: t('Replace the key'), label: t('API key, or env:NAME to read it from the environment'), value: '', confirm: t('Save'), placeholder: 'sk-…',
    onSubmit: (v) => { if (v.trim()) save({ key: v.trim() }, 'key') },
  })
  const rename = () => ui.prompt({ title: t('Rename provider'), label: t('Name'), value: p.name, confirm: t('Rename'), onSubmit: (v) => { if (v.trim()) save({ name: v.trim() }) } })

  const models = p.models.filter((m) => !filter || `${m.id} ${m.name ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  const onCount = p.models.filter((m) => m.on).length
  const usedIn = useMemo(() => (state?.groups ?? []).filter((g) => g.members.some((m) => m.startsWith(p.id + '/'))), [state, p.id])
  const setModel = (id: string, on: boolean) => save({ models: p.models.map((m) => ({ id: m.id, on: m.id === id ? on : m.on })) }, 'models')
  const setAll = (on: boolean) => save({ models: p.models.map((m) => ({ id: m.id, on: filter && !models.includes(m) ? m.on : on })) }, 'models')
  const addManual = () => {
    const id = manual.trim()
    if (!id || p.models.some((m) => m.id === id)) return
    save({ models: [...p.models.map((m) => ({ id: m.id, on: m.on })), { id, on: true }] }, 'models').then(() => setManual(''))
  }

  return (
    <section className="pdetail" aria-label={p.name}>
      <header className="pd-head">
        <ProviderMark provider={p} presets={state?.presets} size={44} />
        <div className="grow">
          <h2>{p.name}</h2>
          <div className="pd-sub">{preset?.kind === 'gateway' ? t('A gateway on this computer') : preset?.kind === 'local' ? t('A model server on this computer') : preset?.kind === 'custom' ? t('Custom endpoint') : t('Vendor API')} · <span className="mono">{p.id}</span></div>
        </div>
        <Switch on={p.on} onChange={(on) => save({ on })} label={p.on ? t('Turn this provider off') : t('Turn this provider on')} />
        <MoreMenu items={[
          { label: t('Rename…'), icon: 'edit2', onSelect: rename },
          ...(preset?.console ? [{ label: t('Open the key console'), icon: 'external', onSelect: () => window.open(preset.console, '_blank', 'noopener') }] : []),
          '-',
          { label: t('Remove provider…'), icon: 'trash', danger: true, onSelect: remove },
        ]} />
      </header>

      <div className="section-label">{t('Connection')}</div>
      <div className="group-card form-card">
        {PROTOCOLS.map((proto) => (
          <EndpointRow key={proto} proto={proto} value={p.endpoints[proto] ?? ''} onSave={(v) => {
            const next = { ...p.endpoints, [proto]: v }
            if (!v) delete next[proto]
            if (!Object.values(next).some(Boolean)) { ui.say(t('Give the provider at least one endpoint.')); return }
            save({ endpoints: next })
          }} />
        ))}
        <div className="form-row">
          <span>{t('API key')}</span>
          <span className="key-row">
            {p.hasKey ? <span className="mono key-mask">{p.key}</span> : <span className="quiet">{preset?.keyless ? t('Not needed') : t('Not set')}</span>}
            <span className="grow" />
            <button className="btn sm" onClick={setKey} disabled={busy === 'key'}><Icon name="key" size={12} />{p.hasKey ? t('Replace…') : t('Set…')}</button>
          </span>
        </div>
      </div>
      <p className="form-hint flat">{t('Only the protocols with an address are offered to agents. Claude Code needs Anthropic Messages, Codex needs OpenAI Responses, OpenCode, Pi and Hermes use OpenAI Chat.')}</p>

      <div className="section-label pd-models-head">
        <span>{t('Models')} <span className="r-meta">{t('{on} of {n} on', { on: onCount, n: p.models.length })}</span></span>
        <span className="grow" />
        {p.refreshedAt && <span className="r-meta">{t('read {when}', { when: relAgo(p.refreshedAt) })}</span>}
        <button className="btn sm" onClick={refresh} disabled={!!busy}><Icon name="refresh" size={12} />{busy === 'refresh' ? t('Reading…') : t('Read from provider')}</button>
      </div>
      <div className="group-card mlist">
        {p.models.length > 8 && (
          <div className="mlist-tools">
            <label className="field grow"><Icon name="search" size={13} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Filter models')} /></label>
            <button className="btn sm" onClick={() => setAll(true)} disabled={!!busy}>{t('All on')}</button>
            <button className="btn sm" onClick={() => setAll(false)} disabled={!!busy}>{t('All off')}</button>
          </div>
        )}
        {!p.models.length && <div className="quiet-note pad">{t('No models yet. Read the list from the provider, or add one by name below.')}</div>}
        {models.map((m) => (
          <div key={m.id} className={`mrow ${m.on ? '' : 'off'}`}>
            <span className="grow ellip"><span className="mrow-name">{m.name ?? m.id}</span>{m.name && m.name !== m.id && <span className="mono mrow-id">{m.id}</span>}{m.manual && <span className="badge">{t('added by hand')}</span>}</span>
            {m.context && <span className="r-meta">{fmtCtx(m.context)}</span>}
            <Switch on={m.on} onChange={(on) => setModel(m.id, on)} label={m.on ? t('Hide this model from agents') : t('Offer this model to agents')} disabled={busy === 'models'} />
          </div>
        ))}
        <form className="mrow add" onSubmit={(e) => { e.preventDefault(); addManual() }}>
          <label className="field grow"><Icon name="other" size={13} /><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t('Add a model by its id, e.g. deepseek-chat')} aria-label={t('Add a model by its id')} /></label>
          <button className="btn sm" disabled={!manual.trim() || !!busy}>{t('Add')}</button>
        </form>
      </div>

      {usedIn.length > 0 && (
        <>
          <div className="section-label">{t('Used in')}</div>
          <div className="chips">{usedIn.map((g) => <a key={g.id} className="chip link" href={href.routing(g.id)}><Icon name="route" size={12} /><b>{g.name}</b></a>)}</div>
        </>
      )}
    </section>
  )
}

const fmtCtx = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`)

/** one protocol's address, edited in place; saved on Enter or when the field is left */
function EndpointRow({ proto, value, onSave }: { proto: Protocol; value: string; onSave: (v: string) => void }) {
  useT()
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => { if (v.trim() !== value) onSave(v.trim()) }
  return (
    <label className="form-row">
      <span>{PROTOCOL_NAME[proto]}</span>
      <span className="field"><input className="mono" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value) }} placeholder={t('not offered')} spellCheck={false} /></span>
    </label>
  )
}

/** the sheet for adding a provider: a preset, then its key */
function AddProvider({ presets, onClose, onAdded }: { presets: CtlPreset[]; onClose: () => void; onAdded: (id: string) => void }) {
  useT()
  const ui = useUi()
  const [preset, setPreset] = useState<CtlPreset>()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [eps, setEps] = useState<Partial<Record<Protocol, string>>>({})
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', k); return () => removeEventListener('keydown', k) }, [onClose])
  const choose = (p: CtlPreset) => { setPreset(p); setName(p.kind === 'custom' ? '' : p.name); setEps({ ...p.endpoints }); setEdit(p.kind === 'custom'); setKey(p.key ?? ''); setErr(undefined) }
  const submit = async () => {
    if (!preset) return
    setBusy(true); setErr(undefined)
    try {
      const r = await controlApi.addProvider({ preset: preset.id, name: name.trim() || undefined, key: key.trim() || undefined, endpoints: eps })
      if (r.warning) ui.say(t('Added, but the model list could not be read: {why}', { why: r.warning }))
      onAdded(r.provider.id)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const kinds: [CtlPreset['kind'], string][] = [['vendor', t('Vendors')], ['local', t('On this computer')], ['gateway', t('Gateways')], ['custom', t('Any compatible endpoint')]]

  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <div className="sheet add-sheet pop-in" role="dialog" aria-label={t('Add provider')} onMouseDown={(e) => e.stopPropagation()}>
        {!preset ? (
          <>
            <h2>{t('Add provider')}</h2>
            <p className="sheet-lede">{t('Pick where the models come from. The model list is read from the provider itself.')}</p>
            {kinds.map(([kind, label]) => (
              <div key={kind}>
                <div className="menu-label">{label}</div>
                <div className="preset-grid">
                  {presets.filter((p) => p.kind === kind).map((p) => (
                    <button key={p.id} className="preset" onClick={() => choose(p)}><ProviderMark provider={p} size={26} /><span className="ellip">{p.name}</span></button>
                  ))}
                </div>
              </div>
            ))}
            <div className="form-actions"><span className="grow" /><button className="btn" onClick={onClose}>{t('Cancel')}</button></div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit() }}>
            <div className="add-head"><button type="button" className="btn icon" onClick={() => setPreset(undefined)} aria-label={t('Back')}><Icon name="chev" size={14} /></button><ProviderMark provider={preset} size={32} /><h2>{preset.kind === 'custom' ? preset.name : preset.name}</h2></div>
            {preset.kind === 'custom' && (
              <label className="form-row"><span>{t('Name')}</span><span className="field"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('My relay')} /></span></label>
            )}
            {!preset.keyless && (
              <label className="form-row"><span>{t('API key')}</span><span className="field"><input autoFocus={preset.kind !== 'custom'} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset.key ? preset.key : 'sk-…'} autoComplete="off" spellCheck={false} /></span></label>
            )}
            {preset.console && <p className="form-hint"><a className="more" href={preset.console} target="_blank" rel="noreferrer">{t('Get a key from {name}', { name: preset.name })} <Icon name="external" size={11} /></a></p>}
            {edit ? PROTOCOLS.map((proto) => (
              <label key={proto} className="form-row"><span>{PROTOCOL_NAME[proto]}</span><span className="field"><input className="mono" value={eps[proto] ?? ''} onChange={(e) => setEps({ ...eps, [proto]: e.target.value })} placeholder={proto === 'anthropic' ? 'https://example.com/anthropic' : 'https://example.com/v1'} spellCheck={false} /></span></label>
            )) : (
              <p className="form-hint">{Object.entries(eps).filter(([, v]) => v).map(([k, v]) => <span key={k} className="ep-line"><b>{PROTOCOL_NAME[k as Protocol]}</b> <span className="mono">{v}</span></span>)}<button type="button" className="more" onClick={() => setEdit(true)}>{t('Change addresses')}</button></p>
            )}
            {err && <div className="form-error">{err}</div>}
            <div className="form-actions">
              <span className="quiet-note grow">{t('Keys stay in Sessionary’s own database on this computer.')}</span>
              <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
              <button className="btn primary" disabled={busy || (!preset.keyless && !key.trim() && !preset.key)}>{busy ? t('Adding…') : t('Add')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
