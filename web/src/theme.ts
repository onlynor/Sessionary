import { useEffect } from 'react'
import { usePersisted } from './hooks'

export type ThemeChoice = 'ember' | 'graphite' | 'paper' | 'system'
export const THEMES: { id: ThemeChoice; label: string; icon: string }[] = [
  { id: 'paper', label: 'Light', icon: 'sun' },
  { id: 'ember', label: 'Dark', icon: 'moon' },
  { id: 'graphite', label: 'Graphite', icon: 'moon' },
  { id: 'system', label: 'System', icon: 'monitor' },
]
export type Density = 'comfortable' | 'compact'

export const resolveTheme = (c: ThemeChoice): string => (c === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'ember') : c)

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = usePersisted<ThemeChoice>('theme', 'ember')
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(choice) }
    apply()
    if (choice !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [choice])
  return [choice, setChoice]
}
