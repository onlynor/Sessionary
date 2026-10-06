import { useEffect, useMemo, useState } from 'react'
import { t, useT } from './i18n'
import { useApi } from './machines'
import { pathOf } from './Blocks'
import { diffOf, diffStats } from './diff'
import { compact, fullTime, relTime, relTo, splitPath } from './format'
import { usePersisted } from './hooks'
import { Icon } from './Icon'
import { Reveal } from './Reveal'
import type { Quick } from './Conversation'
import type { ChangeFocus, EditBlock, ProjectContext, SessionSummary, TreeEntry } from './types'

function Section({ id, title, aside, children, defaultOpen = true }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  useT()
  const [open, setOpen] = usePersisted(`sec:${id}`, defaultOpen)
  return (
    <section className="isec">
      <button className="isec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="isec-title">{t(title)}</span>
        {aside != null && <span className="isec-aside">{aside}</span>}
        <span className={`chev ${open ? 'open' : ''}`}><Icon name="chev" size={12} /></span>
      </button>
      <Reveal open={open}><div className="isec-body">{children}</div></Reveal>
    </section>
  )
}

function FileLine({ path, root, onClick, trailing, lead }: { path: string; root?: string; onClick?: () => void; trailing?: React.ReactNode; lead?: React.ReactNode }) {
  const { dir, name } = splitPath(relTo(path, root))
  return (
    <button className="iline" title={path} onClick={onClick} disabled={!onClick}>
      {lead ?? <Icon name="file" size={14} />}
      <span className="iname">{name}</span>
      <span className="idir">{dir}</span>
      {trailing}
    </button>
  )
}

function TreeDir({ sid, rel, depth, touched, open, onFile }: { sid: string; rel: string; depth: number; touched: Map<string, boolean>; open: Set<string>; onFile: (rel: string) => void }) {
  const api = useApi()
  useT()
  const [entries, setEntries] = useState<TreeEntry[] | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => { api.tree(sid, rel).then(setEntries, () => setEntries([])) }, [sid, rel])
  if (!entries) return <div className="sk-line" style={{ marginLeft: depth * 16 + 26 }} />
  return (
    <>
      {entries.map((e) => {
        const p = rel ? `${rel}/${e.name}` : e.name
        const isOpen = expanded[p] ?? open.has(p)
        const mark = touched.get(p)
        return (
          <div key={p}>
            <button className={`tnode ${mark === true ? 'changed' : mark === false ? 'seen' : ''}`} style={{ paddingLeft: depth * 16 + 4 }} onClick={() => (e.dir ? setExpanded({ ...expanded, [p]: !isOpen }) : onFile(p))} title={e.dir ? undefined : t('Open {file}', { file: e.name })}>
              {e.dir ? <span className={`chev ${isOpen ? 'open' : ''}`}><Icon name="chev" size={12} /></span> : <span className="chev-pad" />}
              <Icon name={e.dir ? (isOpen ? 'folder-open' : 'folder') : 'file'} size={14} />
              <span className="tname">{e.name}</span>
              {mark != null && <span className={`tmark ${mark ? 'on' : ''}`} title={mark ? t('Edited in this session') : t('Read in this session')} />}
            </button>
            {e.dir && <Reveal open={isOpen}><TreeDir sid={sid} rel={p} depth={depth + 1} touched={touched} open={open} onFile={onFile} /></Reveal>}
          </div>
        )
      })}
      {!entries.length && <div className="quiet-note" style={{ paddingLeft: depth * 16 + 26 }}>{t('empty')}</div>}
    </>
  )
}

