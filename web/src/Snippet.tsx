import type { Snip } from './types'

/** Server-side excerpt with match offsets rendered as <mark>. */
export function Snippet({ s }: { s: Pick<Snip, 'text' | 'marks'> }) {
  const out: React.ReactNode[] = []
  let at = 0
  s.marks.forEach(([a, b], i) => {
    if (a < at) return
    if (a > at) out.push(s.text.slice(at, a))
    out.push(<mark key={i}>{s.text.slice(a, b)}</mark>)
    at = b
  })
  out.push(s.text.slice(at))
  return <>{out}</>
}
