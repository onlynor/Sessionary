import { useEffect, useState } from 'react'
import { t, useT } from './i18n'
import { AgentIcon } from './AgentIcon'
import { Icon } from './Icon'
import { useApi } from './machines'
import { cleanTitle, relAgo } from './format'
import type { Trash } from './types'

/** Sessionary's trash: things hidden from this app only. The agents' own files were never touched. */
export function TrashView({ rev, onChanged, onOpen, onRestoreRemoved, onPurge, embedded }: { rev: number; onChanged: () => void; onOpen: (id: string) => void; onRestoreRemoved: (id: string) => void; onPurge: (id: string, title: string) => void; embedded?: boolean }) {
  useT()
  const api = useApi()
  const [trash, setTrash] = useState<Trash | null>(null)
  useEffect(() => { api.trash().then(setTrash, () => setTrash({ sessions: [], partial: [], removed: [] })) }, [rev])
  const act = async (p: Promise<unknown>) => { await p; onChanged() }
  const empty = trash && !trash.sessions.length && !trash.partial.length && !trash.removed.length
  return (
    <div className={embedded ? '' : 'page'}>
      <div className={embedded ? 'trash' : 'page-inner trash enter'}>
        {!embedded && <h1>{t('Trash')}</h1>}
        <p className="page-lede">{t("Hidden items are only hidden from Sessionary — the agents still see them. Sessions deleted from disk live in Sessionary's backup until you delete the backup.")}</p>
        {!trash ? <div className="sk-line" /> : empty ? <div className="empty-state"><span className="tile"><Icon name="trash" size={28} stroke={1.5} /></span>{t('Nothing in the Trash.')}</div> : (
          <>
            {trash.sessions.length > 0 && <div className="section-label">{t('Sessions')} · {trash.sessions.length}</div>}
            {trash.sessions.length > 0 && <div className="group-card">{trash.sessions.map((s) => (
              <div key={s.id} className="trash-row">
                <AgentIcon agent={s.agent} size={16} />
                <button className="t-main" onClick={() => onOpen(s.id)}>
                  <span className="r-title">{cleanTitle(s.title)}</span>
                  <span className="r-meta">{s.project.generic ? t('No project') : s.project.name} · {t('hidden {when}', { when: relAgo(s.hiddenAt) })}</span>
                </button>
                <button className="btn" onClick={() => act(api.restore(s.id))}>{t('Restore')}</button>
              </div>
            ))}
            </div>}
            {trash.removed.length > 0 && <div className="section-label">{t('Deleted from disk')} · {trash.removed.length}</div>}
            {trash.removed.length > 0 && <div className="group-card">{trash.removed.map((s) => (
              <div key={s.id} className="trash-row">
                <AgentIcon agent={s.agent} size={16} />
                <div className="t-main">
                  <span className="r-title">{cleanTitle(s.title)}</span>
                  <span className="r-meta" title={s.backupDir}>{s.project.generic ? t('No project') : s.project.name} · {t('deleted {when}', { when: relAgo(s.removedAt) })} · {t('backup kept')}</span>
                </div>
                <button className="btn" onClick={() => onRestoreRemoved(s.id)}>{t('Restore')}</button>
                <button className="btn danger-quiet" onClick={() => onPurge(s.id, s.title)}>{t('Delete Backup')}</button>
              </div>
            ))}
            </div>}
            {trash.partial.length > 0 && <div className="section-label">{t('Hidden messages')}</div>}
            {trash.partial.length > 0 && <div className="group-card">{trash.partial.map((s) => (
              <div key={s.id} className="trash-row">
                <AgentIcon agent={s.agent} size={16} />
                <button className="t-main" onClick={() => onOpen(s.id)}>
                  <span className="r-title">{cleanTitle(s.title)}</span>
                  <span className="r-meta">{t(s.hiddenMessages > 1 ? '{n} messages hidden' : '{n} message hidden', { n: s.hiddenMessages })} · {relAgo(s.hiddenAt)}</span>
                </button>
                <button className="btn" onClick={() => act(api.restoreMessages(s.id))}>{t('Restore all')}</button>
              </div>
            ))}
            </div>}
          </>
        )}
      </div>
    </div>
  )
}
