import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { THEMES, type ThemeChoice } from './theme'
import { LANGS, t, useT, type Lang } from './i18n'
import { relAgo } from './format'

/** A menu at a fixed screen point (opening upwards from `bottom`, or down from `top`), kept on screen. */
export function Popover({ at, onClose, children, width = 260, label, solid }: {
  at: { left: number; top?: number; bottom?: number }; onClose: () => void; children: React.ReactNode; width?: number; label: string; solid?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(at.left)
  useLayoutEffect(() => { setLeft(Math.max(8, Math.min(at.left, innerWidth - width - 8))) }, [at.left, width])
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // the click that opened the menu must not close it
    const t = setTimeout(() => addEventListener('mousedown', off))
    addEventListener('keydown', key); addEventListener('resize', onClose)
    return () => { clearTimeout(t); removeEventListener('mousedown', off); removeEventListener('keydown', key); removeEventListener('resize', onClose) }
  }, [onClose])
  return (
    <div ref={ref} className={`menu fixed pop-in ${solid ? 'solid' : ''}`} role="menu" aria-label={label}
      style={{ left, width, top: at.top, bottom: at.bottom, transformOrigin: at.bottom != null ? 'bottom left' : 'top left' }}>
      {children}
    </div>
  )
}

/** Everything used rarely lives here: rescan, appearance, language, shortcuts, index status. */
export function SettingsMenu(p: {
  at: { left: number; top?: number; bottom?: number }; onClose: () => void
  theme: ThemeChoice; onTheme: (t: ThemeChoice) => void; lang: Lang; onLang: (l: Lang) => void
  onRefresh: () => void; refreshing: boolean; lastScan?: number; indexed: number; machine: string; onHelp: () => void
}) {
  useT()
  const run = (f: () => void) => () => { f(); p.onClose() }
  return (
    <Popover at={p.at} onClose={p.onClose} label={t('Settings')}>
      <button className="menu-item" role="menuitem" onClick={run(p.onRefresh)} disabled={p.refreshing}><Icon name="refresh" /><span className="grow">{p.refreshing ? t('Scanning…') : t('Rescan sources')}</span></button>
      <div className="menu-sep" />
      <div className="menu-label">{t('Appearance')}</div>
      {THEMES.map((th) => (
        <button key={th.id} className="menu-item" role="menuitemradio" aria-checked={p.theme === th.id} onClick={() => p.onTheme(th.id)}>
          <Icon name={th.icon} /><span className="grow">{t(th.label)}</span>{p.theme === th.id && <span className="check"><Icon name="check" size={14} /></span>}
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-label">{t('Language')}</div>
      <div className="seg sm lang-seg" role="radiogroup" aria-label={t('Language')}>
        {LANGS.map((l) => (
          <button key={l.id} role="radio" aria-checked={p.lang === l.id} className={p.lang === l.id ? 'on' : ''} onClick={() => p.onLang(l.id)} lang={l.id} title={l.label}>{l.short}</button>
        ))}
      </div>
      <div className="menu-sep" />
      <button className="menu-item" role="menuitem" onClick={run(p.onHelp)}><Icon name="keyboard" /><span className="grow">{t('Keyboard shortcuts')}</span><kbd>?</kbd></button>
      <div className="menu-sep" />
      <div className="menu-foot"><span className={p.refreshing ? 'spinner' : 'dot ok'} />{t('{n} sessions indexed on {machine}', { n: p.indexed, machine: p.machine })}{p.lastScan ? ` · ${relAgo(p.lastScan)}` : ''}</div>
    </Popover>
  )
}
