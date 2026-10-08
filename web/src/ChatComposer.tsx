import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t, useT } from './i18n'
import type { ChatView } from './chat'
import { Icon } from './Icon'
import type { ChatModel } from './types'

function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A small menu above the composer for one setting (model, mode, effort). */
function Pick({ label, value, options, onPick, icon, disabled, wide }: {
  label: string; value?: string; options: ChatModel[]; onPick: (id: string) => Promise<void> | void; icon?: string; disabled?: boolean; wide?: boolean
}) {
  useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) { setQ(''); return }
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    addEventListener('mousedown', off); addEventListener('keydown', key, true)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key, true) }
  }, [open])
  const current = options.find((o) => o.id === value)
  const text = current?.label ?? value
  // an agent may offer hundreds of models (Hermes lists every provider it can reach): a long list can be searched
  const searchable = options.length > 12
  const needle = q.trim().toLowerCase()
  const shown = (needle ? options.filter((o) => `${o.label} ${o.id}`.toLowerCase().includes(needle)) : options).slice(0, 200)
  if (!options.length && !value) return null
  return (
    <div className="pick" ref={ref}>
      <button type="button" className={`mode ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} disabled={disabled || busy || !options.length} aria-haspopup="listbox" aria-expanded={open} title={label}>
        {icon && <Icon name={icon} size={14} />}<span className="pick-text">{text}</span>{busy ? <span className="spinner" /> : options.length > 1 && <Icon name="down" size={12} />}
      </button>
      {open && (
        <div className={`pick-menu pop-in ${wide ? 'wide' : ''}`} role="listbox" aria-label={label}>
          <div className="pick-title">{label}</div>
          {searchable && <div className="menu-search"><Icon name="search" size={13} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Filter models')} aria-label={t('Filter models')} spellCheck={false} /></div>}
          {searchable && !shown.length && <div className="pick-desc pick-none">{t('No model matches.')}</div>}
          {shown.map((o) => (
            <button key={o.id} role="option" aria-selected={o.id === value} className={`pick-item ${o.id === value ? 'on' : ''}`}
              onClick={async () => { setOpen(false); if (o.id === value) return; setBusy(true); try { await onPick(o.id) } finally { setBusy(false) } }}>
              <span className="pick-check">{o.id === value && <Icon name="check" size={14} stroke={1.75} />}</span>
              <span className="pick-label"><span>{o.label}</span>{o.description && <span className="pick-desc">{o.description}</span>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const MAX_IMAGES = 4, MAX_IMAGE_BYTES = 5 * 1024 * 1024

interface Img { mimeType: string; data: string; url: string }
const readImage = (f: File) => new Promise<Img | undefined>((res) => {
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type) || f.size > MAX_IMAGE_BYTES) return res(undefined)
  const r = new FileReader()
  r.onload = () => { const url = String(r.result); res({ mimeType: f.type, data: url.slice(url.indexOf(',') + 1), url }) }
  r.onerror = () => res(undefined)
  r.readAsDataURL(f)
})

/**
 * The message box of a live chat: send, steer while the agent works, stop, choose the model / mode / effort, and
 * type `/` for the agent's own commands. It is the same box for every agent; what the agent cannot do is not offered.
 */
export function ChatComposer({ agentName, view, opening, error, placeholder, disabled, hint, reopens, onWarm, onSend, onInterrupt, onModel, onMode, onEffort }: {
  agentName: string
  view: ChatView
  /** the chat is being started */
  opening?: boolean
  error?: string
  placeholder?: string
  disabled?: string
  hint?: string
  /** a session's chat: when its agent has ended (crashed, closed while idle) the next message starts it again */
  reopens?: boolean
  /** the box was focused: start the chat now so it is ready when the message is */
  onWarm: () => void
  onSend: (text: string, images?: { mimeType: string; data: string }[]) => Promise<boolean>
  onInterrupt: () => void
  onModel: (id: string) => Promise<void>
  onMode: (id: string) => Promise<void>
  onEffort: (id: string) => Promise<void>
}) {
  useT()
  const [text, setText] = useState('')
  const [images, setImages] = useState<Img[]>([])
  const [sending, setSending] = useState(false)
  const [slash, setSlash] = useState(0)
  const [, tick] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const { info, state } = view
  const working = state === 'working' || state === 'waiting'
  // ended for good only where nothing can start it again (a new chat whose agent never wrote a session)
  const closed = state === 'closed' && !reopens
  const steer = info.caps?.steer !== false
  const canType = !disabled && !closed

  useEffect(() => { if (!working) return; const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i) }, [working])
  useLayoutEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 220) + 'px' } }, [text])

  const commands = info.commands ?? []
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1]
  // every command, prefix matches first, then names that merely contain what was typed; the list scrolls
  const matches = useMemo(() => {
    if (slashQuery == null) return []
    const q = slashQuery.toLowerCase()
    const rank = (n: string) => (n.toLowerCase().startsWith(q) ? 0 : n.toLowerCase().includes(q) ? 1 : 2)
    return commands.filter((c) => rank(c.name) < 2).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  }, [slashQuery, commands])
  useEffect(() => setSlash(0), [slashQuery])
  const slashRef = useRef<HTMLDivElement>(null)
  useEffect(() => { slashRef.current?.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' }) }, [slash, matches])

  const blocked = !text.trim() && !images.length
  const send = async () => {
    if (blocked || sending || !canType || (working && !steer)) return
    setSending(true)
    const ok = await onSend(text.trim(), images.length ? images.map(({ mimeType, data }) => ({ mimeType, data })) : undefined)
    setSending(false)
    if (ok) { setText(''); setImages([]) }
    ta.current?.focus()
  }
  const pasteImages = async (files: File[]) => {
    if (info.caps?.images === false) return
    const got = (await Promise.all(files.slice(0, MAX_IMAGES).map(readImage))).filter((x): x is Img => !!x)
    if (got.length) setImages((cur) => [...cur, ...got].slice(0, MAX_IMAGES))
  }

  const pickCommand = (name: string) => { setText(`/${name} `); ta.current?.focus() }
  const onKey = (e: React.KeyboardEvent) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlash((slash + 1) % matches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlash((slash - 1 + matches.length) % matches.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && matches[slash] && slashQuery !== matches[slash]!.name)) { e.preventDefault(); pickCommand(matches[slash]!.name); return }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return }
    }
    if (e.key === 'Escape' && working && info.caps?.interrupt !== false) { e.preventDefault(); onInterrupt(); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  const status = opening ? t('Starting {agent}…', { agent: agentName })
    : closed ? (view.items.at(-1)?.k === 'note' ? '' : t('This chat has ended'))
    : state === 'waiting' ? t('{agent} is waiting for you', { agent: agentName })
    : working ? `${t('{agent} is working', { agent: agentName })}${view.since ? ` · ${elapsed(Date.now() - view.since)}` : ''}`
    : ''

  const models = info.models ?? []
  const modes = info.modes ?? []
  const efforts = (info.efforts ?? []).map((e) => ({ id: e, label: e }))
  return (
    <div className={`composer chat ${working ? 'busy' : ''} ${info.mode && /bypass|full|yolo|danger/i.test(info.mode) ? 'write' : ''}`}>
      {(status || error) && (
        <div className={`composer-status fade-in ${error ? 'err' : ''}`}>
          {!error && (opening || working) && <span className="spinner" />}
          <span>{error ?? status}</span>
          {working && info.caps?.interrupt !== false && <button className="btn" onClick={onInterrupt} title={t('Stop (Esc)')}><Icon name="stop" size={12} />{t('Stop')}</button>}
        </div>
      )}
      <div className="composer-box" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); pasteImages([...e.dataTransfer.files]) } }}>
        {matches.length > 0 && (
          <div className="slash pop-in" ref={slashRef} role="listbox" aria-label={t('Commands')}>
            {matches.map((c, i) => (
              <button key={c.name} role="option" aria-selected={i === slash} className={`slash-item ${i === slash ? 'on' : ''}`} onMouseEnter={() => setSlash(i)} onMouseDown={(e) => { e.preventDefault(); pickCommand(c.name) }}>
                <span className="slash-name">/{c.name}</span>{c.hint && <span className="slash-hint">{c.hint}</span>}<span className="slash-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="attach">
            {images.map((im, i) => (
              <span key={i} className="thumb"><img src={im.url} alt="" /><button onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label={t('Remove image')}><Icon name="x" size={12} stroke={2} /></button></span>
            ))}
          </div>
        )}
        <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} rows={1} disabled={!canType}
          placeholder={disabled ?? (closed ? t('This chat has ended') : placeholder ?? t('Message {agent}…', { agent: agentName }))}
          aria-label={t('Message {agent}', { agent: agentName })}
          onFocus={onWarm} onKeyDown={onKey}
          onPaste={(e) => { const f = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); pasteImages(f) } }} />
        <div className="composer-bar">
          <Pick label={t('Permissions')} icon="lock" value={info.mode} options={modes} onPick={onMode} disabled={!canType || info.caps?.setMode === false} />
          <Pick label={t('Model')} value={info.model} options={models} onPick={onModel} disabled={!canType || info.caps?.setModel === false} wide />
          {efforts.length > 0 && <Pick label={t('Effort')} icon="activity" value={info.effort} options={efforts} onPick={onEffort} disabled={!canType || info.caps?.setEffort === false} />}
          <span className="composer-hint">{hint ?? (working ? (steer ? t('Enter to steer · Esc to stop') : t('Esc to stop')) : t('Enter to send · Shift Enter for a new line · / for commands'))}</span>
          <button className="send" onClick={send} disabled={blocked || sending || !canType || (working && !steer)} aria-label={working ? t('Send to the running turn') : t('Send')}>
            {sending ? <span className="spinner" /> : <Icon name="arrowup" size={16} stroke={1.75} />}
          </button>
        </div>
      </div>
    </div>
  )
}
