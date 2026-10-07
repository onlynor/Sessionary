import { useEffect, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { chatApi } from './api'
import { launchTerminal } from './actions'
import { canChat } from './chat'
import { Icon } from './Icon'
import { useInstalled, useMachine } from './machines'
import { projectsOf } from './MachineTabs'
import { go, href } from './route'
import { ProjectMark, shortPath, useUi } from './ui'
import { relAgo } from './format'

/**
 * A new session is a chat: pick the agent, pick where it works, and the page goes straight to Sessionary's chat while
 * the agent starts behind it (the server answers at once). The agent's own terminal UI is never the way in; running
 * it in a terminal stays available as a deliberate choice.
 *
 * Anything on the page starts one with `startNewSession`; when both the agent and the folder are already known the
 * sheet is skipped.
 */
export function startNewSession(o: { agent?: string; cwd?: string } = {}) {
  dispatchEvent(new CustomEvent('sessionary:new-session', { detail: o }))
}

export function NewSessionHost() {
  useT()
  const { machine } = useMachine()
  const ui = useUi()
  const [ask, setAsk] = useState<{ agent?: string; cwd?: string }>()

  // a chat in a folder: the page moves on at once, the agent comes up behind it
  const begin = async (agent: string, cwd?: string) => {
    if (!canChat(agent, machine.kind)) { launchTerminal(ui.say, { machine: machine.id, kind: 'new', agent, cwd }); return true }
    try {
      const c = await chatApi.open({ machine: machine.id, agent, cwd })
      go(href.chat(machine.id, c.id))
      return true
    } catch (e) { ui.say((e as Error).message); return false }
  }

  useEffect(() => {
    const on = (e: Event) => {
      const o = (e as CustomEvent<{ agent?: string; cwd?: string }>).detail ?? {}
      if (o.agent && o.cwd) begin(o.agent, o.cwd)
      else setAsk(o)
    }
    addEventListener('sessionary:new-session', on)
    return () => removeEventListener('sessionary:new-session', on)
  }, [machine.id, machine.kind])

  if (!ask) return null
  return <NewSessionSheet agent={ask.agent} onClose={() => setAsk(undefined)} onStart={async (a, cwd) => { if (await begin(a, cwd)) setAsk(undefined) }}
    onTerminal={(a, cwd) => { setAsk(undefined); launchTerminal(ui.say, { machine: machine.id, kind: 'new', agent: a, cwd }) }} />
}

function NewSessionSheet({ agent: given, onClose, onStart, onTerminal }: {
  agent?: string; onClose: () => void; onStart: (agent: string, cwd?: string) => Promise<void>; onTerminal: (agent: string, cwd?: string) => void
}) {
  useT()
  const { machine, agents, sessions } = useMachine()
  const { installed } = useInstalled(machine)
  const [agent, setAgent] = useState(given)
  const [q, setQ] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', k); return () => removeEventListener('keydown', k) }, [onClose])

  // the agents that can be started here: on PATH (once known) and able to create a session
  const startable = agents.filter((a) => a.canCreate && (!installed || installed.some((i) => i.id === a.id && i.installed)))
  const label = agents.find((a) => a.id === agent)?.label ?? agent ?? ''
  // where this agent worked most recently first, then everything else this machine has seen
  const projects = useMemo(() => {
    const all = projectsOf(sessions).filter((r) => !r.missing && r.dir)
    const mine = new Set(projectsOf(sessions.filter((s) => s.agent === agent)).map((r) => r.key))
    return [...all.filter((r) => mine.has(r.key)), ...all.filter((r) => !mine.has(r.key))]
  }, [sessions, agent])
  const needle = q.trim().toLowerCase()
  const shown = projects.filter((r) => !needle || `${r.name} ${r.dir}`.toLowerCase().includes(needle)).slice(0, 40)
  const start = async (cwd?: string) => { if (!agent || busy) return; setBusy(true); try { await onStart(agent, cwd) } finally { setBusy(false) } }

  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <div className="sheet ns-sheet pop-in" role="dialog" aria-label={t('New session')} onMouseDown={(e) => e.stopPropagation()}>
        {!agent ? (
          <>
            <h2>{t('New session')}</h2>
            <p className="sheet-lede">{t('Which agent should it be?')}</p>
            <div className="ns-agents">
              {startable.map((a) => (
                <button key={a.id} className="ns-agent" onClick={() => setAgent(a.id)}>
                  <span className={`sx-tile at-${a.id}`}><AgentIcon agent={a.id} size={20} /></span>
                  <span className="grow ellip"><b>{a.label}</b></span>
                  <Icon name="chev" size={13} />
                </button>
              ))}
              {!startable.length && <p className="quiet-note">{t('No agent that can start a session was found on this machine.')}</p>}
            </div>
          </>
        ) : (
          <>
            <div className="ns-head">
              {!given && <button className="btn icon ghost" onClick={() => setAgent(undefined)} aria-label={t('Back')}><Icon name="chev" size={14} /></button>}
              <span className={`sx-tile at-${agent}`}><AgentIcon agent={agent} size={20} /></span>
              <div className="grow">
                <h2>{t('New {agent} session', { agent: label })}</h2>
                <p className="sheet-lede flush">{t('Where should it work? The conversation opens right away.')}</p>
              </div>
            </div>
            <label className="field ns-search"><Icon name="search" size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search projects')} aria-label={t('Search projects')} spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) start(shown[0].dir) }} /></label>
            <div className="ns-list" role="listbox" aria-label={t('Projects')}>
              {shown.map((r) => (
                <button key={r.key} role="option" aria-selected={false} className="ns-project" disabled={busy} onClick={() => start(r.dir)}>
                  <ProjectMark name={r.name} id={r.key} size={30} />
                  <span className="grow ns-project-text"><b className="ellip">{r.name}</b><span className="ellip">{shortPath(r.dir)}</span></span>
                  <span className="ns-when">{relAgo(r.last)}</span>
                </button>
              ))}
              {!shown.length && <p className="quiet-note pad">{needle ? t('No project matches.') : t('No projects yet. A project appears when an agent works in a directory.')}</p>}
            </div>
            <form className="ns-other" onSubmit={(e) => { e.preventDefault(); if (path.trim()) start(path.trim()) }}>
              <label className="field grow"><Icon name="folder" size={14} /><input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('Another folder, e.g. ~/code/app')} aria-label={t('Another folder')} spellCheck={false} /></label>
              <button className="btn primary" disabled={!path.trim() || busy}>{busy ? <span className="spinner" /> : t('Start')}</button>
            </form>
            <div className="ns-foot">
              <button className="more" onClick={() => onTerminal(agent, path.trim() || undefined)} title={t('Its own terminal interface, in the folder typed above (or the home folder)')}>
                <Icon name="terminal" size={12} /> {t('Run {agent} in a terminal instead', { agent: label })}
              </button>
              <span className="grow" />
              <button className="btn" onClick={onClose}>{t('Cancel')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
