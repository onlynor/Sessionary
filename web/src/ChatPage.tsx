import { useEffect, useMemo, useRef } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { ChatComposer } from './ChatComposer'
import { useLiveChat } from './chat'
import { agentName } from './Conversation'
import { Icon } from './Icon'
import { LiveThread, toTurns } from './LiveThread'
import { useMachine } from './machines'
import { go, href, type Route } from './route'
import { Crumbs, useUi } from './ui'

/**
 * A chat that has no session yet: the agent is started in a directory and the first message creates its history.
 * Once that history shows up in the machine's list the page hands over to the session page, which carries the same
 * live chat on.
 */
export function ChatPage({ route }: { route: Extract<Route, { page: 'chat' }> }) {
  useT()
  const { machine, sessions } = useMachine()
  const ui = useUi()
  const chat = useLiveChat({ machine: machine.id, agent: '', chatId: route.id, enabled: false, say: ui.say })
  const summary = chat.chat
  const agent = summary?.agent ?? ''
  const turns = useMemo(() => toTurns(chat.view.items), [chat.view.items])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.view.seq])

  // the first turn is done and its history is indexed: carry on in the session itself
  // the summary is from when the page opened; the stream knows the session as soon as the agent says what it is
  const native = chat.view.info.nativeId ?? chat.view.info.sessionId
  const key = summary?.sessionKey ?? (native && agent ? `${agent}:${native}` : undefined)
  const idle = chat.view.state === 'idle'
  const indexed = !!key && sessions.some((s) => s.id === key)
  useEffect(() => { if (idle && indexed && key) go(href.session(machine.id, key)) }, [idle, indexed, key, machine.id])

  const dir = summary?.cwd
  const project = dir?.split('/').filter(Boolean).pop()
  if (chat.loading) return <main className="content"><div className="page"><div className="page-inner"><div className="empty-state"><span className="spinner" /></div></div></div></main>
  if (!summary) return (
    <main className="content"><div className="page"><div className="page-inner"><div className="empty-state"><b>{t('This chat is gone')}</b>{t('The server no longer holds it. Start a new one from the agent’s page.')}<button className="btn" onClick={() => go(href.machine(machine.id))}>{t('Back to agents')}</button></div></div></div></main>
  )
  return (
    <main className="content">
      <header className="toolbar edge">
        <Crumbs items={[{ label: machine.name, href: href.machine(machine.id) }, { label: agentName(agent), href: href.agent(machine.id, agent) }, { label: t('New chat') }]} />
        <div className="tb-actions tb-group">
          <button className="tb-btn" onClick={async () => { await chat.close(); go(href.agent(machine.id, agent)) }} title={t('End this chat')} aria-label={t('End this chat')}><Icon name="x" /></button>
        </div>
      </header>
      <div className="scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 240 }}>
        <div className="thread">
          <header className="doc-head">
            <div className="doc-title-row"><h1 className="doc-title">{t('New chat with {agent}', { agent: agentName(agent) })}</h1></div>
            <div className="doc-meta">
              <span><AgentIcon agent={agent} size={14} />{agentName(agent)}</span>
              {project && <><span className="sep">·</span><span title={dir}><Icon name="folder" size={14} />{project}</span></>}
              {chat.view.info.model && <><span className="sep">·</span><span>{chat.view.info.models?.find((m) => m.id === chat.view.info.model)?.label ?? chat.view.info.model}</span></>}
              {chat.view.info.version && <><span className="sep">·</span><span>v{chat.view.info.version}</span></>}
            </div>
          </header>
          {turns.length === 0 && <div className="empty-note chat-empty">{t('Say something. {agent} runs in {dir} and keeps going between messages.', { agent: agentName(agent), dir: dir ?? '' })}</div>}
          <LiveThread turns={turns} agent={agent} cwd={dir} onRespond={chat.respond} onAnswer={chat.answer} />
        </div>
      </div>
      <ChatComposer agentName={agentName(agent)} view={chat.view} error={chat.error} onWarm={() => {}}
        onSend={async (text, images) => { stick.current = true; return chat.send(text, images) }}
        onInterrupt={() => { chat.interrupt() }} onModel={chat.setModel} onMode={chat.setMode} onEffort={chat.setEffort} />
    </main>
  )
}
