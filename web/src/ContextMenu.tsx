import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hint?: string; icon?: string; disabled?: boolean }

/** A right-click menu at the pointer, kept on screen (scrolling inside if the window is short), closed by click-away, Escape or scrolling. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | '-')[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; maxHeight: number }>()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth, h = el.scrollHeight
    // below the pointer when it fits, else above it, else as high as needed and scrolling
    const top = y + h <= innerHeight - 8 ? y : y - h >= 8 ? y - h : Math.max(8, innerHeight - 8 - h)
    setPos({ x: Math.max(8, Math.min(x, innerWidth - w - 8)), y: top, maxHeight: innerHeight - top - 8 })
  }, [x, y])
  useEffect(() => {
    const off = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', off); addEventListener('keydown', key); addEventListener('wheel', onClose, { passive: true }); addEventListener('blur', onClose)
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', key); removeEventListener('wheel', onClose); removeEventListener('blur', onClose) }
  }, [onClose])
  return createPortal(
    <div ref={ref} className={`menu ctx ${pos ? 'pop-in' : ''}`} role="menu" style={pos ? { left: pos.x, top: pos.y, maxHeight: pos.maxHeight } : { left: x, top: y, visibility: 'hidden' }}>
      {items.map((it, i) => it === '-' ? <div key={i} className="menu-sep" /> : (
        <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { it.onSelect(); onClose() }}>
          {it.icon ? <Icon name={it.icon} /> : <span className="menu-gap" />}<span className="grow">{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  )
}
