import { useEffect, useState } from 'react'
import { t, useT } from './i18n'
import { host } from './api'
import { relAgo } from './format'
import { Icon } from './Icon'
import { useMachines, useSummaries, usable } from './machines'
import { go, href } from './route'
import { CodeBlock, MachineIcon, MoreMenu, PageHead, StateBadge, machineTarget, useUi } from './ui'
import type { Machine, NodeInput, SshHost } from './types'

const EMPTY: NodeInput = { name: '', kind: 'ssh', host: '', user: '', port: '', identity: '', url: '' }

/** Add a machine, or change how one is reached. Opened from the URL, so back closes it. */
function NodeDialog({ editing, onClose }: { editing?: Machine; onClose: () => void }) {
  useT()
  const ui = useUi()
  const { reload } = useMachines()
  const [v, setV] = useState<NodeInput>(() => editing ? { name: editing.name, kind: editing.kind === 'url' ? 'url' : 'ssh', host: editing.host ?? '', user: editing.user ?? '', port: editing.port ? String(editing.port) : '', identity: editing.identity ?? '', url: editing.url ?? '' } : EMPTY)
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  useEffect(() => { host.sshHosts().then(setHosts, () => {}) }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])
  const set = (k: keyof NodeInput) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value })
  // a host from the ssh config is stored by name only: ssh applies its user, port and key itself
  const pick = (h: SshHost) => setV({ ...v, kind: 'ssh', host: h.alias, user: '', port: '', identity: '', name: v.name || h.alias })
  const ready = v.name.trim() && (v.kind === 'ssh' ? v.host?.trim() : v.url?.trim())

  const submit = async (connect: boolean) => {
    setBusy(true); setError(undefined)
    try {
      const n = editing ? await host.updateNode(editing.id, v) : await host.addNode(v)
      await reload()
      if (connect) { host.connectNode(n.id).catch((e) => ui.say(t('Not connected: {error}', { error: (e as Error).message }))).finally(reload); go(href.machine(n.id)) }
      else onClose()
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const text = (k: keyof NodeInput, label: string, placeholder: string, narrow = false) => (
    <label className={`form-row ${narrow ? 'narrow' : ''}`}>
      <span>{label}</span>
      <span className="field"><input value={v[k] ?? ''} onChange={set(k)} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" /></span>
    </label>
  )

  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <form className="sheet node-sheet pop-in" role="dialog" aria-label={editing ? t('Edit Node') : t('Add Node')} onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ready && !busy) submit(true) }}>
        <h2>{editing ? t('Edit Node') : t('Add Node')}</h2>
        <p className="quiet-note flush">{editing ? t('Changing the host or user discards the copy of the old machine; it is copied again on the next connection.') : t('Pick a machine you can reach over SSH. Only this description is saved — SSH uses your own keys, and no password or token is stored.')}</p>

        <div className="node-form">
          {text('name', t('Name'), t('e.g. US VPS'))}
          <div className="form-row">
            <span>{t('Connection')}</span>
            <span className="seg" role="radiogroup" aria-label={t('Connection')}>
              <button type="button" role="radio" aria-checked={v.kind === 'ssh'} className={v.kind === 'ssh' ? 'on' : ''} onClick={() => setV({ ...v, kind: 'ssh' })}>{t('SSH')}</button>
              <button type="button" role="radio" aria-checked={v.kind === 'url'} className={v.kind === 'url' ? 'on' : ''} onClick={() => setV({ ...v, kind: 'url' })}>{t('Address')}</button>
            </span>
          </div>
          {v.kind === 'ssh' ? (
            <>
              {text('host', t('Host'), t('vps.example.com or an ssh_config alias'))}
              {hosts.length > 0 && (
                <div className="form-row"><span>{t('From your SSH config')}</span>
                  <span className="host-chips">{hosts.map((h) => <button key={h.alias} type="button" className={`chip link ${v.host === h.alias ? 'on' : ''}`} onClick={() => pick(h)} title={[h.user && `${h.user}@`, h.hostName].filter(Boolean).join('')}><Icon name="server" size={12} />{h.alias}</button>)}</span>
                </div>
              )}
              {text('user', t('User'), 'root', true)}
              {text('port', t('SSH port'), '22', true)}
              {text('identity', t('Identity file (optional)'), '~/.ssh/id_ed25519')}
            </>
          ) : (
            <>
              {text('url', t('Address'), 'http://127.0.0.1:4888')}
              <p className="form-hint">{t("An address that already reaches the node's Sessionary, for example a tunnel you opened yourself.")}</p>
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        {v.kind === 'ssh' && (
          <div className="node-explain">
            <p>{t("It reads the node's agent history (Claude Code, OpenCode, Pi, Hermes) over SSH and keeps a copy on this computer. Nothing is installed on the node and nothing is written to it.")}</p>
            <button type="button" className="link" onClick={() => setHelp(!help)}>{help ? t('Hide requirements') : t('What does the node need?')}</button>
            {help && (
              <div className="node-help">
                <p className="muted">{t('Key-based SSH login without a password prompt, and the tar and find commands. Connect once by hand so the host key is trusted:')}</p>
                <CodeBlock code="ssh user@your-vps true" />
                <p className="muted">{t('If a connection fails, run this on the node to see what is missing:')}</p>
                <CodeBlock code={"command -v tar find && find . -maxdepth 0 -printf ''"} />
              </div>
            )}
          </div>
        )}

        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
          <span className="grow" />
          <button type="button" className="btn" disabled={!ready || busy} onClick={() => submit(false)}>{editing ? t('Save') : t('Add Node')}</button>
          <button type="submit" className="btn primary" disabled={!ready || busy}>{editing ? t('Save and Connect') : t('Add and Connect')}</button>
        </div>
      </form>
    </div>
  )
}

