import { useEffect } from 'react'
import { t, useT } from './i18n'

export interface ToastMsg { id: number; text: string; undo?: () => void }

/** One transient confirmation at a time, with Undo — destructive-looking actions stay one keystroke away from reversal. */
export function Toast({ msg, onDone }: { msg: ToastMsg; onDone: () => void }) {
  useT()
  useEffect(() => { const id = setTimeout(onDone, 6000); return () => clearTimeout(id) }, [msg.id])
  return (
    <div className="toast pop-in" role="status" key={msg.id}>
      <span>{msg.text}</span>
      {msg.undo && <button onClick={() => { msg.undo!(); onDone() }}>{t('Undo')}</button>}
    </div>
  )
}
