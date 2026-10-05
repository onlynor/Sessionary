import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hint?: string; icon?: string; disabled?: boolean }

/** A right-click menu at the pointer, kept on screen, closed by click-away, Escape or scrolling. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | '-')[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const off = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', off); addEventListener('keydown', key); addEventListener('wheel', onClose, { passive: true }); addEventListener('blur', onClose)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key); removeEventListener('wheel', onClose); removeEventListener('blur', onClose) }
  }, [onClose])
  return (
    <div ref={ref} className="menu ctx pop-in" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => it === '-' ? <div key={i} className="menu-sep" /> : (
        <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { it.onSelect(); onClose() }}>
          {it.icon ? <Icon name={it.icon} /> : <span className="menu-gap" />}<span className="grow">{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}
