import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { Icon } from './Icon'
import type { Run } from './types'

// hints are English keys; translated where shown
const READ_ONLY_HINT: Record<string, string> = {
  'claude-code': 'Claude Code plan mode: it can read and search, but not edit files or run commands.',
  opencode: 'OpenCode’s plan agent: read-only, no file edits.',
  pi: 'Pi with only read, grep, find and ls tools.',
}
const WRITE_HINT: Record<string, string> = {
  'claude-code': 'acceptEdits: file edits are applied; shell commands still need approval and are refused.',
  opencode: 'OpenCode’s build agent with its normal permissions.',
  pi: 'All of Pi’s tools, including bash, edit and write.',
}

function elapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Continue this session: the prompt goes to the agent's own CLI, which appends to the same session.
 * Read-only by default; write access is opted into per session and resets when you leave it.
 */
export function Composer({ agent, agentName, run, disabled, onSend, onStop }: {
  agent: string; agentName: string; run?: Run; disabled?: string
  onSend: (prompt: string, allowWrite: boolean) => Promise<boolean>; onStop: () => void
}) {
  useT()
  const [text, setText] = useState('')
  const [write, setWrite] = useState(false)
  const [sending, setSending] = useState(false)
  const [, tick] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const running = run?.status === 'running'

  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [running])
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px' } }, [text])

  const send = async () => {
    if (!text.trim() || running || sending || disabled) return
    setSending(true)
    const ok = await onSend(text.trim(), write)
    setSending(false)
    if (ok) setText('')
  }

  return (
    <div className={`composer ${running ? 'busy' : ''} ${write ? 'write' : ''}`}>
      {running && (
        <div className="composer-status fade-in">
          <span className="spinner" />
          <span>{t('{agent} is working', { agent: agentName })} · {elapsed(Date.now() - run!.startedAt)} · {run!.allowWrite ? t('can edit files') : t('read-only')}</span>
          <button className="btn" onClick={onStop}>{t('Stop')}</button>
        </div>
      )}
      <div className="composer-box">
        <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} rows={1} disabled={!!disabled || running}
          placeholder={disabled ?? t('Continue with {agent}…', { agent: agentName })} aria-label={t('Continue this session with {agent}', { agent: agentName })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
        <div className="composer-bar">
          <button className={`mode ${write ? 'on' : ''}`} onClick={() => setWrite(!write)} disabled={running || !!disabled}
            title={t((write ? WRITE_HINT[agent] : READ_ONLY_HINT[agent]) ?? '')} aria-pressed={write}>
            <Icon name={write ? 'unlock' : 'lock'} size={14} />{write ? t('Can edit files') : t('Read-only')}
          </button>
          <span className="composer-hint">{write ? t('The agent may change files in this project') : t('Enter to send · Shift Enter for a new line')}</span>
          <button className="send" onClick={send} disabled={!text.trim() || running || sending || !!disabled} aria-label={t('Send')}>
            {sending ? <span className="spinner" /> : <Icon name="arrowup" size={16} stroke={1.75} />}
          </button>
        </div>
      </div>
    </div>
  )
}
