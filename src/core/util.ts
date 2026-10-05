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