/** Manage the machines Sessionary can see: add, edit, connect, remove — all from one table. */
export function NodesPage({ add, edit }: { add: boolean; edit?: string }) {
  useT()
  const ui = useUi()
  const { machines, reload } = useMachines()
  const sums = useSummaries(machines)
  const editing = edit ? machines.find((m) => m.id === edit) : undefined
  const act = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { ui.say((e as Error).message) } finally { reload() } }
  const remove = (m: Machine) => ui.confirm({
    title: t('Remove node?'), danger: true, confirm: t('Remove'),
    body: <><p><b>{m.name}</b></p><p>{t('Sessionary forgets how to reach this node and deletes its local copy. Nothing on the machine itself is changed.')}</p></>,
    onConfirm: () => act(() => host.removeNode(m.id)),
  })
  return (
    <div className="page">
      <div className="page-inner wide enter">
        <PageHead crumbs={[{ label: t('Nodes') }]}>
          <button className="btn primary" onClick={() => go(href.nodes({ add: '1' }))}><Icon name="other" size={14} />{t('Add Node')}</button>
        </PageHead>
        <h1 className="page-title">{t('Nodes')}</h1>
        <p className="page-lede">{t('Other computers whose agents you want to see here, such as a VPS running Claude Code, Hermes or Pi. Sessionary reads them over SSH — nothing is installed on them.')}</p>

        <div className="group-card node-table">
          <div className="nt-head"><span>{t('Name')}</span><span>{t('Address')}</span><span>{t('Status')}</span><span>{t('Agents')}</span><span>{t('Last online')}</span><span /></div>
          {machines.map((m) => {
            const s = sums[m.id]
            return (
              <div key={m.id} className="nt-row">
                <a className="nt-name" href={href.machine(m.id)}><MachineIcon machine={m} size={32} /><span className="t-main"><span className="r-title">{m.name}</span><span className="r-meta">{m.kind === 'local' ? t('This computer') : m.kind === 'ssh' ? 'SSH' : t('Address')}</span></span></a>
                <span className="ellip mono nt-addr">{m.kind === 'local' ? '127.0.0.1' : machineTarget(m)}</span>
                <span><StateBadge state={m.state} /></span>
                <span>{usable(m) && s ? s.agents.filter((a) => a.sessions > 0).length : '—'}</span>
                <span className="r-meta">{m.kind === 'local' ? t('now') : m.sync?.lastSync ? relAgo(m.sync.lastSync) : '—'}</span>
                <span className="nt-act">
                  {m.kind !== 'local' && (m.state === 'online' || m.state === 'connecting'
                    ? <button className="btn sm" onClick={() => act(() => host.syncNode(m.id))} disabled={m.state === 'connecting' || m.kind !== 'ssh'}><Icon name="refresh" size={12} />{t('Refresh')}</button>
                    : <button className="btn sm" onClick={() => act(() => host.connectNode(m.id))}><Icon name="plug" size={12} />{m.state === 'error' ? t('Reconnect') : t('Connect')}</button>)}
                  <MoreMenu items={[
                    { label: t('Open'), icon: 'chev', onSelect: () => go(href.machine(m.id)) },
                    ...(m.kind === 'local' ? [] : [
                      { label: t('Edit'), icon: 'edit2', onSelect: () => go(href.nodes({ edit: m.id })) },
                      ...(m.state === 'online' || m.state === 'connecting' ? [{ label: t('Disconnect'), icon: 'unplug', onSelect: () => act(() => host.disconnectNode(m.id)) }] : []),
                      '-' as const,
                      { label: t('Remove Node…'), icon: 'trash', danger: true, onSelect: () => remove(m) },
                    ]),
                  ]} />
                </span>
                {m.state === 'error' && m.error && <span className="nt-err">{m.error}</span>}
              </div>
            )
          })}
        </div>
        <p className="quiet-note node-note">{t('Nodes that fail to connect show the reason under their row.')}</p>
      </div>
      {(add || (edit && editing)) && <NodeDialog key={editing?.id ?? 'new'} editing={editing} onClose={() => go(href.nodes())} />}
    </div>
  )
}
