import { useEffect, useMemo, useRef, useState } from 'react'
import { t, tx, useT } from './i18n'
import { api } from './api'
import { diffOf, diffStats } from './diff'
import { DiffModeToggle, DiffView } from './DiffView'
import { relTo, splitPath } from './format'
import { Icon } from './Icon'
import { Reveal } from './Reveal'
import type { ChangeFocus, Changes, EditBlock, FileDiff, SessionSummary, ToolBlock } from './types'

const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path']
const STATUS: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', '?': 'Untracked' }

interface Recorded { path: string; edits: { diff: string; tool: ToolBlock }[] }

function recordedEdits(edits: EditBlock[]): Recorded[] {
  const map = new Map<string, Recorded>()
  for (const b of edits) {
    const path = PATH_KEYS.map((k) => b.input?.[k]).find((v): v is string => typeof v === 'string' && !!v)
    const diff = diffOf(b)
    if (!path || !diff) continue
    const r = map.get(path) ?? map.set(path, { path, edits: [] }).get(path)!
    r.edits.push({ diff, tool: b })
  }
  return [...map.values()]
}

function Stat({ add, del }: { add?: number; del?: number }) {
  if (add == null && del == null) return null
  return <span className="tool-stats"><b className="plus">+{add ?? 0}</b> <b className="minus">−{del ?? 0}</b></span>
}

function FileCard({ id, path, root, open, onToggle, badge, stat, children, focused }: {
  id: string; path: string; root?: string; open: boolean; onToggle: () => void; badge?: React.ReactNode; stat?: React.ReactNode; children: React.ReactNode; focused: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [focused])
  const { dir, name } = splitPath(relTo(path, root))
  return (
    <section className={`fcard ${focused ? 'focused' : ''}`} ref={ref} id={id}>
      <button className="fcard-head" onClick={onToggle} aria-expanded={open}>
        <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={14} /></span>
        <Icon name="file" size={14} />
        <span className="fname">{name}</span>
        <span className="fdir" title={path}>{dir}</span>
        {badge}
        {stat}
      </button>
      <Reveal open={open}><div className="fcard-body">{children}</div></Reveal>
    </section>
  )
}

function GitFile({ sid, file }: { sid: string; file: string }) {
  useT()
  const [d, setD] = useState<FileDiff | null | 'err'>(null)
  useEffect(() => { api.changeFile(sid, file).then(setD, () => setD('err')) }, [sid, file])
  if (d === null) return <div className="quiet-note pad">{t('Loading diff…')}</div>
  if (d === 'err') return <div className="quiet-note pad">{t('Diff unavailable.')}</div>
  if (d.binary) return <div className="quiet-note pad">{t('Binary file.')}</div>
  if (!d.patch) return <div className="quiet-note pad">{t('No textual changes.')}</div>
  return <DiffView text={d.patch} truncated={d.truncated} />
}

export function ChangesView({ summary: session, edits, focus, onFocus }: { summary: SessionSummary; edits: EditBlock[]; focus?: ChangeFocus; onFocus: (f: ChangeFocus) => void }) {
  useT()
  const recorded = useMemo(() => recordedEdits(edits), [edits])
  const [git, setGit] = useState<Changes | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => { setGit(null); api.changes(session.id).then(setGit, () => setGit({ root: null, files: [] })) }, [session.id])
  useEffect(() => { if (focus) setOpen((o) => ({ ...o, [`${focus.source}:${focus.path}`]: true })) }, [focus])

  const isOpen = (key: string, dflt: boolean) => open[key] ?? dflt
  const toggle = (key: string, dflt: boolean) => setOpen({ ...open, [key]: !isOpen(key, dflt) })
  const root = git?.root ?? session.cwd
  const gitPaths = new Set(git?.files.map((f) => f.path))

  return (
    <div className="scroll" tabIndex={0} aria-label={t('Changes')}>
      <div className="thread changes">
        <h2>{t('Edited by the agent')} <span className="count">{t(recorded.length === 1 ? '{n} file' : '{n} files', { n: recorded.length })}</span><span className="grow" /><DiffModeToggle /></h2>
        <p className="hint">{t("Reconstructed from this session's own edit and write calls, in the order they happened.")}</p>
        {recorded.length === 0 && <div className="quiet-note">{t('This session did not record any file edits.')}</div>}
        {recorded.map((r) => {
          const key = `session:${r.path}`
          const total = diffStats(r.edits.map((e) => e.diff).join('\n'))
          const rel = root ? relTo(r.path, root).replace(/\\/g, '/') : r.path
          return (
            <FileCard key={key} id={key} path={r.path} root={root ?? undefined} open={isOpen(key, recorded.length <= 3)} onToggle={() => toggle(key, recorded.length <= 3)} focused={focus?.source === 'session' && focus.path === r.path}
              badge={r.edits.length > 1 ? <span className="badge">{t('{n} edits', { n: r.edits.length })}</span> : undefined} stat={<Stat add={total.add} del={total.del} />}>
              {r.edits.map((e, i) => (
                <div key={i} className="edit-chunk">
                  {r.edits.length > 1 && <div className="chunk-label">{t('Edit {i} of {n}', { i: i + 1, n: r.edits.length })}{e.tool.status === 'error' ? ` · ${t('failed')}` : ''}</div>}
                  <DiffView text={e.diff} />
                </div>
              ))}
              {gitPaths.has(rel) && <button className="more" onClick={() => onFocus({ path: rel, source: 'git' })}>{t("See the file's current diff against HEAD")}</button>}
            </FileCard>
          )
        })}

        <h2 className="second">{t('Working tree now')} <span className="count">{git ? t('{n} changed', { n: git.files.length }) : '…'}</span></h2>
        <p className="hint">{tx('Live {cmd} of {root}. It may include work that did not come from this session, and it can change after you read it.', { cmd: <code>git diff HEAD</code>, root: git?.root ?? t('the project') })}</p>
        {git && !git.root && <div className="quiet-note">{session.cwd ? t('This directory is missing or not a git repository.') : t('This session did not record a working directory.')}</div>}
        {git?.root && git.files.length === 0 && <div className="quiet-note">{t('Working tree is clean.')}</div>}
        {git?.files.map((f) => {
          const key = `git:${f.path}`
          return (
            <FileCard key={key} id={key} path={f.path} open={isOpen(key, false)} onToggle={() => toggle(key, false)} focused={focus?.source === 'git' && focus.path === f.path}
              badge={<span className={`badge st-b st-${f.status}`}>{STATUS[f.status] ? t(STATUS[f.status]!) : f.status}</span>} stat={<Stat add={f.add} del={f.del} />}>
              <GitFile sid={session.id} file={f.path} />
            </FileCard>
          )
        })}
      </div>
    </div>
  )
}