export function Inspector({ summary, edits: editBlocks, ctx, onOpenChange, quick }: { summary: SessionSummary; edits?: EditBlock[]; ctx?: ProjectContext; onOpenChange: (f: ChangeFocus) => void; quick: Quick }) {
  const root = ctx?.git?.root ?? summary.cwd
  useT()
  const [allEdits, setAllEdits] = useState(false)

  // per-file +/- totals reconstructed from the session's own edit calls
  const edits = useMemo(() => {
    const m = new Map<string, { add: number; del: number; n: number }>()
    for (const b of editBlocks ?? []) {
      const p = pathOf(b)
      if (!p) continue
      const { add, del } = diffStats(diffOf(b))
      const e = m.get(p) ?? { add: 0, del: 0, n: 0 }
      m.set(p, { add: e.add + add, del: e.del + del, n: e.n + 1 })
    }
    return [...m].map(([path, v]) => ({ path, ...v }))
  }, [editBlocks])

  const { touched, open } = useMemo(() => {
    const touched = new Map<string, boolean>()
    const open = new Set<string>()
    for (const f of ctx?.touchedFiles ?? []) {
      const rel = summary.cwd ? relTo(f.path, summary.cwd) : f.path
      if (rel === f.path && rel.startsWith('/')) continue
      touched.set(rel, f.changed || touched.get(rel) === true)
      if (f.changed) { const parts = rel.split('/'); for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/')) }
    }
    return { touched, open }
  }, [ctx, summary.cwd])

  const p = summary.project
  const git = ctx?.git
  return (
    <div>
      <div className="iproj">
        <div className="iproj-name"><span className="tile folder-tile"><Icon name="folder" size={18} /></span><span className="ellip">{p.generic ? t('No project') : p.name}</span></div>
        <div className="iproj-path mono" title={summary.cwd}>{summary.cwd ?? t('No working directory recorded')}</div>
        {ctx?.cwdExists && (
          <div className="iproj-actions">
            {quick.onFolder && <button className="btn sm" onClick={quick.onFolder}><Icon name="folder-open" size={14} />{t('Folder')}</button>}
            {quick.onTerminal && <button className="btn sm" onClick={quick.onTerminal}><Icon name="terminal" size={14} />{t('Terminal')}</button>}
            {quick.onEditor && <button className="btn sm" onClick={quick.onEditor} title={quick.editor ? t('Open in {editor}', { editor: quick.editor }) : t('Open in editor')}><Icon name="code" size={14} />{t('Editor')}</button>}
          </div>
        )}
        <div className="iproj-state">
          {!ctx ? <span className="sk-line short" />
            : !ctx.cwdExists ? <span className="state warn"><span className="dot" />{t('Directory no longer exists')}</span>
            : git ? <>
                <span className="state"><Icon name="branch" size={14} /><span className="mono">{git.branch ?? 'detached'}</span></span>
                <span className={`state ${git.dirty ? 'warn' : 'ok'}`}>{git.dirty ? <Icon name="dirty" size={14} /> : <span className="dot ok" />}{git.dirty ? t('{n} uncommitted', { n: git.dirty }) : t('Clean')}</span>
              </>
            : <span className="state"><span className="dot" />{t('Not a git repository')}</span>}
        </div>
      </div>

      <Section id="edits" title="Changes in this session" aside={editBlocks ? edits.length || '' : ''}>
        {!editBlocks ? <div className="sk-line" /> : edits.length === 0 ? <div className="quiet-note">{t('No files were edited.')}</div> : (
          <>
            {(allEdits ? edits : edits.slice(0, 8)).map((e) => (
              <FileLine key={e.path} path={e.path} root={root} onClick={() => onOpenChange({ path: e.path, source: 'session' })}
                trailing={<span className="stat"><b className="plus">+{e.add}</b><b className="minus">−{e.del}</b></span>} />
            ))}
            {edits.length > 8 && <button className="more" onClick={() => setAllEdits(!allEdits)}>{allEdits ? t('Show fewer') : t('Show all {n}', { n: edits.length })}</button>}
          </>
        )}
      </Section>

      {ctx?.cwdExists && (
        <Section id="files" title="Files" aside={t('now')}>
          <div className="tree"><TreeDir key={summary.id} sid={summary.id} rel="" depth={0} touched={touched} open={open} onFile={quick.onOpenFile} /></div>
        </Section>
      )}

      {git && (
        <Section id="git" title="Working tree" aside={<span title={t('Live state of the repository; it may differ from when the session ran')}>{t('live')}</span>}>
          {git.status.length === 0 ? <div className="quiet-note">{t('Nothing uncommitted.')}</div> : git.status.slice(0, 10).map((s) => {
            const c = s.code.trim()[0] ?? '·'
            return <FileLine key={s.path} path={s.path} onClick={() => onOpenChange({ path: s.path, source: 'git' })} lead={<span className={`gst gst-${c === '?' ? 'U' : c}`}>{c === '?' ? 'U' : c}</span>} />
          })}
          {git.status.length > 10 && <button className="more" onClick={() => onOpenChange({ path: git.status[0]!.path, source: 'git' })}>{t('Review all {n}', { n: git.status.length })}</button>}
          {git.recent.length > 0 && (
            <div className="commits">
              {git.recent.slice(0, 3).map((c) => (
                <div key={c.hash} className="commit" title={`${c.subject}\n${fullTime(Date.parse(c.date))}`}>
                  <span className="mono hash">{c.hash}</span><span className="csub">{c.subject}</span><span className="ctime">{relTime(Date.parse(c.date))}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section id="meta" title="Session">
        <dl className="kv">
          <dt>{t('Model')}</dt><dd>{summary.model ?? '—'}</dd>
          <dt>{t('Started')}</dt><dd>{fullTime(summary.createdAt)}</dd>
          <dt>{t('Last activity')}</dt><dd>{fullTime(summary.updatedAt)}</dd>
          {summary.gitBranch && <><dt>{t('Branch then')}</dt><dd className="mono">{summary.gitBranch}</dd></>}
          {summary.tokens && <><dt>{t('Tokens')}</dt><dd>{t('{in} in · {out} out', { in: compact(summary.tokens.input), out: compact(summary.tokens.output) })}</dd></>}
          {!!summary.cost && <><dt>{t('Cost')}</dt><dd>${summary.cost.toFixed(2)}</dd></>}
          {!!summary.toolCalls && <><dt>{t('Tool calls')}</dt><dd>{summary.toolCalls}</dd></>}
        </dl>
        {ctx && ctx.toolUsage.length > 0 && <div className="chips">{ctx.toolUsage.slice(0, 8).map((t) => <span key={t.name} className="chip">{t.name}<b>{t.count}</b></span>)}</div>}
      </Section>
    </div>
  )
}
