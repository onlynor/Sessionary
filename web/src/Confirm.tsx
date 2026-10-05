import { useEffect, useRef } from 'react'
import { t, useT } from './i18n'

export interface ConfirmSpec { title: string; body: React.ReactNode; confirm: string; danger?: boolean; onConfirm: () => void }

/** A sheet for the few actions that leave Sessionary's own sandbox. Escape / Cancel is the default. */
export function Confirm({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  useT()
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <div className="sheet confirm pop-in" role="alertdialog" aria-label={spec.title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{spec.title}</h2>
        <div className="confirm-body">{spec.body}</div>
        <div className="confirm-actions">
          <button ref={cancel} className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className={`btn ${spec.danger ? 'danger' : 'primary'}`} onClick={() => { spec.onConfirm(); onClose() }}>{spec.confirm}</button>
        </div>
      </div>
    </div>
  )
}
