import { useEffect, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { clock } from './format'

export interface OutlineEntry { msgIndex: number; text: string; time?: number }

/**
 * Prompt index on the conversation's right edge: one tick per thing you asked. Hovering reveals the list;
 * clicking jumps there. The tick for the prompt you are currently reading is emphasised.
 */
export function Outline({ entries, active, onJump }: { entries: OutlineEntry[]; active: number; onJump: (msgIndex: number) => void }) {
  useT()
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const list = useRef<HTMLDivElement>(null)
  const show = () => { clearTimeout(timer.current); setOpen(true) }
  const hide = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 180) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { if (open) list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [open, active])
  if (entries.length < 2) return null

  // ticks get tighter for long sessions so the rail never outgrows the view
  const gap = Math.max(3, Math.min(10, Math.floor(420 / entries.length)))
  return (
    <nav className={`outline ${open ? 'open' : ''}`} aria-label={t('Your prompts')} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <div className="ticks" style={{ gap }}>
        {entries.map((e, i) => (
          <button key={e.msgIndex} className={`tick ${i === active ? 'on' : ''}`} onClick={() => onJump(e.msgIndex)} aria-label={`${t('Prompt {n}', { n: i + 1 })}: ${e.text}`} tabIndex={-1} />
        ))}
      </div>
      {open && (
        <div className="outline-panel pop-in" ref={list} role="list">
          <div className="outline-head">{t('Your prompts')} · {entries.length}</div>
          {entries.map((e, i) => (
            <button key={e.msgIndex} role="listitem" className={`outline-item ${i === active ? 'on' : ''}`} onClick={() => { onJump(e.msgIndex); setOpen(false) }}>
              <span className="oi-n">{i + 1}</span>
              <span className="oi-text">{e.text}</span>
              {e.time && <span className="oi-time">{clock(e.time)}</span>}
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}
