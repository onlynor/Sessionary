import { createContext, Fragment, useContext, useEffect, useSyncExternalStore } from 'react'
import { DICT } from './locales'

/**
 * UI language. English strings are the keys; each locale maps a key to its translation and anything missing
 * falls back to English. `{name}` placeholders are filled from `vars`.
 */
export type Lang = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja'
export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'English' },
  { id: 'zh-Hans', label: '简体中文', short: '简体' },
  { id: 'zh-Hant', label: '繁體中文', short: '繁體' },
  { id: 'ja', label: '日本語', short: '日本語' },
]
/** BCP 47 tags for Intl date formatting */
const INTL: Record<Lang, string> = { en: 'en', 'zh-Hans': 'zh-Hans-CN', 'zh-Hant': 'zh-Hant-TW', ja: 'ja-JP' }

function detect(): Lang {
  for (const l of navigator.languages ?? [navigator.language]) {
    const s = l.toLowerCase()
    if (s.startsWith('ja')) return 'ja'
    if (/^zh-(hant|tw|hk|mo)/.test(s)) return 'zh-Hant'
    if (s.startsWith('zh')) return 'zh-Hans'
    if (s.startsWith('en')) return 'en'
  }
  return 'en'
}

const KEY = 'sessionary:lang'
let current: Lang = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (LANGS.some((l) => l.id === v)) return v as Lang } catch { /* private mode */ }
  return detect()
})()
const subs = new Set<() => void>()
export function setLang(l: Lang) {
  current = l
  try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* private mode */ }
  subs.forEach((f) => f())
}
export const getLang = () => current
export const intlLocale = () => INTL[current]

type Vars = Record<string, string | number>
export function t(key: string, vars?: Vars): string {
  const s = (current === 'en' ? undefined : DICT[current]?.[key]) ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}
/** Like `t`, but placeholders may be React nodes (a <code>, a link) */
export function tx(key: string, vars: Record<string, React.ReactNode>): React.ReactNode {
  const s = (current === 'en' ? undefined : DICT[current]?.[key]) ?? key
  return s.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    return <Fragment key={i}>{m && m[1]! in vars ? vars[m[1]!] : part}</Fragment>
  })
}

const LangContext = createContext<Lang>(current)
/** Re-render on language change, including inside memoised rows. Returns `t` for convenience. */
export function useT() { useContext(LangContext); return t }

export function useLang(): Lang {
  const lang = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => current)
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  return lang
}
export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>
}
