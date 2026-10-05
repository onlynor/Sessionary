import { useMemo, useState, useSyncExternalStore } from 'react'
import { t, useT } from './i18n'

const LIMIT = 400
type Row = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; o?: number; n?: number }
type Side = { text: string; ln?: number; kind: 'add' | 'del' | 'ctx' | 'empty'; peer?: string }
type Pair = { kind: 'pair'; l: Side; r: Side } | { kind: 'hunk' | 'meta'; text: string }

function parse(diff: string): { rows: Row[]; numbered: boolean } {
  const rows: Row[] = []
  let o = 0, n = 0, numbered = false
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { o = +h[1]!; n = +h[2]!; numbered = true; rows.push({ kind: 'hunk', text: l }); continue }
    if (l === '@@') { rows.push({ kind: 'hunk', text: '⋯' }); continue }
    if (/^(diff --git|index |Index: |={8,}$|--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) { if (!numbered) continue; rows.push({ kind: 'meta', text: l }); continue }
    if (l.startsWith('\\')) { rows.push({ kind: 'meta', text: l }); continue }
    if (l.startsWith('+')) rows.push({ kind: 'add', text: l.slice(1), n: numbered ? n++ : undefined })
    else if (l.startsWith('-')) rows.push({ kind: 'del', text: l.slice(1), o: numbered ? o++ : undefined })
    else rows.push({ kind: 'ctx', text: l.slice(1), o: numbered ? o++ : undefined, n: numbered ? n++ : undefined })
  }
  return { rows: numbered ? rows.filter((r) => r.kind !== 'meta' || r.text.startsWith('\\')) : rows, numbered }
}

/** Side-by-side alignment: context on both sides; a block of deletions faces the additions that replaced it. */
function pairUp(rows: Row[]): Pair[] {
  const out: Pair[] = []
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]!
    if (r.kind === 'hunk' || r.kind === 'meta') { out.push({ kind: r.kind, text: r.text }); i++; continue }
    if (r.kind === 'ctx') { out.push({ kind: 'pair', l: { text: r.text, ln: r.o, kind: 'ctx' }, r: { text: r.text, ln: r.n, kind: 'ctx' } }); i++; continue }
    const dels: Row[] = [], adds: Row[] = []
    while (i < rows.length && rows[i]!.kind === 'del') dels.push(rows[i++]!)
    while (i < rows.length && rows[i]!.kind === 'add') adds.push(rows[i++]!)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k], a = adds[k]
      out.push({
        kind: 'pair',
        l: d ? { text: d.text, ln: d.o, kind: 'del', peer: a?.text } : { text: '', kind: 'empty' },
        r: a ? { text: a.text, ln: a.n, kind: 'add', peer: d?.text } : { text: '', kind: 'empty' },
      })
    }
  }
  return out
}

/** Highlight what changed inside a replaced line: everything between the common prefix and suffix. */
function Inline({ text, peer }: { text: string; peer?: string }) {
  if (peer == null || !text) return <>{text || ' '}</>
  let p = 0
  while (p < text.length && p < peer.length && text[p] === peer[p]) p++
  let s = 0
  while (s < text.length - p && s < peer.length - p && text[text.length - 1 - s] === peer[peer.length - 1 - s]) s++
  const mid = text.slice(p, text.length - s)
  // a fully rewritten line gets no inner highlight; the row colour already says it
  if (!mid || mid.length > text.length * 0.8) return <>{text}</>
  return <>{text.slice(0, p)}<span className="ichg">{mid}</span>{text.slice(text.length - s)}</>
}

// One preference shared by every diff on screen, persisted across reloads.
type Mode = 'split' | 'unified'
let mode: Mode = (() => { try { return (localStorage.getItem('sessionary:diff') as Mode) || 'split' } catch { return 'split' } })()
const subs = new Set<() => void>()
const setMode = (m: Mode) => { mode = m; try { localStorage.setItem('sessionary:diff', m) } catch { /* private mode */ } subs.forEach((f) => f()) }
const useMode = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => mode)

/** Global layout switch, shown once per view rather than on every diff. */
export function DiffModeToggle() {
  const m = useMode()
  useT()
  return (
    <div className="seg sm" role="group" aria-label={t('Diff layout')}>
      <button className={m === 'split' ? 'on' : ''} onClick={() => setMode('split')} aria-pressed={m === 'split'}>{t('Side by side')}</button>
      <button className={m === 'unified' ? 'on' : ''} onClick={() => setMode('unified')} aria-pressed={m === 'unified'}>{t('Unified')}</button>
    </div>
  )
}

export function DiffView({ text, truncated }: { text: string; truncated?: boolean }) {
  const { rows, numbered } = useMemo(() => parse(text), [text])
  const m = useMode()
  // a brand-new file (only additions, no context) has nothing to put on the left
  const oneSided = rows.every((r) => r.kind !== 'del' && r.kind !== 'ctx')
  const split = m === 'split' && !oneSided
  const pairs = useMemo(() => (split ? pairUp(rows) : []), [rows, split])
  const [all, setAll] = useState(false)
  const total = split ? pairs.length : rows.length
  return (
    <div className={`diffbox ${split ? 'split' : 'unified'}`}>
      <div className="diffscroll">
        {split ? (
          <table className="diff sbs">
            <colgroup>{numbered && <col className="c-ln" />}<col /><col className="c-gap" />{numbered && <col className="c-ln" />}<col /></colgroup>
            <tbody>
              {(all ? pairs : pairs.slice(0, LIMIT)).map((p, i) => p.kind === 'pair' ? (
                <tr key={i}>
                  {numbered && <td className={`ln ${p.l.kind}`}>{p.l.ln ?? ''}</td>}
                  <td className={`code-cell ${p.l.kind}`}><Inline text={p.l.text} peer={p.l.peer} /></td>
                  <td className="gap" />
                  {numbered && <td className={`ln ${p.r.kind}`}>{p.r.ln ?? ''}</td>}
                  <td className={`code-cell ${p.r.kind}`}><Inline text={p.r.text} peer={p.r.peer} /></td>
                </tr>
              ) : (
                <tr key={i} className={p.kind}><td colSpan={numbered ? 5 : 3}>{p.text}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="diff">
            <tbody>
              {(all ? rows : rows.slice(0, LIMIT)).map((r, i) => (
                <tr key={i} className={r.kind}>
                  {numbered && <td className="ln">{r.o ?? ''}</td>}
                  {numbered && <td className="ln">{r.n ?? ''}</td>}
                  <td className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                  <td className="code-cell">{r.text || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!all && total > LIMIT && <button className="more pad" onClick={() => setAll(true)}>{t('Show {n} more lines', { n: total - LIMIT })}</button>}
      {truncated && <div className="quiet-note pad">{t('Diff truncated')}</div>}
    </div>
  )
}
