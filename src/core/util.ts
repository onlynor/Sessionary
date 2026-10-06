import os from 'node:os'
import path from 'node:path'

export const home = () => os.homedir()

export function dataHome(): string {
  if (process.env.SESSIONARY_HOME) return process.env.SESSIONARY_HOME
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home(), 'AppData', 'Roaming'), 'sessionary')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home(), '.local', 'share'), 'sessionary')
}

export function truncateTitle(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export const toMs = (iso?: string | number): number | undefined => {
  if (iso == null) return undefined
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

export function* jsonlLines(text: string): Generator<any> {
  for (const line of text.split('\n')) {
    if (!line) continue
    try { yield JSON.parse(line) } catch { /* partially written trailing line */ }
  }
}

/** Prompts are passed as a CLI argument; one that starts with "-" would be read as a flag. */
export const argSafe = (prompt: string) => (prompt.startsWith('-') ? ' ' + prompt : prompt)

/** Where each agent keeps its history. A node's mirror has the same layout under its own directory. */
export interface Roots { claude: string; pi: string; xdgData: string; hermes: string; codex: string; workbuddy: string; workbuddyAi: string }
export const localRoots = (): Roots => ({
  claude: process.env.CLAUDE_CONFIG_DIR ?? path.join(home(), '.claude'),
  pi: process.env.PI_CODING_AGENT_DIR ?? path.join(home(), '.pi', 'agent'),
  xdgData: process.env.XDG_DATA_HOME ?? path.join(home(), '.local', 'share'),
  hermes: process.env.HERMES_HOME ?? path.join(home(), '.hermes'),
  codex: process.env.CODEX_HOME ?? path.join(home(), '.codex'),
  // the China edition and the international edition (WorkBuddy AI) are separate apps with separate homes
  workbuddy: process.env.WORKBUDDY_HOME ?? path.join(home(), '.workbuddy'),
  workbuddyAi: process.env.WORKBUDDY_AI_HOME ?? path.join(home(), '.workbuddy-ai'),
})
/** the layout of a machine's home directory, as mirrored from a node */
export const mirrorRoots = (homeDir: string): Roots => ({
  claude: path.join(homeDir, '.claude'), pi: path.join(homeDir, '.pi', 'agent'),
  xdgData: path.join(homeDir, '.local', 'share'), hermes: path.join(homeDir, '.hermes'),
  codex: path.join(homeDir, '.codex'), workbuddy: path.join(homeDir, '.workbuddy'), workbuddyAi: path.join(homeDir, '.workbuddy-ai'),
})
