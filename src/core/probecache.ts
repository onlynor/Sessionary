import fs from 'node:fs'
import path from 'node:path'
import type { AgentInstall, KnownBin } from './system.ts'
import { dataHome } from './util.ts'

/** What was last found on a machine. Derived data: deleting the file only makes the next probe slower. */
export interface ProbeEntry {
  at: number
  agents: AgentInstall[]
  /** the login shell's PATH, and when it was read: starting a login shell is the slowest part of a probe */
  path?: string
  pathAt?: number
  known: Record<string, KnownBin>
}

export class ProbeCache {
  private data: Record<string, ProbeEntry> | undefined
  constructor(private file = path.join(dataHome(), 'probe-cache.json')) {}

  private load() {
    if (this.data) return this.data
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.data = {} }
    return this.data!
  }
  get(id: string): ProbeEntry | undefined { return this.load()[id] }
  set(id: string, e: ProbeEntry) {
    this.load()[id] = e
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.file)
    } catch { /* a cache that cannot be written is only slower */ }
  }
  drop(id: string) {
    if (!this.load()[id]) return
    delete this.data![id]
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)) } catch { /* see set */ }
  }
}
