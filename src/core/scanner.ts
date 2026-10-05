import type { AgentAdapter, Session } from './model.ts'
import type { IndexStore } from './index-store.ts'

export interface ScanReport { agent: string; found: number; updated: number; removed: number; ms: number; changed: string[]; error?: string }

/** Incremental: only sources whose fingerprint changed are re-read; vanished ones are dropped from the index. */
export async function scan(adapters: AgentAdapter[], store: IndexStore): Promise<ScanReport[]> {
  const reports: ScanReport[] = []
  for (const a of adapters) {
    const t0 = Date.now()
    const known = store.sources(a.id)
    let sources: Awaited<ReturnType<AgentAdapter['listSources']>>
    try { sources = await a.listSources() } catch (e) {
      // keep what we have rather than dropping every session of an agent we could not read this time
      reports.push({ agent: a.id, found: 0, updated: 0, removed: 0, ms: Date.now() - t0, changed: [], error: (e as Error).message })
      continue
    }
    const seen = new Set<string>()
    const changed: string[] = []
    let updated = 0
    for (const s of sources) {
      seen.add(s.key)
      if (known.get(s.key)?.fingerprint === s.fingerprint) continue
      try {
        // one full read per changed source: the summary and the full-text rows come from the same parse
        const full = await a.load(s)
        if (full) { const { messages, ...summary } = full; store.upsert(a.id, s.key, s.fingerprint, summary, messages); changed.push(summary.id) }
        else store.upsert(a.id, s.key, s.fingerprint, null)
        updated++
      } catch (e) {
        console.warn(`[scan] ${a.id} ${s.key}:`, (e as Error).message)
      }
    }
    let removed = 0
    // an empty listing may mean "agent not installed / db locked" – still correct to drop stale rows
    for (const key of known.keys()) if (!seen.has(key)) { const id = store.remove(a.id, key); if (id) changed.push(id); removed++ }
    reports.push({ agent: a.id, found: sources.length, updated, removed, ms: Date.now() - t0, changed })
  }
  return reports
}

export async function loadSession(adapters: AgentAdapter[], store: IndexStore, id: string): Promise<Session | null> {
  const row = store.get(id)
  if (!row) return null
  const adapter = adapters.find((a) => a.id === row.agent)
  if (!adapter) return null
  // by convention a source's ref equals its key; the fingerprint is irrelevant for loading
  return adapter.load({ key: row.sourceKey, ref: row.sourceKey, fingerprint: '' })
}
