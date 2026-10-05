import type { ToolBlock } from './types'

const CONTEXT = 3

/** Line diff of two strings as unified-style lines (' ', '+', '-'); skipped context becomes an '@@' marker. */
export function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split('\n'), b = newText.split('\n')
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const x = a.slice(s, ea), y = b.slice(s, eb)

  const ops: string[] = []
  if (x.length * y.length > 2_000_000) {
    ops.push(...x.map((l) => '-' + l), ...y.map((l) => '+' + l))
  } else {
    const w = y.length + 1
    const t = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
    let i = 0, j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { ops.push(' ' + x[i]); i++; j++ }
      else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push('-' + x[i++])
      else ops.push('+' + y[j++])
    }
    while (i < x.length) ops.push('-' + x[i++])
    while (j < y.length) ops.push('+' + y[j++])
  }

  const all = [...a.slice(Math.max(0, s - CONTEXT), s).map((l) => ' ' + l), ...ops, ...a.slice(ea, ea + CONTEXT).map((l) => ' ' + l)]
  // collapse long unchanged stretches inside the diff
  const out: string[] = []
  let run = 0
  all.forEach((l, i) => {
    if (l[0] !== ' ') { run = 0; out.push(l); return }
    run++
    const next = all.slice(i + 1, i + 1 + CONTEXT + 1)
    const nearChange = next.slice(0, CONTEXT).some((n) => n[0] !== ' ') || run <= CONTEXT
    if (nearChange) out.push(l)
    else if (out[out.length - 1] !== '@@') out.push('@@')
  })
  return out.join('\n')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Best available unified diff for an edit/write tool call, as recorded by the agent. */
export function diffOf(b: ToolBlock): string | undefined {
  if (b.diff) return b.diff
  const i = b.input ?? {}
  const o = i.old_string ?? i.oldString
  const n = i.new_string ?? i.newString
  if (b.kind === 'edit' && typeof o === 'string' && typeof n === 'string') return lineDiff(o, n)
  const content = str(i.content)
  if (b.kind === 'write' && content) return content.split('\n').map((l) => '+' + l).join('\n')
}

export function diffStats(diff?: string) {
  let add = 0, del = 0
  for (const l of diff?.split('\n') ?? []) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}
