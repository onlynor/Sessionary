import { useEffect, useRef, useState } from 'react'
import { t, useT } from './i18n'
import { api } from './api'
import { Icon } from './Icon'
import type { Snip } from './types'

/**
 * In-session find. The conversation is virtualised, so browser find cannot see most of it; this asks the
 * index for every matching message and lets the conversation scroll each one into view.
 */
export function FindBar({ sessionId, initial, onClose, onGoto, onQuery }: {
  sessionId: string; initial: string; onClose: () => void; onGoto: (msgIndex: number) => void; onQuery: (q: string) => void
}) {
  useT()
  const [q, setQ] = useState(initial)
  const [hits, setHits] = useState<Snip[] | null>(null)
  const [cur, setCur] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  useEffect(() => {
    onQuery(q)
    if (!q.trim()) { setHits(null); return }
    const ctl = new AbortController()
    const t = setTimeout(() => api.find(sessionId, q, ctl.signal).then((h) => { setHits(h); setCur(0); if (h[0]) onGoto(h[0].msgIndex) }, () => {}), 160)
    return () => { clearTimeout(t); ctl.abort() }
  }, [q, sessionId])

  const go = (d: number) => {
    if (!hits?.length) return
    const n = (cur + d + hits.length) % hits.length
    setCur(n)
    onGoto(hits[n]!.msgIndex)
  }
  return (
    <div className="findbar pop-in" role="search">
      <Icon name="find" size={14} />
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find in conversation')} aria-label={t('Find in conversation')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { go(e.shiftKey ? -1 : 1); e.preventDefault() }
          else if (e.key === 'Escape') { onClose(); e.preventDefault() }
        }} />
      <span className="find-count">{hits == null ? '' : hits.length ? `${cur + 1} / ${hits.length}` : t('No matches')}</span>
      <button className="tb-btn sm" onClick={() => go(-1)} disabled={!hits?.length} aria-label={t('Previous match')}><Icon name="arrowup" size={14} /></button>
      <button className="tb-btn sm" onClick={() => go(1)} disabled={!hits?.length} aria-label={t('Next match')}><Icon name="arrowdown" size={14} /></button>
      <button className="tb-btn sm" onClick={onClose} aria-label={t('Close find')}><Icon name="x" size={14} /></button>
    </div>
  )
}
