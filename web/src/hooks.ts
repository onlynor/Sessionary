import { useEffect, useState } from 'react'

export function usePersisted<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem('sessionary:' + key); return raw == null ? init : (JSON.parse(raw) as T) } catch { return init }
  })
  return [v, (n: T) => { setV(n); try { localStorage.setItem('sessionary:' + key, JSON.stringify(n)) } catch { /* private mode */ } }]
}

export function useMedia(q: string): boolean {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/** Mirrors macOS: when the window loses focus, selection and materials go quiet. */
export function useWindowActive() {
  useEffect(() => {
    const set = (on: boolean) => document.documentElement.toggleAttribute('data-inactive', !on)
    const onFocus = () => set(true)
    const onBlur = () => set(false)
    addEventListener('focus', onFocus)
    addEventListener('blur', onBlur)
    set(document.hasFocus())
    return () => { removeEventListener('focus', onFocus); removeEventListener('blur', onBlur) }
  }, [])
}
