import { getLang, intlLocale, t } from './i18n'

const UNITS: Record<string, [string, string, string, string]> = {
  // now, minutes, hours, days
  en: ['now', 'm', 'h', 'd'],
  'zh-Hans': ['刚刚', '分钟', '小时', '天'],
  'zh-Hant': ['剛剛', '分鐘', '小時', '天'],
  ja: ['今', '分', '時間', '日'],
}

/** Compact relative time for lists: "now", "5m", "3h", "2d", then a short date. */
export function relTime(ms: number): string {
  const d = Date.now() - ms
  const m = 60_000, h = 60 * m, day = 24 * h
  const u = UNITS[getLang()] ?? UNITS.en!
  if (d < m) return u[0]
  if (d < h) return `${Math.floor(d / m)}${u[1]}`
  if (d < day) return `${Math.floor(d / h)}${u[2]}`
  if (d < 7 * day) return `${Math.floor(d / day)}${u[3]}`
  const tm = new Date(ms)
  return tm.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric', year: tm.getFullYear() === new Date().getFullYear() ? undefined : '2-digit' })
}

/** A span of time: "45m", "3h 20m", "2d 4h" (localised units). */
export function duration(ms: number): string {
  const u = UNITS[getLang()] ?? UNITS.en!
  const sep = getLang() === 'en' ? ' ' : ''
  const m = Math.max(0, Math.round(ms / 60_000)), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (m < 1) return `<1${u[1]}`
  if (h < 1) return `${m}${u[1]}`
  if (d < 1) return m % 60 ? `${h}${u[2]}${sep}${m % 60}${u[1]}` : `${h}${u[2]}`
  return h % 24 ? `${d}${u[3]}${sep}${h % 24}${u[2]}` : `${d}${u[3]}`
}

/** Relative time in a sentence: "just now", "3h ago", or a date. */
export function relAgo(ms: number): string {
  const r = relTime(ms)
  if (Date.now() - ms < 60_000) return t('just now')
  return Date.now() - ms < 7 * 86_400_000 ? t('{when} ago', { when: r }) : r
}

export const fullTime = (ms: number) => new Date(ms).toLocaleString(intlLocale())
export const clock = (ms: number) => new Date(ms).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric', year: 'numeric' })
export const baseName = (p?: string) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '')
export function compact(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
}

/** Group key and label for the session list. The key stays stable across languages. */
export function dayBucket(ms: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const diff = (start.getTime() - ms) / 86_400_000
  if (diff <= 0) return t('Today')
  if (diff <= 1) return t('Yesterday')
  if (diff <= 7) return t('Previous 7 days')
  if (diff <= 30) return t('Previous 30 days')
  // long histories read better by month than as one bottomless "Earlier"
  const d = new Date(ms)
  return d.toLocaleDateString(intlLocale(), { month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

/** Keep the file name visible: long paths lose their middle, not their end. */
export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) }
}
export const relTo = (p: string, root?: string) => {
  if (!root) return p
  const r = root.replace(/[\\/]+$/, '')
  return p.startsWith(r + '/') || p.startsWith(r + '\\') ? p.slice(r.length + 1) : p
}

/** A one-paragraph preview without markdown punctuation (list rows show it as plain text). */
export const plainText = (t: string) => t.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[`*_#>|~]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

/** Titles are often a prompt's first line; drop markdown heading/bullet markers so they read as titles. */
export const cleanTitle = (t: string) => t.replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/, '').replace(/\*\*/g, '')
