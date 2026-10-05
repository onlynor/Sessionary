import { useEffect, useState } from 'react'

/**
 * Height + opacity disclosure. Children mount on first open and unmount after the close transition,
 * so folded tool output costs nothing until someone looks at it.
 */
export function Reveal({ open, children, className = '' }: { open: boolean; children: React.ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
  }, [open])
  if (!mounted) return null
  return (
    <div className={`reveal ${shown ? 'shown' : ''} ${className}`} onTransitionEnd={(e) => { if (e.target === e.currentTarget && !open) setMounted(false) }}>
      <div className="reveal-inner">{children}</div>
    </div>
  )
}
