import fs from 'node:fs'
import path from 'node:path'
import { home } from './util.ts'

export interface SshHost { alias: string; hostName?: string; user?: string; port?: number; identity?: string }

/**
 * The hosts a person has already named in ~/.ssh/config, so adding a node is a choice instead of typing.
 * Only plain `Host` names are listed (patterns with * ? ! are defaults, not machines); ssh itself applies the
 * rest of the file when it connects, so only the alias needs to be stored.
 */
export function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = []
  let current: SshHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\w+)\s*[=\s]\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const val = m[2]!.trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = val.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias }))
      hosts.push(...current)
    } else if (key === 'match') current = []
    else for (const h of current) {
      if (key === 'hostname') h.hostName ??= val
      else if (key === 'user') h.user ??= val
      else if (key === 'port' && Number.isInteger(Number(val))) h.port ??= Number(val)
      else if (key === 'identityfile') h.identity ??= val
    }
  }
  return hosts
}

export function sshHosts(file = path.join(home(), '.ssh', 'config')): SshHost[] {
  try { return parseSshConfig(fs.readFileSync(file, 'utf8')) } catch { return [] }
}
