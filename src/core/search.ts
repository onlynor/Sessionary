import { toolPath } from './derive.ts'
import type { Message } from './model.ts'

const MAX_TEXT = 20_000
const TARGET_KEYS = ['command', 'pattern', 'url', 'query', 'description']

/** What a reader can see of a message without expanding anything: prose plus each tool call's one-line target. */
export function searchableText(m: Message): string {
  const parts: string[] = []
  for (const b of m.blocks) {
    if (b.type === 'text') parts.push(b.text)
    else if (b.type === 'note') parts.push(b.text)
    else if (b.type === 'tool') {
      const i = b.input as Record<string, unknown> | undefined
      const target = toolPath(i) ?? TARGET_KEYS.map((k) => i?.[k]).find((v): v is string => typeof v === 'string')
      parts.push(`${b.name} ${target ?? ''}`.trim())
    }
  }
  return parts.join('\n').slice(0, MAX_TEXT)
}

/** Query terms: whitespace separated, quotes allowed for phrases. */
export function terms(q: string): string[] {
  const out: string[] = []
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2]!).toLowerCase())
  return out.filter(Boolean).slice(0, 8)
}

/** A short excerpt around the first matching term, with match offsets for highlighting. */
export function snippet(text: string, ts: string[], radius = 70): { text: string; marks: [number, number][] } {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of ts) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, (at < 0 ? 0 : at) + radius * 2)
  let s = text.slice(start, end).replace(/\s+/g, ' ')
  const lead = start > 0 ? '…' : ''
  s = lead + s + (end < text.length ? '…' : '')
  const marks: [number, number][] = []
  const ls = s.toLowerCase()
  for (const t of ts) for (let i = ls.indexOf(t); i >= 0; i = ls.indexOf(t, i + t.length)) marks.push([i, i + t.length])
  return { text: s, marks: marks.sort((a, b) => a[0] - b[0]) }
}
