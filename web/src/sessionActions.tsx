import { useEffect, useState } from 'react'
import { t } from './i18n'
import { launchTerminal } from './actions'
import type { MenuItem } from './ContextMenu'
import { useMachine } from './machines'
import { go, href } from './route'
import { useUi } from './ui'
import type { OpenTarget, SessionSummary, Status } from './types'

const DISK_NOTE: Record<string, string> = {
  'claude-code': "The transcript and its per-session folders are moved into Sessionary's backup folder. Claude Code will no longer list it for --resume.",
  opencode: 'The session is exported to a backup file, then removed with `opencode session delete` (sub-agent sessions included). OpenCode will no longer show it.',
  pi: "The session file is moved into Sessionary's backup folder. Pi will no longer list it.",
}

/**
 * What can be done to a session, in one place: the row menu, the session header and the palette all use it.
 * Everything goes through the open machine's API, so a node's sessions get the same verbs — except those that
 * would touch this computer's disk or change the node, which only this computer's sessions have.
 */
export function useSessionActions() {
  const { machine, api, agents, reload } = useMachine()
  const ui = useUi()
  const local = machine.kind === 'local'
  const [caps, setCaps] = useState<Status['capabilities']>()
  useEffect(() => { if (local) api.status().then((s) => setCaps(s.capabilities), () => {}) }, [local, api])
  const agentOf = (s: Pick<SessionSummary, 'agent'>) => agents.find((a) => a.id === s.agent)
  const say = ui.say

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); say(t('Copied {what}', { what })) } catch { say(t('Could not copy to the clipboard')) }
  }
  const open = (s: Pick<SessionSummary, 'id'>, q?: Record<string, string | undefined>) => go(href.session(machine.id, s.id, q))
  const guard = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { say((e as Error).message) } }

  const togglePin = (s: SessionSummary) => guard(async () => { await api.pin(s.id, !s.pinned); await reload() })
  /** `direct` means the title is already the new name (typed in the page header); otherwise ask for one */
  const rename = (s: SessionSummary, direct = false) => direct ? guard(async () => { await api.rename(s.id, s.title); await reload() }) : ui.prompt({
    title: t('Rename session'), label: t('Name'), value: s.title, confirm: t('Rename'), placeholder: t('Name this session'),
    onSubmit: (v) => guard(async () => { await api.rename(s.id, v); await reload() }),
  })
  const openIn = (s: SessionSummary, target: OpenTarget, path?: string) => guard(() => api.open(s.id, target, path))

  /** reopen it in a terminal here (inside the app), on the machine it lives on */
  const resume = (s: SessionSummary) => {
    const go = () => launchTerminal(say, { machine: machine.id, kind: 'resume', sessionId: s.id })
    // a session written to moments ago is probably still open somewhere; two writers would interleave
    if (s.active) ui.confirm({
      title: t('Resume a session that looks open?'), confirm: t('Resume anyway'),
      body: <p>{t('{agent} wrote to this session in the last two minutes, so it is probably still open in another terminal. Resuming it twice can interleave both conversations.', { agent: agentOf(s)?.label ?? s.agent })}</p>,
      onConfirm: go,
    })
    else go()
  }
  const copyResume = (s: SessionSummary) => guard(async () => {
    if (local) { const c = await api.resumeCommand(s.id); copy(c.line, t('resume command')); return }
    const r = await fetch(`/api/nodes/${encodeURIComponent(machine.id)}/resume-command?session=${encodeURIComponent(s.id)}`)
    const body = await r.json()
    if (!r.ok) throw new Error(body.error)
    copy(body.line, t('resume command'))
  })
  const newHere = (s: SessionSummary) => launchTerminal(say, { machine: machine.id, kind: 'new', agent: s.agent, cwd: s.cwd })

  const trash = (s: SessionSummary, then?: () => void) => guard(async () => {
    await api.hide(s.id); await reload(); then?.()
    say(t('Moved “{title}” to Trash', { title: s.title.slice(0, 40) }), async () => { await api.restore(s.id); await reload() })
  })
  const deleteFromDisk = (s: SessionSummary, then?: () => void) => ui.confirm({
    title: t('Delete from disk?'), danger: true, confirm: t('Delete from Disk'),
    body: <><p><b>{s.title}</b></p><p>{t(DISK_NOTE[s.agent] ?? "The session is moved out of the agent's storage.")}</p><p className="muted">{t('You can restore it from the Trash until you delete its backup there.')}</p></>,
    onConfirm: async () => {
      try { await api.deleteFromDisk(s.id); await reload(); then?.(); say(t('Deleted “{title}” from disk — restorable from the Trash', { title: s.title.slice(0, 40) })) }
      catch (e) { say(t('Not deleted: {error}', { error: (e as Error).message })) }
    },
  })
  const showProject = (s: SessionSummary) => go(href.machine(machine.id, 'sessions', { agent: s.agent, p: s.project.generic ? '~none' : s.project.key }))

  const menuFor = (s: SessionSummary, opts: { page?: boolean; then?: () => void } = {}): (MenuItem | '-')[] => {
    const a = agentOf(s)
    const hasDir = !!s.cwd
    return [
      ...(opts.page ? [] : [{ label: t('Open'), icon: 'message', onSelect: () => open(s) } as MenuItem]),
      { label: s.pinned ? t('Unpin') : t('Pin'), icon: s.pinned ? 'unpin' : 'pin', hint: 'P', onSelect: () => togglePin(s) },
      { label: t('Rename'), icon: 'edit2', onSelect: () => rename(s) },
      '-',
      { label: t('Resume in Terminal'), icon: 'play', hint: '⇧R', onSelect: () => resume(s), disabled: !a?.canResume || (local && !hasDir) },
      { label: t('New session in this project'), icon: 'other', onSelect: () => newHere(s), disabled: !a?.canCreate },
      { label: t('Copy resume command'), icon: 'clipboard', onSelect: () => copyResume(s), disabled: !a?.canResume || !hasDir },
      ...(local ? [
        '-' as const,
        { label: t('Open folder'), icon: 'folder-open', onSelect: () => openIn(s, 'folder'), disabled: !hasDir || !caps?.fileManager },
        { label: caps?.editor ? t('Open in {editor}', { editor: caps.editor }) : t('Open in editor'), icon: 'code', onSelect: () => openIn(s, 'editor'), disabled: !hasDir },
      ] : []),
      '-',
      { label: t('Show only this project'), icon: 'folder', onSelect: () => showProject(s) },
      { label: t('Copy session ID'), icon: 'copy', onSelect: () => copy(s.nativeId, t('session ID')) },
      ...(hasDir ? [{ label: t('Copy path'), icon: 'copy', onSelect: () => copy(s.cwd!, t('path')) }] : []),
      '-',
      { label: t('Move to Trash'), icon: 'archive', hint: 'Del', onSelect: () => trash(s, opts.then) },
      ...(local ? [{ label: t('Delete from Disk…'), icon: 'trash', onSelect: () => deleteFromDisk(s, opts.then), danger: true } as MenuItem] : []),
    ]
  }

  return { caps, agentOf, copy, open, togglePin, rename, openIn, resume, copyResume, newHere, trash, deleteFromDisk, showProject, menuFor }
}
