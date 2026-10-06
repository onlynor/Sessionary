import { host } from './api'
import { t } from './i18n'
import { go, href } from './route'
import type { SessionSummary } from './types'

type Say = (text: string, undo?: () => void) => void

/**
 * The size a new terminal should start with. A running terminal cannot be resized, so this is estimated from the
 * window: the terminal's column of the page, in 13px monospace.
 */
export function termSize() {
  const width = Math.max(480, innerWidth - 232 - 300 - 96)
  return { cols: Math.max(60, Math.min(220, Math.floor(width / 7.9))), rows: Math.max(16, Math.min(60, Math.floor((innerHeight - 250) / 17))) }
}

/** Opens a terminal on a machine and goes to it. The terminal outlives the page, so leaving it is safe. */
export async function launchTerminal(say: Say, spec: { machine: string; kind: 'shell' | 'resume' | 'new'; agent?: string; sessionId?: string; cwd?: string }) {
  try {
    const term = await host.openTerminal({ ...termSize(), ...spec })
    go(href.machine(spec.machine, 'terminal', { t: term.id }))
    return term
  } catch (e) { say((e as Error).message) }
}

/** the project directory a session or project key stands for, when it is a real path */
export const projectDir = (key: string | undefined) => (key && !key.startsWith('generic:') && key !== 'none' ? key : undefined)

export const resumeTitle = (s: SessionSummary) => t('Resume “{title}”', { title: s.title.slice(0, 40) })
