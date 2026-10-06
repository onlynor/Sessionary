import { useEffect, useRef } from 'react'

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable || !!el.closest?.('.xterm'))

/** The shortcuts that belong to the window itself; a page adds its own for what it shows. */
export function useHotkeys(h: { onPalette: () => void; onHelp: () => void; onToggleNav: () => void; onEscape: () => void }) {
  const ref = useRef(h)
  ref.current = h
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current.onPalette(); return }
      if (e.key === 'Escape') { ref.current.onEscape(); return }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (e.key === '[') ref.current.onToggleNav()
      else if (e.key === '?') ref.current.onHelp()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [])
}
