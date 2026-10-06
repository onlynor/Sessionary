import { useEffect, useState } from 'react'
import { t, useT } from './i18n'

export interface PromptSpec { title: string; label: string; value: string; confirm: string; placeholder?: string; onSubmit: (value: string) => void }

/** A sheet that asks for one line of text (a name). Enter confirms, Escape cancels. */
export function Prompt({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  useT()
  const [v, setV] = useState(spec.value)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="overlay fade-in" onMouseDown={onClose}>
      <form className="sheet confirm pop-in" role="dialog" aria-label={spec.title} onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); spec.onSubmit(v.trim()); onClose() }}>
        <h2>{spec.title}</h2>
        <label className="prompt-field">
          <span>{spec.label}</span>
          <span className="field"><input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={spec.placeholder} maxLength={200} spellCheck={false}
            onFocus={(e) => e.currentTarget.select()} /></span>
        </label>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn primary">{spec.confirm}</button>
        </div>
      </form>
    </div>
  )
}
